#!/usr/bin/env python3
import argparse
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


def parse_args():
    parser = argparse.ArgumentParser(description='Local mock upstream for little-gate validation.')
    parser.add_argument('--listen', default='127.0.0.1:19090')
    parser.add_argument('--default-format', choices=['chat', 'responses', 'messages'], default='chat')
    parser.add_argument('--default-status', type=int, default=200)
    parser.add_argument('--default-body-text', default='mock-ok')
    parser.add_argument('--default-auth', default='')
    parser.add_argument('--default-delay-ms', type=int, default=0)
    parser.add_argument(
        '--route',
        action='append',
        default=[],
        help='path_prefix|status|body_text|auth|delay_ms|format|error_type',
    )
    parser.add_argument('--models-chat', default='gpt-4o-mini,gpt-4.1-mini')
    parser.add_argument('--models-responses', default='gpt-4.1-mini')
    parser.add_argument('--models-messages', default='claude-sonnet-4-5')
    return parser.parse_args()


class RouteConfig:
    def __init__(self, path_prefix, status, body_text, auth, delay_ms, response_format, error_type):
        self.path_prefix = path_prefix
        self.status = status
        self.body_text = body_text
        self.auth = auth
        self.delay_ms = delay_ms
        self.response_format = response_format
        self.error_type = error_type
        self.hits = 0


class MockState:
    def __init__(self, default_route, routes):
        self.default_route = default_route
        self.routes = routes
        self.lock = threading.Lock()
        self.recent_requests = []

    def resolve(self, path):
        for route in self.routes:
            if path.startswith(route.path_prefix):
                return route
        return self.default_route

    def note_hit(self, route):
        with self.lock:
            route.hits += 1

    def note_request(self, method, path, payload, headers):
        with self.lock:
            self.recent_requests.append({
                'method': method,
                'path': path,
                'model': payload.get('model'),
                'stream': payload.get('stream', False),
                'prompt_cache_key': payload.get('prompt_cache_key'),
                'session_id': headers.get('session-id'),
                'authorization': headers.get('Authorization'),
                'x_api_key': headers.get('x-api-key'),
                'anthropic_version': headers.get('anthropic-version'),
                'anthropic_beta': headers.get('anthropic-beta'),
                'payload': payload,
            })
            self.recent_requests = self.recent_requests[-20:]

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
                    'error_type': route.error_type,
                    'hits': route.hits,
                })
            return {
                'routes': items,
                'recent_requests': list(self.recent_requests),
            }


def parse_route(raw, default_format):
    parts = raw.split('|')
    while len(parts) < 7:
        parts.append('')
    path_prefix, status, body_text, auth, delay_ms, response_format, error_type = parts[:7]
    if not path_prefix:
        raise ValueError(f'invalid route, missing path_prefix: {raw}')
    return RouteConfig(
        path_prefix=path_prefix,
        status=int(status or 200),
        body_text=body_text or 'mock-ok',
        auth=auth or '',
        delay_ms=int(delay_ms or 0),
        response_format=(response_format or default_format),
        error_type=error_type or '',
    )


