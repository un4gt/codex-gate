#!/usr/bin/env python3
"""Focused regression for the Anthropic Messages protocol and Chat -> Messages conversion.

Verifies:
- native /v1/messages and /v1/messages/count_tokens against a native Messages upstream,
- automatic Anthropic upstream auth (official x-api-key vs compatible Bearer),
- Messages clients using an openai_compatible Chat upstream when the per-model
  Chat -> Messages flag is enabled,
- request/response/SSE conversion, tools, usage, and deterministic cache prefixes.
"""
import json
import os
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / 'data' / 'messages_regression.sqlite'
BASE_URL = 'http://127.0.0.1:18083'
MOCK_URL = 'http://127.0.0.1:19093'
ADMIN_TOKEN = 'messages-admin'
CLIENT_KEY_NAME = 'messages-client'
NATIVE_MODEL = 'claude-sonnet-4-5'
CHAT_MODEL = 'deepseek-v4-flash'


def wait_http(url, timeout=20.0):
    deadline = time.time() + timeout
    last_error = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2.0) as response:
                if 200 <= response.getcode() < 500:
                    return
        except Exception as error:  # pragma: no cover - diagnostic path
            last_error = error
        time.sleep(0.2)
    raise RuntimeError(f'timeout waiting for {url}: {last_error}')


def request_json(method, url, token=None, payload=None, timeout=20.0):
    body = None if payload is None else json.dumps(payload).encode('utf-8')
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    request = urllib.request.Request(url=url, method=method, data=body, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return json.loads(raw.decode('utf-8')) if raw else {}
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'{method} {url} -> {error.code}: {error.read().decode("utf-8", "replace")}')


def request_http(method, url, headers=None, payload=None, timeout=30.0):
    body = None if payload is None else json.dumps(payload).encode('utf-8')
    merged = {'Content-Type': 'application/json'}
    merged.update(headers or {})
    request = urllib.request.Request(url=url, method=method, data=body, headers=merged)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.getcode(), dict(response.headers), response.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read().decode('utf-8', 'replace')


