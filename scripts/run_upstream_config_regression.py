#!/usr/bin/env python3
"""Disposable upstream API, direct authorization and unified route acceptance."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer
from run_resilience_regression import ADMIN, ROOT, Mock, Regression, free_port
from run_oauth_metering_regression import WsClient


class UpstreamMock(Mock):
    sync_failed = False

    def do_GET(self):
        if self.path.endswith('/models'):
            self.note('models')
            return self.respond(503 if self.sync_failed else 200, {'data': [{'id': 'inventory-model'}]})
        super().do_GET()

    def do_POST(self):
        if '/combo/' in self.path:
            self.rfile.read(int(self.headers.get('Content-Length', 0)))
            self.note('post')
            return self.respond(401 if self.headers.get('Authorization') == 'Bearer bad-key' else 503, {'error': {'message': 'synthetic'}})
        if '/slow/' in self.path:
            time.sleep(.2)
        super().do_POST()


def check(test):
    def create(name, paths, keys=('good-key',), **options):
        return test.api('POST', '/upstreams', {
            'name': name, 'provider_type': 'openai', 'websocket_enabled': True,
            'endpoints': [{'name': p, 'base_url': f'http://127.0.0.1:{test.mock_port}/{p}/v1', 'priority': i * 10} for i, p in enumerate(paths)],
            'keys': [{'name': f'key-{i}', 'secret': key, 'priority': i * 10} for i, key in enumerate(keys)],
            **options,
        })

    one = create('combined-failures', ['combo', 'healthy'], ('bad-key', 'good-key'), max_retries=2, key_selection_strategy='ordered')
    two = create('backup', ['healthy'])
    client = test.api('POST', '/api-keys', {'name': 'direct', 'allowed_provider_ids': [one['id']], 'log_enabled': True})
    token = client['api_key']
    client_id = client['id']
    configs = test.api('GET', '/upstreams')
    assert len(configs) == 2 and all(not item['endpoints'] and not item['keys'] for item in configs)
    assert configs[0]['provider']['endpoint_count'] == 2
    detail = test.api('GET', f"/upstreams/{one['id']}")
    assert all('secret' not in k and k['configured'] for k in detail['keys'])
    assert 'bad-key' not in json.dumps(detail)
    assert not any(k in detail['provider'] for k in ['priority', 'weight', 'groups'])
    assert test.http('PATCH', f"/api/v1/upstreams/{one['id']}", {'priority': 1})[0] == 400
    groups = test.api('GET', '/provider-groups')
    assert test.http('PATCH', f'/api/v1/api-keys/{client_id}', {'provider_group_ids': [groups[0]['id']]})[0] == 409

    def policy(model, ids, **options):
        return test.api('PUT', '/model-route-policies', {'model_name': model, 'mode': 'ordered', 'sticky': True, 'failover': True,
            'targets': [{'provider_id': id, 'priority': i * 10, 'weight': 1} for i, id in enumerate(ids)], **options})

    policy('combo-model', [one['id']])
    start = len(Mock.hits)
    status, _, _ = test.http('POST', '/v1/chat/completions', {'model': 'combo-model', 'messages': []}, token)
    hits = Mock.hits[start:]
    assert status == 200 and len(hits) == 3, (status, hits)
    assert [h[3] for h in hits] == ['Bearer bad-key', 'Bearer good-key', 'Bearer good-key'], hits
    assert ['/combo/' in h[1] for h in hits] == [True, True, False], hits
    errors = test.api('GET', f"/upstreams/{one['id']}/runtime")['recent_errors']
    assert len(errors) == 2 and {e['status'] for e in errors} == {401, 503}, errors

    policy('denied', [two['id']])
    assert test.http('POST', '/v1/responses', {'model': 'denied', 'input': 'x'}, token)[0] == 403
    three = create('later-upstream', ['healthy'])
    keys = test.api('GET', '/api-keys')
    assert next(k for k in keys if k['id'] == client_id)['allowed_provider_ids'] == [one['id']]
    assert three['id'] not in next(k for k in keys if k['id'] == client_id)['allowed_provider_ids']
    test.api('PATCH', f'/api-keys/{client_id}', {'allowed_provider_ids': [one['id'], two['id']]})

    # Inventory remains intact after failed synchronization; model listing uses the same allow list.
    inventory = test.api('POST', f"/upstreams/{two['id']}/models/sync", {})
    model_id = inventory[0]['id']
    test.api('PATCH', f'/provider-models/{model_id}', {'enabled': False})
    UpstreamMock.sync_failed = True
    assert test.http('POST', f"/api/v1/upstreams/{two['id']}/models/sync", {})[0] == 503
    after = test.api('GET', f"/upstreams/{two['id']}")
    assert after['provider']['model_sync']['last_success_ms'] is not None
    assert after['provider']['model_sync']['error']
    inventory = test.api('GET', f"/upstreams/{two['id']}/models")
    assert inventory[0]['id'] == model_id and not inventory[0]['enabled']
    UpstreamMock.sync_failed = False
    test.api('PATCH', f'/provider-models/{model_id}', {'enabled': True})
    policy('inventory-model', [two['id']])
    models = json.loads(test.http('GET', '/v1/models', token=token)[2])
    assert any(m['id'] == 'inventory-model' for m in models['data'])
    test.api('PATCH', f'/api-keys/{client_id}', {'allowed_provider_ids': []})
    assert json.loads(test.http('GET', '/v1/models', token=token)[2])['data'] == []
    assert test.http('POST', '/v1/chat/completions', {'model': 'inventory-model', 'messages': []}, token)[0] == 403

    # Existing sockets must recheck authorization on the next turn.
    test.api('PATCH', f'/api-keys/{client_id}', {'allowed_provider_ids': [three['id']]})
    policy('ws-model', [three['id']])
    ws = WsClient(test.port, token)
    try:
        ws.send({'model': 'ws-model'})
        assert ws.complete()['type'] == 'response.completed'
        test.api('PATCH', f'/api-keys/{client_id}', {'allowed_provider_ids': []})
        start = len(Mock.hits)
        ws.send({'model': 'ws-model'})
        assert ws.complete()['type'] in ('error', 'response.failed')
        assert len(Mock.hits) == start
    finally:
        ws.close()

    # Failover and timeout overrides execute, not just persist.
    failed = create('failed-address', ['fail-single', 'healthy'], max_retries=2, endpoint_failover=False)
    slow = create('timeout', ['slow'], max_retries=0, request_timeout_ms=20)
    test.api('PATCH', f'/api-keys/{client_id}', {'allowed_provider_ids': [failed['id'], slow['id'], three['id']]})
    policy('no-failover', [failed['id'], three['id']], failover=False)
    start = len(Mock.hits)
    assert test.http('POST', '/v1/chat/completions', {'model': 'no-failover', 'messages': []}, token)[0] == 503
    assert len(Mock.hits[start:]) == 1
    test.api('POST', f"/upstreams/{failed['id']}/circuit/reset", {})
    policy('no-failover', [failed['id'], three['id']], failover=True)
    assert test.http('POST', '/v1/chat/completions', {'model': 'no-failover', 'messages': []}, token)[0] == 200
    policy('timeout-model', [slow['id']])
    before = time.monotonic()
    assert test.http('POST', '/v1/chat/completions', {'model': 'timeout-model', 'messages': []}, token)[0] == 504
    assert time.monotonic() - before < .19
    assert test.api('GET', '/upstream-migration')['version'] == 1
    test.api('DELETE', '/model-route-policies', {'model_name': 'timeout-model'})
    assert all(p['model_name'] != 'timeout-model' for p in test.api('GET', '/model-route-policies'))
    assert test.http('DELETE', '/api/v1/model-route-policies', {'model_name': '*'})[0] == 400
    for options in [{'enabled': False}, {'expires_at_ms': 1}]:
        denied = test.api('POST', '/api-keys', {'name': 'invalid-client', 'allowed_provider_ids': [three['id']], **options})
        assert test.http('GET', '/v1/models', token=denied['api_key'])[0] == 401
    assert test.http('PATCH', f"/api/v1/upstreams/{three['id']}", {'max_retries': 3})[0] == 400
    assert test.http('PATCH', f"/api/v1/upstreams/{three['id']}", {'key_selection_strategy': 'weighted'})[0] == 400
    return {'direct_authorization': 'HTTP / WS next turn / models', 'combined_failures': [401, 503, 200], 'intermediate_errors': len(errors), 'failed_sync_inventory_preserved': True, 'route_failover': True, 'endpoint_failover': True, 'timeout_override': True, 'overview_requests': 1}


def main():
    mock = ThreadingHTTPServer(('127.0.0.1', 0), UpstreamMock)
    mock.daemon_threads = True
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix='little-gate-upstream-config-') as directory:
        port = free_port()
        db = Path(directory) / 'gateway.sqlite'
        env = os.environ | {'ADMIN_TOKEN': ADMIN, 'MASTER_KEY': ADMIN, 'PRICE_SYNC_ENABLED': 'false', 'DB_DSN': os.environ.get('UPSTREAM_TEST_DSN', f'sqlite://{db}'), 'LISTEN_ADDR': f'127.0.0.1:{port}', 'REQUEST_LOG_ARCHIVE_ENABLED': 'false'}
        with open(Path(directory) / 'gateway.log', 'w+') as log:
            process = subprocess.Popen([str(ROOT / 'backend/target/debug/backend')], cwd=ROOT, env=env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 20
                while True:
                    try:
                        test = Regression(port, mock.server_port, db)
                        break
                    except (ConnectionError, OSError):
                        if time.monotonic() > deadline:
                            raise
                        time.sleep(.1)
                print(json.dumps(check(test), ensure_ascii=False, indent=2))
            except Exception:
                log.seek(0)
                print(log.read()[-8000:])
                raise
            finally:
                process.terminate()
                process.wait(timeout=10)
                mock.shutdown()


if __name__ == '__main__':
    main()
