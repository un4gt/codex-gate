#!/usr/bin/env python3
"""Offline Responses Lite wire-contract checks, using only synthetic credentials."""
import argparse
import http.client
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer

from run_oauth_metering_regression import ADMIN, MODEL, ROOT, Mock, Regression, WsClient, free_port

HEADER = 'x-openai-internal-codex-responses-lite'
TOOLS = [{'type': 'function', 'name': 'test', 'parameters': {'type': 'object', 'properties': {}}}]


class LiteRegression(Regression):
    def exchange(self, transport, payload, headers, expected_parallel, expected_lite):
        start = len(Mock.seen)
        before = len(self.logs())
        if transport in ('http', 'sse'):
            conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=8)
            try:
                conn.request('POST', '/v1/responses', json.dumps({
                    'model': MODEL, 'input': 'test', 'stream': transport == 'sse', **payload,
                }), {**headers, 'Content-Type': 'application/json', 'Authorization': f'Bearer {self.token}'})
                response = conn.getresponse()
                raw = response.read()
                assert response.status == 200, (transport, response.status, raw)
                assert b'response.done' in raw if transport == 'sse' else json.loads(raw)['status'] == 'completed'
            finally:
                conn.close()
        else:
            ws = WsClient(self.port, self.token, headers)
            try:
                # Reuse the connection to cover subsequent turns too.
                for _ in range(2):
                    ws.send(payload)
                    result = ws.complete()
                    assert result['type'] == 'response.done', (transport, result)
            finally:
                ws.close()
        count = 1 if transport in ('http', 'sse') else 2
        self.settled(before, count)
        hits = Mock.seen[start:]
        assert len(hits) == count, (transport, len(hits))
        for hit in hits:
            assert hit.get('parallel_tool_calls') is expected_parallel, (transport, hit)
            assert hit['_request_headers'].get(HEADER) == expected_lite, (transport, hit)
            assert hit.get('tools') == payload.get('tools'), 'tools changed'
            assert hit['input'], 'input lost'

    def check(self):
        for oauth in [False, True]:
            if oauth:
                self.enable_oauth()
            for transport in ['http', 'sse', 'ws_native', 'ws_http_bridge']:
                # New endpoint IDs keep the transport capability cache isolated.
                self.api('DELETE', f'/endpoints/{self.endpoint}')
                path = 'bridge' if transport == 'ws_http_bridge' else 'native'
                self.endpoint = self.api('POST', f'/providers/{self.provider}/endpoints', {
                    'name': transport, 'baseUrl': f'http://127.0.0.1:{self.mock_port}/{path}/v1',
                })['id']
                for tools in [None, [], TOOLS]:
                    for parallel in [None, True, False]:
                        payload = {}
                        if tools is not None:
                            payload['tools'] = tools
                        if parallel is not None:
                            payload['parallel_tool_calls'] = parallel
                        self.exchange(transport, payload, {HEADER: 'true'}, False, 'true')

                # Non-Lite requests keep the client's chosen boolean.
                for header in [{}, {HEADER: 'false'}]:
                    for parallel in [True, False]:
                        self.exchange(transport, {'tools': TOOLS, 'parallel_tool_calls': parallel},
                                      header, parallel, header.get(HEADER))

                # Provider overrides are applied before the final Lite invariant.
                self.api('PATCH', f'/providers/{self.provider}', {'requestOverrides': {
                    'headers': [{'scope': 'responses', 'operation': 'set', 'name': HEADER, 'value': 'true'}],
                    'body': [{'scope': 'responses', 'operation': 'set', 'path': 'parallel_tool_calls', 'value': True}],
                }})
                self.exchange(transport, {'tools': TOOLS}, {}, False, 'true')
                self.api('PATCH', f'/providers/{self.provider}', {'requestOverrides': {
                    'headers': [{'scope': 'responses', 'operation': 'remove', 'name': HEADER}],
                    'body': [],
                }})
                self.exchange(transport, {'tools': TOOLS, 'parallel_tool_calls': True}, {HEADER: 'true'}, True, None)
                self.api('PATCH', f'/providers/{self.provider}', {'requestOverrides': {'headers': [], 'body': []}})
                print(f'{"OAuth" if oauth else "API key"} {transport}: Lite true/false/absent, tools, overrides and repeated turns PASS', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, help='Use an existing backend binary instead of building')
    args = parser.parse_args()
    if args.binary:
        binary = args.binary.resolve()
    else:
        subprocess.run(['cargo', 'build', '--manifest-path', 'backend/Cargo.toml', '--locked'], cwd=ROOT, check=True)
        target = Path(os.environ.get('CARGO_TARGET_DIR', ROOT / 'backend/target'))
        if not target.is_absolute():
            target = ROOT / target
        binary = target / 'debug' / ('backend.exe' if os.name == 'nt' else 'backend')
    mock = ThreadingHTTPServer(('127.0.0.1', 0), Mock)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='little-gate-lite-') as tmp:
            directory = Path(tmp)
            port = free_port()
            db = directory / 'gateway.sqlite'
            env = {**os.environ, 'LISTEN_ADDR': f'127.0.0.1:{port}', 'DB_DSN': f'sqlite://{db}',
                   'ADMIN_TOKEN': ADMIN, 'MASTER_KEY': 'offline-lite-master', 'PRICE_SYNC_ENABLED': 'false',
                   'STATS_FLUSH_INTERVAL_MS': '100', 'REQUEST_LOG_ARCHIVE_DIR': str(directory / 'archive'),
                   'CODEX_OAUTH_CALLBACK_LISTEN_ADDR': '127.0.0.1:1455', 'STATIC_DIR': str(directory / 'static'),
                   'UPSTREAM_CACHE_TTL_MS': '1', 'UPSTREAM_CACHE_STALE_GRACE_MS': '0'}
            with open(directory / 'gateway.log', 'w+', encoding='utf-8') as log:
                process = subprocess.Popen([str(binary)], cwd=directory, env=env, stdout=log, stderr=log)
                try:
                    test = LiteRegression(port, db, mock.server_port)
                    until = time.monotonic() + 15
                    while True:
                        assert process.poll() is None, 'gateway exited during startup'
                        try:
                            test.api('GET', '/providers')
                            break
                        except (OSError, http.client.HTTPException):
                            if time.monotonic() > until:
                                raise
                            time.sleep(0.1)
                    test.bootstrap()
                    test.check()
                except Exception:
                    log.flush()
                    log.seek(0)
                    print(log.read()[-3000:])
                    raise
                finally:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
    finally:
        mock.shutdown()
        mock.server_close()


if __name__ == '__main__':
    main()
