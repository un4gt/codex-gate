#!/usr/bin/env python3
"""Offline regressions for Codex quota recovery and transport-failure coalescing.

Covers two production incidents:
  1. A six-day quota window reset used to block routing until the operator
     manually refreshed quota. The gateway now probes again after a bounded
     window, so a quota reset applied upstream recovers on its own.
  2. One upstream connection reset failed four concurrent streams and tripped
     the provider circuit breaker; the burst must count as one failure.

Uses only the Python standard library and a temporary database.
"""
import http.client
import json
import os
from contextlib import closing
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
MODEL = 'gpt-6-astra'
ADMIN = 'quota-recovery-admin'
QUOTA_CAP_MS = 1_500
SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1_000


def now_ms():
    return int(time.time() * 1_000)


def exhausted_quota(reset_at_ms):
    return {
        'plan_type': 'prolite',
        'allowed': True,
        'primary_window': {
            'used_percent': 100.0,
            'remaining_percent': 0.0,
            'window_seconds': 604800,
            'reset_at_ms': reset_at_ms,
        },
        'secondary_window': None,
        'code_review_window': None,
        'credits': {
            'has_credits': False,
            'unlimited': False,
            'balance': 0.0,
            'reset_credits': None,
            'subscription_end_at_ms': None,
        },
    }


