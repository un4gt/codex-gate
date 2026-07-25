#!/usr/bin/env python3
import argparse
import gzip
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TMP = ROOT / 'data' / 'tmp'
ARCHIVE_DIR = ROOT / 'data' / 'archive' / 'request_logs_regression'
DB_PATH = ROOT / 'data' / 'regression.sqlite'
BASE_URL = 'http://127.0.0.1:18082'
MOCK_URL = 'http://127.0.0.1:19092'


def parse_args():
    parser = argparse.ArgumentParser(description='Run little-gate local regression pipeline.')
    parser.add_argument('--archive-compress', action='store_true')
    parser.add_argument('--duration-seconds', type=float, default=5.0)
    parser.add_argument('--concurrency', type=int, default=4)
    return parser.parse_args()


def wait_http(url, timeout=15.0):
    deadline = time.time() + timeout
    last_error = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2.0) as resp:
                if 200 <= resp.getcode() < 500:
                    return
        except Exception as exc:
            last_error = exc
        time.sleep(0.2)
    raise RuntimeError(f'timeout waiting for {url}: {last_error}')


def request_json(method, url, token=None, payload=None, timeout=10.0):
    body = None if payload is None else json.dumps(payload).encode('utf-8')
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    req = urllib.request.Request(url=url, method=method, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw.decode('utf-8')) if raw else {}


def request_http(method, url, token=None, payload=None, timeout=10.0, extra_headers=None):
    body = None if payload is None else json.dumps(payload).encode('utf-8')
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    headers.update(extra_headers or {})
    req = urllib.request.Request(url=url, method=method, data=body, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.getcode(), {name.lower(): value for name, value in resp.headers.items()}, raw
    except urllib.error.HTTPError as error:
        raw = error.read()
        return error.code, {name.lower(): value for name, value in error.headers.items()}, raw


def read_text(url, timeout=10.0):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read().decode('utf-8', errors='replace')


def extract_id(obj):
    return obj['id']


def extract_api_key(obj):
    return obj['api_key']


def start_process(args, env=None, log_name='proc.log'):
    TMP.mkdir(parents=True, exist_ok=True)
    log_file = open(TMP / log_name, 'w', encoding='utf-8')
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
            os.killpg(os.getpgid(process.pid), signal.SIGINT)
            process.wait(timeout=5)
    except Exception:
        try:
            if process.poll() is None:
                os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        except Exception:
            pass
    finally:
        log_file.close()


def run_cmd(args, env=None):
    return subprocess.run(args, cwd=ROOT, env=env, capture_output=True, text=True, check=True)


def prepare_clean_state():
    TMP.mkdir(parents=True, exist_ok=True)
    if DB_PATH.exists():
        DB_PATH.unlink()
    for suffix in ('-shm', '-wal'):
        p = Path(str(DB_PATH) + suffix)
        if p.exists():
            p.unlink()
    if ARCHIVE_DIR.exists():
        shutil.rmtree(ARCHIVE_DIR)
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)


