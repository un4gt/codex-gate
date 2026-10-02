import Plus from "@mui/icons-material/AddOutlined";
import Sparkles from "@mui/icons-material/AutoAwesomeOutlined";
import Braces from "@mui/icons-material/DataObjectOutlined";
import Trash2 from "@mui/icons-material/DeleteOutlined";
import RotateCcw from "@mui/icons-material/RestartAltOutlined";
import IconButton from "@mui/material/IconButton";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import FormControl from "@mui/material/FormControl";
import FormHelperText from "@mui/material/FormHelperText";
import FormLabel from "@mui/material/FormLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import { useI18n } from "@/lib/i18n";
import {
bodyValueError,
createRequestOverridesDraft,
emptyBodyRule,
emptyHeaderRule,
mergeCodexPreset,
OPERATION_OPTIONS,
SCOPE_OPTIONS,
type RequestBodyOverrideDraft,
type RequestHeaderOverrideDraft,
type RequestOverridesDraft,
} from "@/lib/requestOverridesDraft";
import type {
RequestOverrideOperation,
RequestOverrideScope,
} from "@/lib/types";

interface RequestOverridesEditorProps {
  value: RequestOverridesDraft;
  onChange: (value: RequestOverridesDraft) => void;
  disabled?: boolean;
}

export {
createRequestOverridesDraft,
parseRequestOverridesDraft
} from "@/lib/requestOverridesDraft";
export type { RequestOverridesDraft } from "@/lib/requestOverridesDraft";

