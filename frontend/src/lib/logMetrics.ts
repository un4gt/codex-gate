import { formatMs } from "./format";
import { t } from "./i18n";
import type { RequestLogRow } from "./types";

// End-to-end average: output includes reasoning tokens already; never add them again.
export function outputTokensPerSecond(row: Pick<RequestLogRow,
  "output_tokens" | "duration_ms" | "usage_observed" | "span_kind" | "error_type" | "http_status"
>): number | null {
  if (!row.usage_observed || row.error_type || row.http_status == null ||
    row.http_status < 200 || row.http_status >= 300 ||
    row.span_kind === "ws_session" || row.span_kind === "ws_session_close" ||
    row.duration_ms == null || !Number.isFinite(row.duration_ms) || row.duration_ms <= 0 ||
    !Number.isFinite(row.output_tokens) || row.output_tokens < 0) return null;
  const rate = row.output_tokens / row.duration_ms * 1000;
  return Number.isFinite(rate) ? rate : null;
}

export function formatOutputRate(row: RequestLogRow): string {
  const rate = outputTokensPerSecond(row);
  return rate == null ? "—" : `${rate.toFixed(1)} tokens/s`;
}

export const OUTPUT_RATE_HELP = "输出 Token（已包含推理 Token）÷ 请求总耗时，包含首个输出前的等待时间。";

export const CACHE_HIT_RATE_HELP =
  "缓存读取 ÷ 总输入（未缓存输入 + 缓存读 + 缓存写）。";

export function cacheHitRate(
  row: Pick<
    RequestLogRow,
    | "usage_observed"
    | "input_tokens"
    | "cache_read_input_tokens"
    | "cache_creation_input_tokens"
  >,
): number | null {
  if (!row.usage_observed) return null;
  const input =
    row.input_tokens +
    row.cache_read_input_tokens +
    row.cache_creation_input_tokens;
  if (!Number.isFinite(input) || input <= 0) return null;
  const rate = (row.cache_read_input_tokens / input) * 100;
  return Number.isFinite(rate) ? Math.min(100, Math.max(0, rate)) : null;
}

export function formatCacheHitRate(row: Parameters<typeof cacheHitRate>[0]): string {
  const rate = cacheHitRate(row);
  return rate == null ? "—" : `${rate.toFixed(1)}%`;
}

export function formatTtft(row: Pick<RequestLogRow, "t_first_token_ms" | "ttft_source">): string {
  const ms = row.t_first_token_ms;
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const estimated = row.ttft_source === "output_done" || row.ttft_source === "response_done";
  return `${estimated ? "≈ " : ""}${formatMs(ms)}`;
}

export function ttftHelp(row: Pick<RequestLogRow, "t_first_token_ms" | "ttft_source">): string {
  if (row.t_first_token_ms == null) return t("未观测到输出事件；非流式响应或历史记录可能没有此指标。");
  if (row.ttft_source === "output_done") return t("首次观测到完整输出项的时间；没有更早的增量事件，仅作为 TTFT 近似值。");
  if (row.ttft_source === "response_done") return t("仅在最终响应中观测到输出；此时间是 TTFT 的上界，不是精确的首 Token 时间。");
  if (row.ttft_source === "delta") return t("从请求开始到首次非空输出增量，包含文本、推理或工具参数。");
  return t("历史记录未保存 TTFT 采集来源。");
}
