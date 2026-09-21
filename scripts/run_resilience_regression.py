#!/usr/bin/env python3
"""Offline request-count, cooldown, backoff, cancellation and atomic-config regressions.

Only the standard library is required. Every credential and service is synthetic;
the gateway runs on an ephemeral port with a disposable SQLite database.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
from email.utils import formatdate
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
ADMIN = 'resilience-test-admin'


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
            pass  # Client-disconnect scenarios deliberately close live sockets.

    def note(self, kind):
        with self.lock:
            self.hits.append((time.monotonic(), self.path, kind, self.headers.get('Authorization')))

    def respond(self, status, data, headers=None):
        raw = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self.note('connect')
        if '/oauth-replay-' in self.path:
            return self.oauth_error()
        if '/limited/' in self.path:
            return self.respond(429, {'error': {'message': 'limited'}}, {'Retry-After': formatdate(time.time() + 3600, usegmt=True)})
        if '/bridge/' in self.path:
            return self.respond(404, {'error': {'message': 'no native websocket'}})
        if '/fail' in self.path:
            return self.respond(503, {'error': {'message': 'down'}})
        self.send_response(101)
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        accept = base64.b64encode(hashlib.sha1((self.headers['Sec-WebSocket-Key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        self.send_header('Sec-WebSocket-Accept', accept)
        self.end_headers()
        try:
            while True:
                opcode, _ = read_frame(self.rfile)
                if opcode == 8:
                    return
                if opcode != 1:
                    continue
                self.note('turn')
                error = {'type': 'response.failed', 'response': {'status': 'failed', 'error': {'code': 'server_error'}}}
                if '/ws-output/' in self.path:
                    self.wfile.write(frame_bytes(json.dumps({'type': 'response.output_text.delta', 'delta': 'started'})))
                if '/ws-error/' in self.path or '/ws-output/' in self.path:
                    self.wfile.write(frame_bytes(json.dumps(error)))
                else:
                    self.wfile.write(frame_bytes(json.dumps({'type': 'response.completed', 'response': {'status': 'completed', 'usage': {'input_tokens': 1, 'output_tokens': 1}}})))
                self.wfile.flush()
        except (EOFError, ConnectionError, OSError):
            pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        self.note('post')
        if '/oauth-replay-' in self.path:
            return self.oauth_error()
        if '/limited/' in self.path:
            return self.respond(429, {'error': {'message': 'limited'}}, {'Retry-After': formatdate(time.time() + 3600, usegmt=True)})
        if '/auth/' in self.path and self.headers.get('Authorization') != 'Bearer good-key':
            return self.respond(401, {'error': {'type': 'invalid_api_key'}})
        if '/model-error/' in self.path:
            return self.respond(502, {'error': {'type': 'model_not_found', 'message': 'unknown model'}})
        if '/usage-error/' in self.path:
            return self.respond(503, {'error': {'type': 'server_error'}, 'usage': {'prompt_tokens': 1, 'completion_tokens': 1}})
        if '/sse-' in self.path:
            error = {'type': 'response.failed', 'response': {'status': 'failed', 'error': {'code': 'server_error'}}}
            events = []
            if '/sse-output/' in self.path:
                events.append({'type': 'response.output_text.delta', 'delta': 'started'})
            events.append(error)
            raw = ''.join('data: ' + json.dumps(event) + '\n\n' for event in events).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if '/fail' in self.path or '/bridge/' in self.path:
            return self.respond(503, {'error': {'type': 'server_error', 'message': 'down'}})
        self.respond(200, {'id': 'synthetic', 'object': 'chat.completion', 'choices': [{'message': {'role': 'assistant', 'content': 'ok'}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1}})

    def oauth_error(self):
        with self.lock:
            count = sum(hit[1] == self.path for hit in self.hits)
        self.respond(401 if count == 1 else 503, {'error': {'message': 'synthetic rejection'}})


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Regression:
    def __init__(self, gateway_port, mock_port, db):
        self.port = gateway_port
        self.mock_port = mock_port
        self.db = db
        self.token = self.api('POST', '/api-keys', {'name': 'test', 'enabled': True, 'log_enabled': True})['api_key']

    def http(self, method, path, data=None, token=ADMIN):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        try:
            conn.request(method, path, None if data is None else json.dumps(data), {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def api(self, method, path, data=None):
        status, _, body = self.http(method, '/api/v1' + path, data)
        assert status < 300, (path, status, body)
        return json.loads(body) if body else None

    def provider(self, name, paths, keys=('good-key',), priority=10, max_attempts=10, strategy='ordered'):
        return self.api('POST', '/providers', {
            'name': name, 'provider_type': 'openai', 'priority': priority, 'max_attempts': max_attempts,
            'circuit_breaker_failure_threshold': 100, 'key_selection_strategy': strategy,
            'websocket_enabled': True, 'beta_features': ['responses-http-to-ws'],
            'endpoints': [{'name': path, 'base_url': f'http://127.0.0.1:{self.mock_port}/{path}/v1', 'priority': index * 10} for index, path in enumerate(paths)],
            'keys': [{'name': 'key ' + str(index), 'secret': secret, 'priority': index * 10} for index, secret in enumerate(keys)],
        })

    def route(self, model, providers):
        self.api('PUT', '/routes/' + model, {'enabled': True, 'provider_ids': [provider['id'] for provider in providers]})

    def call(self, model, responses=False):
        data = {'model': model, 'messages': [{'role': 'user', 'content': 'test'}]}
        if responses:
            data = {'model': model, 'input': 'test', 'stream': True}
        return self.http('POST', '/v1/responses' if responses else '/v1/chat/completions', data, self.token)

    def hits(self, since):
        return Mock.hits[since:]

    def check_http(self):
        single = self.provider('single', ['fail-single'])
        self.route('single', [single])
        start = len(Mock.hits)
        status, headers, _ = self.call('single')
        assert status == 503 and int(headers['retry-after']) >= 29, (status, headers)
        with ThreadPoolExecutor(max_workers=8) as pool:
            assert all(status == 503 for status, _, _ in pool.map(lambda _: self.call('single'), range(16)))
        before = time.monotonic()
        status, headers, body = self.call('single')
        assert status == 503 and int(headers['retry-after']) >= 29, (status, headers, body)
        assert time.monotonic() - before < .5 and len(self.hits(start)) == 1

        many = self.provider('many', ['fail-1', 'fail-2', 'fail-3', 'fail-4'])
        self.route('many', [many])
        start = len(Mock.hits)
        assert self.call('many')[0] == 503
        hits = self.hits(start)
        assert len(hits) == 3, hits
        attempt_count = len(hits)
        gaps = [hits[i + 1][0] - hits[i][0] for i in range(2)]
        assert gaps[0] >= .49 and gaps[1] >= .99, gaps

        sibling = self.provider('siblings', ['fail-sibling', 'healthy'])
        self.route('siblings', [sibling])
        start = len(Mock.hits)
        assert self.call('siblings')[0] == 200
        assert self.call('siblings')[0] == 200
        hits = self.hits(start)
        assert len(hits) == 3 and sum('/fail-' in hit[1] for hit in hits) == 1, hits

        auth = self.provider('auth', ['auth'], ('bad-key', 'good-key'))
        self.route('auth', [auth])
        start = len(Mock.hits)
        assert self.call('auth')[0] == 200
        assert self.call('auth')[0] == 200
        assert len(self.hits(start)) == 3
        assert self.hits(start)[0][3] == 'Bearer bad-key'
        assert all(hit[3] == 'Bearer good-key' for hit in self.hits(start)[1:])

        for paths, keys in [(['auth', 'healthy'], ('bad-key', 'good-key')),
                            (['fail-combination', 'healthy'], ('good-key', 'other-key'))]:
            name = 'combination-' + paths[0]
            combined = self.provider(name, paths, keys, max_attempts=2)
            self.route(name, [combined])
            start = len(Mock.hits)
            assert self.call(name)[0] == 200
            hits = self.hits(start)
            assert len(hits) == 2, hits
            if paths[0] == 'auth':
                assert all('/auth/' in hit[1] for hit in hits), hits
            else:
                assert hits[0][3] == hits[1][3] == 'Bearer good-key', hits

        rotation = self.provider('rotation', ['healthy'], ('first', 'second'), strategy='round_robin')
        self.route('rotation', [rotation])
        start = len(Mock.hits)
        for _ in range(4):
            assert self.call('rotation')[0] == 200
        assert [hit[3] for hit in self.hits(start)] == ['Bearer first', 'Bearer second'] * 2

        once = self.provider('one-attempt', ['fail-once', 'healthy'], max_attempts=1)
        self.route('one-attempt', [once])
        start = len(Mock.hits)
        status, _, body = self.call('one-attempt')
        assert status == 503 and json.loads(body)['error']['message'] == 'down', (status, body)
        assert len(self.hits(start)) == 1

        limit = self.provider('limited', ['limited'])
        self.route('limited', [limit])
        start = len(Mock.hits)
        assert self.call('limited')[0] == 429
        self.api('POST', f'/providers/{limit["id"]}/circuit/reset', {})
        status, headers, _ = self.call('limited')
        assert status == 503 and int(headers['retry-after']) >= 3590, (status, headers)
        assert len(self.hits(start)) == 1

        model = self.provider('model-scoped', ['model-error'])
        self.route('model-scoped', [model])
        assert self.call('model-scoped')[0] == 502
        endpoint = self.api('GET', f'/providers/{model["id"]}/endpoints')[0]
        assert endpoint['health']['available'], endpoint

        usage = self.provider('usage', ['usage-error', 'healthy'])
        self.route('usage', [usage])
        start = len(Mock.hits)
        assert self.call('usage')[0] == 503
        assert len(self.hits(start)) == 1, self.hits(start)

        for path, expected in [('sse-error', 2), ('sse-output', 1)]:
            provider = self.provider(path, [path, 'healthy'])
            self.route(path, [provider])
            start = len(Mock.hits)
            self.call(path, responses=True)
            assert len(self.hits(start)) == expected, self.hits(start)
        return {'attempt_limit': attempt_count, 'retry_gaps_seconds': [round(gap, 3) for gap in gaps], 'cooldown_seconds': 30, 'retry_after_seconds': int(headers['retry-after'])}

    def check_ws(self):
        for mode in ('fail-ws', 'bridge', 'ws-error', 'ws-output', 'limited'):
            providers = [self.provider(f'{mode}-{i}', [mode], priority=i * 10) for i in range(4)]
            self.route(mode, providers)
            start = len(Mock.hits)
            client = WsClient(self.port, self.token)
            try:
                client.send({'model': mode})
                result = client.complete()
                assert result['type'] in ('error', 'response.failed'), result
            finally:
                client.close()
            hits = self.hits(start)
            attempts = [hit for hit in hits if hit[2] != 'turn']
            assert 1 <= len(attempts) <= 3, hits
            if mode == 'ws-output':
                assert len(attempts) == 1, hits
            if mode == 'limited':
                for provider in providers[:3]:
                    key = self.api('GET', f'/providers/{provider["id"]}/keys')[0]
                    assert key['quota']['cooldown_until_ms'] - time.time() * 1000 > 3590_000, key

    def check_disconnect(self):
        for websocket in (False, True):
            mode = 'ws-cancel' if websocket else 'http-cancel'
            providers = [self.provider(f'{mode}-{i}', ['fail-cancel'], priority=i * 10) for i in range(4)]
            self.route(mode, providers)
            start = len(Mock.hits)
            if websocket:
                client = WsClient(self.port, self.token)
                client.send({'model': mode})
            else:
                client = socket.create_connection(('127.0.0.1', self.port), timeout=5)
                body = json.dumps({'model': mode, 'messages': []}).encode()
                client.sendall((f'POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {self.token}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n').encode() + body)
            deadline = time.monotonic() + 3
            while len(Mock.hits) == start and time.monotonic() < deadline:
                time.sleep(.01)
            assert len(Mock.hits) > start
            client.close()
            time.sleep(1.4)
            assert len(self.hits(start)) == 1, (mode, self.hits(start))

    def check_oauth_budget(self):
        for websocket in (False, True):
            for preceding in (1, 2):
                name = f'oauth-replay-{websocket}-{preceding}'
                providers = [self.provider(f'{name}-failure-{i}', [f'fail-{name}-{i}'], priority=i * 10)
                             for i in range(preceding)]
                oauth = self.provider(name, [name], priority=preceding * 10)
                key_id = oauth['key_ids'][0]
                credential = json.dumps({'refresh_token': 'offline-refresh', 'id_token': '', 'account_id': name, 'email': 'test@example.invalid'})
                carrier = self.api('POST', f'/providers/{oauth["id"]}/keys', {'name': 'envelope', 'secret': credential})['id']
                with sqlite3.connect(self.db) as conn:
                    encrypted = conn.execute('SELECT secret_enc FROM upstream_keys WHERE id=?', (carrier,)).fetchone()[0]
                    now = int(time.time() * 1000)
                    # Simulate another refresher holding a lease with a valid cached token.
                    # This exercises the 401 replay path without contacting a real OAuth server.
                    conn.execute('INSERT INTO codex_oauth_accounts (upstream_key_id,provider_id,account_hash,credentials_enc,token_expires_at_ms,auth_status,quota_checked_at_ms,refresh_lease_owner,refresh_lease_until_ms,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                                 (key_id, oauth['id'], name, encrypted, now + 86400000, 'active', now, 'offline-refresher', now + 60000, now, now))
                self.api('DELETE', f'/keys/{carrier}')
                self.api('PATCH', f'/providers/{oauth["id"]}', {'provider_type': 'openai_codex_oauth'})
                self.route(name, providers + [oauth])
                start = len(Mock.hits)
                if websocket:
                    client = WsClient(self.port, self.token)
                    try:
                        client.send({'model': name})
                        client.complete()
                    finally:
                        client.close()
                else:
                    result = self.call(name, responses=True)
                    assert result[0] >= 400
                hits = self.hits(start)
                assert len(hits) == 3, (name, hits, None if websocket else result)
                assert sum(f'/{name}/' in hit[1] for hit in hits) == 3 - preceding, hits
                with sqlite3.connect(self.db) as conn:
                    status = conn.execute('SELECT auth_status FROM codex_oauth_accounts WHERE upstream_key_id=?', (key_id,)).fetchone()[0]
                assert status == 'active', (name, status)

    def check_atomic(self):
        before = self.api('GET', '/providers')
        status, _, _ = self.http('POST', '/api/v1/providers', {'name': 'bad-bundle', 'provider_type': 'openai', 'endpoints': [{'name': 'valid', 'base_url': 'https://example.invalid'}], 'keys': [{'name': 'empty', 'secret': ''}]})
        assert status == 400
        assert len(self.api('GET', '/providers')) == len(before)
        bundle = self.provider('atomic', ['healthy', 'healthy-2'])
        assert len(bundle['endpoint_ids']) == 2 and len(bundle['key_ids']) == 1
        status, _, _ = self.http('PUT', f'/api/v1/providers/{bundle["id"]}/endpoints/order', {'ids': [bundle['endpoint_ids'][1], 999999]})
        assert status == 409
        endpoints = self.api('GET', f'/providers/{bundle["id"]}/endpoints')
        assert [item['id'] for item in endpoints] == bundle['endpoint_ids']

    def check_attempt_logs(self):
        deadline = time.monotonic() + 3
        while True:
            rows = self.api('GET', '/logs?page=1&page_size=200')
            single = [row for row in rows if row.get('model') == 'single']
            many = [row for row in rows if row.get('model') == 'many']
            if len(single) == 18 and len(many) == 1:
                break
            assert time.monotonic() < deadline, (len(single), len(many))
            time.sleep(.1)
        assert sorted(row['routing_trace']['attempts_sent'] for row in single) == [0] * 17 + [1]
        trace = many[0]['routing_trace']
        assert trace['attempts_sent'] == len(trace['attempts']) == trace['attempt_limit'] == 3, trace
        assert trace['backoff_ms'] >= 1490, trace


def main():
    mock = ThreadingHTTPServer(('127.0.0.1', 0), Mock)
    mock.daemon_threads = True
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    port = free_port()
    with tempfile.TemporaryDirectory(prefix='little-gate-resilience-') as directory:
        env = os.environ | {'ADMIN_TOKEN': ADMIN, 'MASTER_KEY': ADMIN, 'DB_DSN': f'sqlite://{directory}/test.sqlite', 'LISTEN_ADDR': f'127.0.0.1:{port}', 'STATS_FLUSH_INTERVAL_MS': '100', 'UPSTREAM_REQUEST_TIMEOUT_MS': '10000', 'REQUEST_LOG_ARCHIVE_ENABLED': 'false'}
        with open(Path(directory) / 'gateway.log', 'w+') as log:
            process = subprocess.Popen([str(ROOT / 'backend/target/debug/backend')], cwd=ROOT, env=env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 20
                while True:
                    try:
                        test = Regression(port, mock.server_port, Path(directory) / 'test.sqlite')
                        break
                    except (OSError, http.client.HTTPException):
                        if time.monotonic() > deadline:
                            raise
                        time.sleep(.1)
                test.check_atomic()
                http_result = test.check_http()
                test.check_ws()
                test.check_oauth_budget()
                test.check_disconnect()
                test.check_attempt_logs()
                print(json.dumps({'http': http_result, 'websocket': 'passed', 'oauth_replay_budget': 'passed', 'disconnect': 'passed', 'atomic_configuration': 'passed', 'attempt_logs': 'passed'}, indent=2))
            except Exception:
                log.flush()
                log.seek(0)
                print(log.read()[-6000:])
                raise
            finally:
                process.terminate()
                process.wait(timeout=10)
                mock.shutdown()


if __name__ == '__main__':
    main()
