import { t } from "@/lib/i18n";
import type {
  RequestBodyOverride,
  RequestHeaderOverride,
  RequestOverrideOperation,
  RequestOverrides,
  RequestOverrideScope,
} from "@/lib/types";
export interface RequestHeaderOverrideDraft extends RequestHeaderOverride {
  id: string;
}

export interface RequestBodyOverrideDraft {
  id: string;
  scope: RequestOverrideScope;
  operation: RequestOverrideOperation;
  path: string;
  valueText: string;
}

export interface RequestOverridesDraft {
  headers: RequestHeaderOverrideDraft[];
  body: RequestBodyOverrideDraft[];
}

type ParsedRequestOverrides =
  | { ok: true; value: RequestOverrides }
  | { ok: false; error: string };

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const RESERVED_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "host",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "accept-encoding",
  "content-encoding",
  "expect",
  "keep-alive",
  "proxy-connection",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "chatgpt-account-id",
  "forwarded",
  "via",
  "x-real-ip",
  "cf-connecting-ip",
  "cf-ray",
  "cdn-loop",
  "true-client-ip",
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
  "x-original-host",
  "x-original-url",
  "x-original-uri",
  "x-rewrite-url",
  "x-envoy-original-path",
]);
const RESERVED_HEADER_PREFIXES = ["sec-websocket-", "x-forwarded-"];
const RESERVED_BODY_ROOTS = new Set(["model", "stream", "type"]);
export const SCOPE_OPTIONS: Array<{
  value: RequestOverrideScope;
  label: string;
}> = [
  { value: "all", label: "全部请求" },
  { value: "chat_completions", label: "Chat Completions" },
  { value: "responses", label: "Responses" },
];
export const OPERATION_OPTIONS: Array<{
  value: RequestOverrideOperation;
  label: string;
}> = [
  { value: "set", label: "设置值" },
  { value: "remove", label: "移除" },
];

let requestOverrideDraftSequence = 0;

function nextDraftId(prefix: string) {
  requestOverrideDraftSequence += 1;
  return `${prefix}-${requestOverrideDraftSequence}`;
}

function stringifyJsonValue(value: unknown) {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "null";
  }
}

export function emptyHeaderRule(): RequestHeaderOverrideDraft {
  return {
    id: nextDraftId("header-override"),
    scope: "all",
    operation: "set",
    name: "",
    value: "",
  };
}

export function emptyBodyRule(): RequestBodyOverrideDraft {
  return {
    id: nextDraftId("body-override"),
    scope: "responses",
    operation: "set",
    path: "",
    valueText: "null",
  };
}

function codexCompatibilityPreset(): RequestOverridesDraft {
  const requestIdTemplate = "{{request_id}}";
  return {
    headers: [
      {
        id: nextDraftId("header-override"),
        scope: "all",
        operation: "set",
        name: "User-Agent",
        value: "codex-tui/0.146.0 (Ubuntu 22.4.0; x86_64) xterm-256color",
      },
      {
        id: nextDraftId("header-override"),
        scope: "all",
        operation: "set",
        name: "originator",
        value: "codex-tui",
      },
      {
        id: nextDraftId("header-override"),
        scope: "all",
        operation: "set",
        name: "version",
        value: "0.146.0",
      },
      {
        id: nextDraftId("header-override"),
        scope: "all",
        operation: "set",
        name: "x-codex-window-id",
        value: requestIdTemplate,
      },
      {
        id: nextDraftId("header-override"),
        scope: "all",
        operation: "set",
        name: "session-id",
        value: requestIdTemplate,
      },
      {
        id: nextDraftId("header-override"),
        scope: "all",
        operation: "set",
        name: "thread-id",
        value: requestIdTemplate,
      },
    ],
    body: [
      {
        id: nextDraftId("body-override"),
        scope: "responses",
        operation: "set",
        path: "client_metadata.x-codex-window-id",
        valueText: JSON.stringify(requestIdTemplate),
      },
      {
        id: nextDraftId("body-override"),
        scope: "responses",
        operation: "set",
        path: "client_metadata.x-codex-installation-id",
        valueText: JSON.stringify(requestIdTemplate),
      },
    ],
  };
}

export function mergeCodexPreset(
  current: RequestOverridesDraft,
): RequestOverridesDraft {
  const preset = codexCompatibilityPreset();
  const headers = [...current.headers];
  for (const rule of preset.headers) {
    const index = headers.findIndex(
      (item) =>
        item.scope === rule.scope &&
        item.name.trim().toLowerCase() === rule.name.toLowerCase(),
    );
    if (index >= 0) {
      headers[index] = { ...rule, id: headers[index].id };
    } else {
      headers.push(rule);
    }
  }

  const body = [...current.body];
  for (const rule of preset.body) {
    const index = body.findIndex(
      (item) => item.scope === rule.scope && item.path.trim() === rule.path,
    );
    if (index >= 0) {
      body[index] = { ...rule, id: body[index].id };
    } else {
      body.push(rule);
    }
  }

  return { headers, body };
}

