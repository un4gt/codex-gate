#!/usr/bin/env python3
"""Offline TTFT/effort logging across HTTP, SSE, native WS and the HTTP bridge."""
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


class MetricsMock(Mock):
    def events(self, payload):
        Mock.seen.append(payload)
        case = payload.get('test_case', 'done')
        item = {'type': 'function_call', 'name': 'test', 'call_id': 'call', 'arguments': '{"value":1}'}
        yield {'type': 'response.created', 'response': {'status': 'in_progress'}}
        time.sleep(0.06)
        if case == 'delta':
            yield {'type': 'response.reasoning_text.delta', 'delta': 'thinking'}
        elif case == 'done':
            yield {'type': 'response.output_item.done', 'item': item}
        elif case == 'text_done':
            yield {'type': 'response.output_text.done', 'text': 'hello'}
        time.sleep(0.06)
        response = {'id': 'resp_metrics', 'model': MODEL, 'status': 'completed',
                    'output': [item] if case != 'no_output' else [],
                    'usage': {'input_tokens': 100, 'output_tokens': 12,
                              'output_tokens_details': {'reasoning_tokens': 8}}}
        yield {'type': 'response.done', 'response': response}

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if not payload.get('stream'):
            self.json(list(self.events(payload))[-1]['response'])
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()
        try:
            for event in self.events(payload):
                # Split JSON across chunks; terminal event deliberately lacks its final newline.
                suffix = '' if event['type'] == 'response.done' else '\r\n\r\n'
                data = ('data: ' + json.dumps(event) + suffix).encode()
                for offset in range(0, len(data), 31):
                    chunk = data[offset:offset + 31]
                    self.wfile.write(f'{len(chunk):x}\r\n'.encode() + chunk + b'\r\n')
                    self.wfile.flush()
            self.wfile.write(b'0\r\n\r\n')
            self.wfile.flush()
        except OSError:
            pass


class MetricsRegression(Regression):
    def exchange(self, transport, case, effort, expected_effort, oauth):
        before = len(self.logs())
        start = len(Mock.seen)
        payload = {'test_case': case, 'parallel_tool_calls': False}
        if effort is not None:
            payload['reasoning'] = {'effort': effort}
        if transport in ('http', 'sse'):
            status, raw = self.request('POST', '/v1/responses', {
                'model': MODEL, 'input': 'test', 'stream': transport == 'sse', **payload,
            }, self.token)
            assert status == 200, (status, raw)
        else:
            ws = WsClient(self.port, self.token)
            try:
                # Second turn must not inherit the first turn's requested effort.
                ws.send({**payload, 'reasoning': {'effort': 'low'}})
                assert ws.complete()['type'] == 'response.done'
                ws.send(payload)
                assert ws.complete()['type'] == 'response.done'
            finally:
                ws.close()
        count = 1 if transport in ('http', 'sse') else 2
        rows = self.settled(before, count)
        row = rows[-1]
        expected_source = {'delta': 'delta', 'done': 'output_done', 'text_done': 'output_done',
                           'terminal': 'response_done', 'no_output': None}[case]
        if transport == 'http' and not oauth:
            expected_source = None
        assert row['ttft_source'] == expected_source, row
        assert (row['t_first_token_ms'] is not None) == (expected_source is not None), row
        if expected_source:
            # Created metadata arrives first and must not lock TTFT.
            assert 40 <= row['t_first_token_ms'] <= row['duration_ms'], row
        assert row['requested_reasoning_effort'] == effort, row
        assert row['upstream_reasoning_effort'] == expected_effort, row
        assert row['output_tokens'] == 12 and row['reasoning_output_tokens'] == 8, row
        hits = Mock.seen[start:]
        assert len(hits) == count, hits
        assert hits[-1].get('reasoning', {}).get('effort') == expected_effort, hits[-1]
        # Verify API serialization, not only the DB columns.
        api_rows = self.api('GET', '/logs?page=1&page_size=50')
        logged = next(item for item in api_rows if item['id'] == row['id'])
        assert logged['ttft_source'] == expected_source, logged
        assert logged['upstream_reasoning_effort'] == expected_effort, logged

    def check(self):
        for oauth in [False, True]:
            if oauth:
                self.enable_oauth()
            for transport in ['sse', 'http', 'ws_native', 'ws_http_bridge']:
                self.api('DELETE', f'/endpoints/{self.endpoint}')
                route = 'http_only' if transport == 'ws_http_bridge' else 'native'
                self.endpoint = self.api('POST', f'/providers/{self.provider}/endpoints', {
                    'name': route, 'baseUrl': f'http://127.0.0.1:{self.mock_port}/{route}/v1',
                })['id']
                self.api('PATCH', f'/providers/{self.provider}', {'requestOverrides': {'body': [], 'headers': []}})
                for case in ['delta', 'done', 'text_done', 'terminal', 'no_output']:
                    self.exchange(transport, case, 'xhigh', 'xhigh', oauth)
                # The upstream field records provider overrides, not just client intent.
                self.api('PATCH', f'/providers/{self.provider}', {'requestOverrides': {'body': [
                    {'scope': 'responses', 'operation': 'set', 'path': 'reasoning.effort', 'value': 'high'},
                ], 'headers': []}})
                self.exchange(transport, 'done', 'xhigh', 'high', oauth)
                self.api('PATCH', f'/providers/{self.provider}', {'requestOverrides': {'body': [], 'headers': []}})
                self.exchange(transport, 'done', None, None, oauth)
                print(f'{"OAuth" if oauth else "API key"} {transport}: TTFT sources, usage and reasoning overrides PASS', flush=True)
        before = len(self.logs())
        status, _ = self.request('POST', '/v1/responses', {
            'model': 'not-routed', 'input': 'test', 'reasoning': {'effort': 'low'},
        }, self.token)
        assert status >= 400
        row = self.settled(before)[0]
        assert row['requested_reasoning_effort'] == 'low' and row['upstream_reasoning_effort'] is None, row
        print('Pre-routing errors retain requested effort without inventing upstream effort PASS', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True, type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve()
    mock = ThreadingHTTPServer(('127.0.0.1', 0), MetricsMock)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='little-gate-log-metrics-') as tmp:
            directory = Path(tmp)
            port = free_port()
            db = directory / 'gateway.sqlite'
            env = {**os.environ, 'LISTEN_ADDR': f'127.0.0.1:{port}', 'DB_DSN': f'sqlite://{db}',
                   'ADMIN_TOKEN': ADMIN, 'MASTER_KEY': 'offline-log-metrics', 'PRICE_SYNC_ENABLED': 'false',
                   'STATS_FLUSH_INTERVAL_MS': '100', 'REQUEST_LOG_ARCHIVE_DIR': str(directory / 'archive'),
                   'STATIC_DIR': str(directory / 'static'), 'CODEX_OAUTH_CALLBACK_LISTEN_ADDR': '127.0.0.1:1455',
                   'UPSTREAM_CACHE_TTL_MS': '1', 'UPSTREAM_CACHE_STALE_GRACE_MS': '0'}
            with open(directory / 'gateway.log', 'w+', encoding='utf-8') as log:
                process = subprocess.Popen([str(binary)], cwd=directory, env=env, stdout=log, stderr=log)
                try:
                    test = MetricsRegression(port, db, mock.server_port)
                    deadline = time.monotonic() + 15
                    while True:
                        assert process.poll() is None, 'gateway exited'
                        try:
                            test.api('GET', '/providers')
                            break
                        except (OSError, http.client.HTTPException):
                            if time.monotonic() > deadline:
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
