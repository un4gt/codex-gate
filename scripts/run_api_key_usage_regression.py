#!/usr/bin/env python3
"""Exercise API key lifetime metering and limits in an isolated Docker fixture."""

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4

from run_oauth_metering_regression import WsClient, frame_bytes, read_frame


ADMIN = "key-usage-lab-admin"
UPSTREAM_KEY = "key-usage-lab-upstream"
PRICED = "fixture-priced"
UNPRICED = "fixture-unpriced"
DB = Path("/app/data/key-usage.sqlite")
KEYS = DB.with_name("fixture-keys.json")
GATEWAY = "http://127.0.0.1:8080"
MOCK = "http://127.0.0.1:8081"
IMAGE = "codex-gate-key-usage-lab:local"


def observed_usage():
    return {
        "input_tokens": 600_000,
        "output_tokens": 100_000,
        "input_tokens_details": {"cached_tokens": 100_000, "cache_creation_tokens": 50_000},
        "output_tokens_details": {"reasoning_tokens": 20_000},
    }


def request(base, path, body=None, *, method=None, token=None, headers=None):
    headers = {"Content-Type": "application/json", **(headers or {})}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    call = Request(base + path, method=method, headers=headers,
                   data=None if body is None else json.dumps(body).encode())
    try:
        response = urlopen(call, timeout=10)
    except HTTPError as error:
        response = error
    with response:
        content = response.read().decode()
        if "application/json" in response.headers.get("Content-Type", "") and content:
            content = json.loads(content)
        return response.status, content


def admin(path, body=None, *, method=None):
    status, result = request(GATEWAY, "/api/v1" + path, body, method=method, token=ADMIN)
    assert status < 300, (path, status, result)
    return result


class Mock(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    hits = 0
    lock = threading.Lock()

    def log_message(self, *_args):
        pass

    def respond(self, status, payload, *, mime="application/json"):
        body = json.dumps(payload).encode() if mime == "application/json" else payload.encode()
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/_hits":
            return self.respond(200, {"hits": self.hits})
        if self.headers.get("Authorization") != f"Bearer {UPSTREAM_KEY}":
            return self.respond(401, {"error": "wrong fixture credential"})
        if self.path.startswith("/v1/models"):
            return self.respond(200, {"data": [{"id": name} for name in (PRICED, UNPRICED)]})
        if self.path != "/v1/responses" or self.headers.get("Upgrade", "").lower() != "websocket":
            return self.respond(404, {"error": "unknown fixture route"})
        accept = self.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", base64.b64encode(hashlib.sha1(accept.encode()).digest()).decode())
        self.end_headers()
        try:
            while True:
                opcode, payload = read_frame(self.rfile)
                if opcode == 8:
                    return
                if opcode != 1:
                    continue
                body = json.loads(payload)
                assert body["type"] == "response.create" and body["model"] == PRICED, body
                self.note_request()
                self.wfile.write(frame_bytes(json.dumps(self.completed())))
                self.wfile.flush()
        except (EOFError, ConnectionError):
            return

    def note_request(self):
        with self.lock:
            Mock.hits += 1

    def completed(self):
        return {"type": "response.completed", "response": {
            "id": "resp_key_usage_fixture", "status": "completed", "output": [], "usage": observed_usage(),
        }}

    def do_POST(self):
        if self.headers.get("Authorization") != f"Bearer {UPSTREAM_KEY}":
            return self.respond(401, {"error": "wrong fixture credential"})
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert body["model"] in (PRICED, UNPRICED), body
        self.note_request()
        time.sleep(0.08)
        if self.path == "/v1/responses" and body.get("stream"):
            completed = self.completed()
            return self.respond(200, f"data: {json.dumps(completed)}\n\n", mime="text/event-stream")
        if self.path != "/v1/chat/completions":
            return self.respond(404, {"error": "unknown fixture route"})
        response = {"id": "chatcmpl_key_usage_fixture", "object": "chat.completion", "model": body["model"],
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "fixture"}, "finish_reason": "stop"}]}
        prompt = body["messages"][-1]["content"]
        if prompt == "observed zero":
            response["usage"] = {"prompt_tokens": 0, "completion_tokens": 0}
        elif prompt != "omit usage":
            usage = observed_usage()
            response["usage"] = {"prompt_tokens": usage["input_tokens"], "completion_tokens": usage["output_tokens"],
                                 "prompt_tokens_details": usage["input_tokens_details"],
                                 "completion_tokens_details": usage["output_tokens_details"]}
        self.respond(200, response)