def bootstrap_main_provider(admin_token):
    provider_id = extract_id(request_json('POST', f'{BASE_URL}/api/v1/providers', admin_token, {
        'name': 'reg-main-provider',
        'providerType': 'openai',
        'enabled': True,
        'priority': 10,
        'weight': 1,
        'supportsIncludeUsage': True,
    }))
    request_json('POST', f'{BASE_URL}/api/v1/providers/{provider_id}/endpoints', admin_token, {
        'name': 'main-good',
        'baseUrl': f'{MOCK_URL}/good/api/coding/v3',
        'enabled': True,
        'priority': 10,
        'weight': 1,
    })
    request_json('POST', f'{BASE_URL}/api/v1/providers/{provider_id}/keys', admin_token, {
        'name': 'main-key',
        'secret': 'good-key',
        'enabled': True,
        'priority': 10,
        'weight': 1,
    })
    request_json('POST', f'{BASE_URL}/api/v1/prices', admin_token, {
        'providerId': provider_id,
        'modelName': 'gpt-4o-mini',
        'priceData': {
            'schema_version': 2,
            'unit': 'usd_per_million_tokens',
            'base': {
                'input': '1',
                'output': '2',
                'cache_read': '0.25',
                'cache_write': '0.5',
            },
            'tiers': [{
                'over_total_input_tokens': 272000,
                'rates': {
                    'input': '2',
                    'output': '3',
                    'cache_read': '0.5',
                    'cache_write': '1',
                },
            }],
        },
    })
    request_json('PUT', f'{BASE_URL}/api/v1/routes/gpt-4o-mini', admin_token, {
        'enabled': True,
        'providerIds': [provider_id],
    })
    client_key = request_json('POST', f'{BASE_URL}/api/v1/api-keys', admin_token, {
        'name': 'reg-main-client',
        'enabled': True,
        'logEnabled': True,
    })
    return extract_api_key(client_key)


def verify_model_sync_error_passthrough(admin_token):
    provider_id = extract_id(request_json('POST', f'{BASE_URL}/api/v1/providers', admin_token, {
        'name': 'reg-model-sync-auth',
        'providerType': 'openai',
        'enabled': True,
        'priority': 20,
        'weight': 1,
    }))
    request_json('POST', f'{BASE_URL}/api/v1/providers/{provider_id}/endpoints', admin_token, {
        'name': 'auth-models',
        'baseUrl': f'{MOCK_URL}/key/api/coding/v3',
        'enabled': True,
        'priority': 10,
        'weight': 1,
    })
    key_id = extract_id(request_json('POST', f'{BASE_URL}/api/v1/providers/{provider_id}/keys', admin_token, {
        'name': 'bad-model-key',
        'secret': 'bad-key',
        'enabled': True,
        'priority': 10,
        'weight': 1,
    }))

    responses = []
    for path in (
        f'/api/v1/providers/{provider_id}/models/sync',
        f'/api/v1/keys/{key_id}/models/sync',
    ):
        status, headers, body = request_http('POST', f'{BASE_URL}{path}', admin_token, {})
        parsed = json.loads(body.decode('utf-8'))
        if status != 401:
            raise RuntimeError(f'model sync did not preserve upstream 401 for {path}: {status} {body!r}')
        if parsed.get('error', {}).get('message') != 'invalid upstream credential':
            raise RuntimeError(f'model sync changed upstream error body for {path}: {parsed!r}')
        if headers.get('x-upstream-error') != 'authentication-failed':
            raise RuntimeError(f'model sync dropped safe upstream headers for {path}: {headers!r}')
        if 'set-cookie' in headers or 'x-remove-me' in headers:
            raise RuntimeError(f'model sync leaked unsafe upstream headers for {path}: {headers!r}')
        responses.append({'path': path, 'status': status, 'body': parsed})

    request_json('PATCH', f'{BASE_URL}/api/v1/keys/{key_id}', admin_token, {
        'secret': 'good-key',
    })
    synced = request_json(
        'POST',
        f'{BASE_URL}/api/v1/providers/{provider_id}/models/sync',
        admin_token,
        {},
    )
    if not synced:
        raise RuntimeError('model sync did not recover after correcting the upstream key')

    return {
        'errors': responses,
        'recovered_model_count': len(synced),
    }


