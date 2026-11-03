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
    release_terminal = threading.Event()

    def events(self, payload):
        Mock.seen.append(payload)
        case = payload.get('test_case', 'done')
        item = {'type': 'function_call', 'name': 'test', 'call_id': 'call', 'arguments': '{"value":1}'}
        yield {'type': 'response.created', 'response': {'status': 'in_progress', 'service_tier': 'auto'}}
        time.sleep(0.06)
        if case == 'delta':
            yield {'type': 'response.reasoning_text.delta', 'delta': 'thinking'}
        elif case == 'done':
            yield {'type': 'response.output_item.done', 'item': item}
        elif case == 'text_done':
            yield {'type': 'response.output_text.done', 'text': 'hello'}
        if payload.get('test_hold_terminal'):
            self.release_terminal.wait(10)
        time.sleep(0.06)
        response = {'id': 'resp_metrics', 'model': MODEL, 'status': 'completed', 'service_tier': 'default',
                    'output': [item] if case != 'no_output' else [],
                    'usage': {'input_tokens': 100, 'output_tokens': 12,
                              'output_tokens_details': {'reasoning_tokens': 8}}}
        yield {'type': 'response.done', 'response': response}

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if not payload.get('stream') or payload.get('test_json_response'):
            self.json(list(self.events(payload))[-1]['response'])
            return
        self.send_response(200)
        content_type = payload.get('test_content_type', 'text/event-stream')
        if content_type != 'missing':
            self.send_header('Content-Type', content_type)
        if payload.get('test_connection_content_type'):
            self.send_header('Connection', 'Content-Type')
        self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()
        try:
            time.sleep(payload.get('test_body_delay', 0))
            for index, event in enumerate(self.events(payload)):
                # Split JSON across chunks; terminal event deliberately lacks its final newline.
                suffix = '' if event['type'] == 'response.done' else '\r\n\r\n'
                prefix = payload.get('test_prefix', '') if index == 0 else ''
                data = (prefix + 'data: ' + json.dumps(event) + suffix).encode()
                chunk_size = payload.get('test_chunk_size', 31)
                for offset in range(0, len(data), chunk_size):
                    chunk = data[offset:offset + chunk_size]
                    self.wfile.write(f'{len(chunk):x}\r\n'.encode() + chunk + b'\r\n')
                    self.wfile.flush()
            self.wfile.write(b'0\r\n\r\n')
            self.wfile.flush()
        except OSError:
            pass


class MetricsRegression(Regression):
    def stream_response(self, payload):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        MetricsMock.release_terminal.clear()
        try:
            conn.request('POST', '/v1/responses', json.dumps(payload), {
                'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json',
            })
            response = conn.getresponse()
            assert response.status == 200, (response.status, response.read())
            assert response.getheader('Content-Type').split(';')[0] == 'text/event-stream'
            raw, events = bytearray(), []
            while line := response.readline():
                raw.extend(line)
                if line.startswith(b'data:'):
                    event = json.loads(line[5:])
                    events.append(event)
                    if event['type'].endswith('.delta'):
                        # The mock cannot produce the terminal event until the client receives output.
                        MetricsMock.release_terminal.set()
            assert events[0]['type'] == 'response.created', events
            assert events[-1]['type'] == 'response.done', events
            assert len(events) == (2 if payload['test_case'] in ('terminal', 'no_output') else 3), events
            if prefix := payload.get('test_prefix'):
                assert raw.startswith(prefix.encode()), raw
            return response.status, bytes(raw)
        finally:
            MetricsMock.release_terminal.set()
            conn.close()

    def exchange(self, transport, case, effort, expected_effort, oauth,
                 content_type='text/event-stream', **extra):
        before = len(self.logs())
        start = len(Mock.seen)
        payload = {'test_case': case, 'parallel_tool_calls': False, 'test_content_type': content_type, **extra}
        if effort is not None:
            payload['reasoning'] = {'effort': effort}
        if transport in ('http', 'sse'):
            request = {
                'model': MODEL, 'input': 'test', 'stream': transport == 'sse', **payload,
            }
            if transport == 'sse' and not payload.get('test_json_response'):
                status, raw = self.stream_response(request)
            else:
                status, raw = self.request('POST', '/v1/responses', request, self.token)
            assert status == 200, (status, raw)
            if payload.get('test_json_response'):
                assert json.loads(raw)['service_tier'] == 'default', raw
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
        if (transport == 'http' and not oauth) or payload.get('test_json_response'):
            expected_source = None
        assert row['ttft_source'] == expected_source, row
        assert (row['t_first_token_ms'] is not None) == (expected_source is not None), row
        if expected_source:
            # Created metadata arrives first and must not lock TTFT.
            assert 40 <= row['t_first_token_ms'] <= row['duration_ms'], row
        if payload.get('test_body_delay'):
            # Header latency must not include waiting for the sniffed body prefix.
            assert row['t_first_byte_ms'] - row['t_stream_ms'] >= 80, row
        assert row['requested_reasoning_effort'] == effort, row
        assert row['upstream_reasoning_effort'] == expected_effort, row
        assert row['service_tier'] == 'default', row
        assert row['output_tokens'] == 12 and row['reasoning_output_tokens'] == 8, row
        hits = Mock.seen[start:]
        assert len(hits) == count, hits
        assert hits[-1].get('reasoning', {}).get('effort') == expected_effort, hits[-1]
        # Verify API serialization, not only the DB columns.
        api_rows = self.api('GET', '/logs?page=1&page_size=50')
        logged = next(item for item in api_rows if item['id'] == row['id'])
        assert logged['ttft_source'] == expected_source, logged
        assert logged['upstream_reasoning_effort'] == expected_effort, logged
        assert logged['service_tier'] == 'default', logged

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
                if transport != 'ws_native' and (transport != 'http' or oauth):
                    for content_type in ['missing', 'application/octet-stream', 'Text/Event-Stream; charset=utf-8']:
                        self.exchange(transport, 'delta', 'xhigh', 'xhigh', oauth, content_type)
                    for prefix in ['', '\r\n: keepalive\r\n\r\n', 'event: response.created\r\n']:
                        self.exchange(transport, 'delta', 'xhigh', 'xhigh', oauth, 'missing',
                                      test_prefix=prefix, test_chunk_size=1)
                if transport == 'sse':
                    self.exchange(transport, 'delta', 'xhigh', 'xhigh', oauth, 'missing',
                                  test_hold_terminal=True, test_body_delay=0.12)
                    self.exchange(transport, 'delta', 'xhigh', 'xhigh', oauth,
                                  test_connection_content_type=True)
                    if not oauth:
                        self.exchange(transport, 'delta', 'xhigh', 'xhigh', oauth,
                                      test_json_response=True)
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