def start_process(args, env=None, log_name='messages_proc.log'):
    log_path = ROOT / 'data' / 'tmp' / log_name
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_file = open(log_path, 'w', encoding='utf-8')
    process = subprocess.Popen(
        args,
        cwd=ROOT,
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return process, log_file


def stop_process(process, log_file):
    try:
        if process.poll() is None:
            if os.name == 'nt':
                process.terminate()
            else:
                os.killpg(os.getpgid(process.pid), signal.SIGINT)
            process.wait(timeout=5)
    except Exception:
        try:
            if process.poll() is None:
                process.kill()
        except Exception:
            pass
    finally:
        log_file.close()


def prepare_clean_state():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    if DB_PATH.exists():
        DB_PATH.unlink()
    for suffix in ('-shm', '-wal'):
        path = Path(str(DB_PATH) + suffix)
        if path.exists():
            path.unlink()


def mock_requests():
    with urllib.request.urlopen(f'{MOCK_URL}/__admin/stats', timeout=5.0) as response:
        return json.loads(response.read().decode('utf-8'))['recent_requests']


def last_mock_request(path_suffix):
    for item in reversed(mock_requests()):
        if item['path'].endswith(path_suffix):
            return item
    raise AssertionError(f'no mock request ending with {path_suffix}')


def parse_sse(text):
    events = []
    for frame in text.replace('\r\n', '\n').split('\n\n'):
        data = [line[5:].strip() for line in frame.split('\n') if line.startswith('data:')]
        if not data:
            continue
        payload = '\n'.join(data)
        if payload == '[DONE]':
            events.append({'done': True})
            continue
        events.append(json.loads(payload))
    return events


def wait_for_logs(count, timeout=10.0):
    deadline = time.time() + timeout
    rows = []
    while time.time() < deadline:
        connection = sqlite3.connect(DB_PATH)
        try:
            rows = connection.execute(
                'SELECT api_format, upstream_api_format, input_tokens, output_tokens, '
                'cache_read_input_tokens, cache_creation_input_tokens, http_status, '
                'usage_observed FROM request_logs ORDER BY time_ms ASC, id ASC'
            ).fetchall()
        finally:
            connection.close()
        if len(rows) >= count:
            return rows
        time.sleep(0.2)
    raise AssertionError(f'expected at least {count} request logs, got {rows}')


def cache_controls(value):
    found = []
    if isinstance(value, dict):
        if isinstance(value.get('cache_control'), dict):
            found.append(value['cache_control'])
        for child in value.values():
            found.extend(cache_controls(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(cache_controls(child))
    return found


def create_provider(name, provider_type, secret):
    provider_id = request_json('POST', f'{BASE_URL}/api/v1/providers', ADMIN_TOKEN, {
        'name': name,
        'providerType': provider_type,
        'enabled': True,
        'priority': 10,
        'weight': 1,
        'supportsIncludeUsage': provider_type == 'openai_compatible',
    })['id']
    request_json('POST', f'{BASE_URL}/api/v1/providers/{provider_id}/endpoints', ADMIN_TOKEN, {
        'name': f'{name}-endpoint',
        'baseUrl': MOCK_URL,
        'enabled': True,
        'priority': 10,
        'weight': 1,
    })
    request_json('POST', f'{BASE_URL}/api/v1/providers/{provider_id}/keys', ADMIN_TOKEN, {
        'name': f'{name}-key',
        'secret': secret,
        'enabled': True,
        'priority': 10,
        'weight': 1,
    })
    models = request_json(
        'POST', f'{BASE_URL}/api/v1/providers/{provider_id}/models/sync', ADMIN_TOKEN, {}
    )
    return provider_id, models


def bootstrap():
    native_id, native_models = create_provider('native-messages', 'anthropic', 'mock-ant-key')
    assert any(item['upstream_model'] == NATIVE_MODEL for item in native_models), native_models

    chat_id, chat_models = create_provider('chat-messages', 'openai_compatible', 'mock-chat-key')
    chat_model = next(
        (item for item in chat_models if item['upstream_model'] == CHAT_MODEL), None
    )
    assert chat_model, chat_models
    request_json(
        'PATCH', f'{BASE_URL}/api/v1/provider-models/{chat_model["id"]}', ADMIN_TOKEN,
        {'messages_via_chat_enabled': True},
    )

    client_key = request_json('POST', f'{BASE_URL}/api/v1/api-keys', ADMIN_TOKEN, {
        'name': CLIENT_KEY_NAME,
        'enabled': True,
        'logEnabled': True,
        'allowed_provider_ids': [native_id, chat_id],
    })['api_key']
    return native_id, chat_id, client_key


def verify_models(client_key):
    status, _, body = request_http('GET', f'{BASE_URL}/v1/models', {
        'x-api-key': client_key,
        'anthropic-version': '2023-06-01',
    })
    assert status == 200, (status, body)
    models = json.loads(body)
    ids = {item['id'] for item in models['data']}
    assert models['data'] and all(item['type'] == 'model' for item in models['data']), models
    assert NATIVE_MODEL in ids and CHAT_MODEL in ids, models

    status, _, body = request_http('GET', f'{BASE_URL}/v1/models', {
        'Authorization': f'Bearer {client_key}',
    })
    assert status == 200, (status, body)
    openai_ids = {item['id'] for item in json.loads(body)['data']}
    assert CHAT_MODEL in openai_ids, openai_ids


def verify_native_messages(client_key):
    request = {
        'model': NATIVE_MODEL,
        'max_tokens': 64,
        'stream': False,
        'system': [{
            'type': 'text',
            'text': 'stable system prefix',
            'cache_control': {'type': 'ephemeral', 'ttl': '1h'},
        }],
        'messages': [
            {'role': 'user', 'content': 'hello native'},
            {'role': 'assistant', 'content': [{'type': 'text', 'text': 'hi'}]},
            {'role': 'user', 'content': [{
                'type': 'text',
                'text': 'native turn',
                'cache_control': {'type': 'ephemeral'},
            }]},
        ],
    }
    status, headers, body = request_http('POST', f'{BASE_URL}/v1/messages', {
        'x-api-key': client_key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
    }, request)
    assert status == 200, (status, body)
    assert headers.get('content-type', '').startswith('application/json'), headers
    parsed = json.loads(body)
    assert parsed['type'] == 'message' and parsed['content'][0]['text'] == 'mock-ok', parsed
    upstream = last_mock_request('/messages')
    assert upstream['path'].endswith('/messages'), upstream
    assert upstream['x_api_key'] == 'mock-ant-key', upstream
    assert upstream['authorization'] is None, upstream
    assert upstream['anthropic_version'] == '2023-06-01', upstream
    assert upstream['anthropic_beta'] == 'interleaved-thinking-2025-05-14', upstream
    assert upstream['payload']['system'][0]['cache_control']['ttl'] == '1h', upstream

    status, _, body = request_http('POST', f'{BASE_URL}/v1/messages/count_tokens', {
        'Authorization': f'Bearer {client_key}',
        'anthropic-version': '2023-06-01',
    }, {'model': NATIVE_MODEL, 'messages': [{'role': 'user', 'content': 'count'}]})
    assert status == 200 and json.loads(body)['input_tokens'] == 42, (status, body)
    assert last_mock_request('/messages/count_tokens')['path'].endswith('/messages/count_tokens')

    status, headers, body = request_http('POST', f'{BASE_URL}/v1/messages', {
        'x-api-key': client_key,
        'anthropic-version': '2023-06-01',
    }, {**request, 'stream': True})
    assert status == 200 and headers.get('content-type', '').startswith('text/event-stream'), headers
    events = parse_sse(body)
    assert events and events[0].get('type') == 'message_start', events[:2]
    assert any(event.get('type') == 'message_stop' for event in events), events[-3:]
    streamed = ''.join(
        event['delta']['text']
        for event in events
        if event.get('type') == 'content_block_delta'
        and event.get('delta', {}).get('type') == 'text_delta'
    )
    assert streamed == 'mock-ok', streamed

    status, _, body = request_http('POST', f'{BASE_URL}/v1/messages/count_tokens', {
        'Authorization': f'Bearer {client_key}',
        'anthropic-version': '2023-06-01',
    }, {'model': CHAT_MODEL, 'messages': [{'role': 'user', 'content': 'count'}]})
    assert status == 400, (status, body)
    assert 'count_tokens' in body, body


def verify_messages_via_chat(client_key):
    marker_system = {'type': 'ephemeral', 'ttl': '1h'}
    marker_tool = {'type': 'ephemeral'}
    marker_user = {'type': 'ephemeral'}
    request = {
        'model': CHAT_MODEL,
        'max_tokens': 64,
        'stream': False,
        'system': [{'type': 'text', 'text': 'cache me', 'cache_control': marker_system}],
        'messages': [
            {'role': 'user', 'content': 'hello conversion'},
            {'role': 'assistant', 'content': 'hi'},
            {
                'role': 'user',
                'content': [{'type': 'text', 'text': 'latest turn', 'cache_control': marker_user}],
            },
        ],
        'tools': [
            {
                'name': 'Read',
                'description': 'read a file',
                'input_schema': {
                    'type': 'object',
                    'properties': {'path': {'type': 'string'}},
                    'required': ['path'],
                },
            },
            {
                'name': 'Write',
                'description': 'write a file',
                'input_schema': {'type': 'object', 'properties': {'path': {'type': 'string'}}},
                'cache_control': marker_tool,
            },
        ],
    }
    status, _, body = request_http('POST', f'{BASE_URL}/v1/messages', {
        'Authorization': f'Bearer {client_key}',
    }, request)
    assert status == 200, (status, body)
    parsed = json.loads(body)
    assert parsed['type'] == 'message', parsed
    assert parsed['content'][0]['type'] == 'text', parsed
    assert parsed['content'][0]['text'] == 'mock-ok', parsed
    assert parsed['stop_reason'] == 'end_turn', parsed
    assert parsed['usage']['input_tokens'] == 9, parsed
    assert parsed['usage']['output_tokens'] == 5, parsed
    assert parsed['usage']['cache_read_input_tokens'] == 2, parsed
    assert parsed['usage']['cache_creation_input_tokens'] == 1, parsed

    upstream = last_mock_request('/chat/completions')
    payload = upstream['payload']
    assert upstream['authorization'] == 'Bearer mock-chat-key', upstream
    assert payload['model'] == CHAT_MODEL, payload
    assert payload['max_tokens'] == 64, payload
    assert payload['messages'][0]['role'] == 'system', payload
    assert payload['messages'][0]['content'][0]['cache_control'] == marker_system, payload
    assert payload['messages'][-1]['content'][-1]['cache_control'] == marker_user, payload
    assert payload['tools'][1]['cache_control'] == marker_tool, payload
    assert len(cache_controls(payload)) == 3, cache_controls(payload)

    # Two turns with the same history must keep the converted upstream prefix.
    turn_two = {
        **request,
        'messages': [
            *request['messages'],
            {'role': 'assistant', 'content': 'next answer'},
            {'role': 'user', 'content': 'another turn'},
        ],
    }
    status, _, body = request_http('POST', f'{BASE_URL}/v1/messages', {
        'x-api-key': client_key,
    }, turn_two)
    assert status == 200, (status, body)
    second = last_mock_request('/chat/completions')['payload']
    assert second['messages'][:len(payload['messages'])] == payload['messages'], (
        'converted upstream history prefix changed between turns'
    )
    assert second['tools'] == payload['tools'], second['tools']

    # No client cache markers: the upstream automatic prefix cache needs no
    # synthetic Anthropic cache_control fields.
    plain = {
        'model': CHAT_MODEL,
        'max_tokens': 32,
        'messages': [
            {'role': 'user', 'content': 'plain one'},
            {'role': 'assistant', 'content': 'plain two'},
            {'role': 'user', 'content': 'plain three'},
        ],
    }
    status, _, body = request_http('POST', f'{BASE_URL}/v1/messages', {
        'Authorization': f'Bearer {client_key}',
    }, plain)
    assert status == 200, (status, body)
    plain_payload = last_mock_request('/chat/completions')['payload']
    assert cache_controls(plain_payload) == [], cache_controls(plain_payload)

    tool_request = {
        'model': CHAT_MODEL,
        'max_tokens': 64,
        'stream': True,
        'messages': [{'role': 'user', 'content': 'call a tool'}],
        'tools': [{
            'name': 'Bash',
            'input_schema': {
                'type': 'object',
                'properties': {'input': {'type': 'string'}},
            },
        }],
    }
    status, headers, body = request_http('POST', f'{BASE_URL}/v1/messages', {
        'Authorization': f'Bearer {client_key}',
    }, tool_request)
    assert status == 200 and headers.get('content-type', '').startswith('text/event-stream'), headers
    events = parse_sse(body)
    assert events and events[0].get('type') == 'message_start', events[:2]
    assert any(event.get('type') == 'message_stop' for event in events), events[-3:]
    tool_start = next(
        event for event in events
        if event.get('type') == 'content_block_start'
        and event.get('content_block', {}).get('type') == 'tool_use'
    )
    assert tool_start['content_block']['name'] == 'Bash', tool_start
    stop = next(event for event in events if event.get('type') == 'message_delta')
    assert stop['delta']['stop_reason'] == 'tool_use', stop
    assert stop['usage']['input_tokens'] == 9, stop
    assert stop['usage']['cache_read_input_tokens'] == 2, stop


def verify_logs():
    rows = wait_for_logs(6)
    native = [
        row for row in rows
        if row[0] == 'messages' and row[1] == 'messages' and row[7]
    ]
    converted = [
        row for row in rows
        if row[0] == 'messages' and row[1] == 'chat_completions' and row[7]
    ]
    assert native, rows
    assert len(converted) >= 3, rows
    for row in native:
        assert (row[2], row[3], row[4], row[5], row[6]) == (10, 5, 90, 3, 200), row
    for row in converted:
        assert (row[2], row[3], row[4], row[5], row[6]) == (9, 5, 2, 1, 200), row
    assert any(
        row[0] == 'messages' and row[1] == 'messages' and not row[7]
        for row in rows
    ), rows


def main():
    prepare_clean_state()
    run = subprocess.run(
        ['cargo', 'build', '--manifest-path', 'backend/Cargo.toml', '--locked'],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if run.returncode != 0:
        print(run.stdout)
        print(run.stderr)
        return 1
    compile_mock = subprocess.run(
        [sys.executable, '-m', 'py_compile', 'scripts/mock_upstream.py'],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if compile_mock.returncode != 0:
        print(compile_mock.stderr)
        return 1

    mock, mock_log = start_process([
        sys.executable, 'scripts/mock_upstream.py',
        '--listen', '127.0.0.1:19093',
        '--default-format', 'chat',
        '--default-body-text', 'mock-ok',
        '--models-chat', CHAT_MODEL,
        '--models-messages', NATIVE_MODEL,
    ], log_name='messages_mock.log')

    env = os.environ.copy()
    env.update({
        'PRICE_SYNC_ENABLED': 'false',
        'ADMIN_TOKEN': ADMIN_TOKEN,
        'MASTER_KEY': ADMIN_TOKEN,
        'DB_DSN': 'sqlite://./data/messages_regression.sqlite',
        'LISTEN_ADDR': '127.0.0.1:18083',
        'STATIC_DIR': './frontend/dist',
        'STATS_FLUSH_INTERVAL_MS': '200',
        'RETENTION_CLEANUP_INTERVAL_MS': '1000',
        'REQUEST_LOG_RETENTION_DAYS': '1',
        'STATS_DAILY_RETENTION_DAYS': '1',
        'REQUEST_LOG_ARCHIVE_ENABLED': 'false',
        'UPSTREAM_REQUEST_TIMEOUT_MS': '15000',
    })
    gateway, gateway_log = start_process(
        ['./backend/target/debug/backend'], env=env, log_name='messages_gateway.log'
    )

    try:
        wait_http(f'{MOCK_URL}/__admin/stats')
        wait_http(f'{BASE_URL}/healthz')
        wait_http(f'{BASE_URL}/readyz')
        native_id, chat_id, client_key = bootstrap()
        verify_models(client_key)
        verify_native_messages(client_key)
        verify_messages_via_chat(client_key)
        verify_logs()
        print(json.dumps({
            'status': 'ok',
            'native_provider_id': native_id,
            'chat_provider_id': chat_id,
            'client_key': CLIENT_KEY_NAME,
            'native_messages': 'passed',
            'messages_via_chat': 'passed',
            'upstream_x_api_key': 'passed',
            'cache_prefix': 'stable',
            'usage': 'verified',
        }, ensure_ascii=False))
        return 0
    except Exception as error:
        print(f'messages regression failed: {error}', file=sys.stderr)
        print('--- gateway log tail ---', file=sys.stderr)
        try:
            print((ROOT / 'data' / 'tmp' / 'messages_gateway.log').read_text(encoding='utf-8')[-4000:], file=sys.stderr)
        except Exception:
            pass
        return 1
    finally:
        stop_process(gateway, gateway_log)
        stop_process(mock, mock_log)


if __name__ == '__main__':
    sys.exit(main())
