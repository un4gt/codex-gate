#!/usr/bin/env python3
import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


def parse_args():
    parser = argparse.ArgumentParser(description='Local mock upstream for codex-gate validation.')
    parser.add_argument('--listen', default='127.0.0.1:19090')
    parser.add_argument('--default-format', choices=['chat', 'responses'], default='chat')
    parser.add_argument('--default-status', type=int, default=200)
    parser.add_argument('--default-body-text', default='mock-ok')
    parser.add_argument('--default-auth', default='')
    parser.add_argument('--default-delay-ms', type=int, default=0)
    parser.add_argument('--route', action='append', default=[], help='path_prefix|status|body_text|auth|delay_ms|format')
    return parser.parse_args()


class RouteConfig:
    def __init__(self, path_prefix, status, body_text, auth, delay_ms, response_format):
        self.path_prefix = path_prefix
        self.status = status
        self.body_text = body_text
        self.auth = auth
        self.delay_ms = delay_ms
        self.response_format = response_format
        self.hits = 0


class MockState:
    def __init__(self, default_route, routes):
        self.default_route = default_route
        self.routes = routes
        self.lock = threading.Lock()

    def resolve(self, path):
        for route in self.routes:
            if path.startswith(route.path_prefix):
                return route
        return self.default_route

    def note_hit(self, route):
        with self.lock:
            route.hits += 1

    def snapshot(self):
        with self.lock:
            items = []
            for route in self.routes + [self.default_route]:
                items.append({
                    'path_prefix': route.path_prefix,
                    'status': route.status,
                    'body_text': route.body_text,
                    'auth': route.auth,
                    'delay_ms': route.delay_ms,
                    'response_format': route.response_format,
                    'hits': route.hits,
                })
            return items


def parse_route(raw, default_format):
    parts = raw.split('|')
    while len(parts) < 6:
        parts.append('')
    path_prefix, status, body_text, auth, delay_ms, response_format = parts[:6]
    if not path_prefix:
        raise ValueError(f'invalid route, missing path_prefix: {raw}')
    return RouteConfig(
        path_prefix=path_prefix,
        status=int(status or 200),
        body_text=body_text or 'mock-ok',
        auth=auth or '',
        delay_ms=int(delay_ms or 0),
        response_format=(response_format or default_format),
    )


class MockHandler(BaseHTTPRequestHandler):
    server_version = 'codex-gate-mock/0.1'

    def do_GET(self):
        if self.path.startswith('/__admin/stats'):
            return self.handle_stats()
        self.respond_not_found()

    def do_POST(self):
        path = urlparse(self.path).path
        route = self.server.state.resolve(path)
        self.server.state.note_hit(route)

        content_length = int(self.headers.get('Content-Length', '0') or '0')
        body = self.rfile.read(content_length) if content_length > 0 else b''
        auth = self.headers.get('Authorization', '')

        if route.delay_ms > 0:
            time.sleep(route.delay_ms / 1000.0)

        if route.auth and auth != f'Bearer {route.auth}':
            self.respond_json(401, {
                'error': {
                    'message': 'invalid upstream credential',
                    'type': 'invalid_api_key',
                }
            })
            return

        if route.status >= 400:
            self.respond_json(route.status, {
                'error': {
                    'message': route.body_text,
                    'type': f'http_{route.status}',
                }
            })
            return

        response_format = route.response_format
        if response_format == 'responses' or path.endswith('/responses'):
            self.respond_json(200, build_responses_body(route.body_text, body))
        else:
            self.respond_json(200, build_chat_body(route.body_text, body))

    def log_message(self, fmt, *args):
        return

    def handle_stats(self):
        self.respond_json(200, {
            'routes': self.server.state.snapshot(),
            'time_ms': int(time.time() * 1000),
        })

    def respond_not_found(self):
        self.respond_json(404, {'error': {'message': 'not found', 'type': 'not_found'}})

    def respond_json(self, status, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def build_chat_body(body_text, request_body):
    model = 'unknown'
    try:
        payload = json.loads(request_body.decode('utf-8')) if request_body else {}
        model = payload.get('model') or model
    except Exception:
        payload = {}
    return {
        'id': 'chatcmpl-mock',
        'object': 'chat.completion',
        'created': int(time.time()),
        'model': model,
        'choices': [
            {
                'index': 0,
                'finish_reason': 'stop',
                'message': {
                    'role': 'assistant',
                    'content': body_text,
                },
            }
        ],
        'usage': {
            'prompt_tokens': 12,
            'completion_tokens': 5,
            'total_tokens': 17,
            'prompt_tokens_details': {
                'cached_tokens': 2,
                'cache_creation_tokens': 1,
            },
        },
    }


def build_responses_body(body_text, request_body):
    model = 'unknown'
    try:
        payload = json.loads(request_body.decode('utf-8')) if request_body else {}
        model = payload.get('model') or model
    except Exception:
        payload = {}
    return {
        'id': 'resp-mock',
        'object': 'response',
        'created_at': int(time.time()),
        'model': model,
        'output': [
            {
                'type': 'message',
                'role': 'assistant',
                'content': [
                    {
                        'type': 'output_text',
                        'text': body_text,
                    }
                ],
            }
        ],
        'usage': {
            'input_tokens': 9,
            'output_tokens': 4,
            'input_tokens_details': {
                'cached_tokens': 1,
                'cache_creation_tokens': 1,
            },
        },
    }


def main():
    args = parse_args()
    host, port = args.listen.rsplit(':', 1)
    default_route = RouteConfig('/', args.default_status, args.default_body_text, args.default_auth, args.default_delay_ms, args.default_format)
    routes = [parse_route(item, args.default_format) for item in args.route]
    server = ThreadingHTTPServer((host, int(port)), MockHandler)
    server.state = MockState(default_route, routes)
    print(f'mock upstream listening on http://{args.listen}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