def configure_responses_via_chat_provider(
    admin_token,
    name,
    model,
    endpoint_url,
    enable_conversion=True,
):
    provider_id = extract_id(request_json('POST', f'{BASE_URL}/api/v1/providers', admin_token, {
        'name': name,
        'providerType': 'openai_compatible',
        'enabled': True,
        'priority': 10,
        'weight': 1,
        'supportsIncludeUsage': True,
    }))
    endpoint_id = extract_id(request_json(
        'POST',
        f'{BASE_URL}/api/v1/providers/{provider_id}/endpoints',
        admin_token,
        {
            'name': f'{name}-endpoint',
            'baseUrl': endpoint_url,
            'enabled': True,
            'priority': 10,
            'weight': 1,
        },
    ))
    key_id = extract_id(request_json(
        'POST',
        f'{BASE_URL}/api/v1/providers/{provider_id}/keys',
        admin_token,
        {
            'name': f'{name}-key',
            'secret': 'good-key',
            'enabled': True,
            'priority': 10,
            'weight': 1,
        },
    ))
    provider_models = request_json(
        'POST',
        f'{BASE_URL}/api/v1/providers/{provider_id}/models/sync',
        admin_token,
        {},
    )
    provider_model = next(
        (item for item in provider_models if item.get('upstream_model') == model),
        None,
    )
    if provider_model is None:
        raise RuntimeError(f'{name} provider sync did not return {model}: {provider_models!r}')
    if enable_conversion:
        request_json(
            'PATCH',
            f'{BASE_URL}/api/v1/provider-models/{provider_model["id"]}',
            admin_token,
            {'responses_via_chat_enabled': True},
        )
    key_models = request_json(
        'POST',
        f'{BASE_URL}/api/v1/keys/{key_id}/models/sync',
        admin_token,
        {},
    )
    if not any(item.get('model_name') == model and item.get('enabled') for item in key_models):
        raise RuntimeError(f'{name} key sync did not enable {model}: {key_models!r}')
    request_json('PUT', f'{BASE_URL}/api/v1/routes/{model}', admin_token, {
        'enabled': True,
        'providerIds': [provider_id],
    })
    return {
        'provider_id': provider_id,
        'endpoint_id': endpoint_id,
        'key_id': key_id,
    }


