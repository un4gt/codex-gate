import json
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, "/app")
from calc import add

assert [(a, b, add(a, b)) for a, b in [(2, 3), (0, 0), (-2, 2), (-4, -5)]] == [
    (2, 3, 5), (0, 0, 0), (-2, 2, 0), (-4, -5, -9),
]
rounds = [json.loads(line) for line in Path("/tmp/responses-fixture-trace.jsonl").read_text().splitlines()]
assert [turn["tools"] for turn in rounds] == [["Read", "Read"], ["Edit"], ["Bash"], []], rounds
for count, turn in zip((0, 2, 3, 4), rounds, strict=True):
    assert turn["results_received"] == count
    assert set(turn["replayed_call_ids"]) == {f"call_fixture_{j}" for j in range(count)}
    assert turn["terminal"] == "response.completed" and turn["stream"] is True

log = Path("/logs/agent/claude-code.txt").read_text(encoding="utf-8")
events = [json.loads(line) for line in log.splitlines() if line.startswith("{")]
init = next(event for event in events if event.get("subtype") == "init")
result = next(event for event in events if event["type"] == "result")
assert result["is_error"] is False and result["stop_reason"] == "end_turn", result
assert result["result"], result
usage = result["usage"]
assert (usage["input_tokens"], usage["cache_read_input_tokens"], usage["output_tokens"]) == (32, 16, 12), usage
checks = json.loads(Path("/tmp/responses-fixture-checks.json").read_text())
assert init["model"] == checks["selected_model"], init["model"]
profile = json.loads(Path("/opt/responses-fixture/settings.gpt.json").read_text())["env"]
context_window = result["modelUsage"][init["model"]]["contextWindow"]
if "CLAUDE_CODE_MAX_CONTEXT_TOKENS" in profile:
    assert context_window == int(profile["CLAUDE_CODE_MAX_CONTEXT_TOKENS"]), context_window
if "CLAUDE_CODE_MAX_OUTPUT_TOKENS" in profile:
    assert all(turn["max_output_tokens"] == int(profile["CLAUDE_CODE_MAX_OUTPUT_TOKENS"]) for turn in rounds), rounds

expected = Counter({
    (1, 8, 4, 3): 8,  # Two JSON smoke checks, two interleaving probes, four CLI turns.
    (0, 0, 0, 0): 3,  # JSON and SSE missing, plus JSON partial.
    (1, 0, 0, 0): 2,  # Explicit zero in JSON and SSE.
    (1, 22, 0, 2): 1,
    (1, 31, 0, 3): 1,
    (1, 41, 0, 4): 1,
})
with sqlite3.connect("/tmp/responses-fixture.sqlite") as database:
    for attempt in range(30):
        samples = database.execute(
            "SELECT usage_observed, input_tokens, cache_read_input_tokens, output_tokens, error_type "
            "FROM request_logs WHERE span_kind = 'request' AND api_format = 'messages' AND upstream_api_format = 'responses'"
        ).fetchall()
        counts = database.execute("SELECT usage_observed, input_tokens FROM request_logs WHERE span_kind = 'count_tokens'").fetchall()
        if len(samples) >= expected.total() and len(counts) >= 9:
            break
        time.sleep(0.2)
assert Counter(row[:4] for row in samples) == expected, samples
assert all(bool(row[4]) == (row[1] == 41) for row in samples), samples
assert counts == [(0, 0)] * 9, counts
Path("/logs/verifier/protocol-summary.json").write_text(
    json.dumps({
        "task_passed": True, "claude_code_version": init["claude_code_version"],
        "model": init["model"], "stop_reason": result["stop_reason"], "rounds": rounds, "checks": checks,
        "context_window": context_window,
        "observed_responses": sum(row[0] for row in samples), "unobserved_responses": sum(not row[0] for row in samples),
        "count_requests": len(counts),
    }, indent=2) + "\n",
    encoding="utf-8",
)