def serve():
    mock = ThreadingHTTPServer(("127.0.0.1", 8081), Mock)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    process = subprocess.Popen(["/app/backend"], env={
        **os.environ,
        "ADMIN_TOKEN": ADMIN, "MASTER_KEY": "key-usage-lab-master",
        "DB_DSN": "sqlite:///app/data/key-usage.sqlite", "LISTEN_ADDR": "0.0.0.0:8080",
        "STATIC_DIR": "/app/static", "PRICE_SYNC_ENABLED": "false", "STATS_FLUSH_INTERVAL_MS": "500",
        "REQUEST_LOG_RETENTION_DAYS": "0", "STATS_DAILY_RETENTION_DAYS": "0", "RUST_LOG": "warn",
    })
    signal.signal(signal.SIGTERM, lambda *_: process.terminate())
    raise SystemExit(process.wait())


def seed():
    provider = admin("/providers", {
        "name": "Key usage mock", "provider_type": "openai", "websocket_enabled": True,
        "endpoints": [{"name": "Fixture", "base_url": MOCK + "/v1"}],
        "keys": [{"name": "Fixture", "secret": UPSTREAM_KEY}],
    })["id"]
    admin(f"/providers/{provider}/models/sync", {})
    price = admin("/prices", {"model_name": PRICED, "price_data": {
        "schema_version": 2, "unit": "usd_per_million_tokens",
        "base": {"input": "2", "output": "8", "cache_read": "0.5", "cache_write": "3"}, "tiers": [],
    }})["id"]
    config = {
        "Token limit": {"kind": "tokens", "value": 1_100_000},
        "Cost limit": {"kind": "cost_usd", "value": "3.125"},
        "Concurrent limit": {"kind": "tokens", "value": 700_000},
        "WebSocket limit": {"kind": "tokens", "value": 700_000},
        "Measured zero": None,
        "No usage reported": None,
    }
    fixture_keys = {name: admin("/api-keys", {
        "name": name, "allowed_provider_ids": [provider], "usage_limit": limit,
        "log_enabled": name != "Cost limit",
    }) for name, limit in config.items()}
    KEYS.write_text(json.dumps(fixture_keys), encoding="utf-8")

    # Each limited fixture has 0.4 M historical tokens, including 0.35 M priced for $1.225.
    day_ms = 86_400_000
    now_ms = int(time.time() * 1000)
    bucket = (now_ms // day_ms - 2) * day_ms
    date = datetime.fromtimestamp(bucket / 1000, timezone.utc).strftime("%Y%m%d")
    with sqlite3.connect(DB) as db:
        for name in ("Token limit", "Cost limit"):
            key_id = fixture_keys[name]["id"]
            db.execute("UPDATE api_keys SET created_at_ms = ? WHERE id = ?", (bucket - day_ms, key_id))
            db.execute("""INSERT INTO stats_daily
                (date, api_key_id, request_success, request_failed, input_tokens, output_tokens,
                 cache_read_input_tokens, cache_creation_input_tokens, reasoning_output_tokens,
                 usage_observed_requests, wait_time_ms, updated_at_ms)
                VALUES (?, ?, 2, 0, 250000, 100000, 50000, 0, 0, 2, 0, ?)""", (date, key_id, now_ms))
            for model, version, tier, inputs, outputs, cached in (
                (PRICED, price, 0, 200_000, 100_000, 50_000), (UNPRICED, 0, -1, 50_000, 0, 0),
            ):
                db.execute("""INSERT INTO stats_hourly
                    (bucket_ms, api_key_id, provider_id, endpoint_id, upstream_key_id, api_format, model,
                     price_version_id, price_tier_index, request_success, request_failed, input_tokens, output_tokens,
                     cache_read_input_tokens, cache_creation_input_tokens, reasoning_output_tokens,
                     usage_observed_requests, wait_time_ms, latency_lt_500ms, latency_lt_1000ms, latency_lt_2000ms,
                     latency_lt_5000ms, latency_lt_15000ms, latency_gte_15000ms, updated_at_ms)
                    VALUES (?, ?, ?, 0, 0, 'chat_completions', ?, ?, ?, 1, 0, ?, ?, ?, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, ?)""",
                           (bucket, key_id, provider, model, version, tier, inputs, outputs, cached, now_ms))


def key_row(name):
    return next(item for item in admin("/api-keys") if item["name"] == name)


def assert_usage(name, tokens, cost, *, priced, reached=False, observed=None):
    for _ in range(25):
        item = key_row(name)
        usage = item["lifetime_usage"]
        if usage["total_tokens"] == tokens and (observed is None or usage["observed_requests"] == observed):
            break
        time.sleep(0.1)
    assert (usage["total_tokens"], usage["cost_usd"], usage["priced_tokens"], item["usage_limit_reached"]) == (
        tokens, cost, priced, reached), item
    if observed is not None:
        assert usage["observed_requests"] == observed, item


def verify(*, restarted=False):
    keys = json.loads(KEYS.read_text(encoding="utf-8"))

    def chat(name, model=PRICED, prompt="fixture request"):
        return request(GATEWAY, "/v1/chat/completions", {"model": model, "messages": [{"role": "user", "content": prompt}]},
                       token=keys[name]["api_key"])

    def hits():
        return request(MOCK, "/_hits")[1]["hits"]

    def blocked(result):
        status, body = result
        assert status == 429 and body["error"]["code"] == "api_key_limit_reached", result

    if restarted:
        for name, tokens in (("Token limit", 1_100_000), ("Cost limit", 1_800_000)):
            assert_usage(name, tokens, "3.125", priced=1_050_000, reached=True)
            blocked(chat(name))
        assert hits() == 0
        print("Restart preserved charges and exhausted limits.")
        return

    for name in ("Token limit", "Cost limit"):
        assert_usage(name, 400_000, "1.225", priced=350_000, observed=2)
    before = hits()
    assert chat("Token limit")[0] == 200
    blocked(chat("Token limit"))
    blocked(request(GATEWAY, "/v1/models", token=keys["Token limit"]["api_key"]))
    assert hits() == before + 1, "exhausted token key reached the upstream"
    assert_usage("Token limit", 1_100_000, "3.125", priced=1_050_000, reached=True, observed=3)

    before = hits()
    assert chat("Cost limit", UNPRICED)[0] == 200
    assert_usage("Cost limit", 1_100_000, "1.225", priced=350_000)
    cost_key = keys["Cost limit"]["api_key"]
    status, stream = request(GATEWAY, "/v1/responses", {"model": PRICED, "input": "fixture", "stream": True}, token=cost_key)
    assert status == 200 and "response.completed" in stream
    blocked(chat("Cost limit"))
    assert hits() == before + 2, "exhausted cost key reached the upstream"
    assert_usage("Cost limit", 1_800_000, "3.125", priced=1_050_000, reached=True, observed=4)

    before = hits()
    ready = threading.Barrier(2)

    def parallel_request(_):
        ready.wait(timeout=5)
        return chat("Concurrent limit")[0]

    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(parallel_request, range(2))) == [200, 429]
    assert hits() == before + 1
    assert_usage("Concurrent limit", 700_000, "1.9", priced=700_000, reached=True)

    before = hits()
    with closing(WsClient(8080, keys["WebSocket limit"]["api_key"])) as ws:
        ws.send({"model": PRICED})
        assert ws.complete()["type"] == "response.completed"
        ws.send({"model": PRICED})
        error = ws.complete()
        assert error["type"] == "error" and error["error"]["code"] == "api_key_limit_reached", error
    assert hits() == before + 1
    assert_usage("WebSocket limit", 700_000, "1.9", priced=700_000, reached=True)

    assert chat("Measured zero", prompt="observed zero")[0] == 200
    assert chat("No usage reported", prompt="omit usage")[0] == 200
    assert_usage("Measured zero", 0, "0", priced=0, observed=1)
    assert_usage("No usage reported", 0, None, priced=0, observed=0)
    key_path = f"/api-keys/{keys['Concurrent limit']['id']}"
    admin(key_path, {"usage_limit": None}, method="PATCH")
    assert chat("Concurrent limit")[0] == 200
    admin(key_path, {"usage_limit": {"kind": "cost_usd", "value": "3.80"}}, method="PATCH")
    blocked(chat("Concurrent limit"))
    assert_usage("Concurrent limit", 1_400_000, "3.8", priced=1_400_000, reached=True)

    # Simulate retention cleanup on the disposable database. Lifetime totals remain in their own table.
    with sqlite3.connect(DB) as db:
        key_id = keys["Cost limit"]["id"]
        assert db.execute("SELECT COUNT(*) FROM request_logs WHERE api_key_id = ?", (key_id,)).fetchone() == (0,)
        db.execute("DELETE FROM stats_daily WHERE api_key_id = ?", (key_id,))
        db.execute("DELETE FROM stats_hourly WHERE api_key_id = ?", (key_id,))
    print(json.dumps({name: key_row(name)["lifetime_usage"] for name in keys}, indent=2))


