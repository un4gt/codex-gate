#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TS="${TS:-$(date -u +%Y%m%dT%H%M%SZ)}"
MOCK_PORT="${MOCK_PORT:-19120}"
GW_PORT="${GW_PORT:-18120}"

BACKEND_BIN="${BACKEND_BIN:-./backend/target/debug/backend}"
if [[ ! -x "$BACKEND_BIN" ]]; then
  echo "backend binary not found: $BACKEND_BIN" >&2
  echo "build first: cargo build --manifest-path backend/Cargo.toml" >&2
  exit 1
fi

mkdir -p data/tmp

ADMIN_TOKEN="admin-${TS}"
MASTER_KEY="master-${TS}"
DB_PATH="data/tmp/responses_chain_sync_${TS}.sqlite"
MOCK_LOG="data/tmp/responses_mock_sync_${TS}.log"
GW_LOG="data/tmp/responses_gateway_sync_${TS}.log"
RESULT_LOG="data/tmp/responses_chain_sync_result_${TS}.log"

json_get() {
  local raw_json="$1"
  local key="$2"
  python3 - "$raw_json" "$key" <<'PY'
import json
import sys

obj = json.loads(sys.argv[1])
for part in sys.argv[2].split("."):
    obj = obj[part]
print(obj)
PY
}

cleanup() {
  if [[ -n "${GW_PID:-}" ]]; then
    kill "$GW_PID" 2>/dev/null || true
    wait "$GW_PID" 2>/dev/null || true
  fi
  if [[ -n "${MOCK_PID:-}" ]]; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

python3 scripts/mock_upstream.py \
  --listen "127.0.0.1:${MOCK_PORT}" \
  --default-format responses \
  --default-body-text "responses-sync-ok-${TS}" \
  --models-chat "chat-a,chat-b" \
  --models-responses "resp-sync-mini,resp-sync-plus" \
  >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!

ADMIN_TOKEN="$ADMIN_TOKEN" \
MASTER_KEY="$MASTER_KEY" \
LISTEN_ADDR="127.0.0.1:${GW_PORT}" \
DB_DSN="sqlite://./${DB_PATH}" \
UPSTREAM_CACHE_TTL_MS=800 \
"$BACKEND_BIN" >"$GW_LOG" 2>&1 &
GW_PID=$!

for _ in $(seq 1 80); do
  if curl -fsS "http://127.0.0.1:${GW_PORT}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
curl -fsS "http://127.0.0.1:${GW_PORT}/healthz" >/dev/null

ADMIN_AUTH="Authorization: Bearer ${ADMIN_TOKEN}"

provider_json="$(
  curl -fsS -X POST "http://127.0.0.1:${GW_PORT}/api/v1/providers" \
    -H "$ADMIN_AUTH" \
    -H 'Content-Type: application/json' \
    -d '{"name":"resp-provider-sync","provider_type":"openai_compatible_responses","enabled":true,"websocket_enabled":true}'
)"
provider_id="$(json_get "$provider_json" "id")"

curl -fsS -X POST "http://127.0.0.1:${GW_PORT}/api/v1/providers/${provider_id}/endpoints" \
  -H "$ADMIN_AUTH" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"mock-responses\",\"base_url\":\"http://127.0.0.1:${MOCK_PORT}/v1\",\"enabled\":true}" >/dev/null

key_json="$(
  curl -fsS -X POST "http://127.0.0.1:${GW_PORT}/api/v1/providers/${provider_id}/keys" \
    -H "$ADMIN_AUTH" \
    -H 'Content-Type: application/json' \
    -d '{"name":"mock-key","secret":"sk-upstream","enabled":true}'
)"
key_id="$(json_get "$key_json" "id")"

client_json="$(
  curl -fsS -X POST "http://127.0.0.1:${GW_PORT}/api/v1/api-keys" \
    -H "$ADMIN_AUTH" \
    -H 'Content-Type: application/json' \
    -d '{"name":"resp-client","enabled":true}'
)"
client_key="$(json_get "$client_json" "api_key")"

sync_provider="$(
  curl -fsS -X POST "http://127.0.0.1:${GW_PORT}/api/v1/providers/${provider_id}/models/sync" \
    -H "$ADMIN_AUTH"
)"
sync_key="$(
  curl -fsS -X POST "http://127.0.0.1:${GW_PORT}/api/v1/keys/${key_id}/models/sync" \
    -H "$ADMIN_AUTH"
)"