def verify_responses_via_chat_routing(admin_token, api_key):
    success_model = 'kimi-k3'
    configure_responses_via_chat_provider(
        admin_token,
        'reg-responses-via-chat',
        success_model,
        f'{MOCK_URL}/bridge/api/coding/v3',
    )
    response_status, _, response_body = request_http(
        'POST',
        f'{BASE_URL}/v1/responses',
        api_key,
        {
            'model': success_model,
            'input': 'Return a short reply.',
            'stream': True,
        },
        extra_headers={'Accept': 'text/event-stream'},
    )
    response_stream = response_body.decode('utf-8', errors='replace')
    if response_status != 200:
        raise RuntimeError(
            f'Responses via Chat request failed: {response_status} {response_stream!r}'
        )
    if 'response.completed' not in response_stream:
        raise RuntimeError(f'Responses via Chat stream did not complete: {response_stream!r}')
    if 'response.failed' in response_stream or 'event: error' in response_stream:
        raise RuntimeError(f'Responses via Chat stream emitted an error: {response_stream!r}')
    mock_stats = request_json('GET', f'{MOCK_URL}/__admin/stats')
    success_upstream_request = next(
        (
            item for item in reversed(mock_stats.get('recent_requests', []))
            if item.get('method') == 'POST' and item.get('model') == success_model
        ),
        None,
    )
    if success_upstream_request is None:
        raise RuntimeError('mock did not record the successful Responses via Chat request')
    if success_upstream_request.get('path') != '/bridge/api/coding/v3/chat/completions':
        raise RuntimeError(
            f'Responses request reached the wrong upstream path: {success_upstream_request!r}'
        )
    if success_upstream_request.get('stream') is not True:
        raise RuntimeError(
            f'Codex-compatible streaming flag was not preserved: {success_upstream_request!r}'
        )

    default_models = request_json(
        'GET',
        f'{BASE_URL}/v1/models',
        api_key,
    )
    response_models = request_json(
        'GET',
        f'{BASE_URL}/v1/models?api_format=responses',
        api_key,
    )
    default_model_ids = {item.get('id') for item in default_models.get('data', [])}
    response_model_ids = {item.get('id') for item in response_models.get('data', [])}
    if default_model_ids != response_model_ids:
        raise RuntimeError(
            f'Model registry changed with api_format query: '
            f'default={default_models!r} responses={response_models!r}'
        )
    if success_model not in response_model_ids:
        raise RuntimeError(
            f'Responses model list omitted Chat-converted model: {response_models!r}'
        )

    disabled_conversion_model = 'kimi-k3-no-conversion'
    configure_responses_via_chat_provider(
        admin_token,
        'reg-responses-via-chat-disabled',
        disabled_conversion_model,
        f'{MOCK_URL}/bridge/api/coding/v3',
        enable_conversion=False,
    )
    disabled_status, _, disabled_body = request_http(
        'POST',
        f'{BASE_URL}/v1/responses',
        api_key,
        {
            'model': disabled_conversion_model,
            'input': 'This request must not reach the upstream.',
            'stream': False,
        },
    )
    disabled_error = json.loads(disabled_body.decode('utf-8'))
    if disabled_status != 400:
        raise RuntimeError(
            f'Disabled Responses conversion returned wrong status: '
            f'{disabled_status} {disabled_error!r}'
        )
    error_payload = disabled_error.get('error') or {}
    if error_payload.get('code') != 'model_protocol_unsupported':
        raise RuntimeError(
            f'Disabled Responses conversion returned wrong error code: {disabled_error!r}'
        )
    reasons = (error_payload.get('details') or {}).get('reasons') or []
    if not any(item.get('code') == 'responses_via_chat_disabled' for item in reasons):
        raise RuntimeError(
            f'Disabled Responses conversion omitted its routing reason: {disabled_error!r}'
        )
    mock_stats = request_json('GET', f'{MOCK_URL}/__admin/stats')
    if any(
        item.get('method') == 'POST' and item.get('model') == disabled_conversion_model
        for item in mock_stats.get('recent_requests', [])
    ):
        raise RuntimeError('Protocol-rejected request unexpectedly reached the upstream')

    error_model = 'kimi-k3-error'
    failing = configure_responses_via_chat_provider(
        admin_token,
        'reg-responses-via-chat-error',
        error_model,
        f'{MOCK_URL}/bridge/api/coding/v3',
    )
    request_json(
        'PATCH',
        f'{BASE_URL}/api/v1/endpoints/{failing["endpoint_id"]}',
        admin_token,
        {'baseUrl': f'{MOCK_URL}/model-error/api/coding/v3'},
    )
    expected_error = {
        'error': {
            'message': f'Model "{error_model}" is not supported by any configured account in this group',
            'type': 'model_not_found',
        },
    }
    error_statuses = []
    for _ in range(4):
        status, _, body = request_http(
            'POST',
            f'{BASE_URL}/v1/responses',
            api_key,
            {
                'model': error_model,
                'input': 'Return a short reply.',
                'stream': False,
            },
        )
        parsed = json.loads(body.decode('utf-8'))
        if status != 502 or parsed != expected_error:
            raise RuntimeError(
                f'Chat upstream error was not preserved on attempt {len(error_statuses) + 1}: '
                f'{status} {parsed!r}'
            )
        error_statuses.append(status)

    mock_stats = request_json('GET', f'{MOCK_URL}/__admin/stats')
    error_upstream_request = next(
        (
            item for item in reversed(mock_stats.get('recent_requests', []))
            if item.get('method') == 'POST' and item.get('model') == error_model
        ),
        None,
    )
    if error_upstream_request is None:
        raise RuntimeError('mock did not record the failing Responses via Chat request')
    if error_upstream_request.get('path') != '/model-error/api/coding/v3/chat/completions':
        raise RuntimeError(
            f'Failing Responses request reached the wrong upstream path: {error_upstream_request!r}'
        )

    providers = request_json('GET', f'{BASE_URL}/api/v1/providers', admin_token)
    failing_provider = next(
        (item for item in providers if item.get('id') == failing['provider_id']),
        None,
    )
    if failing_provider is None:
        raise RuntimeError('failing Chat bridge provider disappeared from provider inventory')
    runtime = failing_provider.get('runtime') or {}
    if runtime.get('state') != 'closed' or runtime.get('consecutive_failures') != 0:
        raise RuntimeError(f'model-scoped 502 incorrectly tripped provider circuit: {runtime!r}')

    time.sleep(0.8)
    logs = request_json('GET', f'{BASE_URL}/api/v1/logs?page=1&page_size=100', admin_token)
    success_log = next((item for item in logs if item.get('model') == success_model), None)
    error_log = next((item for item in logs if item.get('model') == error_model), None)
    for label, item in [('success', success_log), ('error', error_log)]:
        if item is None or item.get('api_format') != 'responses':
            raise RuntimeError(f'missing Responses via Chat {label} log: {item!r}')
        if item.get('upstream_api_format') != 'chat_completions':
            raise RuntimeError(f'{label} log recorded wrong upstream API format: {item!r}')
        if item.get('provider_id') is None or item.get('endpoint_id') is None:
            raise RuntimeError(f'{label} log omitted resolved upstream target: {item!r}')
    if success_log.get('http_status') != 200 or success_log.get('error_type') is not None:
        raise RuntimeError(f'successful Codex-compatible request was logged as an error: {success_log!r}')
    if error_log.get('http_status') != 502:
        raise RuntimeError(f'upstream model error log lost its original status: {error_log!r}')
    if error_log.get('error_type') != 'model_not_found':
        raise RuntimeError(f'upstream model error log lost its error type: {error_log!r}')

    return {
        'success_status': response_status,
        'success_stream_completed': True,
        'success_log_error_type': success_log.get('error_type'),
        'success_upstream_path': success_upstream_request.get('path'),
        'model_registry_protocol_independent': default_model_ids == response_model_ids,
        'disabled_conversion_error': disabled_error,
        'error_statuses': error_statuses,
        'error_body': expected_error,
        'error_upstream_path': error_upstream_request.get('path'),
        'error_provider_runtime': runtime,
    }