export function RequestOverridesEditor({
  value,
  onChange,
  disabled = false,
}: RequestOverridesEditorProps) {
  const { t } = useI18n();
  const ruleCount = value.headers.length + value.body.length;

  const updateHeader = (
    id: string,
    patch: Partial<RequestHeaderOverrideDraft>,
  ) => {
    onChange({
      ...value,
      headers: value.headers.map((rule) =>
        rule.id === id ? { ...rule, ...patch } : rule,
      ),
    });
  };

  const updateBody = (id: string, patch: Partial<RequestBodyOverrideDraft>) => {
    onChange({
      ...value,
      body: value.body.map((rule) =>
        rule.id === id ? { ...rule, ...patch } : rule,
      ),
    });
  };

  return (
    <Box
      sx={{
        borderStyle: "solid",
        borderWidth: "1px",
        borderColor:
          "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
        backgroundColor:
          "color-mix(in oklab, var(--mui-palette-action-hover) 5%, transparent)",
      }}
      component="section"
    >
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
          borderBottomStyle: "solid",
          borderBottomWidth: "1px",
          borderColor:
            "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
          padding: "1rem",
          "@media (width >= 64rem)": {
            flexDirection: "row",
            alignItems: "flex-start",
            justifyContent: "space-between",
          },
        }}
      >
        <Box sx={{ minWidth: "0" }}>
          <Box
            sx={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "0.5rem",
            }}
          >
            <Braces
              sx={{ width: "1rem", height: "1rem", opacity: "70%" }}
              aria-hidden="true"
            />
            <Typography
              sx={{
                fontSize: "0.875rem",
                lineHeight: "calc(1.25 / 0.875)",
                fontWeight: "500",
                letterSpacing: "-0.025em",
              }}
              component="h4"
            >
              {t("请求覆写")}
            </Typography>
            <Chip
              size="small"
              variant="outlined"
              label={t("{{count}} 条规则", { count: ruleCount })}
            />
          </Box>
          <Typography
            sx={{
              marginTop: "0.5rem",
              maxWidth: "48rem",
              fontSize: "0.75rem",
              lineHeight: "1.625",
              color: "var(--mui-palette-text-secondary)",
            }}
            component="p"
          >
            {t(
              "在路由转换与鉴权完成后，按上游覆写请求 Header 和 JSON Body。具体协议规则会覆盖 all；模板 {{request_id}} 在同一次请求中保持一致。",
            )}
          </Typography>
        </Box>
        <Box
          sx={{
            display: "flex",
            flexShrink: "0",
            flexWrap: "wrap",
            gap: "0.5rem",
          }}
        >
          <Button
            type="button"
            size="small"
            variant="outlined"
            disabled={disabled}
            onClick={() => onChange(mergeCodexPreset(value))}
          >
            <Sparkles
              sx={{ width: "0.875rem", height: "0.875rem" }}
              aria-hidden="true"
            />
            {t("应用 Codex 客户端兼容预设")}
          </Button>
          <Button
            type="button"
            size="small"
            variant="text"
            disabled={disabled || ruleCount === 0}
            onClick={() => onChange(createRequestOverridesDraft())}
          >
            <RotateCcw
              sx={{ width: "0.875rem", height: "0.875rem" }}
              aria-hidden="true"
            />
            {t("清空规则")}
          </Button>
        </Box>
      </Box>

      <Alert
        sx={{
          margin: "0.75rem",
          borderColor:
            "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
          backgroundColor:
            "color-mix(in oklab, var(--mui-palette-background-default) 60%, transparent)",
        }}
        severity="info"
        variant="outlined"
      >
        {t(
          "一键补齐 Codex 客户端所需的身份标识与元数据；同名规则会被覆盖，其余保留。",
        )}
      </Alert>

      <Box sx={{ display: "grid", gap: "1rem", padding: "0.75rem" }}>
        <Box sx={{ display: "grid", gap: "0.625rem" }}>
          <Box
            sx={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "0.5rem",
            }}
          >
            <Box>
              <Typography
                sx={{
                  fontSize: "0.875rem",
                  lineHeight: "calc(1.25 / 0.875)",
                  fontWeight: "500",
                }}
                component="h5"
              >
                {t("Header 规则")}
              </Typography>
              <Typography
                sx={{
                  marginTop: "0.25rem",
                  fontSize: "0.75rem",
                  lineHeight: "calc(1 / 0.75)",
                  color: "var(--mui-palette-text-secondary)",
                }}
                component="p"
              >
                {t("设置或移除发送到该上游的请求头。Header 名称不区分大小写。")}
              </Typography>
            </Box>
            <Button
              type="button"
              size="small"
              variant="outlined"
              disabled={disabled || value.headers.length >= 64}
              onClick={() =>
                onChange({
                  ...value,
                  headers: [...value.headers, emptyHeaderRule()],
                })
              }
            >
              <Plus
                sx={{ width: "0.875rem", height: "0.875rem" }}
                aria-hidden="true"
              />
              {t("添加 Header")}
            </Button>
          </Box>

          {value.headers.length === 0 ? (
            <Box
              sx={{
                borderRadius: "8px",
                borderStyle: "dashed",
                borderWidth: "1px",
                borderColor:
                  "color-mix(in oklab, var(--mui-palette-divider) 60%, transparent)",
                paddingInline: "0.75rem",
                paddingBlock: "1rem",
                textAlign: "center",
                fontSize: "0.75rem",
                lineHeight: "calc(1 / 0.75)",
                color: "var(--mui-palette-text-secondary)",
              }}
            >
              {t("尚未配置 Header 覆写。")}
            </Box>
          ) : (
            value.headers.map((rule, index) => (
              <Box
                key={rule.id}
                sx={{
                  display: "grid",
                  gap: "0.75rem",
                  borderStyle: "solid",
                  borderWidth: "1px",
                  borderColor:
                    "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                  backgroundColor:
                    "color-mix(in oklab, var(--mui-palette-background-default) 70%, transparent)",
                  padding: "0.75rem",
                  "@media (width >= 80rem)": {
                    gridTemplateColumns:
                      "8rem 8rem minmax(10rem,0.8fr) minmax(14rem,1fr) 2.5rem",
                  },
                }}
              >
                <FormControl size="small">
                  <FormLabel>{t("作用域")}</FormLabel>
                  <Select
                    value={rule.scope}
                    disabled={disabled}
                    inputProps={{
                      "aria-label": t("Header 规则 {{index}} 作用域", {
                        index: index + 1,
                      }),
                    }}
                    onChange={(event) =>
                      updateHeader(rule.id, {
                        scope: event.target.value as RequestOverrideScope,
                      })
                    }
                  >
                    {SCOPE_OPTIONS.map((option) => (
                      <MenuItem key={option.value} value={option.value}>
                        {t(option.label)}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl size="small">
                  <FormLabel>{t("操作")}</FormLabel>
                  <Select
                    value={rule.operation}
                    disabled={disabled}
                    inputProps={{
                      "aria-label": t("Header 规则 {{index}} 操作", {
                        index: index + 1,
                      }),
                    }}
                    onChange={(event) =>
                      updateHeader(rule.id, {
                        operation: event.target
                          .value as RequestOverrideOperation,
                      })
                    }
                  >
                    {OPERATION_OPTIONS.map((option) => (
                      <MenuItem key={option.value} value={option.value}>
                        {t(option.label)}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl>
                  <TextField
                    value={rule.name}
                    disabled={disabled}
                    placeholder="x-codex-window-id"
                    autoComplete="off"
                    sx={{
                      backgroundColor: "var(--mui-palette-background-default)",
                      fontSize: "0.75rem",
                      lineHeight: "calc(1 / 0.75)",
                    }}
                    onChange={(event) =>
                      updateHeader(rule.id, { name: event.target.value })
                    }
                    label={t("Header 名称")}
                    slotProps={{
                      htmlInput: { autoCapitalize: "none", spellCheck: false },
                    }}
                  />
                </FormControl>
                <FormControl>
                  <TextField
                    value={rule.operation === "set" ? rule.value : ""}
                    disabled={disabled || rule.operation === "remove"}
                    placeholder={
                      rule.operation === "set"
                        ? "{{request_id}}"
                        : t("移除操作不需要值")
                    }
                    autoComplete="off"
                    sx={{
                      backgroundColor: "var(--mui-palette-background-default)",
                      fontSize: "0.75rem",
                      lineHeight: "calc(1 / 0.75)",
                    }}
                    onChange={(event) =>
                      updateHeader(rule.id, { value: event.target.value })
                    }
                    label={t("值")}
                    slotProps={{ htmlInput: { spellCheck: false } }}
                  />
                </FormControl>
                <Box sx={{ display: "flex", alignItems: "flex-end" }}>
                  <IconButton
                    type="button"
                    size="small"

                    color="inherit"
                    disabled={disabled}
                    aria-label={t("删除 Header 规则 {{index}}", {
                      index: index + 1,
                    })}
                    onClick={() =>
                      onChange({
                        ...value,
                        headers: value.headers.filter(
                          (item) => item.id !== rule.id,
                        ),
                      })
                    }
                  >
                    <Trash2
                      sx={{ width: "1rem", height: "1rem" }}
                      aria-hidden="true"
                    />
                  </IconButton>
                </Box>
              </Box>
            ))
          )}
        </Box>

        <Box sx={{ display: "grid", gap: "0.75rem" }}>
          <Box
            sx={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "0.5rem",
            }}
          >
            <Box>
              <Typography
                sx={{
                  fontSize: "0.875rem",
                  lineHeight: "calc(1.25 / 0.875)",
                  fontWeight: "500",
                }}
                component="h5"
              >
                {t("Body 规则")}
              </Typography>
              <Typography
                sx={{
                  marginTop: "0.25rem",
                  fontSize: "0.75rem",
                  lineHeight: "calc(1 / 0.75)",
                  color: "var(--mui-palette-text-secondary)",
                }}
                component="p"
              >
                {t(
                  '使用点路径设置或移除 JSON 字段；设置操作的值必须是 JSON，例如 true、123、"text" 或对象。',
                )}
              </Typography>
            </Box>
            <Button
              type="button"
              size="small"
              variant="outlined"
              disabled={disabled || value.body.length >= 128}
              onClick={() =>
                onChange({ ...value, body: [...value.body, emptyBodyRule()] })
              }
            >
              <Plus
                sx={{ width: "0.875rem", height: "0.875rem" }}
                aria-hidden="true"
              />
              {t("添加 Body 规则")}
            </Button>
          </Box>

          {value.body.length === 0 ? (
            <Box
              sx={{
                borderRadius: "8px",
                borderStyle: "dashed",
                borderWidth: "1px",
                borderColor:
                  "color-mix(in oklab, var(--mui-palette-divider) 60%, transparent)",
                paddingInline: "0.75rem",
                paddingBlock: "1rem",
                textAlign: "center",
                fontSize: "0.75rem",
                lineHeight: "calc(1 / 0.75)",
                color: "var(--mui-palette-text-secondary)",
              }}
            >
              {t("尚未配置 Body 覆写。")}
            </Box>
          ) : (
            value.body.map((rule, index) => {
              const valueError = bodyValueError(rule);
              return (
                <Box
                  key={rule.id}
                  sx={{
                    display: "grid",
                    gap: "0.75rem",
                    borderStyle: "solid",
                    borderWidth: "1px",
                    borderColor:
                      "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                    backgroundColor:
                      "color-mix(in oklab, var(--mui-palette-background-default) 70%, transparent)",
                    padding: "0.75rem",
                    "@media (width >= 80rem)": {
                      gridTemplateColumns:
                        "8rem 8rem minmax(14rem,0.9fr) minmax(16rem,1fr) 2.5rem",
                    },
                  }}
                >
                  <FormControl size="small">
                    <FormLabel>{t("作用域")}</FormLabel>
                    <Select
                      value={rule.scope}
                      disabled={disabled}
                      inputProps={{
                        "aria-label": t("Body 规则 {{index}} 作用域", {
                          index: index + 1,
                        }),
                      }}
                      onChange={(event) =>
                        updateBody(rule.id, {
                          scope: event.target.value as RequestOverrideScope,
                        })
                      }
                    >
                      {SCOPE_OPTIONS.map((option) => (
                        <MenuItem key={option.value} value={option.value}>
                          {t(option.label)}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <FormControl size="small">
                    <FormLabel>{t("操作")}</FormLabel>
                    <Select
                      value={rule.operation}
                      disabled={disabled}
                      inputProps={{
                        "aria-label": t("Body 规则 {{index}} 操作", {
                          index: index + 1,
                        }),
                      }}
                      onChange={(event) =>
                        updateBody(rule.id, {
                          operation: event.target
                            .value as RequestOverrideOperation,
                        })
                      }
                    >
                      {OPERATION_OPTIONS.map((option) => (
                        <MenuItem key={option.value} value={option.value}>
                          {t(option.label)}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <FormControl>
                    <TextField
                      value={rule.path}
                      disabled={disabled}
                      placeholder="client_metadata.x-codex-window-id"
                      autoComplete="off"
                      sx={{
                        backgroundColor:
                          "var(--mui-palette-background-default)",
                        fontSize: "0.75rem",
                        lineHeight: "calc(1 / 0.75)",
                      }}
                      onChange={(event) =>
                        updateBody(rule.id, { path: event.target.value })
                      }
                      label={t("JSON 点路径")}
                      slotProps={{
                        htmlInput: {
                          autoCapitalize: "none",
                          spellCheck: false,
                        },
                      }}
                    />
                  </FormControl>
                  <FormControl error={Boolean(valueError)}>
                    <TextField
                      value={rule.operation === "set" ? rule.valueText : ""}
                      disabled={disabled || rule.operation === "remove"}
                      placeholder={
                        rule.operation === "set"
                          ? '"{{request_id}}"'
                          : t("移除操作不需要值")
                      }
                      autoComplete="off"
                      multiline
                      minRows={1}
                      sx={{
                        backgroundColor:
                          "var(--mui-palette-background-default)",
                        fontSize: "0.75rem",
                        lineHeight: "calc(1 / 0.75)",
                      }}
                      onChange={(event) =>
                        updateBody(rule.id, { valueText: event.target.value })
                      }
                      label={t("JSON 值")}
                      slotProps={{ htmlInput: { spellCheck: false } }}
                    />
                    <FormHelperText>
                      {valueError ??
                        t(
                          "字符串必须包含双引号；对象与数组会递归展开 {{request_id}}。",
                        )}
                    </FormHelperText>
                  </FormControl>
                  <Box sx={{ display: "flex", alignItems: "flex-end" }}>
                    <IconButton
                      type="button"
                      size="small"

                      color="inherit"
                      disabled={disabled}
                      aria-label={t("删除 Body 规则 {{index}}", {
                        index: index + 1,
                      })}
                      onClick={() =>
                        onChange({
                          ...value,
                          body: value.body.filter(
                            (item) => item.id !== rule.id,
                          ),
                        })
                      }
                    >
                      <Trash2
                        sx={{ width: "1rem", height: "1rem" }}
                        aria-hidden="true"
                      />
                    </IconButton>
                  </Box>
                </Box>
              );
            })
          )}
        </Box>
      </Box>
    </Box>
  );
}
