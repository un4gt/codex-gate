#!/usr/bin/env python3
"""Isolated, offline HTTP/SSE/WebSocket OAuth metering and admission regressions.

Uses only the Python standard library and a temporary database. All credentials
and upstream responses are synthetic; no OpenAI service is contacted.
"""
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import struct
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
MODEL = 'gpt-6-astra'
ADMIN = 'offline-regression-admin'


def read_exact(stream, size):
    result = bytearray()
    while len(result) < size:
        part = stream.read(size - len(result))
        if not part:
            raise EOFError('websocket closed')
        result.extend(part)
    return bytes(result)


def read_frame(stream):
    first, second = read_exact(stream, 2)
    length = second & 127
    if length == 126:
        length = struct.unpack('!H', read_exact(stream, 2))[0]
    elif length == 127:
        length = struct.unpack('!Q', read_exact(stream, 8))[0]
    mask = read_exact(stream, 4) if second & 128 else None
    body = read_exact(stream, length)
    if mask:
        body = bytes(value ^ mask[index % 4] for index, value in enumerate(body))
    return first & 15, body


def frame_bytes(payload, masked=False, opcode=1):
    data = payload.encode() if isinstance(payload, str) else payload
    flag = 128 if masked else 0
    if len(data) < 126:
        prefix = bytes([128 | opcode, flag | len(data)])
    elif len(data) < 65536:
        prefix = bytes([128 | opcode, flag | 126]) + struct.pack('!H', len(data))
    else:
        prefix = bytes([128 | opcode, flag | 127]) + struct.pack('!Q', len(data))
    if masked:
        mask = os.urandom(4)
        return prefix + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(data))
    return prefix + data


