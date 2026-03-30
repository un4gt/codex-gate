#!/usr/bin/env python3
import argparse
import json
import sys
import time
import urllib.error
import urllib.request


def parse_args():
    parser = argparse.ArgumentParser(description='Failover baseline runner for codex-gate.')
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--admin-token', required=True)
    parser.add_argument('--scenario', choices=['endpoint', 'key'], required=True)
    parser.add_argument('--model', default='gpt-4o-mini')
    parser.add_argument('--provider-name', default='mock-provider')
    parser.add_argument('--client-key-name', default='bench-client')
    parser.add_argument('--timeout', type=float, default=10.0)
    parser.add_argument('--endpoint-a-url')
    parser.add_argument('--endpoint-b-url')
    parser.add_argument('--bad-key-secret', default='bad-key')
    parser.add_argument('--good-key-secret', default='good-key')
    return parser.parse_args()


def request_json(method, url, token=None, payload=None, timeout=10.0):
    body = None if payload is None else json.dumps(payload).encode('utf-8')
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    req = urllib.request.Request(url=url, method=method, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        if not raw:
            return {}
        return json.loads(raw.decode('utf-8'))


def fetch_text(url, timeout=10.0):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read().decode('utf-8', errors='replace')


def parse_metrics(text):
    metrics = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#') or ' ' not in line:
            continue
        name, value = line.rsplit(' ', 1)
        try:
            metrics[name] = float(value)
        except ValueError:
            metrics[name] = value
    return metrics


def metrics_delta(before, after, key):
    return (after.get(key, 0.0) or 0.0) - (before.get(key, 0.0) or 0.0)


def create_provider(base_url, admin_token, name, timeout):
    return request_json('POST', f'{base_url}/api/v1/providers', admin_token, {
        'name': name,
        'providerType': 'openai',
        'enabled': True,
        'priority': 10,
        'weight': 1,
        'supportsIncludeUsage': True,
    }, timeout)['id']


def create_endpoint(base_url, admin_token, provider_id, name, endpoint_base_url, priority, weight, timeout):
    return request_json('POST', f'{base_url}/api/v1/providers/{provider_id}/endpoints', admin_token, {
        'name': name,
        'baseUrl': endpoint_base_url,
        'enabled': True,
        'priority': priority,
        'weight': weight,
    }, timeout)['id']


def create_key(base_url, admin_token, provider_id, name, secret, priority, weight, timeout):
    return request_json('POST', f'{base_url}/api/v1/providers/{provider_id}/keys', admin_token, {
        'name': name,
        'secret': secret,
        'enabled': True,
        'priority': priority,
        'weight': weight,
    }, timeout)['id']


def create_price(base_url, admin_token, provider_id, model, timeout):
    return request_json('POST', f'{base_url}/api/v1/prices', admin_token, {
        'providerId': provider_id,
        'modelName': model,
        'priceData': {
            'input_cost_per_token': '0.000001',
            'output_cost_per_token': '0.000002',
            'cache_creation_input_token_cost': '0.0000005',
            'cache_read_input_token_cost': '0.00000025',
        },
    }, timeout)['id']


def create_client_key(base_url, admin_token, name, timeout):
    return request_json('POST', f'{base_url}/api/v1/api-keys', admin_token, {
        'name': name,
        'enabled': True,
        'logEnabled': True,
    }, timeout)


def upsert_route(base_url, admin_token, model, provider_id, timeout):
    return request_json('PUT', f'{base_url}/api/v1/routes/{model}', admin_token, {
        'enabled': True,
        'providerIds': [provider_id],
    }, timeout)


def find_provider(base_url, admin_token, provider_id, timeout):
    items = request_json('GET', f'{base_url}/api/v1/providers', admin_token, None, timeout)
    for item in items:
        if item['id'] == provider_id:
            return item
    raise RuntimeError(f'provider {provider_id} not found')


def list_provider_children(base_url, admin_token, provider_id, timeout):
    endpoints = request_json('GET', f'{base_url}/api/v1/providers/{provider_id}/endpoints', admin_token, None, timeout)
    keys = request_json('GET', f'{base_url}/api/v1/providers/{provider_id}/keys', admin_token, None, timeout)
    return endpoints, keys


def proxy_request(url, api_key, model, timeout):
    payload = json.dumps({
        'model': model,
        'messages': [{'role': 'user', 'content': 'Return a short reply.'}],
        'stream': False,
    }).encode('utf-8')
    req = urllib.request.Request(
        url=url,
        method='POST',
        data=payload,
        headers={
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json',
        },
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode('utf-8', errors='replace')
            status = resp.getcode()
    except urllib.error.HTTPError as exc:
        body = exc.read().decode('utf-8', errors='replace')
        status = exc.code
    duration_ms = (time.perf_counter() - started) * 1000.0
    return {'status': status, 'duration_ms': round(duration_ms, 3), 'body': body[:600]}


def main():
    args = parse_args()
    base_url = args.base_url.rstrip('/')
    metrics_url = f'{base_url}/metrics'
    chat_url = f'{base_url}/v1/chat/completions'

    provider_id = create_provider(base_url, args.admin_token, f'{args.provider_name}-{args.scenario}-{int(time.time())}', args.timeout)

    endpoint_a_url = args.endpoint_a_url or base_url
    endpoint_b_url = args.endpoint_b_url or endpoint_a_url

    endpoint_ids = []
    key_ids = []

    if args.scenario == 'endpoint':
        endpoint_ids.append(create_endpoint(base_url, args.admin_token, provider_id, 'endpoint-bad', endpoint_a_url, 10, 1, args.timeout))
        endpoint_ids.append(create_endpoint(base_url, args.admin_token, provider_id, 'endpoint-good', endpoint_b_url, 20, 1, args.timeout))
        key_ids.append(create_key(base_url, args.admin_token, provider_id, 'key-main', args.good_key_secret, 10, 1, args.timeout))
    else:
        endpoint_ids.append(create_endpoint(base_url, args.admin_token, provider_id, 'endpoint-main', endpoint_a_url, 10, 1, args.timeout))
        key_ids.append(create_key(base_url, args.admin_token, provider_id, 'key-bad', args.bad_key_secret, 10, 1, args.timeout))
        key_ids.append(create_key(base_url, args.admin_token, provider_id, 'key-good', args.good_key_secret, 20, 1, args.timeout))

    create_price(base_url, args.admin_token, provider_id, args.model, args.timeout)
    upsert_route(base_url, args.admin_token, args.model, provider_id, args.timeout)
    client_key = create_client_key(base_url, args.admin_token, f'{args.client_key_name}-{args.scenario}', args.timeout)

    metrics_before = parse_metrics(fetch_text(metrics_url, args.timeout))
    response = proxy_request(chat_url, client_key['api_key'], args.model, args.timeout)
    time.sleep(0.4)
    metrics_after = parse_metrics(fetch_text(metrics_url, args.timeout))
    provider = find_provider(base_url, args.admin_token, provider_id, args.timeout)
    endpoints, keys = list_provider_children(base_url, args.admin_token, provider_id, args.timeout)

    output = {
        'scenario': args.scenario,
        'provider_id': provider_id,
        'endpoint_ids': endpoint_ids,
        'key_ids': key_ids,
        'client_api_key_id': client_key['id'],
        'proxy_response': response,
        'metrics_delta': {
            'upstream_attempts_total': metrics_delta(metrics_before, metrics_after, 'codex_gate_upstream_attempts_total'),
            'failovers_endpoint_total': metrics_delta(metrics_before, metrics_after, 'codex_gate_failovers_total{scope="endpoint"}'),
            'failovers_key_total': metrics_delta(metrics_before, metrics_after, 'codex_gate_failovers_total{scope="key"}'),
            'chat_ok_total': metrics_delta(metrics_before, metrics_after, 'codex_gate_requests_total{api_format="chat_completions",result="ok"}'),
            'chat_error_total': metrics_delta(metrics_before, metrics_after, 'codex_gate_requests_total{api_format="chat_completions",result="error"}'),
        },
        'provider_health': provider.get('health'),
        'endpoints': endpoints,
        'keys': keys,
    }
    json.dump(output, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