export function bodyValueError(rule: RequestBodyOverrideDraft) {
  if (rule.operation === "remove") return null;
  try {
    JSON.parse(rule.valueText);
    return null;
  } catch {
    return t("请输入有效的 JSON 值。");
  }
}

export function createRequestOverridesDraft(
  value?: RequestOverrides | null,
): RequestOverridesDraft {
  return {
    headers: (value?.headers ?? []).map((rule) => ({
      ...rule,
      id: nextDraftId("header-override"),
    })),
    body: (value?.body ?? []).map((rule) => ({
      id: nextDraftId("body-override"),
      scope: rule.scope,
      operation: rule.operation,
      path: rule.path,
      valueText: stringifyJsonValue(rule.value),
    })),
  };
}

export function parseRequestOverridesDraft(
  draft: RequestOverridesDraft,
): ParsedRequestOverrides {
  if (draft.headers.length > 64) {
    return { ok: false, error: t("Header 规则不能超过 64 条。") };
  }
  if (draft.body.length > 128) {
    return { ok: false, error: t("Body 规则不能超过 128 条。") };
  }
  const seenHeaders = new Set<string>();
  const headers: RequestHeaderOverride[] = [];

  for (const [index, rule] of draft.headers.entries()) {
    const name = rule.name.trim();
    const normalizedName = name.toLowerCase();
    if (!name) {
      return {
        ok: false,
        error: t("Header 规则 {{index}} 缺少名称。", { index: index + 1 }),
      };
    }
    if (!HEADER_NAME_PATTERN.test(name)) {
      return {
        ok: false,
        error: t("Header 规则 {{index}} 的名称无效。", { index: index + 1 }),
      };
    }
    if (
      RESERVED_HEADERS.has(normalizedName) ||
      RESERVED_HEADER_PREFIXES.some((prefix) =>
        normalizedName.startsWith(prefix),
      )
    ) {
      return {
        ok: false,
        error: t("Header {{name}} 由网关管理，不能覆写。", { name }),
      };
    }
    if (rule.operation === "set" && /[\r\n\0]/.test(rule.value)) {
      return {
        ok: false,
        error: t("Header {{name}} 的值包含非法字符。", { name }),
      };
    }
    const duplicateKey = `${rule.scope}:${normalizedName}`;
    if (seenHeaders.has(duplicateKey)) {
      return {
        ok: false,
        error: t("同一作用域内不能重复覆写 Header {{name}}。", { name }),
      };
    }
    seenHeaders.add(duplicateKey);
    headers.push({
      scope: rule.scope,
      operation: rule.operation,
      name,
      value: rule.operation === "set" ? rule.value : "",
    });
  }

  const seenBodyPaths = new Set<string>();
  const body: RequestBodyOverride[] = [];
  for (const [index, rule] of draft.body.entries()) {
    const path = rule.path
      .split(".")
      .map((segment) => segment.trim())
      .join(".");
    const segments = path.split(".");
    if (!path || segments.some((segment) => !segment)) {
      return {
        ok: false,
        error: t("Body 规则 {{index}} 的点路径无效。", { index: index + 1 }),
      };
    }
    if (segments.length > 16) {
      return {
        ok: false,
        error: t("Body 规则 {{index}} 的路径层级过深。", { index: index + 1 }),
      };
    }
    if (RESERVED_BODY_ROOTS.has(segments[0].toLowerCase())) {
      return {
        ok: false,
        error: t("Body 字段 {{name}} 由网关管理，不能覆写。", {
          name: segments[0],
        }),
      };
    }
    const duplicateKey = `${rule.scope}:${path}`;
    if (seenBodyPaths.has(duplicateKey)) {
      return {
        ok: false,
        error: t("同一作用域内不能重复覆写 Body 路径 {{path}}。", { path }),
      };
    }
    seenBodyPaths.add(duplicateKey);

    let parsedValue: unknown = null;
    if (rule.operation === "set") {
      try {
        parsedValue = JSON.parse(rule.valueText);
      } catch {
        return {
          ok: false,
          error: t("Body 规则 {{index}} 的值不是有效 JSON。", {
            index: index + 1,
          }),
        };
      }
    }
    body.push({
      scope: rule.scope,
      operation: rule.operation,
      path,
      value: parsedValue,
    });
  }

  const value = { headers, body };
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 256 * 1024) {
    return { ok: false, error: t("请求覆写配置不能超过 256 KiB。") };
  }
  return { ok: true, value };
}