def verify_global_model_registry(admin_token, default_api_key):
    model = 'isolated-responses-model'
    group_id = extract_id(request_json(
        'POST',
        f'{BASE_URL}/api/v1/provider-groups',
        admin_token,
        {'name': 'reg-isolated-group'},
    ))
    provider_id = extract_id(request_json('POST', f'{BASE_URL}/api/v1/providers', admin_token, {
        'name': 'reg-isolated-responses',
        'providerType': 'openai_compatible_responses',
        'enabled': True,
        'priority': 10,
        'weight': 1,
        'groups': [{'groupId': group_id}],
    }))
    request_json('POST', f'{BASE_URL}/api/v1/providers/{provider_id}/endpoints', admin_token, {
        'name': 'isolated-responses-endpoint',
        'baseUrl': f'{MOCK_URL}/isolated/api/coding/v3',
        'enabled': True,
        'priority': 10,
        'weight': 1,
    })
    key_id = extract_id(request_json(
        'POST',
        f'{BASE_URL}/api/v1/providers/{provider_id}/keys',
        admin_token,
        {
            'name': 'isolated-responses-key',
            'secret': 'good-key',
            'enabled': True,
            'priority': 10,
            'weight': 1,
        },
    ))
    provider_models = request_json(
        'POST',
        f'{BASE_URL}/api/v1/providers/{provider_id}/models/sync',
        admin_token,
        {},
    )
    if not any(item.get('upstream_model') == model for item in provider_models):
        raise RuntimeError(f'isolated provider did not register {model}: {provider_models!r}')
    key_models = request_json(
        'POST',
        f'{BASE_URL}/api/v1/keys/{key_id}/models/sync',
        admin_token,
        {},
    )
    if not any(item.get('model_name') == model and item.get('enabled') for item in key_models):
        raise RuntimeError(f'isolated key did not register {model}: {key_models!r}')
    request_json('PUT', f'{BASE_URL}/api/v1/routes/{model}', admin_token, {
        'enabled': True,
        'providerIds': [provider_id],
    })

    isolated_client = request_json('POST', f'{BASE_URL}/api/v1/api-keys', admin_token, {
        'name': 'reg-isolated-client',
        'enabled': True,
        'logEnabled': True,
        'providerGroupIds': [group_id],
    })
    isolated_api_key = extract_api_key(isolated_client)

    default_models = request_json('GET', f'{BASE_URL}/v1/models', default_api_key)
    isolated_models = request_json('GET', f'{BASE_URL}/v1/models', isolated_api_key)
    default_ids = {item.get('id') for item in default_models.get('data', [])}
    isolated_ids = {item.get('id') for item in isolated_models.get('data', [])}
    if default_ids != isolated_ids or model not in default_ids:
        raise RuntimeError(
            f'global model registry differs by API key group: '
            f'default={default_models!r} isolated={isolated_models!r}'
        )

    denied_status, _, denied_body = request_http(
        'POST',
        f'{BASE_URL}/v1/responses',
        default_api_key,
        {'model': model, 'input': 'default group must be denied'},
    )
    denied_error = json.loads(denied_body.decode('utf-8'))
    if denied_status != 403 or (denied_error.get('error') or {}).get('code') != 'model_not_authorized':
        raise RuntimeError(
            f'global registry group denial was not explicit: {denied_status} {denied_error!r}'
        )

    allowed_status, _, allowed_body = request_http(
        'POST',
        f'{BASE_URL}/v1/responses',
        isolated_api_key,
        {'model': model, 'input': 'isolated group request'},
    )
    if allowed_status != 200:
        raise RuntimeError(
            f'isolated group could not execute its registered model: '
            f'{allowed_status} {allowed_body!r}'
        )

    return {
        'model': model,
        'registry_count': len(default_ids),
        'same_registry_for_distinct_groups': default_ids == isolated_ids,
        'unauthorized_status': denied_status,
        'unauthorized_error': denied_error,
        'authorized_status': allowed_status,
    }