class MockHandler(BaseHTTPRequestHandler):
    server_version = 'little-gate-mock/0.1'
    protocol_version = 'HTTP/1.1'

    def setup(self):
        super().setup()
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.endswith('/models'):
            self.server.state.note_request('GET', self.path, {}, self.headers)
            return self.handle_models(parsed.path, parsed.query)
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
        api_key = self.headers.get('x-api-key', '')
        try:
            payload = json.loads(body.decode('utf-8')) if body else {}
        except Exception:
            payload = {}
        self.server.state.note_request('POST', path, payload, self.headers)

        if route.delay_ms > 0:
            time.sleep(route.delay_ms / 1000.0)

        if route.auth and auth != f'Bearer {route.auth}' and api_key != route.auth:
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
                    'type': route.error_type or f'http_{route.status}',
                }
            })
            return

        response_format = route.response_format
        is_messages = path.endswith('/messages') or path.endswith('/messages/count_tokens')
        if is_messages and path.endswith('/messages/count_tokens'):
            self.respond_json(200, {'input_tokens': 42})
        elif is_messages:
            if payload.get('stream'):
                self.respond_messages_sse(route.body_text, payload)
            else:
                self.respond_json(200, build_messages_body(route.body_text, body))
        elif payload.get('stream') and response_format == 'chat' and not path.endswith('/responses'):
            self.respond_chat_sse(route.body_text, payload)
        elif response_format == 'responses' or path.endswith('/responses'):
            self.respond_json(200, build_responses_body(route.body_text, body))
        else:
            self.respond_json(200, build_chat_body(route.body_text, body))

    def log_message(self, fmt, *args):
        return

    def handle_stats(self):
        snapshot = self.server.state.snapshot()
        snapshot['time_ms'] = int(time.time() * 1000)
        self.respond_json(200, snapshot)

    def handle_models(self, path, query_raw):
        route = self.server.state.resolve(path)
        self.server.state.note_hit(route)
        if route.delay_ms > 0:
            time.sleep(route.delay_ms / 1000.0)
        auth = self.headers.get('Authorization', '')
        api_key = self.headers.get('x-api-key', '')
        if route.auth and auth != f'Bearer {route.auth}' and api_key != route.auth:
            self.respond_json(401, {
                'error': {
                    'message': 'invalid upstream credential',
                    'type': 'invalid_api_key',
                }
            }, {
                'X-Upstream-Error': 'authentication-failed',
                'Set-Cookie': 'upstream_session=unsafe',
                'Connection': 'X-Remove-Me',
                'X-Remove-Me': 'unsafe',
            })
            return
        if route.status >= 400:
            self.respond_json(route.status, {
                'error': {
                    'message': route.body_text,
                    'type': route.error_type or f'http_{route.status}',
                }
            })
            return
        query = parse_qs(query_raw)
        requested_format = (query.get('api_format') or [route.response_format])[0]
        if self.headers.get('anthropic-version') or (api_key and not auth):
            models = self.server.messages_models
            data = [
                {
                    'type': 'model',
                    'id': model_id,
                    'display_name': model_id,
                    'created_at': '1970-01-01T00:00:00Z',
                }
                for model_id in models
            ]
            self.respond_json(200, {
                'data': data,
                'has_more': False,
                'first_id': models[0] if models else None,
                'last_id': models[-1] if models else None,
            })
            return
        models = (
            self.server.responses_models
            if requested_format == 'responses'
            else self.server.chat_models
        )
        data = [
            {
                'id': model_id,
                'object': 'model',
                'created': 0,
                'owned_by': 'mock-upstream',
            }
            for model_id in models
        ]
        self.respond_json(200, {
            'object': 'list',
            'data': data,
        })

    def respond_not_found(self):
        self.respond_json(404, {'error': {'message': 'not found', 'type': 'not_found'}})

    def respond_json(self, status, payload, headers=None):
        raw = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(raw)

    def respond_messages_sse(self, body_text, payload):
        model = payload.get('model') or 'unknown'
        has_tool_output = any(
            isinstance(message, dict)
            and any(
                isinstance(block, dict) and block.get('type') == 'tool_result'
                for block in (message.get('content') if isinstance(message.get('content'), list) else [])
            )
            for message in payload.get('messages', [])
        )
        tools = payload.get('tools') or []
        events = [
            {
                'type': 'message_start',
                'message': {
                    'id': 'msg_mock_stream',
                    'type': 'message',
                    'role': 'assistant',
                    'model': model,
                    'content': [],
                    'stop_reason': None,
                    'usage': {
                        'input_tokens': 10,
                        'output_tokens': 1,
                        'cache_read_input_tokens': 90,
                        'cache_creation_input_tokens': 3,
                    },
                },
            },
            {
                'type': 'content_block_start',
                'index': 0,
                'content_block': {'type': 'text', 'text': ''},
            },
        ]
        if tools and not has_tool_output:
            name = tools[0].get('name') or 'mock_tool'
            arguments = json.dumps({'input': 'mock'}, separators=(',', ':'))
            mid = max(1, len(arguments) // 2)
            events.extend([
                {
                    'type': 'content_block_delta',
                    'index': 0,
                    'delta': {'type': 'text_delta', 'text': 'calling '},
                },
                {'type': 'content_block_stop', 'index': 0},
                {
                    'type': 'content_block_start',
                    'index': 1,
                    'content_block': {
                        'type': 'tool_use',
                        'id': 'tool_mock_1',
                        'name': name,
                        'input': {},
                    },
                },
                {
                    'type': 'content_block_delta',
                    'index': 1,
                    'delta': {'type': 'input_json_delta', 'partial_json': arguments[:mid]},
                },
                {
                    'type': 'content_block_delta',
                    'index': 1,
                    'delta': {'type': 'input_json_delta', 'partial_json': arguments[mid:]},
                },
                {'type': 'content_block_stop', 'index': 1},
                {
                    'type': 'message_delta',
                    'delta': {'stop_reason': 'tool_use', 'stop_sequence': None},
                    'usage': {'output_tokens': 5},
                },
            ])
        else:
            mid = max(1, len(body_text) // 2)
            for text in (body_text[:mid], body_text[mid:]):
                if text:
                    events.append({
                        'type': 'content_block_delta',
                        'index': 0,
                        'delta': {'type': 'text_delta', 'text': text},
                    })
            events.extend([
                {'type': 'content_block_stop', 'index': 0},
                {
                    'type': 'message_delta',
                    'delta': {'stop_reason': 'end_turn', 'stop_sequence': None},
                    'usage': {'output_tokens': 5},
                },
            ])
        events.append({'type': 'message_stop'})
        raw = ''.join(
            f'event: {event["type"]}\r\ndata: {json.dumps(event, ensure_ascii=False)}\r\n\r\n'
            for event in events
        ).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        for offset in range(0, len(raw), 23):
            self.wfile.write(raw[offset:offset + 23])
            self.wfile.flush()

    def respond_chat_sse(self, body_text, payload):
        model = payload.get('model') or 'unknown'
        has_tool_output = any(
            message.get('role') == 'tool'
            for message in payload.get('messages', [])
            if isinstance(message, dict)
        )
        tools = payload.get('tools') or []
        chunks = [{
            'id': 'chatcmpl-mock-stream',
            'object': 'chat.completion.chunk',
            'created': int(time.time()),
            'model': model,
            'choices': [{'index': 0, 'delta': {'role': 'assistant'}, 'finish_reason': None}],
        }]
        if tools and not has_tool_output:
            function = tools[0].get('function', {})
            name = function.get('name', 'mock_tool')
            properties = function.get('parameters', {}).get('properties', {})
            if 'cmd' in properties:
                arguments = json.dumps({'cmd': 'echo mock'}, separators=(',', ':'))
            elif 'command' in properties:
                arguments = json.dumps({'command': 'echo mock'}, separators=(',', ':'))
            else:
                arguments = json.dumps({'input': 'echo mock'}, separators=(',', ':'))
            midpoint = max(1, len(arguments) // 2)
            chunks.extend([
                {
                    'id': 'chatcmpl-mock-stream',
                    'object': 'chat.completion.chunk',
                    'created': int(time.time()),
                    'model': model,
                    'choices': [{'index': 0, 'delta': {'tool_calls': [{
                        'index': 0,
                        'id': 'call_mock_1',
                        'type': 'function',
                        'function': {'name': name, 'arguments': arguments[:midpoint]},
                    }]}, 'finish_reason': None}],
                },
                {
                    'id': 'chatcmpl-mock-stream',
                    'object': 'chat.completion.chunk',
                    'created': int(time.time()),
                    'model': model,
                    'choices': [{'index': 0, 'delta': {'tool_calls': [{
                        'index': 0,
                        'function': {'arguments': arguments[midpoint:]},
                    }]}, 'finish_reason': 'tool_calls'}],
                },
            ])
        else:
            midpoint = max(1, len(body_text) // 2)
            for text in (body_text[:midpoint], body_text[midpoint:]):
                if text:
                    chunks.append({
                        'id': 'chatcmpl-mock-stream',
                        'object': 'chat.completion.chunk',
                        'created': int(time.time()),
                        'model': model,
                        'choices': [{'index': 0, 'delta': {'content': text}, 'finish_reason': None}],
                    })
            chunks.append({
                'id': 'chatcmpl-mock-stream',
                'object': 'chat.completion.chunk',
                'created': int(time.time()),
                'model': model,
                'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}],
            })
        chunks.append({
            'id': 'chatcmpl-mock-stream',
            'object': 'chat.completion.chunk',
            'created': int(time.time()),
            'model': model,
            'choices': [],
            'usage': {
                'prompt_tokens': 12,
                'completion_tokens': 5,
                'total_tokens': 17,
                'prompt_tokens_details': {'cached_tokens': 2, 'cache_creation_tokens': 1},
            },
        })
        events = ''.join(
            f'data: {json.dumps(chunk, ensure_ascii=False)}\r\n\r\n'
            for chunk in chunks
        ) + 'data: [DONE]\r\n\r\n'
        raw = events.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        for offset in range(0, len(raw), 17):
            self.wfile.write(raw[offset:offset + 17])
            self.wfile.flush()


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


def build_messages_body(body_text, request_body):
    model = 'unknown'
    try:
        payload = json.loads(request_body.decode('utf-8')) if request_body else {}
        model = payload.get('model') or model
    except Exception:
        payload = {}
    return {
        'id': 'msg_mock',
        'type': 'message',
        'role': 'assistant',
        'model': model,
        'content': [{'type': 'text', 'text': body_text}],
        'stop_reason': 'end_turn',
        'stop_sequence': None,
        'usage': {
            'input_tokens': 10,
            'output_tokens': 5,
            'cache_read_input_tokens': 90,
            'cache_creation_input_tokens': 3,
            'output_tokens_details': {'thinking_tokens': 2},
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


def parse_models(raw):
    out = []
    for item in raw.split(','):
        model = item.strip()
        if model:
            out.append(model)
    return out


def main():
    args = parse_args()
    host, port = args.listen.rsplit(':', 1)
    default_route = RouteConfig(
        '/',
        args.default_status,
        args.default_body_text,
        args.default_auth,
        args.default_delay_ms,
        args.default_format,
        '',
    )
    routes = [parse_route(item, args.default_format) for item in args.route]
    server = ThreadingHTTPServer((host, int(port)), MockHandler)
    server.state = MockState(default_route, routes)
    server.default_model_format = args.default_format
    server.chat_models = parse_models(args.models_chat)
    server.responses_models = parse_models(args.models_responses)
    server.messages_models = parse_models(args.models_messages)
    print(f'mock upstream listening on http://{args.listen}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
