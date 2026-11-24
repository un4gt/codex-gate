"""Deterministic Responses mock and disposable gateway for the Harbor task."""
import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

LAB = Path("/opt/responses-fixture")
TRACE = Path("/tmp/responses-fixture-trace.jsonl")
COUNT_TRACE = Path("/tmp/responses-fixture-counts.jsonl")
CHECKS = Path("/tmp/responses-fixture-checks.json")
GATEWAY = "http://127.0.0.1:8184"
MOCK = "http://127.0.0.1:8185"
ADMIN = "harbor-local-fixture-admin"
UPSTREAM_KEY = "harbor-local-fixture-upstream"
SETTINGS = json.loads((LAB / "settings.gpt.json").read_text())
PROFILE = SETTINGS["env"]
MODEL = f"fixture-{SETTINGS['model']}"
ALIASES = {f"fixture-{tier.lower()}": PROFILE[f"ANTHROPIC_DEFAULT_{tier}_MODEL"]
           for tier in ("OPUS", "SONNET", "HAIKU") if f"ANTHROPIC_DEFAULT_{tier}_MODEL" in PROFILE}
ALIAS = ALIASES[MODEL]
COUNT_MODEL = "fixture-count-shared"
COUNT_ERRORS = {
    "unsupported": (404, "endpoint_not_found", "count_tokens endpoint not found"),
    "model": (404, "model_not_found", "fixture model unavailable for counting"),
    "auth": (401, "invalid_api_key", "fixture count authentication failure"),
    "rate": (429, "rate_limit_exceeded", "fixture count rate limit"),
    "invalid": (200, None, None),
    "slow": (504, None, None),
}
ZERO_USAGE = {"input_tokens": 0, "output_tokens": 0}
USAGE_CASES = {
    "json-missing": (False, None, None, False),
    "json-zero": (False, None, ZERO_USAGE, False),
    "json-partial": (False, None, {"input_tokens": 998, "completion_tokens": 999}, False),
    "sse-missing": (True, None, None, False),
    "sse-zero": (True, None, ZERO_USAGE, False),
    "sse-replace": (True, {"input_tokens": 21, "output_tokens": 1}, {"input_tokens": 22, "output_tokens": 2}, False),
    "sse-partial": (True, {"input_tokens": 31, "output_tokens": 3}, {"input_tokens": 997}, False),
    "sse-interrupted": (True, {"input_tokens": 41, "output_tokens": 4}, None, True),
}
TOOLS = (
    ("Read", {"file_path": "/app/calc.py"}),
    ("Read", {"file_path": "/app/expected.txt"}),
    ("Edit", {"file_path": "/app/calc.py", "old_string": "return a - b", "new_string": "return a + b", "replace_all": False}),
    ("Bash", {
        "command": (
            "python3 -c 'from calc import add; assert add(2, 3) == 5; "
            "assert add(0, 0) == 0; assert add(-4, -5) == -9; print(\"HARNESS_OK\")'"
        ),
        "description": "Verify addition",
    }),
)


def api(path, method="GET", payload=None, *, headers=None):
    request = Request(GATEWAY + path, method=method,
                      data=None if payload is None else json.dumps(payload).encode(),
                      headers={"Content-Type": "application/json", **(headers or {"Authorization": f"Bearer {ADMIN}"})})
    with urlopen(request, timeout=5) as response:
        return json.load(response)


def client_headers(providers):
    token = api("/api/v1/api-keys", "POST", {
        "name": "Harbor client", "enabled": True, "logEnabled": True, "allowed_provider_ids": providers,
    })["api_key"]
    return {"x-api-key": token, "anthropic-version": "2023-06-01"}


def create_provider(name, *, native=False, aliases=None):
    provider = api("/api/v1/providers", "POST", {
        "name": f"Harbor {name or 'Responses'} fixture", "enabled": True,
        "providerType": "anthropic" if native else "openai_compatible_responses",
        "maxAttempts": 1, **({"request_timeout_ms": 1000} if name == "slow" else {}),
    })["id"]
    base = f"/api/v1/providers/{provider}"
    path = f"/{name}/v1" if name else "/v1"
    api(base + "/endpoints", "POST", {"name": "Local mock", "baseUrl": MOCK + path, "enabled": True})
    api(base + "/keys", "POST", {"name": "Fixture key", "secret": UPSTREAM_KEY, "enabled": True})
    inventory = api(base + "/models/sync", "POST", {})
    if not native:
        for model in inventory:
            patch = {"messages_via_responses_enabled": True}
            if aliases and model["upstream_model"] in aliases:
                patch["alias"] = aliases[model["upstream_model"]]
            api(f"/api/v1/provider-models/{model['id']}", "PATCH", patch)
    return provider


