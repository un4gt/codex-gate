#!/usr/bin/env python3
"""Offline model catalog regression; optionally exercise a native Codex executable.

Uses a temporary DB, synthetic credentials and local servers. --codex enables
the real app-server model/list check with a disposable CODEX_HOME (no login).
"""
import argparse
from contextlib import closing
import http.client
import json
import os
from pathlib import Path
import queue
import sqlite3
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from run_oauth_metering_regression import ADMIN, MODEL, ROOT, Regression, free_port

UNKNOWN = 'catalog-unknown-model'
ALIAS = 'catalog-native-alias'
MIXED = 'catalog-mixed-alias'
CHAT = 'gpt-6.1-sol'


class Mock(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        models = [MODEL, UNKNOWN]
        if self.path.startswith('/private/'):
            models = [CHAT, 'catalog-private-model']
        elif self.path.startswith('/chat/'):
            models = [CHAT]
        body = json.dumps({'object': 'list', 'data': [{'id': name} for name in models]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class CatalogRegression(Regression):
    def catalog(self, token=None, version='0.163.0'):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            conn.request('GET', f'/v1/models?client_version={version}',
                         headers={'Authorization': f'Bearer {token or self.token}'})
            response = conn.getresponse()
            raw = response.read()
            assert response.status == 200, (response.status, raw)
            assert response.getheader('Cache-Control') == 'private, no-store'
            assert len(raw) <= 1024 * 1024
            payload = json.loads(raw)
            assert set(payload) == {'models'}
            assert all(m['supported_in_api'] and m['visibility'] == 'list' for m in payload['models'])
            return {m['slug']: m for m in payload['models']}
        finally:
            conn.close()

    def check(self):
        self.bootstrap()
        private = self.api('POST', '/providers', {'name': 'private', 'providerType': 'openai'})['id']
        chat = self.api('POST', '/providers', {'name': 'chat', 'providerType': 'openai_compatible'})['id']
        for provider, path in [(private, 'private'), (chat, 'chat')]:
            self.api('POST', f'/providers/{provider}/endpoints',
                     {'name': path, 'baseUrl': f'http://127.0.0.1:{self.mock_port}/{path}/v1'})
            self.api('POST', f'/providers/{provider}/keys', {'name': path, 'secret': 'synthetic'})
            self.api('POST', f'/providers/{provider}/models/sync', {})
        client = self.api('POST', '/api-keys', {'name': 'catalog-client', 'allowed_provider_ids': [self.provider, chat]})
        self.token = client['api_key']
        for name, targets in [(ALIAS, [(self.provider, MODEL)]),
                              (MIXED, [(self.provider, MODEL), (private, CHAT)])]:
            alias = self.api('POST', '/model-aliases', {'name': name})['id']
            for provider, model in targets:
                self.api('POST', f'/model-aliases/{alias}/targets', {'providerId': provider, 'upstreamModel': model})

        expected = {MODEL, UNKNOWN, ALIAS, MIXED}
        models = self.catalog()
        assert set(models) == expected, set(models)
        assert models[ALIAS]['context_window'] == models[MODEL]['context_window']
        assert models[ALIAS]['supported_reasoning_levels'] == models[MODEL]['supported_reasoning_levels']
        assert models[ALIAS]['model_messages'] == models[MODEL]['model_messages']
        assert models[MIXED]['context_window'] == models[MODEL]['context_window']
        assert models[UNKNOWN]['context_window'] is None
        assert models[UNKNOWN]['supported_reasoning_levels'] == []
        assert 'base_instructions' not in models[MODEL]
        assert self.catalog(version='0.159.1')[MODEL]['base_instructions']

        # Standard clients keep their existing schema, including Chat-only models.
        for suffix in ['', '?client_version=', '?client_version=%20']:
            status, raw = self.request('GET', '/v1/models' + suffix, token=self.token)
            body = json.loads(raw)
            assert status == 200 and body['object'] == 'list' and 'models' not in body
            assert CHAT in {item['id'] for item in body['data']}
        path = '/v1/models?client_version=0.163.0'
        assert self.request('GET', path, token='invalid')[0] == 401
        for patch in [{'enabled': False}, {'expires_at_ms': 1}]:
            denied = self.api('POST', '/api-keys', {'name': 'denied', 'allowed_provider_ids': [self.provider], **patch})
            assert self.request('GET', path, token=denied['api_key'])[0] == 401
        empty = self.api('POST', '/api-keys', {'name': 'empty', 'allowed_provider_ids': []})
        assert self.catalog(token=empty['api_key']) == {}

        # Authorization changes both visibility and the set of possible alias capabilities.
        self.api('PATCH', f'/api-keys/{client["id"]}', {'allowed_provider_ids': [self.provider, chat, private]})
        assert self.catalog()[MIXED]['context_window'] is None
        assert 'catalog-private-model' in self.catalog()
        self.api('PATCH', f'/api-keys/{client["id"]}', {'allowed_provider_ids': [self.provider, chat]})
        inventory = self.api('GET', f'/providers/{chat}/models')
        chat_model = next(m for m in inventory if m['upstream_model'] == CHAT)['id']
        self.api('PATCH', f'/provider-models/{chat_model}', {'responses_via_chat_enabled': True})
        assert self.catalog()[CHAT]['context_window'] is None
        assert self.catalog()[CHAT]['use_responses_lite'] is False
        self.api('PATCH', f'/provider-models/{chat_model}', {'responses_via_chat_enabled': False})

        # The catalog shares admission rules with actual routing.
        for resource in [f'/providers/{self.provider}', f'/keys/{self.key}', f'/endpoints/{self.endpoint}']:
            self.api('PATCH', resource, {'enabled': False})
            assert self.catalog() == {}, resource
            self.api('PATCH', resource, {'enabled': True})
            assert set(self.catalog()) == expected
        inventory = self.api('GET', f'/providers/{self.provider}/models')
        model_id = next(m for m in inventory if m['upstream_model'] == MODEL)['id']
        self.api('PATCH', f'/provider-models/{model_id}', {'enabled': False})
        assert set(self.catalog()) == {UNKNOWN}
        self.api('PATCH', f'/provider-models/{model_id}', {'enabled': True})
        self.api('PATCH', '/gateway-models', {'model_name': MODEL, 'enabled': False})
        assert set(self.catalog()) == {UNKNOWN}
        self.api('PATCH', '/gateway-models', {'model_name': MODEL, 'enabled': True})
        key_model = self.api('POST', f'/keys/{self.key}/models', {'models': [MODEL]})[0]['id']
        assert set(self.catalog()) == {MODEL, ALIAS, MIXED}
        self.api('PATCH', f'/key-models/{key_model}', {'enabled': False})
        assert self.catalog() == {}
        self.api('DELETE', f'/key-models/{key_model}')
        self.api('PUT', '/model-route-policies', {'model_name': MODEL, 'mode': 'ordered', 'sticky': True, 'failover': True,
                 'targets': [{'provider_id': private, 'priority': 1, 'weight': 1}]})
        assert set(self.catalog()) == {UNKNOWN}
        self.api('DELETE', '/model-route-policies', {'model_name': MODEL})

        # OAuth account validity is evaluated using synthetic encrypted credentials.
        self.enable_oauth()
        assert set(self.catalog()) == expected
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.execute("UPDATE codex_oauth_accounts SET auth_status='reauth_required' WHERE upstream_key_id=?", (self.key,))
        self.api('PATCH', f'/keys/{self.key}', {'enabled': True})  # Invalidate the snapshot.
        assert self.catalog() == {}
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.execute("UPDATE codex_oauth_accounts SET auth_status='active' WHERE upstream_key_id=?", (self.key,))
        self.api('PATCH', f'/keys/{self.key}', {'enabled': True})
        assert set(self.catalog()) == expected
        print('OpenAI/Codex negotiation, metadata, aliases, authorization, routing and OAuth availability: PASS', flush=True)


def check_cli(executable, test, directory):
    home = directory / 'codex-home'
    home.mkdir()
    base = f'http://127.0.0.1:{test.port}/v1'
    (home / 'config.toml').write_text(f'''model_provider = "catalog-regression"
cli_auth_credentials_store = "file"
[features]
api_key_model_discovery = true
[analytics]
enabled = false
[model_providers.catalog-regression]
name = "catalog-regression"
base_url = "{base}"
model_catalog_url = "{base}/models"
env_key = "LITTLE_GATE_CATALOG_TEST_KEY"
wire_api = "responses"
''', encoding='utf-8')
    env = {key: value for key, value in os.environ.items()
           if key not in {'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'}}
    env.update(CODEX_HOME=str(home), LITTLE_GATE_CATALOG_TEST_KEY=test.token)
    version = subprocess.check_output([executable, '--version'], env=env, text=True).strip()
    with open(directory / 'codex-stderr.log', 'w+', encoding='utf-8') as log:
        process = subprocess.Popen([executable, 'app-server'], cwd=directory, env=env,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
                                   text=True, encoding='utf-8')
        messages = queue.Queue()

        def read():
            for line in process.stdout:
                messages.put(json.loads(line))
            messages.put({'eof': True})

        reader = threading.Thread(target=read, daemon=True)
        reader.start()

        def send(message):
            process.stdin.write(json.dumps(message) + '\n')
            process.stdin.flush()

        def receive(request_id):
            until = time.monotonic() + 30
            while True:
                message = messages.get(timeout=max(0.01, until - time.monotonic()))
                assert not message.get('eof'), 'app-server closed before replying'
                if message.get('id') == request_id:
                    assert 'error' not in message, message
                    return message['result']
                assert time.monotonic() < until, 'app-server response timed out'

        try:
            send({'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'catalog_regression', 'version': '1.0.0'}}})
            receive(1)
            send({'method': 'initialized'})
            send({'id': 2, 'method': 'model/list', 'params': {}})
            result = receive(2)
            models = {m['model']: m for m in result['data']}
            assert set(models) == set(test.catalog()), list(models)
            assert models[ALIAS]['displayName'] == ALIAS
            assert models[ALIAS]['supportedReasoningEfforts'] == models[MODEL]['supportedReasoningEfforts']
            assert models[UNKNOWN]['supportedReasoningEfforts'] == []
            print(f'{version} app-server model/list with isolated CODEX_HOME and gateway API key: PASS', flush=True)
        except Exception:
            log.flush()
            log.seek(0)
            print(log.read()[-4000:])
            raise
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            reader.join(timeout=5)
            process.stdout.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex', help='Path to a native Codex executable for the real model/list check')
    args = parser.parse_args()
    subprocess.run(['cargo', 'build', '--manifest-path', 'backend/Cargo.toml', '--locked'], cwd=ROOT, check=True)
    target = Path(os.environ.get('CARGO_TARGET_DIR', ROOT / 'backend/target'))
    if not target.is_absolute():
        target = ROOT / target
    binary = target / 'debug' / ('backend.exe' if os.name == 'nt' else 'backend')
    mock = ThreadingHTTPServer(('127.0.0.1', 0), Mock)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='little-gate-catalog-') as tmp:
            directory = Path(tmp)
            port = free_port()
            db = directory / 'gateway.sqlite'
            env = {**os.environ, 'LISTEN_ADDR': f'127.0.0.1:{port}', 'DB_DSN': f'sqlite://{db}',
                   'ADMIN_TOKEN': ADMIN, 'MASTER_KEY': 'offline-catalog-master', 'PRICE_SYNC_ENABLED': 'false',
                   'REQUEST_LOG_ARCHIVE_DIR': str(directory / 'archive'), 'STATIC_DIR': str(directory / 'static'),
                   'CODEX_OAUTH_CALLBACK_LISTEN_ADDR': '127.0.0.1:1455',
                   'UPSTREAM_CACHE_TTL_MS': '1', 'UPSTREAM_CACHE_STALE_GRACE_MS': '0'}
            with open(directory / 'gateway.log', 'w+', encoding='utf-8') as log:
                process = subprocess.Popen([str(binary)], cwd=directory, env=env, stdout=log, stderr=log)
                try:
                    test = CatalogRegression(port, db, mock.server_port)
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
                    test.check()
                    if args.codex:
                        check_cli(args.codex, test, directory)
                    else:
                        print('Native Codex check skipped; pass --codex /path/to/codex to enable.', flush=True)
                except Exception:
                    log.flush()
                    log.seek(0)
                    print(log.read()[-4000:])
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
