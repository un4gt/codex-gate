#!/usr/bin/env python3
"""Offline WeCom send-test flow with real usage data and a local webhook mock."""
import argparse
import http.client
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer

from run_oauth_metering_regression import ADMIN, ROOT, Mock, Regression, free_port


class WecomMock(Mock):
    received = []
    business_code = 0

    def do_POST(self):
        if self.path != '/wecom':
            return super().do_POST()
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        kind = payload.get('msgtype')
        if kind in ('text', 'markdown'):
            content = payload.get(kind, {}).get('content')
            valid = isinstance(content, str) and 0 < len(content.encode()) <= (4096 if kind == 'markdown' else 2048)
        elif kind == 'news':
            articles = payload.get('news', {}).get('articles', [])
            valid = 1 <= len(articles) <= 8 and all(
                item.get('url') and len(item['title'].encode()) <= 128
                and len(item.get('description', '').encode()) <= 512 for item in articles)
        elif kind == 'template_card':
            card = payload.get('template_card', {})
            valid = (card.get('card_type') in ('text_notice', 'news_notice')
                     and card.get('main_title', {}).get('title')
                     and card.get('card_action', {}).get('url')
                     and card['card_action']['type'] == 1
                     and len(card.get('horizontal_content_list', [])) <= 6
                     and len(card.get('vertical_content_list', [])) <= 4
                     and len(card.get('jump_list', [])) <= 3)
            if card.get('card_type') == 'news_notice':
                valid = valid and bool(card.get('card_image', {}).get('url'))
        else:
            valid = False
        valid = valid and self.headers.get('Content-Type') == 'application/json'
        WecomMock.received.append(payload)
        code = self.business_code if valid else 40058
        self.json({'errcode': code, 'errmsg': 'ok' if code == 0 else 'invalid parameter'})


def wait_delivery(test, run_id):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        items = test.api('GET', '/notifications/deliveries')['items']
        for item in items:
            if item['run_id'] == run_id and item['status'] in ('failed', 'succeeded'):
                return test.api('GET', f'/notifications/deliveries/{item["id"]}')
        time.sleep(0.1)
    raise AssertionError('notification delivery timed out')