class Mock(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    mode = 'ok'
    hits = 0
    lock = threading.Lock()

    def log_message(self, *_):
        pass

    def handle(self):
        try:
            super().handle()
        except (ConnectionError, OSError):
            # The disconnect scenario intentionally drops sockets mid-response.
            pass

    def json(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.json({'object': 'list', 'data': [{'id': MODEL}]})

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        payload = json.loads(self.rfile.read(length) or b'{}')
        with Mock.lock:
            Mock.hits += 1
        if Mock.mode == 'exhausted':
            self.json({'error': {
                'type': 'usage_limit_reached',
                'message': 'The usage limit has been reached',
                'resets_at': now_ms() + SIX_DAYS_MS,
            }}, 429)
            return
        if Mock.mode == 'disconnect':
            # Headers and one event, then drop the connection mid-body.
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()
            event = b'data: {"type":"response.output_text.delta","delta":"hello"}\n\n'
            self.wfile.write(b'%x\r\n' % len(event) + event + b'\r\n')
            self.wfile.flush()
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.close_connection = True
            return
        response = {
            'id': 'resp_mock',
            'model': MODEL,
            'status': 'completed',
            'output': [{'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'ok'}]}],
            'usage': {'input_tokens': 10, 'output_tokens': 2},
        }
        if not payload.get('stream'):
            self.json(response)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()
        events = [
            {'type': 'response.output_text.delta', 'delta': 'ok'},
            {'type': 'response.completed', 'response': response},
        ]
        for item in events:
            data = ('data: ' + json.dumps(item) + '\n\n').encode()
            self.wfile.write(b'%x\r\n' % len(data) + data + b'\r\n')
            self.wfile.flush()
        self.wfile.write(b'0\r\n\r\n')
        self.wfile.flush()


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Gateway:
    def __init__(self, port, db, mock_port):
        self.port, self.db, self.mock_port = port, db, mock_port
        self.token = ADMIN

    def request(self, method, path, payload=None, token=ADMIN, timeout=40):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=timeout)
        conn.request(
            method,
            path,
            body=None if payload is None else json.dumps(payload),
            headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'},
        )
        response = conn.getresponse()
        body = response.read()
        headers = {name.lower(): value for name, value in response.getheaders()}
        status = response.status
        conn.close()
        return status, headers, body

    def api(self, method, path, payload=None):
        status, _, body = self.request(method, '/api/v1' + path, payload)
        assert status < 300, (path, status, body)
        return json.loads(body) if body else None

    def provider(self):
        return next(item for item in self.api('GET', '/providers') if item['id'] == self.provider_id)

    def runtime(self):
        return self.api('GET', f'/upstreams/{self.provider_id}/runtime')

    def logs(self):
        with closing(sqlite3.connect(self.db)) as conn:
            conn.row_factory = sqlite3.Row
            return [dict(row) for row in conn.execute(
                "SELECT * FROM request_logs WHERE span_kind IN ('request', 'ws_turn') ORDER BY rowid")]

    def settled(self, before, expected=1, timeout=10):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            rows = self.logs()[before:]
            if len(rows) >= expected:
                return rows
            time.sleep(0.05)
        raise AssertionError(('missing settlement', self.logs()[before:]))

    def bootstrap(self):
        self.provider_id = self.api('POST', '/providers', {
            'name': 'offline-quota', 'providerType': 'openai',
        })['id']
        self.api('POST', f'/providers/{self.provider_id}/endpoints', {
            'name': 'mock', 'baseUrl': f'http://127.0.0.1:{self.mock_port}/native/v1',
        })
        self.key_id = self.api('POST', f'/providers/{self.provider_id}/keys', {
            'name': 'account-a', 'secret': 'synthetic-access',
        })['id']
        self.token = self.api('POST', '/api-keys', {'name': 'client', 'logEnabled': True})['api_key']
        self.api('POST', f'/providers/{self.provider_id}/models/sync', {})

    def enable_oauth(self):
        credential = json.dumps({
            'refresh_token': 'offline-refresh',
            'id_token': '',
            'account_id': 'offline-account',
            'email': 'test@example.invalid',
        })
        carrier = self.api('POST', f'/providers/{self.provider_id}/keys', {
            'name': 'credential-envelope', 'secret': credential,
        })['id']
        with closing(sqlite3.connect(self.db)) as conn, conn:
            encrypted = conn.execute(
                'SELECT secret_enc FROM upstream_keys WHERE id=?', (carrier,)).fetchone()[0]
            stamp = now_ms()
            conn.execute(
                'INSERT INTO codex_oauth_accounts '
                '(upstream_key_id, provider_id, account_hash, credentials_enc, token_expires_at_ms, '
                'auth_status, quota_json, quota_checked_at_ms, created_at_ms, updated_at_ms) '
                'VALUES (?,?,?,?,?,?,?,?,?,?)',
                (self.key_id, self.provider_id, 'offline-hash', encrypted,
                 stamp + 86_400_000, 'active', None, None, stamp, stamp))
        self.api('DELETE', f'/keys/{carrier}')
        self.api('PATCH', f'/providers/{self.provider_id}', {'providerType': 'openai_codex_oauth'})

    def set_quota(self, quota, checked_at_ms):
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.execute(
                'UPDATE codex_oauth_accounts SET quota_json=?, quota_checked_at_ms=? WHERE upstream_key_id=?',
                (None if quota is None else json.dumps(quota), checked_at_ms, self.key_id))

    def send(self, stream=False):
        status, headers, body = self.request(
            'POST', '/v1/responses',
            {'model': MODEL, 'input': 'quota probe', 'stream': stream},
            self.token,
        )
        return status, headers, body

    def wait_snapshot(self, seconds=1.0):
        # The upstream snapshot cache refreshes quickly; give it a moment.
        time.sleep(seconds)


def main():
    subprocess.run(['cargo', 'build', '--manifest-path', 'backend/Cargo.toml', '--locked'],
                   cwd=ROOT, check=True)
    target_dir = Path(os.environ.get('CARGO_TARGET_DIR', ROOT / 'backend/target'))
    if not target_dir.is_absolute():
        target_dir = ROOT / target_dir
    binary = target_dir / 'debug' / ('backend.exe' if os.name == 'nt' else 'backend')
    mock = ThreadingHTTPServer(('127.0.0.1', 0), Mock)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix='little-gate-quota-') as tmp:
        port = free_port()
        db = Path(tmp) / 'gateway.sqlite'
        env = {
            **os.environ,
            'LISTEN_ADDR': f'127.0.0.1:{port}',
            'PRICE_SYNC_ENABLED': 'false',
            'DB_DSN': f'sqlite://{db}',
            'ADMIN_TOKEN': ADMIN,
            'MASTER_KEY': 'offline-regression-master',
            'STATS_FLUSH_INTERVAL_MS': '100',
            'UPSTREAM_CACHE_TTL_MS': '50',
            'UPSTREAM_CACHE_STALE_GRACE_MS': '0',
            'UPSTREAM_REQUEST_TIMEOUT_MS': '15000',
            'UPSTREAM_RATE_LIMIT_FALLBACK_COOLDOWN_MS': '30000',
            'CODEX_QUOTA_BLOCK_CAP_MS': str(QUOTA_CAP_MS),
            'STATIC_DIR': str(ROOT / 'frontend/dist'),
            'CODEX_OAUTH_CALLBACK_LISTEN_ADDR': '127.0.0.1:1455',
        }
        with open(Path(tmp) / 'gateway.log', 'w+') as log:
            process = subprocess.Popen([str(binary)], cwd=ROOT, env=env, stdout=log, stderr=log)
            try:
                test = Gateway(port, db, mock.server_port)
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
                test.enable_oauth()
                test.wait_snapshot()

                # 1. A 429 whose reset hint is six days away must not block for six days.
                Mock.mode = 'exhausted'
                before = len(test.logs())
                status, _, body = test.send()
                assert status >= 400, (status, body)
                rows = test.settled(before)
                assert any(row['provider_id'] == test.provider_id and row['http_status'] == 429 for row in rows), rows
                runtime = test.runtime()
                cooldown = runtime['keys'][0]['quota']['cooldown_until_ms']
                assert cooldown is not None, runtime
                assert cooldown <= now_ms() + QUOTA_CAP_MS + 3_000, ('six-day cooldown', cooldown - now_ms())
                assert test.provider()['routing_availability']['reason'] == 'quota_unavailable'
                print(f'429 reset hint capped at {(cooldown - now_ms()) / 1000:.1f}s: PASS', flush=True)

                # The upstream "restores" quota; no manual refresh is issued.
                Mock.mode = 'ok'
                time.sleep((QUOTA_CAP_MS + 1_000) / 1_000)
                before = len(test.logs())
                status, _, body = test.send()
                assert status == 200, (status, body)
                test.settled(before)
                assert test.provider()['routing_availability']['available']
                print('quota cooldown expiry auto-recovers without a manual refresh: PASS', flush=True)

                # 2. A persisted exhausted snapshot may only block for the probe window.
                test.set_quota(exhausted_quota(now_ms() + SIX_DAYS_MS), now_ms())
                test.wait_snapshot()
                status, headers, body = test.send()
                assert status == 503, (status, body)
                assert b'all_upstreams_temporarily_unavailable' in body, body
                retry_after = int(headers.get('retry-after', '0'))
                assert 1 <= retry_after <= 300, ('six-day retry-after', retry_after)
                assert test.provider()['routing_availability']['reason'] == 'quota_unavailable'
                print(f'fresh exhausted snapshot returns 503 with retry-after {retry_after}s: PASS', flush=True)

                # The operator resets quota upstream; the gateway keeps the old
                # snapshot, so only the probe window can unblock it. Wait for it
                # instead of touching the database: this is the real clock path.
                time.sleep((QUOTA_CAP_MS + 500) / 1_000)
                test.wait_snapshot(0.3)
                before = len(test.logs())
                status, _, body = test.send()
                assert status == 200, (status, body)
                test.settled(before)
                print('expired exhausted snapshot recovers automatically: PASS', flush=True)

                # 3. One connection reset failing concurrent streams must not open the breaker.
                test.set_quota(None, None)
                test.wait_snapshot()
                Mock.mode = 'disconnect'
                results = []

                def fire():
                    results.append(test.send()[0])

                threads = [threading.Thread(target=fire) for _ in range(4)]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join(30)
                assert len(results) == 4 and all(status >= 500 for status in results), results
                runtime = test.runtime()
                assert runtime['provider']['runtime']['consecutive_failures'] == 1, runtime['provider']['runtime']
                assert runtime['provider']['runtime']['state'] == 'closed', runtime['provider']['runtime']
                # Endpoint health may still be cooling down; that is a separate layer.
                test.api('POST', f'/providers/{test.provider_id}/circuit/reset', {})
                Mock.mode = 'ok'
                before = len(test.logs())
                status, _, body = test.send()
                assert status == 200, (status, body)
                test.settled(before)
                print('concurrent stream resets coalesce into one provider failure: PASS', flush=True)
            except Exception:
                log.flush()
                log.seek(0)
                print(log.read()[-6000:])
                raise
            finally:
                if os.name == 'nt':
                    process.terminate()
                else:
                    process.send_signal(signal.SIGINT)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
    mock.shutdown()
    print('ALL QUOTA RECOVERY CHECKS PASSED', flush=True)


if __name__ == '__main__':
    main()