def count_checks(responses, native, disabled, failing, headers):
    count_request = {
        "model": ALIAS,
        "system": [{"type": "text", "text": "Count the structured prompt"}],
        "messages": [
            {"role": "user", "content": "Prior turn"},
            {"role": "assistant", "content": [{"type": "tool_use", "id": "call_count", "name": "Lookup", "input": {"q": "x"}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "call_count", "content": "answer"}]},
        ],
        "tools": [{"name": "Lookup", "input_schema": {"type": "object", "properties": {"q": {"type": "string"}}}}],
        "tool_choice": {"type": "tool", "name": "Lookup"},
    }
    count_path = "/v1/messages/count_tokens"
    assert api(count_path, "POST", count_request, headers=headers) == {"input_tokens": 0}
    check_cases = ["responses_zero"]
    expected_paths = ["/v1/responses/input_tokens"]
    common = {"model": COUNT_MODEL, "messages": [{"role": "user", "content": "Protocol smoke check"}]}

    def check(name, providers, paths, *, input_tokens=None, status=200):
        request_headers = client_headers(providers)
        try:
            result = api(count_path, "POST", common, headers=request_headers)
        except HTTPError as error:
            assert error.code == status and json.load(error)["type"] == "error", (name, error.code)
        else:
            assert status == 200, (name, result)
            if input_tokens is not None:
                assert result == {"input_tokens": input_tokens}, (name, result)
            else:
                assert result["input_tokens"] > 0, (name, result)
        check_cases.append(name)
        expected_paths.extend(paths)
        calls = [json.loads(line)["path"] for line in COUNT_TRACE.read_text().splitlines()]
        assert calls == expected_paths, (name, calls, expected_paths)
        return request_headers

    check("native_first", [native, responses], ["/native/v1/messages/count_tokens"], input_tokens=67)
    check("compatible_opt_out", [disabled], [])
    check("unsupported_fallback", [failing["unsupported"]], ["/unsupported/v1/responses/input_tokens"])
    check("model_error", [failing["model"]], ["/model/v1/responses/input_tokens"], status=404)
    auth_headers = check("auth_then_unsupported", [failing["auth"], failing["unsupported"]],
                         ["/auth/v1/responses/input_tokens", "/unsupported/v1/responses/input_tokens"], status=401)
    message = api("/v1/messages", "POST", {**common, "max_tokens": 32}, headers=auth_headers)
    assert message["content"][0]["text"] == "ready", "count failure affected generation"
    check_cases.append("generation_after_failed_count")
    for mode in ("rate", "invalid", "slow"):
        check(f"{mode}_failover", [failing[mode], responses],
              [f"/{mode}/v1/responses/input_tokens", "/v1/responses/input_tokens"], input_tokens=79)
    return check_cases


def configure_gateway():
    for _ in range(50):
        try:
            api("/readyz")
            break
        except (URLError, json.JSONDecodeError):
            # /readyz can return a plain health string.
            try:
                with urlopen(GATEWAY + "/readyz", timeout=1) as response:
                    if response.status == 200:
                        break
            except URLError:
                pass
            time.sleep(0.2)
    else:
        raise RuntimeError("gateway readiness timed out")
    failing = {name: create_provider(name) for name in ("auth", "unsupported", "model", "rate", "invalid", "slow")}
    disabled = create_provider("disabled")
    provider = create_provider("", aliases=ALIASES)
    native = create_provider("native", native=True)
    api("/api/v1/model-route-policies", "PUT", {
        "model_name": COUNT_MODEL, "mode": "ordered", "failover": True, "sticky": False,
        "targets": [{"provider_id": candidate, "priority": priority, "weight": 1}
                    for priority, candidate in enumerate([*failing.values(), disabled, provider, native])],
    })
    headers = client_headers([provider])
    models = api("/v1/models", headers=headers)
    assert set(ALIASES.values()) <= {model["id"] for model in models["data"]}, "converted model missing from Messages catalog"
    checks = {"count_tokens": count_checks(provider, native, disabled, failing, headers)}
    request_body = {"model": ALIAS, "messages": [{"role": "user", "content": "Protocol smoke check"}]}
    message = api("/v1/messages", "POST", {**request_body, "max_tokens": 32}, headers=headers)
    assert message["model"] == ALIAS and message["content"][0]["text"] == "ready"
    assert message["usage"]["input_tokens"] == 8 and message["usage"]["cache_read_input_tokens"] == 4
    checks["interleaving"] = check_interleaving(headers)
    # The interrupted stream exercises generation health on a different endpoint from the CLI.
    checks["usage"] = check_usage(client_headers([disabled]), COUNT_MODEL)
    checks["profile_models"] = ALIASES
    checks["selected_model"] = ALIAS
    CHECKS.write_text(json.dumps(checks), encoding="utf-8")
    temporary = Path("/tmp/responses-fixture-client-key.tmp")
    temporary.write_text(headers["x-api-key"], encoding="utf-8")
    temporary.replace("/tmp/responses-fixture-client-key")


