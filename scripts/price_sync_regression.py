#!/usr/bin/env python3
"""Exercise price-sync HTTP jobs against an isolated SQLite database and local source."""
import copy
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
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
TOKEN = 'price-sync-regression-only'
CARD = {'schema_version': 2, 'unit': 'usd_per_million_tokens', 'base': {'input': '1', 'output': '2', 'cache_read': '0', 'cache_write': '0'}, 'tiers': []}
DOCUMENT = {'schema': 'cchp.pricing-table/v1', 'currency': 'USD', 'version': 'fixture-v1', 'models': [
    {'model_name': 'test-model', 'display_name': 'Friendly test model', 'vendor': 'openai', 'aliases': ['request-alias'], 'pricing': [{'provider': 'openai', 'official': True, 'charges': {key: {'unit': 'per_M_tokens', 'price': value} for key, value in [('prompt', '1'), ('completion', '2'), ('cache_read', '0'), ('cache_write', '0')]}}]},
    {'model_name': 'removed-model', 'pricing': [{'provider': 'fixture', 'charges': {'prompt': {'unit': 'per_M_tokens', 'price': '3'}}}]},
]}


def main():
    source_state = {'document': copy.deepcopy(DOCUMENT), 'status': 200, 'delay': 0}

    class Source(BaseHTTPRequestHandler):
        def do_GET(self):
            time.sleep(source_state['delay'])
            body = json.dumps(source_state['document']).encode()
            self.send_response(source_state['status'])
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Source)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'

    def api(method, path, payload=None, token=TOKEN):
        body = None if payload is None else json.dumps(payload).encode()
        req = Request(base + '/api/v1/' + path, body, {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}, method=method)
        with urlopen(req, timeout=10) as response:
            return json.load(response)

    def wait_for(fn, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = fn()
            if value:
                return value
            time.sleep(0.05)
        raise AssertionError('timed out waiting for price sync')

    def job_done(job_id):
        def check():
            result = api('GET', f'price-sync/jobs/{job_id}')
            return result if result['status'] != 'running' else None
        return wait_for(check)

    def preview():
        return job_done(api('POST', 'price-sync/preview')['id'])

    def apply(job, selected=None):
        queued = api('POST', f'price-sync/apply/{job["id"]}', {'source_version': job['source_version'], 'use_cloud': selected or []})
        return job_done(queued['id'])

    def prices():
        return {p['model_name']: p for p in api('GET', 'prices') if p['provider_id'] is None}

    with tempfile.TemporaryDirectory(prefix='little-gate-price-sync-') as work:
        db_path = Path(work) / 'test.sqlite'
        env = dict(os.environ, ADMIN_TOKEN=TOKEN, MASTER_KEY=TOKEN, LISTEN_ADDR=f'127.0.0.1:{port}', DB_DSN=f'sqlite://{db_path}', STATIC_DIR=str(ROOT / 'frontend/dist'), PRICE_SYNC_ENABLED='true', PRICE_SYNC_SOURCE_URL=f'http://127.0.0.1:{server.server_port}/models.json', PRICE_SYNC_INTERVAL_MINUTES='30')
        with (Path(work) / 'gateway.log').open('w+') as log:
            process = subprocess.Popen([str(ROOT / 'backend/target/debug/backend')], cwd=ROOT, env=env, stdout=log, stderr=log)
            try:
                def ready():
                    try:
                        return api('GET', 'price-sync')
                    except OSError:
                        return None
                wait_for(ready)
                try:
                    api('GET', 'price-sync', token='wrong-token')
                    raise AssertionError('sync endpoint must require administrator authentication')
                except HTTPError as error:
                    assert error.code == 401
                wait_for(lambda: (api('GET', 'price-sync').get('last_job') or {}).get('status') == 'applied')
                assert api('GET', 'provider-models') == []
                initial = prices()
                assert len(initial) == 3 and initial['test-model']['source'] == 'cloud'
                assert initial['request-alias']['display']['display_name'] == 'Friendly test model'
                manual = copy.deepcopy(CARD)
                manual['base']['input'] = '9'
                manual_id = api('PATCH', f'prices/{initial["test-model"]["id"]}', {'price_data': manual})['id']
                source_state['document']['models'][0]['pricing'][0]['charges']['prompt']['price'] = '2'
                stale = preview()
                assert stale['status'] == 'preview' and stale['counts']['manual_preserved'] == 1
                assert prices()['test-model']['id'] == manual_id
                manual['base']['input'] = '10'
                newest_manual = api('PATCH', f'prices/{manual_id}', {'price_data': manual})['id']
                rejected = apply(stale, ['test-model'])
                assert rejected['status'] == 'failed' and 'price changed' in rejected['error']
                assert prices()['test-model']['id'] == newest_manual
                kept = apply(preview())
                assert kept['status'] == 'applied' and kept['counts']['manual_preserved'] == 1
                assert prices()['test-model']['source'] == 'manual'
                selected = apply(preview(), ['test-model'])
                assert selected['status'] == 'applied'
                assert prices()['test-model']['price_data']['base']['input'] == '2'
                assert prices()['test-model']['source'] == 'cloud'
                stable_ids = {name: item['id'] for name, item in prices().items()}
                assert apply(preview())['counts']['unchanged'] == 3
                assert stable_ids == {name: item['id'] for name, item in prices().items()}
                source_state['document']['models'].pop()
                assert apply(preview())['status'] == 'applied'
                assert prices()['removed-model']['display']['present'] is False
                before_failure = prices()
                source_state['status'] = 503
                assert preview()['status'] == 'failed'
                assert prices() == before_failure
                source_state.update(status=200, delay=0.3)
                first = api('POST', 'price-sync/preview')
                second = api('POST', 'price-sync/preview')
                assert first['id'] == second['id']
                assert job_done(first['id'])['status'] == 'preview'
                config = api('GET', 'price-sync')['config']
                config['enabled'] = False
                assert api('PUT', 'price-sync/config', config)['enabled'] is False
                with sqlite3.connect(db_path) as db:
                    assert json.loads(db.execute("SELECT value_json FROM runtime_settings WHERE key='price_sync'").fetchone()[0])['enabled'] is False
                    assert db.execute('SELECT COUNT(*) FROM model_prices WHERE id=?', (manual_id,)).fetchone()[0] == 1
                print(json.dumps({'ok': True, 'checks': ['authenticated APIs', 'automatic startup', 'catalog independent of inventory', 'explicit aliases and display metadata', 'manual version protection', 'stale preview rejection', 'explicit cloud override', 'unchanged versions', 'missing source retention', 'download failure rollback', 'concurrent preview coalescing', 'persisted runtime configuration', 'historical version retention']}))
            except Exception:
                log.flush()
                log.seek(0)
                print(log.read()[-6000:])
                raise
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    main()
