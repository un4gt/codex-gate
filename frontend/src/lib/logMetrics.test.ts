import { describe, expect, it } from "@rstest/core";
import { formatTtft, outputTokensPerSecond } from "./logMetrics";

const row = { output_tokens: 1000, duration_ms: 20000, usage_observed: true,
  span_kind: "request", http_status: 200, error_type: null };

describe("log throughput and timing semantics", () => {
  it("uses total request duration, including the wait before output", () => {
    expect(outputTokensPerSecond(row)).toBe(50);
    expect(outputTokensPerSecond({ ...row, output_tokens: 0 })).toBe(0);
  });
  it("does not invent speed for missing usage, invalid timing, errors, or session spans", () => {
    for (const change of [{ usage_observed: false }, { duration_ms: 0 }, { duration_ms: null },
      { duration_ms: Infinity }, { output_tokens: -1 }, { output_tokens: NaN },
      { error_type: "client_disconnected" }, { http_status: 502 }, { http_status: null },
      { span_kind: "ws_session" }, { span_kind: "ws_session_close" }]) {
      expect(outputTokensPerSecond({ ...row, ...change })).toBeNull();
    }
  });
  it("distinguishes complete-output timing from deltas and keeps zero valid", () => {
    expect(formatTtft({ t_first_token_ms: null })).toBe("—");
    expect(formatTtft({ t_first_token_ms: 0, ttft_source: "delta" })).not.toBe("—");
    expect(formatTtft({ t_first_token_ms: 1500, ttft_source: "delta" })).not.toContain("≈");
    for (const source of ["output_done", "response_done"]) {
      expect(formatTtft({ t_first_token_ms: 1500, ttft_source: source })).toContain("≈");
    }
  });
});
