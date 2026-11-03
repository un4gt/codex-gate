#!/usr/bin/env python3
"""Offline regression for native Responses input item ID normalization.

The mock rejects any `custom_tool_call`, `custom_tool_call_output`, or
`function_call` item whose `id` does not use the type-specific prefix. The
gateway must normalize a replayed `call_...` item before the upstream sees it.
"""
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

PREFIXES = {
    'custom_tool_call': 'ctc_',
    'custom_tool_call_output': 'ctco_',
    'function_call': 'fc_',
    'tool_search_call': 'tsc_',
}

REPLAY_INPUT = [
    {
        'type': 'message',
        'role': 'user',
        'content': [{'type': 'input_text', 'text': 'replay'}],
    },
    {
        'type': 'custom_tool_call',
        'id': 'call_deadbeef',
        'call_id': 'call_deadbeef',
        'name': 'exec',
        'input': 'pwd',
    },
    {
        'type': 'custom_tool_call_output',
        'id': 'call_deadbeef_out',
        'call_id': 'call_deadbeef',
        'output': 'ok',
    },
    {
        'type': 'function_call',
        'id': 'call_function',
        'call_id': 'call_function',
        'name': 'lookup',
        'arguments': '{}',
    },
]


class StrictMock(Mock):
    def payload_error(self, payload):
        items = payload.get('input')
        if isinstance(items, dict):
            items = [items]
        if not isinstance(items, list):
            return None
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            target = PREFIXES.get(item.get('type'))
            item_id = item.get('id')
            if (target and isinstance(item_id, str) and item_id
                    and not item_id.startswith(target)):
                return {
                    'type': 'invalid_request_error',
                    'code': 'invalid_id_prefix',
                    'param': f'input[{index}].id',
                    'message': (f"Invalid 'input[{index}].id': '{item_id}'. "
                                f"Expected an ID that begins with '{target}'."),
                }
        return None


class IdRegression(Regression):
    def check_transport(self, transport):
        start = len(Mock.seen)
        payload = {'model': MODEL, 'input': REPLAY_INPUT, 'stream': transport == 'sse'}
        if transport in ('http', 'sse'):
            conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=8)
            try:
                conn.request(
                    'POST',
                    '/v1/responses',
                    json.dumps(payload),
                    {
                        'Content-Type': 'application/json',
                        'Authorization': f'Bearer {self.token}',
                    },
                )
                response = conn.getresponse()
                raw = response.read()
                assert response.status == 200, (transport, response.status, raw)
                assert b'response.done' in raw if transport == 'sse' else json.loads(raw)['status'] == 'completed'
            finally:
                conn.close()
        else:
            ws = WsClient(self.port, self.token)
            try:
                ws.send({'input': REPLAY_INPUT})
                result = ws.complete()
                assert result['type'] == 'response.done', (transport, result)
            finally:
                ws.close()

        hits = Mock.seen[start:]
        assert hits, (transport, 'upstream request was not recorded')
        input_items = hits[0]['input']
        assert isinstance(input_items, list), (transport, input_items)
        custom = next(item for item in input_items if item.get('type') == 'custom_tool_call')
        function = next(item for item in input_items if item.get('type') == 'function_call')
        output = next(item for item in input_items if item.get('type') == 'custom_tool_call_output')
        assert custom['id'] == 'ctc_call_deadbeef', (transport, custom)
        assert custom['call_id'] == 'call_deadbeef', (transport, custom)
        assert function['id'] == 'fc_call_function', (transport, function)
        assert function['call_id'] == 'call_function', (transport, function)
        assert output['id'] == 'ctco_call_deadbeef_out', (transport, output)
        assert output['call_id'] == 'call_deadbeef', (transport, output)

    def check(self):
        self.check_transport('http')
        self.check_transport('sse')
        self.check_transport('ws_native')

        self.api('DELETE', f'/endpoints/{self.endpoint}')
        self.endpoint = self.api('POST', f'/providers/{self.provider}/endpoints', {
            'name': 'bridge',
            'baseUrl': f'http://127.0.0.1:{self.mock_port}/bridge/v1',
        })['id']
        self.check_transport('ws_http_bridge')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, help='Use an existing backend binary instead of building')
    args = parser.parse_args()
    if args.binary:
        binary = args.binary.resolve()
    else:
        subprocess.run(
            ['cargo', 'build', '--manifest-path', 'backend/Cargo.toml', '--locked'],
            cwd=ROOT,
            check=True,
        )
        target = Path(os.environ.get('CARGO_TARGET_DIR', ROOT / 'backend/target'))
        if not target.is_absolute():
            target = ROOT / target
        binary = target / 'debug' / ('backend.exe' if os.name == 'nt' else 'backend')

    mock = ThreadingHTTPServer(('127.0.0.1', 0), StrictMock)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='little-gate-ids-') as tmp:
            directory = Path(tmp)
            port = free_port()
            db = directory / 'gateway.sqlite'
            env = {
                **os.environ,
                'LISTEN_ADDR': f'127.0.0.1:{port}',
                'DB_DSN': f'sqlite://{db}',
                'ADMIN_TOKEN': ADMIN,
                'MASTER_KEY': 'offline-ids-master',
                'PRICE_SYNC_ENABLED': 'false',
                'STATS_FLUSH_INTERVAL_MS': '100',
                'REQUEST_LOG_ARCHIVE_DIR': str(directory / 'archive'),
                'CODEX_OAUTH_CALLBACK_LISTEN_ADDR': '127.0.0.1:1455',
                'STATIC_DIR': str(directory / 'static'),
                'UPSTREAM_CACHE_TTL_MS': '1',
                'UPSTREAM_CACHE_STALE_GRACE_MS': '0',
            }
            with open(directory / 'gateway.log', 'w+', encoding='utf-8') as log:
                process = subprocess.Popen([str(binary)], cwd=directory, env=env, stdout=log, stderr=log)
                try:
                    test = IdRegression(port, db, mock.server_port)
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
                    print('Responses input item ID normalization: HTTP, SSE, WS native and WS HTTP bridge PASS', flush=True)
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
