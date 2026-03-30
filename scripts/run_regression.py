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
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TMP = ROOT / 'data' / 'tmp'
ARCHIVE_DIR = ROOT / 'data' / 'archive' / 'request_logs_regression'
DB_PATH = ROOT / 'data' / 'regression.sqlite'
BASE_URL = 'http://127.0.0.1:18082'
MOCK_URL = 'http://127.0.0.1:19092'


def parse_args():
    parser = argparse.ArgumentParser(description='Run codex-gate local regression pipeline.')
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
        'baseUrl': f'{MOCK_URL}/good',
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
            'input_cost_per_token': '0.000001',
            'output_cost_per_token': '0.000002',
            'cache_creation_input_token_cost': '0.0000005',
            'cache_read_input_token_cost': '0.00000025',
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


def seed_expired_rows():
    now_ms = int(time.time() * 1000)
    old_ms = now_ms - 3 * 86400 * 1000
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO request_logs (
          id, time_ms, api_key_id, provider_id, endpoint_id, upstream_key_id,
          api_format, model, http_status, error_type, error_message,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          cost_in_usd, cost_out_usd, cost_total_usd,
          t_stream_ms, t_first_byte_ms, t_first_token_ms, duration_ms,
          created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            '01ARZ3NDEKTSV4RRFFQ69G5FAV', old_ms, 999, 1, 1, 1,
            'chat_completions', 'archive-model', 200, None, None,
            11, 7, 3, 2, '0.000011', '0.000014', '0.000025',
            12, 14, 15, 18, old_ms,
        ),
    )
    cur.execute(
        'INSERT OR REPLACE INTO stats_daily (date, api_key_id, request_success, request_failed, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cost_in_usd, cost_out_usd, cost_total_usd, wait_time_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ('20260301', 999, 1, 0, 11, 7, 3, 2, '0.000011', '0.000014', '0.000025', 18, old_ms),
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
    conn.close()
    return {
        'archive_files': [str(p.relative_to(ROOT)) for p in files],
        'archive_preview': preview,
        'index_entries': index_lines,
        'request_logs_after': req_after,
        'stats_daily_after': stats_after,
    }


def main():
    args = parse_args()
    prepare_clean_state()

    run_cmd(['cargo', 'build', '--manifest-path', 'backend/Cargo.toml'])
    run_cmd(['python3', '-m', 'py_compile', 'scripts/mock_upstream.py', 'scripts/bench_failover.py', 'scripts/bench_gateway.py'])

    mock_proc, mock_log = start_process([
        'python3', 'scripts/mock_upstream.py',
        '--listen', '127.0.0.1:19092',
        '--route', '/bad/v1|429|rate limited||0|chat',
        '--route', '/good/v1|200|good endpoint||0|chat',
        '--route', '/key/v1|200|key ok|good-key|0|chat',
    ], log_name='regression_mock.log')

    gateway_env = os.environ.copy()
    gateway_env.update({
        'ADMIN_TOKEN': 'adm',
        'MASTER_KEY': 'adm',
        'DB_DSN': f'sqlite://./{DB_PATH.relative_to(ROOT)}',
        'LISTEN_ADDR': '127.0.0.1:18082',
        'STATIC_DIR': './frontend/dist',
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
            '--endpoint-a-url', f'{MOCK_URL}/bad',
            '--endpoint-b-url', f'{MOCK_URL}/good',
            '--good-key-secret', 'good-key',
        ]).stdout)

        failover_key = json.loads(run_cmd([
            'python3', 'scripts/bench_failover.py',
            '--base-url', BASE_URL,
            '--admin-token', 'adm',
            '--scenario', 'key',
            '--model', 'gpt-4o-mini',
            '--endpoint-a-url', f'{MOCK_URL}/key',
            '--bad-key-secret', 'bad-key',
            '--good-key-secret', 'good-key',
        ]).stdout)

        seed_expired_rows()
        time.sleep(2.0)
        archive = archive_summary()

        output = {
            'build_ok': True,
            'bench': bench_data,
            'failover_endpoint': failover_endpoint,
            'failover_key': failover_key,
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