def message_item(text, round_index):
    return {"id": f"msg_fixture_{round_index}", "type": "message", "role": "assistant",
            "status": "completed", "content": [{"type": "output_text", "text": text, "annotations": []}]}


def response(output, round_index, request):
    timestamp = int(time.time())
    return {
        "id": f"resp_fixture_{round_index}", "object": "response",
        "created_at": timestamp, "completed_at": timestamp, "model": request["model"],
        "status": "completed", "incomplete_details": None, "error": None,
        "previous_response_id": None, "instructions": request.get("instructions"), "output": output,
        "tools": [{"description": None, **tool} for tool in request.get("tools", [])],
        "tool_choice": request.get("tool_choice", "auto"), "truncation": "disabled",
        "parallel_tool_calls": request.get("parallel_tool_calls", True),
        "text": {"format": {"type": "text"}}, "top_p": 1, "temperature": 1,
        "presence_penalty": 0, "frequency_penalty": 0, "top_logprobs": 0, "reasoning": None,
        "usage": {"input_tokens": 12, "input_tokens_details": {"cached_tokens": 4},
                  "output_tokens": 3, "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 15},
        "max_output_tokens": request["max_output_tokens"], "max_tool_calls": None,
        "store": False, "background": False, "service_tier": "default", "metadata": {},
        "safety_identifier": None, "prompt_cache_key": request.get("prompt_cache_key"),
    }


def item_events(index, item):
    fields = {"item_id": item["id"], "output_index": index}
    if item["type"] == "message":
        part = item["content"][0]
        fields["content_index"] = 0
        yield "response.output_item.added", {"output_index": index, "item": {**item, "status": "in_progress", "content": []}}
        yield "response.content_part.added", {**fields, "part": {**part, "text": ""}}
        midpoint = len(part["text"]) // 2
        for delta in (part["text"][:midpoint], part["text"][midpoint:]):
            yield "response.output_text.delta", {**fields, "delta": delta}
        yield "response.output_text.done", {**fields, "text": part["text"]}
        yield "response.content_part.done", {**fields, "part": part}
    else:
        yield "response.output_item.added", {"output_index": index, "item": {**item, "status": "in_progress", "arguments": ""}}
        arguments = item["arguments"]
        midpoint = len(arguments) // 2
        for delta in (arguments[:midpoint], arguments[midpoint:]):
            yield "response.function_call_arguments.delta", {**fields, "delta": delta}
        yield "response.function_call_arguments.done", {**fields, "arguments": arguments}
    yield "response.output_item.done", {"output_index": index, "item": item}


def stream_events(result, *, first=None, initial_usage=None, truncated=False):
    initial = {**result, "status": "in_progress", "completed_at": None, "output": [], "usage": initial_usage}
    yield "response.created", {"response": initial}
    yield "response.in_progress", {"response": initial}
    items = [list(item_events(index, item)) for index, item in enumerate(result["output"])]
    if first:
        a, b, text = items
        yield from a[:2]
        yield from b[:2]
        earlier, later = (a, b) if first == "A" else (b, a)
        yield from earlier[2:]
        yield from text
        yield from later[2:]
    else:
        for frames in items:
            yield from frames
    if not truncated:
        yield "response.completed", {"response": result}


def tool_item(index):
    name, arguments = TOOLS[index]
    return {"type": "function_call", "id": f"fc_fixture_{index}", "status": "completed",
            "call_id": f"call_fixture_{index}", "name": name, "arguments": json.dumps(arguments)}


def read_round():
    return [tool_item(0), tool_item(1), message_item("I will read both files first.", 0)]


def response_for_request(body):
    assert body["model"] in (MODEL, COUNT_MODEL) and body["store"] is False and body["max_output_tokens"] > 0
    assert isinstance(body["input"], list)
    probe = body["input"][-1].get("content", [{}])[0].get("text", "")
    if probe in USAGE_CASES:
        result = response([message_item("usage probe", probe)], probe, body)
        result["usage"] = USAGE_CASES[probe][2]
        return result, {"initial_usage": USAGE_CASES[probe][1], "truncated": USAGE_CASES[probe][3]}
    if probe in ("interleaving-A", "interleaving-B"):
        return response(read_round(), probe, body), {"first": probe[-1]}
    if not body["stream"]:
        assert probe == "Protocol smoke check"
        return response([message_item("ready", "smoke")], "smoke", body), {}

    assert isinstance(body["instructions"], str) and body["instructions"]
    definitions = {tool["name"] for tool in body["tools"] if tool["type"] == "function" and isinstance(tool["parameters"], dict)}
    assert {name for name, _ in TOOLS} <= definitions, "required tool schemas are missing"
    outputs = {item["call_id"]: item["output"] for item in body["input"]
               if item["type"] == "function_call_output" and item["call_id"].startswith("call_fixture_")}
    history = {item["call_id"]: item for item in body["input"] if item["type"] == "function_call"}
    round_index = len(outputs)
    assert round_index in (0, 2, 3, 4), "unexpected or incomplete tool results"
    for index, expected in enumerate(("return a - b", "HARNESS_EXPECTED_ADDITION", "calc.py", "HARNESS_OK")[:round_index]):
        call_id = f"call_fixture_{index}"
        assert history[call_id]["name"] == TOOLS[index][0], f"wrong tool name for {call_id}"
        assert json.loads(history[call_id]["arguments"]) == TOOLS[index][1], f"wrong tool arguments for {call_id}"
        assert expected in json.dumps(outputs[call_id]), f"unexpected tool result for {call_id}"

    if round_index == 0:
        output = read_round()
    elif round_index < len(TOOLS):
        output = [tool_item(round_index)]
    else:
        output = [message_item("I fixed add and verified it with the local Python check.", round_index)]
    with TRACE.open("a", encoding="utf-8") as trace:
        trace.write(json.dumps({"results_received": round_index, "tools": [item["name"] for item in output if item["type"] == "function_call"],
                                "replayed_call_ids": list(outputs),
                                "max_output_tokens": body["max_output_tokens"],
                                "terminal": "response.completed", "stream": True}) + "\n")
    return response(output, round_index, body), {"first": "B"} if round_index == 0 else {}


def read_messages_stream(prompt, headers, model=ALIAS):
    body = {"model": model, "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 32, "stream": True}
    request = Request(GATEWAY + "/v1/messages", method="POST", data=json.dumps(body).encode(),
                      headers={"Content-Type": "application/json", **headers})
    with urlopen(request, timeout=5) as stream:
        return [json.loads(line[6:]) for line in stream if line.startswith(b"data: ")]


def check_interleaving(headers):
    for first in ("A", "B"):
        frames = read_messages_stream(f"interleaving-{first}", headers)
        assert frames[0]["type"] == "message_start" and frames[-1]["type"] == "message_stop", frames
        active = None
        blocks = []
        for frame in frames[1:-2]:
            index = frame["index"]
            match frame["type"]:
                case "content_block_start":
                    assert active is None and index == len(blocks), frame
                    active = index
                    blocks.append((frame["content_block"], []))
                case "content_block_delta":
                    assert index == active, frame
                    blocks[active][1].append(frame["delta"])
                case "content_block_stop":
                    assert index == active, frame
                    active = None
                case _:
                    raise AssertionError(frame)
        assert active is None and len(blocks) == 3, blocks
        for index, (block, deltas) in enumerate(blocks[:2]):
            assert block["type"] == "tool_use" and block["id"] == f"call_fixture_{index}", block
            assert json.loads("".join(delta["partial_json"] for delta in deltas)) == TOOLS[index][1], deltas
        block, deltas = blocks[2]
        assert block["type"] == "text" and "".join(delta["text"] for delta in deltas) == "I will read both files first."
        assert frames[-2]["delta"]["stop_reason"] == "tool_use", frames[-2]
    return ["A_finishes_first", "B_finishes_first"]


def check_usage(headers, model):
    for name, (streaming, initial, terminal, truncated) in USAGE_CASES.items():
        if streaming:
            frames = read_messages_stream(name, headers, model)
            if truncated:
                assert frames[-1]["type"] == "error", frames
                assert not any(frame["type"] == "message_stop" for frame in frames), frames
                usage = frames[0]["message"]["usage"]
            else:
                assert frames[-1]["type"] == "message_stop", frames
                usage = frames[-2]["usage"]
        else:
            body = {"model": model, "messages": [{"role": "user", "content": name}], "max_tokens": 32}
            usage = api("/v1/messages", "POST", body, headers=headers)["usage"]
        expected = terminal if terminal and "output_tokens" in terminal else initial or ZERO_USAGE
        assert (usage["input_tokens"], usage["output_tokens"]) == (expected["input_tokens"], expected["output_tokens"]), (name, usage)
    return list(USAGE_CASES)


class Mock(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path.endswith("/v1/models"):
            models = [COUNT_MODEL, *ALIASES] if path == "/v1/models" else [COUNT_MODEL]
            self.reply(200, {"object": "list", "data": [{"id": model, "object": "model"} for model in models]})
        else:
            self.reply(404, {"error": {"message": "unknown mock route"}})

    def count(self, path, body):
        native = path.endswith("/messages/count_tokens")
        if native:
            assert self.headers["x-api-key"] == UPSTREAM_KEY and self.headers["anthropic-version"] == "2023-06-01"
            assert set(body) == {"model", "messages"} and body["model"] == COUNT_MODEL, body
        else:
            assert self.headers["Authorization"] == f"Bearer {UPSTREAM_KEY}"
            assert set(body) <= {"model", "input", "instructions", "tools", "tool_choice"}, body.keys()
            assert body["model"] in (MODEL, COUNT_MODEL), body["model"]
            if body["model"] == MODEL:
                assert body["instructions"] == "Count the structured prompt"
                assert body["tools"][0]["parameters"]["properties"]["q"] == {"type": "string"}
                assert body["tool_choice"] == {"type": "function", "name": "Lookup"}
                assert [item["type"] for item in body["input"]] == ["message", "function_call", "function_call_output"]
                call, output = body["input"][1:]
                assert call["call_id"] == output["call_id"] == "call_count" and output["output"] == "answer"
        with COUNT_TRACE.open("a", encoding="utf-8") as trace:
            trace.write(json.dumps({"path": path, "model": body["model"]}) + "\n")
        mode = path.split("/")[1]
        if mode == "invalid":
            self.reply(200, {"input_tokens": -1})
        elif mode == "slow":
            time.sleep(2)
            self.reply(200, {"input_tokens": 99})
        elif mode in COUNT_ERRORS:
            status, code, message = COUNT_ERRORS[mode]
            self.reply(status, {"error": {"type": "invalid_request_error", "code": code, "message": message}})
        else:
            tokens = 67 if native else (0 if body["model"] == MODEL else 79)
            self.reply(200, {"input_tokens": tokens} if native else {"object": "response.input_tokens", "input_tokens": tokens})

    def do_POST(self):
        path = urlsplit(self.path).path
        try:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if path.endswith(("/responses/input_tokens", "/messages/count_tokens")):
                self.count(path, body)
                return
            assert path.endswith("/v1/responses") and self.headers.get("Authorization") == f"Bearer {UPSTREAM_KEY}"
            result, stream_options = response_for_request(body)
        except (BrokenPipeError, ConnectionResetError):
            return
        except (AssertionError, KeyError, ValueError, TypeError) as error:
            print(f"Mock rejected request: {error}", flush=True)
            self.reply(400, {"error": {"message": f"invalid fixture request: {error}"}})
            return
        if not body["stream"]:
            self.reply(200, result)
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for sequence, (kind, data) in enumerate(stream_events(result, **stream_options)):
            data.update(type=kind, sequence_number=sequence)
            self.wfile.write(f"event: {kind}\ndata: {json.dumps(data)}\n\n".encode())
            self.wfile.flush()


def main():
    mock = ThreadingHTTPServer(("127.0.0.1", 8185), Mock)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    env = {
        **os.environ, "LISTEN_ADDR": "127.0.0.1:8184", "ADMIN_TOKEN": ADMIN,
        "DB_DSN": "sqlite:///tmp/responses-fixture.sqlite", "PRICE_SYNC_ENABLED": "false",
        "CODEX_OAUTH_CALLBACK_LISTEN_ADDR": "", "RUST_LOG": "warn",
        "RESPONSES_INPUT_TOKENS_BASE_URLS": ",".join([MOCK + "/v1", *(f"{MOCK}/{mode}/v1" for mode in COUNT_ERRORS)]),
    }
    with Path("/tmp/responses-fixture-gateway.log").open("w", encoding="utf-8") as log:
        gateway = subprocess.Popen([LAB / "backend"], cwd=LAB, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            configure_gateway()
            gateway.wait()
        finally:
            if gateway.poll() is None:
                gateway.terminate()


if __name__ == "__main__":
    main()