def wait_ready(base):
    for _ in range(50):
        try:
            if request(base, "/readyz")[0] == 200:
                return
        except (OSError, URLError):
            pass
        time.sleep(0.2)
    raise RuntimeError(f"gateway readiness timed out at {base}")


def docker(*args):
    subprocess.run(["docker", *map(str, args)], check=True)


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", required=True, type=Path, help="Linux x86-64 gateway binary")
    parser.add_argument("--frontend", required=True, type=Path, help="built frontend dist directory")
    parser.add_argument("--port", type=int, default=18765)
    parser.add_argument("--keep", action="store_true", help="keep the test container and data after verification")
    args = parser.parse_args()
    script = Path(__file__).resolve()
    with tempfile.TemporaryDirectory(prefix="codex-gate-key-usage-") as directory:
        context = Path(directory)
        shutil.copy2(args.backend, context / "backend")
        shutil.copytree(args.frontend, context / "static")
        for path in (script, script.with_name("run_oauth_metering_regression.py")):
            shutil.copy2(path, context)
        (context / "Dockerfile").write_text(f"""FROM python:3.12-slim
WORKDIR /app
COPY backend /app/backend
COPY static /app/static
COPY {script.name} run_oauth_metering_regression.py /lab/
RUN chmod +x /app/backend
VOLUME ["/app/data"]
ENTRYPOINT ["python", "/lab/{script.name}", "serve"]
""", encoding="utf-8")
        docker("build", "--network", "none", "-t", IMAGE, context)
    name = f"codex-gate-key-usage-{uuid4().hex[:8]}"
    base = f"http://127.0.0.1:{args.port}"
    docker("run", "-d", "--name", name, "-p", f"127.0.0.1:{args.port}:8080", IMAGE)
    passed = False
    try:
        wait_ready(base)
        docker("exec", name, "python", f"/lab/{script.name}", "seed")
        docker("restart", name)
        wait_ready(base)
        docker("exec", name, "python", f"/lab/{script.name}", "verify")
        docker("restart", name)
        wait_ready(base)
        docker("exec", name, "python", f"/lab/{script.name}", "verify-restart")
        passed = True
    finally:
        if not passed:
            docker("logs", "--tail", "80", name)
        if not args.keep or not passed:
            docker("rm", "-fv", name)
    if args.keep:
        print(f"Kiri fixture: {name}\nConsole: {base}/keys\nFixture admin token: {ADMIN}")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) == 2 else None
    if mode == "serve":
        serve()
    elif mode == "seed":
        seed()
    elif mode in ("verify", "verify-restart"):
        verify(restarted=mode == "verify-restart")
    else:
        run()