def check(test):
    test.bootstrap()
    # Produce nonempty provider/key dimensions with fractional error and coverage rates.
    for case in ['normal', 'missing', 'failed']:
        test.check_http(case, stream=False)
    channel = test.api('POST', '/notifications/channels', {
        'name': 'offline-wecom', 'kind': 'webhook',
        'config': {'format': 'wecom', 'url': f'http://127.0.0.1:{test.mock_port}/wecom'},
    })['channel']['id']
    run_id = test.api('POST', f'/notifications/channels/{channel}/test', {'locale': 'zh-CN'})['run_id']
    detail = wait_delivery(test, run_id)
    assert detail['status'] == 'succeeded', (detail['last_error_code'], detail['last_error_message'])
    payload = detail['event_payload']
    assert payload['event']['type'] == 'test'
    assert payload['usage']['totals']['requests'] == 3, payload['usage']
    for dimension in ['providers', 'client_keys']:
        row = payload['usage'][dimension][0]
        assert 33 < row['error_rate_percent'] < 34, row
        assert 66 < row['usage_coverage_percent'] < 67, row
    assert detail['last_http_status'] == 200
    assert json.loads(detail['last_request_body']) == WecomMock.received[-1]
    assert json.loads(detail['last_response_body'])['errcode'] == 0
    content = WecomMock.received[-1]['markdown']['content']
    assert re.search(r'\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}', content), content
    assert str(payload['window']['from_ms']) not in content
    assert '## 通知通道测试' in content and '服务器状态' in content, content
    print('WeCom legacy config defaults to Markdown with readable time and persisted usage PASS', flush=True)

    # Configuration round trip, real delivery shapes, and business errors for every style.
    for style, image in [('template_card', ''), ('template_card', 'https://example.test/cover.png'),
                         ('news', 'https://example.test/cover.png'), ('text', ''), ('markdown', '')]:
        config = {'message_type': style, 'details_url': 'https://example.test/notifications', 'image_url': image}
        updated = test.api('PATCH', f'/notifications/channels/{channel}', {
            'kind': 'webhook', 'config': {'format': 'wecom', 'url': '', 'wecom': config},
        })
        assert updated['config']['wecom'] == config, updated
        assert updated['config']['url_masked'].endswith('/…'), updated
        run_id = test.api('POST', f'/notifications/channels/{channel}/test', {})['run_id']
        detail = wait_delivery(test, run_id)
        assert detail['status'] == 'succeeded', detail
        body = WecomMock.received[-1]
        assert body['msgtype'] == style, body
        if style == 'template_card':
            card = body['template_card']
            assert card['card_type'] == ('news_notice' if image else 'text_notice'), card
            assert card['card_action']['url'] == config['details_url']
        if style == 'news':
            assert body['news']['articles'][0]['picurl'] == image
        WecomMock.business_code = 40058
        run_id = test.api('POST', f'/notifications/channels/{channel}/test', {})['run_id']
        failed_style = wait_delivery(test, run_id)
        assert failed_style['last_error_code'] == 'webhook_platform_rejected', failed_style
        WecomMock.business_code = 0
    print('WeCom Markdown/text/news/text-card/image-card config, wire format and business errors PASS', flush=True)

    for link in ['', 'javascript:alert(1)', 'https://user:secret@example.test/report']:
        status, _ = test.request('POST', '/api/v1/notifications/channels', {
            'name': 'invalid-card', 'kind': 'webhook',
            'config': {'format': 'wecom', 'url': f'http://127.0.0.1:{test.mock_port}/wecom',
                       'wecom': {'message_type': 'template_card', 'details_url': link}},
        }, ADMIN)
        assert status == 400, (link, status)
    print('WeCom required card links and URL validation PASS', flush=True)

    # A large report must be shortened by bytes without changing the event payload.
    long_name = '中文统计🙂' * 60
    test.api('PATCH', f'/providers/{test.provider}', {'name': long_name})
    client = next(k for k in test.api('GET', '/api-keys') if k['name'] == 'client')
    test.api('PATCH', f'/api-keys/{client["id"]}', {'name': long_name})
    run_id = test.api('POST', f'/notifications/channels/{channel}/test', {})['run_id']
    detail = wait_delivery(test, run_id)
    assert detail['status'] == 'succeeded', (detail['last_error_code'], detail['last_error_message'])
    content = WecomMock.received[-1]['markdown']['content']
    assert len(content.encode('utf-8')) <= 4096
    assert '…' in content, 'fixture must exercise truncation'
    assert '上游消耗' in content and '客户端 Key 消耗' in content
    assert detail['event_payload']['usage']['providers'][0]['name'] == long_name
    print('WeCom UTF-8 byte limit and unmodified stored report PASS', flush=True)

    # HTTP 200 with a nonzero errcode is still a failure; manual retry uses stored JSON.
    WecomMock.business_code = 40058
    run_id = test.api('POST', f'/notifications/channels/{channel}/test', {})['run_id']
    failed = wait_delivery(test, run_id)
    assert failed['status'] == 'failed' and failed['last_error_code'] == 'webhook_platform_rejected', failed
    assert failed['last_http_status'] == 200
    WecomMock.business_code = 0
    test.api('POST', f'/notifications/deliveries/{failed["id"]}/retry', {})
    retried = wait_delivery(test, run_id)
    assert retried['status'] == 'succeeded', (retried['last_error_code'], retried['last_error_message'])
    assert retried['event_payload'] == failed['event_payload']
    print('WeCom business errors and retry of persisted report PASS', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, help='Use an existing backend executable')
    args = parser.parse_args()
    if args.binary:
        binary = args.binary.resolve()
    else:
        subprocess.run(['cargo', 'build', '--manifest-path', 'backend/Cargo.toml', '--locked'], cwd=ROOT, check=True)
        target = Path(os.environ.get('CARGO_TARGET_DIR', ROOT / 'backend/target'))
        if not target.is_absolute():
            target = ROOT / target
        binary = target / 'debug' / ('backend.exe' if os.name == 'nt' else 'backend')
    mock = ThreadingHTTPServer(('127.0.0.1', 0), WecomMock)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='little-gate-wecom-') as tmp:
            directory = Path(tmp)
            port = free_port()
            db = directory / 'gateway.sqlite'
            env = {**os.environ, 'LISTEN_ADDR': f'127.0.0.1:{port}', 'DB_DSN': f'sqlite://{db}',
                   'ADMIN_TOKEN': ADMIN, 'MASTER_KEY': 'offline-wecom-master', 'PRICE_SYNC_ENABLED': 'false',
                   'STATS_FLUSH_INTERVAL_MS': '100', 'REQUEST_LOG_ARCHIVE_DIR': str(directory / 'archive'),
                   'CODEX_OAUTH_CALLBACK_LISTEN_ADDR': '127.0.0.1:1455', 'STATIC_DIR': str(directory / 'static'),
                   'UPSTREAM_CACHE_TTL_MS': '1', 'UPSTREAM_CACHE_STALE_GRACE_MS': '0'}
            with open(directory / 'gateway.log', 'w+', encoding='utf-8') as log:
                process = subprocess.Popen([str(binary)], cwd=directory, env=env, stdout=log, stderr=log)
                try:
                    test = Regression(port, db, mock.server_port)
                    deadline = time.monotonic() + 15
                    while True:
                        assert process.poll() is None, 'gateway exited during startup'
                        try:
                            test.api('GET', '/providers')
                            break
                        except (OSError, http.client.HTTPException):
                            if time.monotonic() > deadline:
                                raise
                            time.sleep(0.1)
                    check(test)
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