def seed_expired_rows():
    now_ms = int(time.time() * 1000)
    old_ms = now_ms - 3 * 86400 * 1000
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute('SELECT id FROM model_prices ORDER BY id DESC LIMIT 1')
    price_version_id = cur.fetchone()[0]
    cur.execute(
        """
        INSERT INTO request_logs (
          id, time_ms, api_key_id, provider_id, endpoint_id, upstream_key_id,
          api_format, model, http_status, error_type, error_message,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          reasoning_output_tokens, usage_observed, price_version_id, price_tier_index,
          t_stream_ms, t_first_byte_ms, t_first_token_ms, duration_ms,
          created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            '01ARZ3NDEKTSV4RRFFQ69G5FAV', old_ms, 999, 1, 1, 1,
            'chat_completions', 'archive-model', 200, None, None,
            11, 7, 3, 2, 1, 1, price_version_id, 0,
            12, 14, 15, 18, old_ms,
        ),
    )
    cur.execute(
        'INSERT OR REPLACE INTO stats_daily (date, api_key_id, request_success, request_failed, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, reasoning_output_tokens, usage_observed_requests, wait_time_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ('20260301', 999, 1, 0, 11, 7, 3, 2, 1, 1, 18, old_ms),
    )
    conn.commit()
    conn.close()


def archive_summary():
    files = sorted(ARCHIVE_DIR.rglob('*.jsonl')) + sorted(ARCHIVE_DIR.rglob('*.jsonl.gz'))
    index_path = ARCHIVE_DIR / '_index.jsonl'
    preview = None
    if files:
        latest = files[-1]
        if latest.suffix == '.gz':
            with gzip.open(latest, 'rt', encoding='utf-8') as fh:
                preview = fh.readline().strip()
        else:
            with open(latest, 'r', encoding='utf-8') as fh:
                preview = fh.readline().strip()
    index_lines = []
    if index_path.exists():
        index_lines = [line.strip() for line in index_path.read_text(encoding='utf-8').splitlines() if line.strip()]
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM request_logs WHERE id='01ARZ3NDEKTSV4RRFFQ69G5FAV'")
    req_after = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM stats_daily WHERE date='20260301' AND api_key_id=999")
    stats_after = cur.fetchone()[0]
    monetary_columns = {}
    for table in ('request_logs', 'stats_events', 'stats_daily', 'stats_hourly'):
        cur.execute(f'PRAGMA table_info({table})')
        monetary_columns[table] = [row[1] for row in cur.fetchall() if row[1].startswith('cost_')]
    conn.close()
    archive_record = json.loads(preview) if preview else {}
    return {
        'archive_files': [str(p.relative_to(ROOT)) for p in files],
        'archive_preview': preview,
        'index_entries': index_lines,
        'request_logs_after': req_after,
        'stats_daily_after': stats_after,
        'monetary_columns': monetary_columns,
        'archive_has_cost_fields': any(key.startswith('cost_') for key in archive_record),
        'archive_price_version_id': archive_record.get('price_version_id'),
        'archive_price_tier_index': archive_record.get('price_tier_index'),
    }


def main():
    args = parse_args()
    prepare_clean_state()

    run_cmd(['cargo', 'build', '--manifest-path', 'backend/Cargo.toml'])
    run_cmd(['python3', '-m', 'py_compile', 'scripts/mock_upstream.py', 'scripts/bench_failover.py', 'scripts/bench_gateway.py'])

    mock_proc, mock_log = start_process([
        'python3', 'scripts/mock_upstream.py',
        '--listen', '127.0.0.1:19092',
        '--route', '/bad/api/coding/v3|429|rate limited||0|chat',
        '--route', '/good/api/coding/v3|200|good endpoint||0|chat',
        '--route', '/key/api/coding/v3|200|key ok|good-key|0|chat',
        '--route', '/bridge/api/coding/v3|200|bridge ok|good-key|0|chat',
        '--route', '/isolated/api/coding/v3|200|isolated responses ok|good-key|0|responses',
        '--route', '/model-error/api/coding/v3|502|Model "kimi-k3-error" is not supported by any configured account in this group|good-key|0|chat|model_not_found',
        '--models-chat', 'gpt-4o-mini,gpt-4.1-mini,kimi-k3,kimi-k3-no-conversion,kimi-k3-error',
        '--models-responses', 'isolated-responses-model',
    ], log_name='regression_mock.log')

    gateway_env = os.environ.copy()
    gateway_env.update({
        'ADMIN_TOKEN': 'adm',
        'MASTER_KEY': 'adm',
        'DB_DSN': f'sqlite://./{DB_PATH.relative_to(ROOT)}',
        'LISTEN_ADDR': '127.0.0.1:18082',
        'STATIC_DIR': './frontend/dist',
        'STATS_FLUSH_INTERVAL_MS': '500',
        'RETENTION_CLEANUP_INTERVAL_MS': '1000',
        'RETENTION_DELETE_BATCH': '100',
        'REQUEST_LOG_RETENTION_DAYS': '1',
        'STATS_DAILY_RETENTION_DAYS': '1',
        'REQUEST_LOG_ARCHIVE_ENABLED': 'true',
        'REQUEST_LOG_ARCHIVE_DIR': f'./{ARCHIVE_DIR.relative_to(ROOT)}',
        'REQUEST_LOG_ARCHIVE_COMPRESS': 'true' if args.archive_compress else 'false',
    })
    gateway_proc, gateway_log = start_process([
        './backend/target/debug/backend'
    ], env=gateway_env, log_name='regression_gateway.log')

    try:
        wait_http(f'{MOCK_URL}/__admin/stats')
        wait_http(f'{BASE_URL}/healthz')
        wait_http(f'{BASE_URL}/readyz')

        api_key = bootstrap_main_provider('adm')
        model_sync_passthrough = verify_model_sync_error_passthrough('adm')
        responses_via_chat = verify_responses_via_chat_routing('adm', api_key)
        global_model_registry = verify_global_model_registry('adm', api_key)

        bench = run_cmd([
            'python3', 'scripts/bench_gateway.py',
            '--url', f'{BASE_URL}/v1/chat/completions',
            '--api-key', api_key,
            '--model', 'gpt-4o-mini',
            '--format', 'chat',
            '--concurrency', str(args.concurrency),
            '--duration-seconds', str(args.duration_seconds),
            '--warmup-requests', '8',
            '--timeout', '10',
            '--metrics-url', f'{BASE_URL}/metrics',
        ])
        bench_data = json.loads(bench.stdout)

        failover_endpoint = json.loads(run_cmd([
            'python3', 'scripts/bench_failover.py',
            '--base-url', BASE_URL,
            '--admin-token', 'adm',
            '--scenario', 'endpoint',
            '--model', 'gpt-4o-mini',
            '--endpoint-a-url', f'{MOCK_URL}/bad/api/coding/v3',
            '--endpoint-b-url', f'{MOCK_URL}/good/api/coding/v3',
            '--good-key-secret', 'good-key',
        ]).stdout)

        failover_key = json.loads(run_cmd([
            'python3', 'scripts/bench_failover.py',
            '--base-url', BASE_URL,
            '--admin-token', 'adm',
            '--scenario', 'key',
            '--model', 'gpt-4o-mini',
            '--endpoint-a-url', f'{MOCK_URL}/key/api/coding/v3',
            '--bad-key-secret', 'bad-key',
            '--good-key-secret', 'good-key',
        ]).stdout)

        mock_stats = request_json('GET', f'{MOCK_URL}/__admin/stats')
        upstream_requests = mock_stats.get('recent_requests', [])
        proxy_requests = [item for item in upstream_requests if item.get('method') == 'POST']
        if not proxy_requests:
            raise RuntimeError('mock did not record upstream proxy requests')
        unexpected_paths = [
            item.get('path')
            for item in proxy_requests
            if not (
                str(item.get('path')).endswith('/api/coding/v3/chat/completions')
                or str(item.get('path')).endswith('/api/coding/v3/responses')
            )
        ]
        if unexpected_paths:
            raise RuntimeError(f'unexpected custom-prefix upstream paths: {unexpected_paths}')

        logs_payload = request_json('GET', f'{BASE_URL}/api/v1/logs?page=1&page_size=5', 'adm')
        overview_payload = request_json('GET', f'{BASE_URL}/api/v1/stats/overview?period=24h', 'adm')

        seed_expired_rows()
        time.sleep(2.0)
        archive = archive_summary()

        output = {
            'build_ok': True,
            'bench': bench_data,
            'failover_endpoint': failover_endpoint,
            'failover_key': failover_key,
            'upstream_requests': upstream_requests,
            'model_sync_passthrough': model_sync_passthrough,
            'responses_via_chat': responses_via_chat,
            'global_model_registry': global_model_registry,
            'pricing_contract': {
                'logs_have_pricing': bool(logs_payload) and 'pricing' in logs_payload[0],
                'logs_have_cost_fields': bool(logs_payload) and any(key.startswith('cost_') for key in logs_payload[0]),
                'overview_has_pricing': 'pricing' in overview_payload,
                'overview_kpis_have_cost': any(key.startswith('cost_') for key in overview_payload.get('kpis', {})),
            },
            'archive': archive,
            'logs': {
                'mock': str((TMP / 'regression_mock.log').relative_to(ROOT)),
                'gateway': str((TMP / 'regression_gateway.log').relative_to(ROOT)),
            },
        }
        json.dump(output, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write('\n')
    finally:
        stop_process(gateway_proc, gateway_log)
        stop_process(mock_proc, mock_log)


if __name__ == '__main__':
    main()