sleep 1.2

resp_body="$(mktemp)"
chat_body="$(mktemp)"
resp_models_body="$(mktemp)"
chat_models_body="$(mktemp)"

resp_code="$(
  curl -sS -o "$resp_body" -w '%{http_code}' "http://127.0.0.1:${GW_PORT}/v1/responses" \
    -H "Authorization: Bearer ${client_key}" \
    -H 'Content-Type: application/json' \
    -d '{"model":"resp-sync-mini","input":"hello"}'
)"

chat_code="$(
  curl -sS -o "$chat_body" -w '%{http_code}' "http://127.0.0.1:${GW_PORT}/v1/chat/completions" \
    -H "Authorization: Bearer ${client_key}" \
    -H 'Content-Type: application/json' \
    -d '{"model":"resp-sync-mini","messages":[{"role":"user","content":"hello"}]}'
)"

curl -sS "http://127.0.0.1:${GW_PORT}/v1/models" \
  -H "Authorization: Bearer ${client_key}" >"$chat_models_body"

curl -sS "http://127.0.0.1:${GW_PORT}/v1/models?api_format=responses" \
  -H "Authorization: Bearer ${client_key}" >"$resp_models_body"

python3 - \
  "$resp_code" \
  "$chat_code" \
  "$resp_body" \
  "$chat_body" \
  "$chat_models_body" \
  "$resp_models_body" \
  "$RESULT_LOG" \
  "$MOCK_LOG" \
  "$GW_LOG" \
  "$DB_PATH" \
  "$sync_provider" \
  "$sync_key" <<'PY'
import json
import sys

resp_code, chat_code = sys.argv[1], sys.argv[2]
resp_body_path, chat_body_path = sys.argv[3], sys.argv[4]
chat_models_path, resp_models_path = sys.argv[5], sys.argv[6]
result_log, mock_log, gw_log, db_path, sync_provider_raw, sync_key_raw = sys.argv[7:13]

sync_provider = json.loads(sync_provider_raw)
sync_key = json.loads(sync_key_raw)
with open(resp_body_path, "r", encoding="utf-8") as f:
    resp_body = json.load(f)
with open(chat_body_path, "r", encoding="utf-8") as f:
    chat_body = json.load(f)
with open(chat_models_path, "r", encoding="utf-8") as f:
    chat_models = json.load(f)
with open(resp_models_path, "r", encoding="utf-8") as f:
    resp_models = json.load(f)

assert resp_code == "200", f"/v1/responses expected 200, got {resp_code}"
assert chat_code == "503", f"/v1/chat/completions expected 503, got {chat_code}"
assert chat_body.get("error") == "no available providers", f"unexpected chat error: {chat_body}"
assert isinstance(chat_models.get("data"), list) and len(chat_models["data"]) == 0, f"chat models should be empty: {chat_models}"

responses_ids = [item.get("id") for item in resp_models.get("data", [])]
provider_sync_ids = [item.get("upstream_model") for item in sync_provider]
key_sync_ids = [item.get("model_name") for item in sync_key]
for expected in ("resp-sync-mini", "resp-sync-plus"):
    assert expected in responses_ids, f"responses models missing {expected}: {resp_models}"
    assert expected in provider_sync_ids, f"provider sync missing {expected}: {sync_provider}"
    assert expected in key_sync_ids, f"key sync missing {expected}: {sync_key}"

result = {
    "responses_status": resp_code,
    "chat_status": chat_code,
    "responses_model": resp_body.get("model"),
    "responses_output_text": (((resp_body.get("output") or [{}])[0].get("content") or [{}])[0].get("text")),
    "chat_error": chat_body.get("error"),
    "chat_models_count": len(chat_models.get("data", [])),
    "responses_models": responses_ids,
    "provider_sync_models": provider_sync_ids,
    "key_sync_models": key_sync_ids,
    "artifacts": {
        "db": db_path,
        "mock_log": mock_log,
        "gateway_log": gw_log,
        "chat_models_raw": chat_models,
        "responses_models_raw": resp_models,
    },
}
with open(result_log, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(json.dumps(result, ensure_ascii=False))
PY

echo "result log: ${RESULT_LOG}"