class WsClient:
    def __init__(self, port, token):
        self.socket = socket.create_connection(('127.0.0.1', port), timeout=40)
        self.stream = self.socket.makefile('rb')
        key = base64.b64encode(os.urandom(16)).decode()
        self.socket.sendall((f'GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n'
                             f'Authorization: Bearer {token}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                             f'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\n\r\n').encode())
        status = self.stream.readline()
        assert b'101' in status, status
        while self.stream.readline() != b'\r\n':
            pass

    def send(self, payload):
        self.socket.sendall(frame_bytes(json.dumps({'type': 'response.create', 'model': MODEL, 'input': 'test', **payload}), True))

    def receive(self):
        while True:
            opcode, body = read_frame(self.stream)
            if opcode == 1:
                return json.loads(body)
            if opcode == 9:
                self.socket.sendall(frame_bytes(body, True, 10))
            if opcode == 8:
                raise EOFError('websocket close frame')

    def complete(self):
        while True:
            value = self.receive()
            if value.get('type') in ('response.done', 'response.completed', 'response.failed', 'error'):
                return value

    def close(self):
        self.socket.shutdown(socket.SHUT_RDWR)
        self.stream.close()
        self.socket.close()


class Mock(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    seen = []

    def log_message(self, *_):
        pass

    def json(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def events(self, payload):
        Mock.seen.append(payload)
        case = payload.get('test_case', '')
        if case == 'preflight_error':
            yield {'type': 'response.failed', 'response': {'status': 'failed', 'service_tier': 'default', 'error': {'code': 'server_error'}}}
            return
        if case != 'terminal_only':
            yield {'type': 'response.output_text.delta', 'delta': 'hello'}
        if case == 'disconnect':
            time.sleep(0.8)
        if case == 'deadline':
            time.sleep(32)
        response = {'id': 'resp_mock', 'model': MODEL, 'status': 'completed', 'output': []}
        if case != 'missing':
            response['usage'] = {'input_tokens': 0 if case == 'zero' else 100, 'output_tokens': 0 if case == 'zero' else 12}
        if case != 'missing_tier':
            response['service_tier'] = payload.get('actual_tier', 'default')
        if case == 'large':
            response['output'] = [{'text': 'x' * (256 * 1024)}]
        if case == 'failed':
            response['status'] = 'failed'
            response['error'] = {'code': 'mock_failure', 'message': 'synthetic failure with usage'}
        yield {'type': 'response.done', 'response': response}

    def do_GET(self):
        if self.headers.get('Upgrade', '').lower() == 'websocket':
            if self.path.startswith('/bridge/'):
                self.json({'error': 'websocket unsupported'}, 404)
                return
            accept = base64.b64encode(hashlib.sha1((self.headers['Sec-WebSocket-Key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            self.send_response(101)
            self.send_header('Upgrade', 'websocket')
            self.send_header('Connection', 'Upgrade')
            self.send_header('Sec-WebSocket-Accept', accept)
            self.end_headers()
            try:
                while True:
                    opcode, body = read_frame(self.rfile)
                    if opcode == 8:
                        return
                    if opcode != 1:
                        continue
                    events = [{'type': 'response.failed', 'response': {'status': 'failed', 'error': {'code': 'server_error'}}}] if self.path.startswith('/retry/') else self.events(json.loads(body))
                    for event in events:
                        self.wfile.write(frame_bytes(json.dumps(event)))
                        self.wfile.flush()
            except (EOFError, OSError):
                return
        self.json({'object': 'list', 'data': [{'id': MODEL}, {'id': 'gpt-4.1'}]})

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path.startswith('/retry/'):
            self.json({'error': {'code': 'server_error'}, 'service_tier': 'priority'}, 503)
            return
        if payload.get('test_case') == 'http_error_usage':
            response = list(self.events(payload))[-1]['response']
            response.update(status='failed', error={'code': 'http_failure', 'message': 'failed with usage'})
            self.json(response, 502)
            return
        if not payload.get('stream'):
            self.json(list(self.events(payload))[-1]['response'])
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()
        try:
            for event in self.events(payload):
                # Deliberately no event: line; terminal frame has no newline at EOF.
                data = ('data: ' + json.dumps(event) + ('\r\n\r\n' if event['type'].endswith('delta') or payload.get('test_case') == 'terminal_hold' else '')).encode()
                for offset in range(0, len(data), 8191):
                    chunk = data[offset:offset + 8191]
                    self.wfile.write(f'{len(chunk):x}\r\n'.encode() + chunk + b'\r\n')
                    self.wfile.flush()
            if payload.get('test_case') == 'terminal_hold':
                time.sleep(32)
            self.wfile.write(b'0\r\n\r\n')
            self.wfile.flush()
        except OSError:
            pass


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Regression:
    def __init__(self, port, db, mock_port):
        self.port, self.db, self.mock_port = port, db, mock_port
        self.token = ADMIN

    def request(self, method, path, payload=None, token=ADMIN):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=40)
        conn.request(method, path, body=None if payload is None else json.dumps(payload), headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'})
        response = conn.getresponse()
        raw = response.read()
        status = response.status
        conn.close()
        return status, raw

    def api(self, method, path, payload=None):
        status, raw = self.request(method, '/api/v1' + path, payload)
        assert status < 300, (path, status, raw)
        return json.loads(raw) if raw else None

    def logs(self):
        with sqlite3.connect(self.db) as conn:
            conn.row_factory = sqlite3.Row
            return [dict(row) for row in conn.execute("SELECT * FROM request_logs WHERE span_kind IN ('request', 'ws_turn') ORDER BY rowid")]

    def settled(self, before, expected=1, timeout=8):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            rows = self.logs()[before:]
            if len(rows) >= expected:
                assert len(rows) == expected, ('duplicate settlement', rows)
                return rows
            time.sleep(0.05)
        raise AssertionError(('missing settlement', self.logs()[before:]))

    def bootstrap(self):
        self.provider = self.api('POST', '/providers', {'name': 'offline-metering', 'providerType': 'openai', 'websocketEnabled': True, 'betaFeatures': ['responses-http-to-ws'], 'maxConcurrency': 1})['id']
        self.endpoint = self.api('POST', f'/providers/{self.provider}/endpoints', {'name': 'mock', 'baseUrl': f'http://127.0.0.1:{self.mock_port}/native/v1'})['id']
        self.key = self.api('POST', f'/providers/{self.provider}/keys', {'name': 'account-a', 'secret': 'synthetic-access'})['id']
        self.token = self.api('POST', '/api-keys', {'name': 'client', 'logEnabled': True})['api_key']
        self.api('POST', f'/providers/{self.provider}/models/sync', {})

    def check_http(self, case, stream=True):
        before = len(self.logs())
        status, body = self.request('POST', '/v1/responses', {'model': MODEL, 'input': 'test', 'stream': stream, 'service_tier': 'fast', 'test_case': case}, self.token)
        assert status == 200, (status, body)
        row = self.settled(before)[0]
        assert bool(row['usage_observed']) == (case != 'missing'), row
        assert row['input_tokens'] == (0 if case in ('zero', 'missing') else 100), row
        assert row['service_tier'] == (None if case == 'missing_tier' else 'default'), row
        assert row['requested_service_tier'] == 'fast', row
        assert row['upstream_service_tier'] == ('priority' if getattr(self, 'oauth', False) else 'fast'), row
        if case == 'failed':
            assert row['error_type'] == 'mock_failure', row
        return row

    def check_failed_preflight_tier(self):
        before = len(self.logs())
        status, _ = self.request('POST', '/v1/responses', {'model': MODEL, 'input': 'test', 'stream': True, 'service_tier': 'fast', 'test_case': 'preflight_error'}, self.token)
        assert status == 502
        row = self.settled(before)[0]
        assert row['requested_service_tier'] == 'fast' and row['service_tier'] == 'default', row
        assert not row['usage_observed'], row

    def check_ws(self, transport="ws_native"):
        before = len(self.logs())
        ws = WsClient(self.port, self.token)
        ws.send({'service_tier': 'fast', 'actual_tier': 'default'})
        event = ws.complete()
        assert event['type'] == 'response.done', event
        self.settled(before)
        ws.send({'service_tier': 'priority', 'actual_tier': 'priority'})
        event = ws.complete()
        assert event['type'] == 'response.done', event
        rows = self.settled(before, 2)
        assert [row['requested_service_tier'] for row in rows] == ['fast', 'priority'], rows
        assert [row['service_tier'] for row in rows] == ['default', 'priority'], rows
        assert [row['upstream_service_tier'] for row in rows] == ['priority' if getattr(self, 'oauth', False) else 'fast', 'priority'], rows
        assert all(row['transport'] == transport for row in rows), rows
        assert all(row['input_tokens'] == 100 for row in rows), rows
        # Existing connection must reject next turn after account disable.
        self.api('PATCH', f'/keys/{self.key}', {'enabled': False})
        ws.send({})
        error = ws.receive()
        assert error['type'] == 'error' and 'reconnect' in json.dumps(error), error
        ws.close()
        self.settled(before, 3)
        self.api('PATCH', f'/keys/{self.key}', {'enabled': True})
        before = len(self.logs())
        ws = WsClient(self.port, self.token)
        ws.send({})
        ws.complete()
        self.settled(before)
        restrictions = self.api('POST', f'/keys/{self.key}/models', {'models': ['gpt-4.1']})
        ws.send({})
        error = ws.receive()
        assert error['type'] == 'error' and 'reconnect' in json.dumps(error), error
        ws.close()
        self.settled(before, 2)
        for model in restrictions:
            self.api('DELETE', f'/key-models/{model["id"]}')

    def check_disconnect_after_terminal(self):
        before = len(self.logs())
        client = http.client.HTTPConnection('127.0.0.1', self.port, timeout=8)
        client.request('POST', '/v1/responses', json.dumps({'model': MODEL, 'input': 'test', 'stream': True, 'test_case': 'terminal_hold'}), {'Content-Type': 'application/json', 'Authorization': f'Bearer {self.token}'})
        response = client.getresponse()
        while b'response.done' not in response.readline():
            pass
        client.sock.shutdown(socket.SHUT_RDWR)
        response.close()
        client.close()
        # A terminal event seen before disconnect must settle immediately, without waiting 30 seconds.
        row = self.settled(before, timeout=5)[0]
        assert row['usage_observed'] and row['input_tokens'] == 100, row
        assert row['error_type'] == 'client_disconnected', row

    def check_disconnect(self, websocket=False, deadline=False):
        before = len(self.logs())
        case = 'deadline' if deadline else 'disconnect'
        if websocket:
            client = WsClient(self.port, self.token)
            client.send({'service_tier': 'fast', 'test_case': case})
            assert client.receive()['type'].endswith('delta')
            client.close()
        else:
            client = http.client.HTTPConnection('127.0.0.1', self.port, timeout=40)
            client.request('POST', '/v1/responses', json.dumps({'model': MODEL, 'input': 'test', 'stream': True, 'service_tier': 'fast', 'test_case': case}), {'Content-Type': 'application/json', 'Authorization': f'Bearer {self.token}'})
            response = client.getresponse()
            assert response.status == 200
            assert response.readline().startswith(b'data:')
            client.sock.shutdown(socket.SHUT_RDWR)
            response.close()
            client.close()
        started = time.monotonic()
        row = self.settled(before, timeout=35 if deadline else 8)[0]
        assert row['error_type'] == 'client_disconnected', row
        assert bool(row['usage_observed']) == (not deadline), row
        assert row['duration_ms'] < 700, row
        if deadline:
            assert 28 <= time.monotonic() - started <= 34
        else:
            assert row['input_tokens'] == 100 and row['service_tier'] == 'default', row
        time.sleep(0.15)
        assert len(self.logs()) == before + 1, 'settled twice'
        provider = next(p for p in self.api('GET', '/providers') if p['id'] == self.provider)
        assert provider['runtime']['in_flight'] == 0, provider
        assert provider['runtime']['state'] == 'closed', provider

    def check_availability(self):
        def provider():
            return next(item for item in self.api('GET', '/providers') if item['id'] == self.provider)
        assert provider()['routing_availability']['available']
        self.api('PATCH', f'/keys/{self.key}', {'enabled': False})
        assert provider()['enabled'] and provider()['routing_availability']['reason'] == 'no_available_accounts'
        self.api('PATCH', f'/keys/{self.key}', {'enabled': True})
        assert provider()['routing_availability']['available']
        self.api('PATCH', f'/providers/{self.provider}', {'enabled': False})
        assert provider()['routing_availability']['reason'] == 'provider_disabled'
        self.api('PATCH', f'/providers/{self.provider}', {'enabled': True})
        if not getattr(self, 'oauth', False):
            second = self.api('POST', f'/providers/{self.provider}/keys', {'name': 'second-account', 'secret': 'synthetic-access'})['id']
            self.api('PATCH', f'/keys/{self.key}', {'enabled': False})
            assert provider()['routing_availability']['available'], 'one enabled account keeps the provider available'
            self.api('PATCH', f'/keys/{self.key}', {'enabled': True})
            self.api('DELETE', f'/keys/{second}')
        models = self.api('POST', f'/keys/{self.key}/models', {'models': [MODEL]})
        item = models[0]
        alias = self.api('POST', '/model-aliases', {'name': 'astra-alias'})['id']
        self.api('POST', f'/model-aliases/{alias}/targets', {'providerId': self.provider, 'upstreamModel': MODEL})
        before = len(self.logs())
        status, _ = self.request('POST', '/v1/responses', {'model': 'astra-alias', 'input': 'allowed by real name'}, self.token)
        assert status == 200
        assert self.settled(before)[0]['input_tokens'] == 100
        self.api('DELETE', f'/model-aliases/{alias}')
        self.api('PATCH', f'/key-models/{item["id"]}', {'enabled': False})
        assert not provider()['routing_availability']['available']
        self.api('PATCH', f'/key-models/{item["id"]}', {'enabled': True})
        assert provider()['routing_availability']['available']
        before = len(self.logs())
        status, _ = self.request('POST', '/v1/responses', {'model': 'gpt-4.1', 'input': 'denied'}, self.token)
        assert status >= 400
        self.settled(before)
        self.api('DELETE', f'/key-models/{item["id"]}')

    def check_retry_tiers(self):
        other = self.api('POST', '/providers', {'name': 'retry-final', 'providerType': 'openai', 'websocketEnabled': True, 'priority': 200,
                        'requestOverrides': {'headers': [], 'body': [{'scope': 'responses', 'operation': 'set', 'path': 'service_tier', 'value': 'priority'}]}})['id']
        self.api('POST', f'/providers/{other}/endpoints', {'name': 'final', 'baseUrl': f'http://127.0.0.1:{self.mock_port}/native/v1'})
        self.api('POST', f'/providers/{other}/keys', {'name': 'final-key', 'secret': 'offline'})
        self.api('POST', f'/providers/{other}/models/sync', {})
        self.api('PATCH', f'/endpoints/{self.endpoint}', {'baseUrl': f'http://127.0.0.1:{self.mock_port}/retry/v1'})
        before = len(self.logs())
        status, _ = self.request('POST', '/v1/responses', {'model': MODEL, 'input': 'retry', 'service_tier': 'fast'}, self.token)
        assert status == 200
        row = self.settled(before)[0]
        assert (row['provider_id'], row['requested_service_tier'], row['upstream_service_tier'], row['service_tier']) == (other, 'fast', 'priority', 'default'), row
        before = len(self.logs())
        metrics_before = self.api('GET', '/stats/live')['metrics']['responses']
        ws = WsClient(self.port, self.token)
        ws.send({'service_tier': 'fast'})
        ws.complete()
        row = self.settled(before)[0]
        assert (row['provider_id'], row['upstream_service_tier'], row['service_tier']) == (other, 'priority', 'default'), row
        metrics_after = self.api('GET', '/stats/live')['metrics']['responses']
        assert sum(metrics_after[k] - metrics_before[k] for k in ['ok_total', 'error_total']) == 1, 'retry double-counted request metrics'
        ws.close()
        self.api('DELETE', f'/providers/{other}')
        self.api('PATCH', f'/endpoints/{self.endpoint}', {'baseUrl': f'http://127.0.0.1:{self.mock_port}/native/v1'})
        self.api('POST', f'/providers/{self.provider}/circuit/reset', {})
        # A successful probe clears consecutive endpoint failures from the retry cases.
        self.check_http('normal', False)
        before = len(self.logs())
        status, _ = self.request('POST', '/v1/responses', {'model': MODEL, 'input': 'failed usage', 'test_case': 'http_error_usage'}, self.token)
        assert status == 502
        assert self.settled(before)[0]['input_tokens'] == 100

    def enable_oauth(self):
        # Let the gateway encrypt a synthetic credential envelope, then seed only
        # this disposable DB to avoid contacting the real OAuth login service.
        credential = json.dumps({'refresh_token': 'offline-refresh', 'id_token': '', 'account_id': 'offline-account', 'email': 'test@example.invalid'})
        carrier = self.api('POST', f'/providers/{self.provider}/keys', {'name': 'credential-envelope', 'secret': credential})['id']
        with sqlite3.connect(self.db) as conn:
            encrypted = conn.execute('SELECT secret_enc FROM upstream_keys WHERE id=?', (carrier,)).fetchone()[0]
            now = int(time.time() * 1000)
            conn.execute('INSERT INTO codex_oauth_accounts (upstream_key_id,provider_id,account_hash,credentials_enc,token_expires_at_ms,auth_status,quota_checked_at_ms,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)',
                         (self.key, self.provider, 'offline-hash', encrypted, now + 86400000, 'active', now, now, now))
        self.api('DELETE', f'/keys/{carrier}')
        self.api('PATCH', f'/providers/{self.provider}', {'providerType': 'openai_codex_oauth'})
        self.oauth = True


def main():
    subprocess.run(['cargo', 'build', '--manifest-path', 'backend/Cargo.toml', '--locked'], cwd=ROOT, check=True)
    mock = ThreadingHTTPServer(('127.0.0.1', 0), Mock)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix='little-gate-metering-') as tmp:
        port = free_port()
        db = Path(tmp) / 'gateway.sqlite'
        env = {**os.environ, 'LISTEN_ADDR': f'127.0.0.1:{port}', 'DB_DSN': f'sqlite://{db}', 'ADMIN_TOKEN': ADMIN,
               'MASTER_KEY': 'offline-regression-master', 'STATS_FLUSH_INTERVAL_MS': '100', 'UPSTREAM_REQUEST_TIMEOUT_MS': '45000',
               'UPSTREAM_CACHE_TTL_MS': '1', 'UPSTREAM_CACHE_STALE_GRACE_MS': '0', 'STATIC_DIR': str(ROOT / 'frontend/dist')}
        with open(Path(tmp) / 'gateway.log', 'w+') as log:
            process = subprocess.Popen([str(ROOT / 'backend/target/debug/backend')], env=env, stdout=log, stderr=log)
            try:
                test = Regression(port, db, mock.server_port)
                until = time.monotonic() + 15
                while True:
                    try:
                        test.api('GET', '/providers')
                        break
                    except (OSError, http.client.HTTPException):
                        if time.monotonic() > until:
                            raise
                        time.sleep(0.1)
                test.bootstrap()
                for stream in [False, True]:
                    for case in ['normal', 'zero', 'missing', 'missing_tier', 'large', 'failed', 'terminal_only']:
                        test.check_http(case, stream)
                test.api('PATCH', f'/providers/{test.provider}', {'requestOverrides': {'headers': [], 'body': [{'scope': 'responses', 'operation': 'set', 'path': 'service_tier', 'value': 'priority'}]}})
                before = len(test.logs())
                status, _ = test.request('POST', '/v1/responses', {'model': MODEL, 'input': 'override', 'service_tier': 'fast'}, test.token)
                assert status == 200
                assert test.settled(before)[0]['upstream_service_tier'] == 'priority'
                test.api('PATCH', f'/providers/{test.provider}', {'requestOverrides': {'headers': [], 'body': []}})
                test.check_availability()
                test.check_retry_tiers()
                test.check_failed_preflight_tier()
                test.check_ws()
                test.check_disconnect_after_terminal()
                test.check_disconnect()
                test.check_disconnect(websocket=True)
                test.check_disconnect(deadline=True)
                test.check_disconnect(websocket=True, deadline=True)
                print('HTTP/WS framing, usage, tiers, restrictions and disconnect deadline: PASS', flush=True)
                test.api('PATCH', f'/endpoints/{test.endpoint}', {'baseUrl': f'http://127.0.0.1:{mock.server_port}/bridge/v1'})
                test.check_ws('ws_http_bridge')
                test.check_disconnect(websocket=True)
                print('WebSocket over HTTP bridge: PASS', flush=True)
                test.enable_oauth()
                for stream in [False, True]:
                    for case in ['normal', 'zero', 'missing', 'missing_tier', 'failed', 'large']:
                        test.check_http(case, stream)
                test.check_availability()
                test.check_ws('ws_http_bridge')
                assert any(item.get('service_tier') == 'priority' for item in Mock.seen)
                test.api('DELETE', f'/endpoints/{test.endpoint}')
                test.endpoint = test.api('POST', f'/providers/{test.provider}/endpoints', {'name': 'oauth-native', 'baseUrl': f'http://127.0.0.1:{mock.server_port}/native/v1'})['id']
                test.check_ws()
                print('OAuth HTTP, SSE-to-JSON, native WS, HTTP bridge and account availability: PASS', flush=True)
            except Exception:
                log.flush()
                log.seek(0)
                print(log.read()[-6000:])
                raise
            finally:
                process.send_signal(signal.SIGINT)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
    mock.shutdown()


if __name__ == '__main__':
    main()
