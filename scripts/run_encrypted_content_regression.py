#!/usr/bin/env python3
"""Exercise encrypted-content recovery against an offline Python mock upstream.

Only the standard library is required. The actual gateway binary runs with a
disposable SQLite database; OAuth credentials, ciphertext and tool results are
synthetic. No real OAuth login, token refresh or OpenAI request is needed.
"""
import argparse
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from run_oauth_metering_regression import WsClient, frame_bytes, read_frame

ROOT = Path(__file__).resolve().parents[1]
ADMIN = 'encrypted-recovery-test-admin'
SETTING = 'encrypted_content_recovery'
ERROR = {
    'message': 'The encrypted content for item rs_mock could not be verified. '
               'Reason: Encrypted content could not be decrypted or parsed.',
    'type': 'invalid_request_error', 'param': None, 'code': 'invalid_encrypted_content',
}


class Mock(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    hits = []
    lock = threading.Lock()

    def log_message(self, *_args):
        pass

    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError):
            pass

    def note(self, payload, transport):
        with self.lock:
            self.hits.append({'payload': payload, 'transport': transport, 'path': self.path,
                              'auth': self.headers.get('Authorization'),
                              'account': self.headers.get('ChatGPT-Account-ID')})

    def respond(self, status, value):
        raw = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def error(self, payload):
        case = payload.get('test_case')
        items = payload.get('input', [])
        if isinstance(items, dict):
            items = [items]
        stale = any(isinstance(item, dict) and str(item.get('encrypted_content', '')).startswith('stale-')
                    for item in items)
        if stale or case in ('always', 'always_sse'):
            error = dict(ERROR)
            if case == 'other':
                error.update(code='invalid_request', message='text mentions invalid_encrypted_content')
            return error
        return None

    def events(self, payload):
        error = self.error(payload)
        if error:
            if payload.get('test_case') == 'late':
                yield {'type': 'response.output_item.added', 'item': {
                    'type': 'function_call', 'call_id': 'new-tool', 'name': 'shell', 'arguments': '{}'}}
            event = {'type': 'response.failed', 'status': 400, 'response': {'status': 'failed', 'error': error}}
            if payload.get('test_case') == 'usage':
                event['response']['usage'] = {'input_tokens': 0, 'output_tokens': 0}
            if payload.get('test_case') == 'error_event':
                event = {'type': 'error', 'error': error}
            yield event
            return
        yield {'type': 'response.output_text.delta', 'delta': 'continued'}
        yield {'type': 'response.completed', 'response': self.completed()}

    @staticmethod
    def completed():
        return {'id': 'resp_mock', 'object': 'response', 'status': 'completed',
                'output': [], 'usage': {'input_tokens': 12, 'output_tokens': 3}}

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.note(payload, 'http')
        if '/fail-' in self.path:
            return self.respond(503, {'error': {'message': 'synthetic outage'}})
        if payload.get('test_case') in ('sse', 'always_sse', 'late', 'error_event'):
            # Split UTF-8/JSON across HTTP chunks to exercise incremental parsing.
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()
            for event in self.events(payload):
                data = ('data: ' + json.dumps(event) + '\r\n\r\n').encode()
                for start in range(0, len(data), 17):
                    chunk = data[start:start + 17]
                    self.wfile.write(f'{len(chunk):x}\r\n'.encode() + chunk + b'\r\n')
                self.wfile.flush()
            self.wfile.write(b'0\r\n\r\n')
            return
        error = self.error(payload)
        if error:
            value = {'error': error}
            if payload.get('test_case') == 'usage':
                value['usage'] = {'input_tokens': 0, 'output_tokens': 0}
            return self.respond(400, value)
        if payload.get('stream'):
            data = ''.join('data: ' + json.dumps(event) + '\n\n' for event in self.events(payload)).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.respond(200, self.completed())

    def do_GET(self):
        if '/bridge/' in self.path:
            return self.respond(404, {'error': {'message': 'use HTTP bridge'}})
        self.send_response(101)
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        accept = base64.b64encode(hashlib.sha1((self.headers['Sec-WebSocket-Key'] +
                                               '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        self.send_header('Sec-WebSocket-Accept', accept)
        self.end_headers()
        try:
            while True:
                opcode, raw = read_frame(self.rfile)
                if opcode == 8:
                    return
                if opcode != 1:
                    continue
                payload = json.loads(raw)
                self.note(payload, 'ws')
                for event in self.events(payload):
                    self.wfile.write(frame_bytes(json.dumps(event)))
                    self.wfile.flush()
        except (EOFError, OSError):
            pass


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Regression:
    def __init__(self, port, mock_port, database):
        self.port, self.mock_port, self.database = port, mock_port, database
        self.results = []

    def http(self, method, path, value=None, token=ADMIN, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=20)
        try:
            conn.request(method, path, json.dumps(value) if value is not None else None,
                         {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', **(headers or {})})
            response = conn.getresponse()
            return response.status, response.read()
        finally:
            conn.close()

    def api(self, method, path, value=None):
        status, raw = self.http(method, '/api/v1' + path, value)
        assert 200 <= status < 300, (path, status, raw)
        return json.loads(raw) if raw else None

    def setting(self, value):
        self.api('PATCH', '/runtime-settings', {'key': SETTING, 'value': value})
        assert self.setting_view()['value'] is value

    def setting_view(self):
        return next(item for item in self.api('GET', '/runtime-settings')['settings'] if item['key'] == SETTING)

    def provider(self, name, path='normal', max_retries=2):
        result = self.api('POST', '/upstreams', {
            'name': name, 'provider_type': 'openai', 'max_retries': max_retries,
            'websocket_enabled': True, 'beta_features': ['responses-http-to-ws'],
            'endpoints': [{'name': name, 'base_url': f'http://127.0.0.1:{self.mock_port}/{path}/v1'}],
            'keys': [{'name': name, 'secret': 'synthetic-' + name}],
        })
        return self.api('GET', f'/upstreams/{result["id"]}')

    def client(self, providers):
        return self.api('POST', '/api-keys', {'name': 'test-client', 'enabled': True, 'log_enabled': True,
                                            'allowed_provider_ids': [p['provider']['id'] for p in providers]})['api_key']

    def route(self, model, providers):
        self.api('PUT', '/model-route-policies', {'model_name': model, 'mode': 'ordered', 'sticky': False,
                 'failover': True, 'targets': [{'provider_id': p['provider']['id'], 'priority': i * 10, 'weight': 1}
                                             for i, p in enumerate(providers)]})

    @staticmethod
    def payload(model, session, case='normal'):
        return {'model': model, 'stream': False, 'prompt_cache_key': session, 'test_case': case, 'input': [
            {'role': 'user', 'content': 'Continue the half-finished task; files are already edited.'},
            {'type': 'reasoning', 'id': 'rs_mock', 'encrypted_content': 'stale-' + session,
             'content': None, 'summary': [{'type': 'summary_text', 'text': 'The patch is written.'}]},
            {'type': 'function_call', 'call_id': 'call_done', 'name': 'shell', 'arguments': '{"cmd":"git diff"}'},
            {'type': 'function_call_output', 'call_id': 'call_done', 'output': 'Already completed; preserve this result.'},
        ]}

    def call(self, payload, token=None):
        return self.http('POST', '/v1/responses', payload, token or self.token)

    def passed(self, name):
        self.results.append(name)
        print('PASS ' + name, flush=True)

    def check_cleaned(self, original, cleaned):
        assert cleaned['input'][0] == original['input'][0]
        assert cleaned['input'][1] == {k: v for k, v in original['input'][1].items()
                                       if k not in ('encrypted_content', 'content')}
        assert cleaned['input'][2:4] == original['input'][2:4]

    def check_http(self):
        normal = self.provider('normal')
        self.normal = normal
        self.token = self.client([normal])
        self.route('normal', [normal])
        setting = self.setting_view()
        assert setting['value'] is False and setting['default_value'] is False
        assert setting['group'] == 'beta' and setting['requires_restart'] is False
        assert self.http('PATCH', '/api/v1/runtime-settings', {'key': SETTING, 'value': 'true'})[0] == 400
        assert self.http('PATCH', '/api/v1/runtime-settings', {'key': SETTING, 'value': True}, self.token)[0] == 401
        body = self.payload('normal', 'first')
        start = len(Mock.hits)
        status, raw = self.call(body)
        assert status == 400 and json.loads(raw)['error'] == ERROR
        assert len(Mock.hits) - start == 1 and Mock.hits[-1]['payload'] == body
        self.passed('default off: exact error and unchanged payload; setting validation and admin authorization')

        self.setting(True)
        start = len(Mock.hits)
        assert self.call(body)[0] == 200
        hits = Mock.hits[start:]
        assert len(hits) == 2 and hits[0]['auth'] == hits[1]['auth'] and hits[0]['path'] == hits[1]['path']
        self.check_cleaned(body, hits[1]['payload'])
        self.passed('HTTP 400: one retry on the same account, visible history and tool results preserved')

        body['input'].append({'type': 'reasoning', 'id': 'rs_new', 'encrypted_content': 'fresh-ciphertext'})
        start = len(Mock.hits)
        assert self.call(body)[0] == 200 and len(Mock.hits) - start == 1
        assert Mock.hits[-1]['payload']['input'][-1] == body['input'][-1]
        self.passed('next HTTP turn: old ciphertext filtered, fresh ciphertext retained')

        # The same textual session must never share recovery state between access keys.
        other_token = self.client([normal])
        start = len(Mock.hits)
        assert self.call(body, other_token)[0] == 200 and len(Mock.hits) - start == 2
        assert Mock.hits[start]['payload'] == body
        self.passed('access-key isolation')
        self.setting(False)
        start = len(Mock.hits)
        assert self.call(body)[0] == 400 and len(Mock.hits) - start == 1
        assert Mock.hits[-1]['payload'] == body
        self.setting(True)
        self.passed('disable immediately bypasses both recovery and cached filtering')

        for case in ('other', 'usage', 'always', 'sse', 'always_sse', 'error_event', 'late'):
            body = self.payload('normal', 'http-' + case, case)
            body['stream'] = case in ('sse', 'always_sse', 'error_event', 'late')
            start = len(Mock.hits)
            status, raw = self.call(body)
            expected = 2 if case in ('always', 'always_sse', 'sse', 'error_event') else 1
            assert len(Mock.hits) - start == expected, (case, Mock.hits[start:])
            if case in ('sse', 'error_event'):
                assert status == 200 and b'response.completed' in raw and b'invalid_encrypted_content' not in raw
            elif case == 'late':
                assert b'new-tool' in raw and b'invalid_encrypted_content' in raw
            elif case == 'always_sse':
                assert status == 200 and b'invalid_encrypted_content' in raw
            else:
                assert status == 400, (case, status, raw)
            self.passed('HTTP/SSE guard: ' + case)

        body = self.payload('normal', 'compaction')
        body['input'] += [{'type': kind, 'encrypted_content': 'stale-' + kind}
                          for kind in ('compaction', 'compaction_summary')]
        assert self.call(body)[0] == 200
        assert len(Mock.hits[-1]['payload']['input']) == 4
        self.passed('encrypted compaction items removed during explicit Beta recovery')

        body = self.payload('normal', 'unsupported')
        body['input'][1] = {'type': 'agent_message', 'encrypted_content': 'stale-unsupported'}
        start = len(Mock.hits)
        assert self.call(body)[0] == 400 and len(Mock.hits) - start == 1
        assert Mock.hits[-1]['payload'] == body
        self.passed('unsupported encrypted tool/message items preserved without useless retry')

        once = self.provider('once', max_retries=0)
        self.route('once', [once])
        token = self.client([once])
        start = len(Mock.hits)
        assert self.call(self.payload('once', 'once'), token)[0] == 400
        assert len(Mock.hits) - start == 1
        self.passed('provider retry limit respected')

        for preceding in (1, 2):
            providers = [self.provider(f'failure-{preceding}-{i}', f'fail-{preceding}-{i}')
                         for i in range(preceding)] + [normal]
            model = f'budget-{preceding}'
            self.route(model, providers)
            token = self.client(providers)
            start = len(Mock.hits)
            assert self.call(self.payload(model, model), token)[0] == (200 if preceding == 1 else 400)
            assert len(Mock.hits) - start == 3
        self.passed('global budget shared with failover: never more than three sends')

    def check_ws(self, provider, model):
        self.route(model, [provider])
        token = self.client([provider])
        client = WsClient(self.port, token)
        try:
            body = self.payload(model, model + '-session')
            body['previous_response_id'] = 'resp_previous_tool_chain'
            start = len(Mock.hits)
            client.send(body)
            assert client.receive()['type'] == 'response.output_text.delta'
            assert client.complete()['type'] == 'response.completed'
            hits = Mock.hits[start:]
            assert len(hits) == 2 and hits[0]['auth'] == hits[1]['auth']
            self.check_cleaned(body, hits[1]['payload'])
            assert hits[1]['payload']['previous_response_id'] == 'resp_previous_tool_chain'
            body['input'].append({'type': 'reasoning', 'encrypted_content': 'fresh-ws'})
            start = len(Mock.hits)
            client.send(body)
            assert client.complete()['type'] == 'response.completed'
            assert len(Mock.hits) - start == 1
            assert Mock.hits[-1]['payload']['input'][-1] == body['input'][-1]
        finally:
            client.close()
        self.passed(model + ': transparent recovery, next-turn filtering and tool continuation preserved')

        # A reconnect retains the same session's digest cache.
        client = WsClient(self.port, token)
        try:
            start = len(Mock.hits)
            client.send(body)
            assert client.complete()['type'] == 'response.completed'
            assert len(Mock.hits) - start == 1
        finally:
            client.close()
        self.passed(model + ': filtering survives WebSocket reconnect')

        for case in ('late', 'usage', 'always', 'other', 'error_event'):
            client = WsClient(self.port, token)
            try:
                start = len(Mock.hits)
                client.send(self.payload(model, model + '-' + case, case))
                terminal = client.complete()
                assert len(Mock.hits) - start == (2 if case in ('always', 'error_event') else 1)
                assert terminal['type'] == ('response.completed' if case == 'error_event' else 'response.failed' if model.endswith('native') or case == 'late' else 'error'), terminal
            finally:
                client.close()
            self.passed(model + ' guard: ' + case)

        self.setting(False)
        client = WsClient(self.port, token)
        try:
            start = len(Mock.hits)
            client.send(body)
            assert client.complete()['type'] in ('error', 'response.failed')
            assert len(Mock.hits) - start == 1
        finally:
            client.close()
            self.setting(True)
        self.passed(model + ': disabled feature leaves rejected history unchanged')

    def enable_oauth(self, provider):
        provider_id = provider['provider']['id']
        key_id = provider['keys'][0]['id']
        envelope = json.dumps({'refresh_token': 'offline-refresh', 'id_token': '',
                               'account_id': 'offline-account', 'email': 'test@example.invalid'})
        carrier = self.api('POST', f'/providers/{provider_id}/keys', {'name': 'envelope', 'secret': envelope})['id']
        with sqlite3.connect(self.database) as conn:
            encrypted = conn.execute('SELECT secret_enc FROM upstream_keys WHERE id=?', (carrier,)).fetchone()[0]
            now = int(time.time() * 1000)
            conn.execute('INSERT INTO codex_oauth_accounts '
                         '(upstream_key_id,provider_id,account_hash,credentials_enc,token_expires_at_ms,auth_status,quota_checked_at_ms,created_at_ms,updated_at_ms) '
                         'VALUES (?,?,?,?,?,?,?,?,?)',
                         (key_id, provider_id, f'offline-{key_id}', encrypted, now + 86400000, 'active', now, now, now))
        self.api('DELETE', f'/keys/{carrier}')
        self.api('PATCH', f'/upstreams/{provider_id}', {'provider_type': 'openai_codex_oauth'})

    def check_logs(self):
        deadline = time.monotonic() + 10
        while True:
            with sqlite3.connect(self.database) as conn:
                rows = conn.execute('SELECT transport, routing_trace_json FROM request_logs WHERE routing_trace_json IS NOT NULL').fetchall()
            recovered = [(transport, json.loads(raw)) for transport, raw in rows
                         if json.loads(raw).get('encrypted_content_recovery', {}).get('retries') == 1]
            if {'http', 'ws_native', 'ws_http_bridge'} <= {transport for transport, _ in recovered}:
                break
            assert time.monotonic() < deadline, (rows, recovered)
            time.sleep(.1)
        for _, trace in recovered:
            assert 2 <= trace['attempts_sent'] <= 3
            assert any(attempt['error_type'] == 'invalid_encrypted_content' for attempt in trace['attempts'])
        self.passed('request logs retain rejected attempt, recovery counts and final result on every transport')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-build', action='store_true')
    parser.add_argument('--output', type=Path, help='Write the regression report as JSON')
    args = parser.parse_args()
    if not args.skip_build:
        subprocess.run(['cargo', 'build', '--manifest-path', 'backend/Cargo.toml', '--locked'], cwd=ROOT, check=True)
    mock = ThreadingHTTPServer(('127.0.0.1', 0), Mock)
    mock.daemon_threads = True
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix='little-gate-encrypted-recovery-') as directory:
        port = free_port()
        database = Path(directory) / 'gateway.sqlite'
        env = os.environ | {'ADMIN_TOKEN': ADMIN, 'MASTER_KEY': ADMIN, 'PRICE_SYNC_ENABLED': 'false',
              'DB_DSN': f'sqlite://{database}', 'LISTEN_ADDR': f'127.0.0.1:{port}',
              'STATS_FLUSH_INTERVAL_MS': '100', 'UPSTREAM_REQUEST_TIMEOUT_MS': '15000',
              'UPSTREAM_CACHE_TTL_MS': '1', 'UPSTREAM_CACHE_STALE_GRACE_MS': '0',
              'REQUEST_LOG_ARCHIVE_ENABLED': 'false'}
        test = Regression(port, mock.server_port, database)
        process = None
        with open(Path(directory) / 'gateway.log', 'w+') as log:
            def start_gateway():
                running = subprocess.Popen([str(ROOT / 'backend/target/debug/backend')], cwd=ROOT, env=env, stdout=log, stderr=log)
                deadline = time.monotonic() + 30
                while True:
                    try:
                        test.setting_view()
                        return running
                    except (OSError, http.client.HTTPException):
                        if running.poll() is not None or time.monotonic() > deadline:
                            running.terminate()
                            running.wait(timeout=10)
                            raise
                        time.sleep(.1)
            try:
                process = start_gateway()
                test.check_http()
                test.check_ws(test.normal, 'ws-native')
                bridge = test.provider('bridge', 'bridge')
                test.check_ws(bridge, 'ws-bridge')
                oauth = test.provider('oauth')
                test.enable_oauth(oauth)
                test.route('oauth', [oauth])
                token = test.client([oauth])
                for stream in (False, True):
                    start = len(Mock.hits)
                    status, raw = test.call({**test.payload('oauth', 'oauth-' + str(stream)), 'stream': stream}, token)
                    assert status == 200 and len(Mock.hits) - start == 2, (status, raw)
                    assert Mock.hits[-1]['account'] == 'offline-account'
                    assert Mock.hits[-1]['payload']['store'] is False
                    assert b'invalid_encrypted_content' not in raw
                test.passed('OAuth normalization, same-account retry, SSE streaming and SSE-to-JSON aggregation')
                test.check_ws(oauth, 'oauth-native')
                test.check_logs()
                process.terminate()
                process.wait(timeout=10)
                process = start_gateway()
                assert test.setting_view()['value'] is True
                # The setting persists; process-local ciphertext digests intentionally do not.
                start = len(Mock.hits)
                assert test.call(test.payload('normal', 'first'))[0] == 200 and len(Mock.hits) - start == 2
                test.passed('restart persists opt-in setting and safely rebuilds transient digest cache')
                report = {'passed': len(test.results), 'checks': test.results, 'upstream_requests': len(Mock.hits),
                          'real_upstream_requests': 0}
                if args.output:
                    args.output.parent.mkdir(parents=True, exist_ok=True)
                    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
                print(json.dumps(report, ensure_ascii=False, indent=2))
            except Exception:
                log.flush()
                log.seek(0)
                print(log.read()[-10000:])
                raise
            finally:
                if process and process.poll() is None:
                    process.terminate()
                    process.wait(timeout=10)
                mock.shutdown()
                mock.server_close()


if __name__ == '__main__':
    main()
