import ExpandMoreOutlined from "@mui/icons-material/ExpandMoreOutlined";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Chip from "@mui/material/Chip";
import { useState,type FormEvent } from "react";

import { useI18n } from "@/lib/i18n";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import FormControl from "@mui/material/FormControl";
import FormHelperText from "@mui/material/FormHelperText";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { Link } from "react-router";
import { updateRuntimeSetting } from "../lib/api";
import {
formatBytes,
formatCommitShort,
formatMs,
formatVersionLabel,
} from "../lib/format";
import type {
ConnectionSettings,
RuntimeEnvPreviewResponse,
RuntimeSettingView,
RuntimeSettingsResponse,
SystemConfigResponse,
} from "../lib/types";
interface SettingsPageProps {
  settings: ConnectionSettings;
  systemConfig: SystemConfigResponse | null;
  runtimeSettings: RuntimeSettingsResponse | null;
  runtimeEnvPreview: RuntimeEnvPreviewResponse | null;
  onApiBaseChange: (value: string) => void;
  onAdminTokenChange: (value: string) => void;
  onRefresh: (successMessage?: string) => Promise<void>;
  onMessage: (message: string) => void;
}
type SectionKey =
  | "basic"
  | "runtime"
  | "routing"
  | "stability"
  | "retention"
  | "pricing"
  | "beta";
function readString(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}
export function SettingsPage(props: SettingsPageProps) {
  const { t } = useI18n();
  const [openSection, setOpenSection] = useState<SectionKey | null>("basic");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const toggleSection = (key: SectionKey) =>
    setOpenSection((current) => (current === key ? null : key));
  const submitRuntimeSetting = async (
    event: FormEvent<HTMLFormElement>,
    setting: RuntimeSettingView,
  ) => {
    event.preventDefault();
    if (busy) return;
    setSaveError(null);
    if (!props.settings.adminToken.trim()) {
      props.onMessage("请先填写管理员口令。");
      return;
    }
    if (!setting.editable) {
      props.onMessage("该设置需要重启后调整。");
      return;
    }
    const formData = new FormData(event.currentTarget);
    const raw = readString(formData, `runtime_${setting.key}`);
    let value: string | number | boolean | null = raw;
    if (typeof setting.value === "boolean") {
      value = formData.get(`runtime_${setting.key}`) === "on";
    } else if (typeof setting.value === "number") {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        props.onMessage("请输入有效数字。");
        return;
      }
      value = parsed;
    }
    setBusy(true);
    try {
      await updateRuntimeSetting(props.settings, setting.key, value);
      await props.onRefresh(`${setting.label} 已更新。`);
    } catch (error) {
      props.onMessage(
        error instanceof Error ? error.message : "更新设置失败。",
      );
    } finally {
      setBusy(false);
    }
  };
  const renderRuntimeSetting = (setting: RuntimeSettingView) => (
    <Box
      key={`${setting.key}:${String(setting.value)}`}
      sx={{
        borderStyle: "solid",
        borderWidth: "1px",
        borderColor:
          "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
        backgroundColor:
          "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
        padding: "0.75rem",
        borderRadius: "8px",
      }}
      onSubmit={(event) => void submitRuntimeSetting(event, setting)}
      component="form"
    >
      <Box
        sx={{
          marginBottom: "0.75rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.625rem",
        }}
      >
        <Box>
          <Box
            sx={{
              fontSize: "0.875rem",
              fontWeight: "500",
              color: "var(--mui-palette-text-primary)",
            }}
          >
            {t(setting.label)}
          </Box>
          <Box
            sx={{
              marginTop: "0.125rem",
              fontSize: "0.75rem",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              color: "var(--mui-palette-text-secondary)",
            }}
          >
            {setting.requires_restart ? "重启生效" : "立即生效"}
          </Box>
        </Box>
        <Chip
          color={
            (
              {
                normal: "success",
                warning: "warning",
                error: "error",
                disabled: "default",
                draft: "default",
                archived: "default",
              } as const
            )[setting.editable ? "normal" : "warning"]
          }
          label={t(setting.editable ? "可修改" : "需重启")}
        />
      </Box>

      <RuntimeSettingControl setting={setting} />
      {saveError?.key === setting.key ? (
        <Alert severity="error" sx={{ mt: 1 }}>
          {saveError.message}
        </Alert>
      ) : null}
      {setting.key === "encrypted_content_recovery" ? (
        <Box
          sx={{
            marginTop: "0.5rem",
            ":where(& > :not(:last-child))": {
              marginBlockStart: "calc(0.5rem * 0)",
              marginBlockEnd: "calc(0.5rem * calc(1 - 0))",
            },
          }}
        >
          <Typography variant="body2" color="text.secondary">
            {t(
              "遇到加密内容校验失败时，清理加密推理内容并在当前账号重试一次；同一会话后续请求自动过滤已失效的旧密文。",
            )}
          </Typography>
          <Typography variant="body2" color="warning.main">
            {t(
              "实验功能，默认关闭。恢复会移除加密压缩项，可能丢失早期上下文；保留可见消息和工具记录。",
            )}
          </Typography>
        </Box>
      ) : null}

      <Box
        sx={{
          marginTop: "0.75rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.625rem",
          borderTopStyle: "solid",
          borderTopWidth: "1px",
          borderColor:
            "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
          paddingTop: "0.75rem",
        }}
      >
        <Box
          sx={{
            fontSize: "0.75rem",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "var(--mui-palette-text-secondary)",
          }}
          component="span"
        >
          默认 {formatSettingValue(setting.default_value)}
        </Box>
        <Button
          type="submit"
          size="small"
          disabled={!setting.editable}
          loading={busy}
        >
          {t("保存")}
        </Button>
      </Box>
    </Box>
  );
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <Card>
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            padding: "1rem",
            paddingBottom: "0.75rem",
          }}
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "0.625rem",
            }}
          >
            <Box>
              <Typography
                sx={{
                  fontSize: "0.875rem",
                  lineHeight: "calc(1.25 / 0.875)",
                  fontWeight: "600",
                  letterSpacing: "0em",
                  color: "var(--mui-palette-text-primary)",
                }}
                component="div"
              >
                {t("基础连接")}
              </Typography>
              <Typography
                sx={{
                  marginTop: "0.125rem",
                  fontSize: "0.875rem",
                  lineHeight: "1.25rem",
                  color: "var(--mui-palette-text-secondary)",
                }}
                component="div"
              >
                {t("更新当前控制台的连接信息。")}
              </Typography>
            </Box>
            <Chip
              color={
                (
                  {
                    normal: "success",
                    warning: "warning",
                    error: "error",
                    disabled: "default",
                    draft: "default",
                    archived: "default",
                  } as const
                )[props.settings.adminToken.trim() ? "normal" : "warning"]
              }
              label={t(props.settings.adminToken.trim() ? "已连接" : "未连接")}
            />
          </Box>
        </Box>
        <CardContent>
          <Box
            sx={{ display: "flex", flexDirection: "column", gap: "1rem" }}
            onSubmit={(event) => {
              event.preventDefault();
              void props.onRefresh("连接信息已刷新。");
            }}
            component="form"
          >
            <Box
              sx={{
                display: "grid",
                gap: "1rem",
                "@media (width >= 48rem)": {
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                },
              }}
            >
              <FormControl>
                <TextField
                  label={t("服务地址")}
                  id="settings-api-base"
                  value={props.settings.apiBase}
                  onChange={(event) =>
                    props.onApiBaseChange(event.target.value)
                  }
                />
              </FormControl>
              <FormControl>
                <TextField
                  label={t("管理员口令")}
                  id="settings-admin-token"
                  type="password"
                  value={props.settings.adminToken}
                  onChange={(event) =>
                    props.onAdminTokenChange(event.target.value)
                  }
                />
                <FormHelperText>{t("只保存在当前标签页。")}</FormHelperText>
              </FormControl>
            </Box>
            <Box
              sx={{
                display: "flex",
                justifyContent: "flex-end",
                borderTopStyle: "solid",
                borderTopWidth: "1px",
                borderColor:
                  "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                paddingTop: "0.75rem",
              }}
            >
              <Button type="submit">{t("刷新连接")}</Button>
            </Box>
          </Box>
        </CardContent>
      </Card>

      <Accordion
        expanded={openSection === "basic"}
        onChange={() => toggleSection("basic")}
        disableGutters
      >
        <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
          <Box>
            <Typography component="h2" variant="h2">
              {t("基础设置")}
            </Typography>
            <Typography color="text.secondary">
              {t("查看当前服务配置。")}
            </Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          {
            <>
              <Box
                sx={{
                  display: "grid",
                  gap: "1rem",
                  "@media (width >= 48rem)": {
                    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  },
                }}
              >
                <Box
                  sx={{
                    borderStyle: "solid",
                    borderWidth: "1px",
                    borderColor:
                      "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                    backgroundColor:
                      "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                    padding: "0.75rem",
                    borderRadius: "8px",
                  }}
                >
                  <Box
                    sx={{
                      fontSize: "0.75rem",
                      fontWeight: "600",
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      color: "var(--mui-palette-text-secondary)",
                    }}
                  >
                    {t("服务版本")}
                  </Box>
                  <Box
                    sx={{
                      marginTop: "0.375rem",
                      wordBreak: "break-all",
                      fontSize: "0.875rem",
                      color: "var(--mui-palette-text-primary)",
                    }}
                  >
                    {t(formatVersionLabel(props.systemConfig?.build?.version))}
                  </Box>
                </Box>
                <Box
                  sx={{
                    borderStyle: "solid",
                    borderWidth: "1px",
                    borderColor:
                      "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                    backgroundColor:
                      "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                    padding: "0.75rem",
                    borderRadius: "8px",
                  }}
                >
                  <Box
                    sx={{
                      fontSize: "0.75rem",
                      fontWeight: "600",
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      color: "var(--mui-palette-text-secondary)",
                    }}
                  >
                    {t("构建提交")}
                  </Box>
                  <Box
                    sx={{
                      marginTop: "0.375rem",
                      wordBreak: "break-all",
                      fontSize: "0.875rem",
                      color: "var(--mui-palette-text-primary)",
                    }}
                  >
                    {t(formatCommitShort(props.systemConfig?.build?.commit))}
                  </Box>
                </Box>
                <Box
                  sx={{
                    borderStyle: "solid",
                    borderWidth: "1px",
                    borderColor:
                      "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                    backgroundColor:
                      "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                    padding: "0.75rem",
                    borderRadius: "8px",
                  }}
                >
                  <Box
                    sx={{
                      fontSize: "0.75rem",
                      fontWeight: "600",
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      color: "var(--mui-palette-text-secondary)",
                    }}
                  >
                    {t("请求大小限制")}
                  </Box>
                  <Box
                    sx={{
                      marginTop: "0.375rem",
                      wordBreak: "break-all",
                      fontSize: "0.875rem",
                      color: "var(--mui-palette-text-primary)",
                    }}
                  >
                    {t(
                      props.systemConfig
                        ? formatBytes(
                            props.systemConfig.basic.max_request_bytes,
                          )
                        : "—",
                    )}
                  </Box>
                </Box>
                <Box
                  sx={{
                    borderStyle: "solid",
                    borderWidth: "1px",
                    borderColor:
                      "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                    backgroundColor:
                      "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                    padding: "0.75rem",
                    borderRadius: "8px",
                  }}
                >
                  <Box
                    sx={{
                      fontSize: "0.75rem",
                      fontWeight: "600",
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      color: "var(--mui-palette-text-secondary)",
                    }}
                  >
                    {t("统计刷新")}
                  </Box>
                  <Box
                    sx={{
                      marginTop: "0.375rem",
                      wordBreak: "break-all",
                      fontSize: "0.875rem",
                      color: "var(--mui-palette-text-primary)",
                    }}
                  >
                    {t(
                      props.systemConfig
                        ? `${props.systemConfig.basic.stats_flush_interval_ms}ms`
                        : "—",
                    )}
                  </Box>
                </Box>
              </Box>
            </>
          }
        </AccordionDetails>
      </Accordion>

      <Accordion disableGutters>
        <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
          {" "}
          {t("高级设置")}
        </AccordionSummary>
        <AccordionDetails>
          <Box sx={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <Accordion
              expanded={openSection === "beta"}
              onChange={() => toggleSection("beta")}
              disableGutters
            >
              <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
                <Box>
                  <Typography component="h2" variant="h2">
                    {t("Beta 功能")}
                  </Typography>
                  <Typography color="text.secondary">
                    {t("按需开启实验功能，保存后立即生效。")}
                  </Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                {
                  <>
                    <Box
                      sx={{
                        display: "grid",
                        gap: "0.75rem",
                        "@media (width >= 48rem)": {
                          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                        },
                      }}
                    >
                      {(props.runtimeSettings?.settings ?? [])
                        .filter((setting) => setting.group === "beta")
                        .map(renderRuntimeSetting)}
                    </Box>
                  </>
                }
              </AccordionDetails>
            </Accordion>
            <Accordion
              expanded={openSection === "runtime"}
              onChange={() => toggleSection("runtime")}
              disableGutters
            >
              <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
                <Box>
                  <Typography component="h2" variant="h2">
                    {t("运行设置")}
                  </Typography>
                  <Typography color="text.secondary">
                    {t("常用设置可直接生效，资源类设置按建议调整后重启。")}
                  </Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                {
                  <>
                    <Box sx={{ display: "grid", gap: "1rem" }}>
                      <Box
                        sx={{
                          display: "grid",
                          gap: "0.75rem",
                          "@media (width >= 48rem)": {
                            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                          },
                        }}
                      >
                        {(props.runtimeSettings?.settings ?? [])
                          .filter(
                            (setting) =>
                              setting.group !== "beta" &&
                              setting.key !== "price_sync" &&
                              setting.key !== "endpoint_selector_strategy",
                          )
                          .map(renderRuntimeSetting)}
                      </Box>

                      {props.runtimeEnvPreview
                        ? ((preview) => (
                            <Box
                              sx={{
                                borderStyle: "solid",
                                borderWidth: "1px",
                                borderColor:
                                  "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                                backgroundColor:
                                  "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                                padding: "0.75rem",
                                borderRadius: "8px",
                              }}
                            >
                              <Box
                                sx={{
                                  marginBottom: "0.75rem",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: "0.625rem",
                                }}
                              >
                                <Box>
                                  <Box
                                    sx={{
                                      fontSize: "0.875rem",
                                      fontWeight: "500",
                                      color: "var(--mui-palette-text-primary)",
                                    }}
                                    component="h3"
                                  >
                                    低内存建议
                                  </Box>
                                  <Box
                                    sx={{
                                      marginTop: "0.125rem",
                                      fontSize: "0.75rem",
                                      color:
                                        "var(--mui-palette-text-secondary)",
                                    }}
                                    component="p"
                                  >
                                    适合少量用户和低请求量部署。
                                  </Box>
                                </Box>
                                <Chip
                                  color={
                                    (
                                      {
                                        normal: "success",
                                        warning: "warning",
                                        error: "error",
                                        disabled: "default",
                                        draft: "default",
                                        archived: "default",
                                      } as const
                                    )["normal"]
                                  }
                                  label={t("建议值")}
                                />
                              </Box>
                              <Box
                                sx={{
                                  display: "grid",
                                  gap: "0.625rem",
                                  "@media (width >= 48rem)": {
                                    gridTemplateColumns:
                                      "repeat(2, minmax(0, 1fr))",
                                  },
                                }}
                              >
                                {preview.restart_settings.map((item) => (
                                  <Box
                                    key={item.key}
                                    sx={{
                                      borderStyle: "solid",
                                      borderWidth: "1px",
                                      borderColor:
                                        "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                                      backgroundColor:
                                        "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                                      padding: "0.75rem",
                                      borderRadius: "8px",
                                    }}
                                  >
                                    <Box
                                      sx={{
                                        fontSize: "0.75rem",
                                        fontWeight: "600",
                                        textTransform: "uppercase",
                                        letterSpacing: "0.08em",
                                        color:
                                          "var(--mui-palette-text-secondary)",
                                      }}
                                    >
                                      {t(item.label)}
                                    </Box>
                                    <Box
                                      sx={{
                                        marginTop: "0.375rem",
                                        wordBreak: "break-all",
                                        fontSize: "0.875rem",
                                        color:
                                          "var(--mui-palette-text-primary)",
                                      }}
                                    >
                                      {t(
                                        `${formatSettingValue(item.current)} → ${formatSettingValue(item.recommended)}`,
                                      )}
                                    </Box>
                                  </Box>
                                ))}
                              </Box>
                            </Box>
                          ))(props.runtimeEnvPreview)
                        : null}
                    </Box>
                  </>
                }
              </AccordionDetails>
            </Accordion>

            <Accordion
              expanded={openSection === "routing"}
              onChange={() => toggleSection("routing")}
              disableGutters
            >
              <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
                <Box>
                  <Typography component="h2" variant="h2">
                    {t("分配设置")}
                  </Typography>
                  <Typography color="text.secondary">
                    {t("查看请求分配策略。")}
                  </Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                {
                  <>
                    <Box
                      sx={{
                        display: "grid",
                        gap: "1rem",
                        "@media (width >= 48rem)": {
                          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                        },
                      }}
                    >
                      <Box
                        sx={{
                          borderStyle: "solid",
                          borderWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                          backgroundColor:
                            "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                          padding: "0.75rem",
                          borderRadius: "8px",
                        }}
                      >
                        <Box
                          sx={{
                            fontSize: "0.75rem",
                            fontWeight: "600",
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            color: "var(--mui-palette-text-secondary)",
                          }}
                        >
                          {t("地址选择")}
                        </Box>
                        <Box
                          sx={{
                            marginTop: "0.375rem",
                            wordBreak: "break-all",
                            fontSize: "0.875rem",
                            color: "var(--mui-palette-text-primary)",
                          }}
                        >
                          {t("健康地址按顺序选择")}
                        </Box>
                      </Box>
                      <Box
                        sx={{
                          borderStyle: "solid",
                          borderWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                          backgroundColor:
                            "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                          padding: "0.75rem",
                          borderRadius: "8px",
                        }}
                      >
                        <Box
                          sx={{
                            fontSize: "0.75rem",
                            fontWeight: "600",
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            color: "var(--mui-palette-text-secondary)",
                          }}
                        >
                          {t("返回用量")}
                        </Box>
                        <Box
                          sx={{
                            marginTop: "0.375rem",
                            wordBreak: "break-all",
                            fontSize: "0.875rem",
                            color: "var(--mui-palette-text-primary)",
                          }}
                        >
                          {t(
                            props.systemConfig?.routing.inject_include_usage
                              ? "开启"
                              : "已关闭",
                          )}
                        </Box>
                      </Box>
                      <Box
                        sx={{
                          borderStyle: "solid",
                          borderWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                          backgroundColor:
                            "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                          padding: "0.75rem",
                          borderRadius: "8px",
                        }}
                      >
                        <Box
                          sx={{
                            fontSize: "0.75rem",
                            fontWeight: "600",
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            color: "var(--mui-palette-text-secondary)",
                          }}
                        >
                          {t("上游刷新")}
                        </Box>
                        <Box
                          sx={{
                            marginTop: "0.375rem",
                            wordBreak: "break-all",
                            fontSize: "0.875rem",
                            color: "var(--mui-palette-text-primary)",
                          }}
                        >
                          {t(
                            props.systemConfig
                              ? formatMs(
                                  props.systemConfig.routing
                                    .upstream_cache_ttl_ms,
                                )
                              : "—",
                          )}
                        </Box>
                      </Box>
                      <Box
                        sx={{
                          borderStyle: "solid",
                          borderWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                          backgroundColor:
                            "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                          padding: "0.75rem",
                          borderRadius: "8px",
                        }}
                      >
                        <Box
                          sx={{
                            fontSize: "0.75rem",
                            fontWeight: "600",
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            color: "var(--mui-palette-text-secondary)",
                          }}
                        >
                          {t("密钥刷新")}
                        </Box>
                        <Box
                          sx={{
                            marginTop: "0.375rem",
                            wordBreak: "break-all",
                            fontSize: "0.875rem",
                            color: "var(--mui-palette-text-primary)",
                          }}
                        >
                          {t(
                            props.systemConfig
                              ? formatMs(
                                  props.systemConfig.routing
                                    .api_key_cache_ttl_ms,
                                )
                              : "—",
                          )}
                        </Box>
                      </Box>
                    </Box>
                  </>
                }
              </AccordionDetails>
            </Accordion>

            <Accordion
              expanded={openSection === "stability"}
              onChange={() => toggleSection("stability")}
              disableGutters
            >
              <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
                <Box>
                  <Typography component="h2" variant="h2">
                    {t("稳定性与保护")}
                  </Typography>
                  <Typography color="text.secondary">
                    {t("查看服务故障保护的配置与实际规则。")}
                  </Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                {
                  <>
                    <Box
                      sx={{
                        display: "grid",
                        gap: "1rem",
                        "@media (width >= 48rem)": {
                          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                        },
                      }}
                    >
                      <Box
                        sx={{
                          borderStyle: "solid",
                          borderWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                          backgroundColor:
                            "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                          padding: "0.75rem",
                          borderRadius: "8px",
                        }}
                      >
                        <Box
                          sx={{
                            fontSize: "0.75rem",
                            fontWeight: "600",
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            color: "var(--mui-palette-text-secondary)",
                          }}
                        >
                          {t("单次请求最多尝试")}
                        </Box>
                        <Box
                          sx={{
                            marginTop: "0.375rem",
                            wordBreak: "break-all",
                            fontSize: "0.875rem",
                            color: "var(--mui-palette-text-primary)",
                          }}
                        >
                          {t("3 次")}
                        </Box>
                      </Box>
                      <Box
                        sx={{
                          borderStyle: "solid",
                          borderWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                          backgroundColor:
                            "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                          padding: "0.75rem",
                          borderRadius: "8px",
                        }}
                      >
                        <Box
                          sx={{
                            fontSize: "0.75rem",
                            fontWeight: "600",
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            color: "var(--mui-palette-text-secondary)",
                          }}
                        >
                          {t("首次故障冷却")}
                        </Box>
                        <Box
                          sx={{
                            marginTop: "0.375rem",
                            wordBreak: "break-all",
                            fontSize: "0.875rem",
                            color: "var(--mui-palette-text-primary)",
                          }}
                        >
                          {t("至少 30 秒，反复失败递增")}
                        </Box>
                      </Box>
                      <Box
                        sx={{
                          borderStyle: "solid",
                          borderWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                          backgroundColor:
                            "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                          padding: "0.75rem",
                          borderRadius: "8px",
                        }}
                      >
                        <Box
                          sx={{
                            fontSize: "0.75rem",
                            fontWeight: "600",
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            color: "var(--mui-palette-text-secondary)",
                          }}
                        >
                          {t("失败阈值")}
                        </Box>
                        <Box
                          sx={{
                            marginTop: "0.375rem",
                            wordBreak: "break-all",
                            fontSize: "0.875rem",
                            color: "var(--mui-palette-text-primary)",
                          }}
                        >
                          {t(
                            String(
                              props.systemConfig?.stability
                                .circuit_breaker_failure_threshold ?? "—",
                            ),
                          )}
                        </Box>
                      </Box>
                      <Box
                        sx={{
                          borderStyle: "solid",
                          borderWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                          backgroundColor:
                            "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                          padding: "0.75rem",
                          borderRadius: "8px",
                        }}
                      >
                        <Box
                          sx={{
                            fontSize: "0.75rem",
                            fontWeight: "600",
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            color: "var(--mui-palette-text-secondary)",
                          }}
                        >
                          {t("熔断时长")}
                        </Box>
                        <Box
                          sx={{
                            marginTop: "0.375rem",
                            wordBreak: "break-all",
                            fontSize: "0.875rem",
                            color: "var(--mui-palette-text-primary)",
                          }}
                        >
                          {t(
                            props.systemConfig
                              ? formatMs(
                                  props.systemConfig.stability
                                    .circuit_breaker_open_ms,
                                )
                              : "—",
                          )}
                        </Box>
                      </Box>
                    </Box>
                  </>
                }
              </AccordionDetails>
            </Accordion>

            <Accordion
              expanded={openSection === "retention"}
              onChange={() => toggleSection("retention")}
              disableGutters
            >
              <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
                <Box>
                  <Typography component="h2" variant="h2">
                    {t("数据保留与归档")}
                  </Typography>
                  <Typography color="text.secondary">
                    {t("归档和清理策略集中在这里。")}
                  </Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                {
                  <>
                    <Box
                      sx={{
                        display: "grid",
                        gap: "1rem",
                        "@media (width >= 48rem)": {
                          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                        },
                      }}
                    >
                      <Box
                        sx={{
                          borderStyle: "solid",
                          borderWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                          backgroundColor:
                            "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                          padding: "0.75rem",
                          borderRadius: "8px",
                        }}
                      >
                        <Box
                          sx={{
                            fontSize: "0.75rem",
                            fontWeight: "600",
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            color: "var(--mui-palette-text-secondary)",
                          }}
                        >
                          {t("请求日志保留")}
                        </Box>
                        <Box
                          sx={{
                            marginTop: "0.375rem",
                            wordBreak: "break-all",
                            fontSize: "0.875rem",
                            color: "var(--mui-palette-text-primary)",
                          }}
                        >
                          {t(
                            props.systemConfig
                              ? `${props.systemConfig.retention.request_log_retention_days} 天`
                              : "—",
                          )}
                        </Box>
                      </Box>
                      <Box
                        sx={{
                          borderStyle: "solid",
                          borderWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                          backgroundColor:
                            "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                          padding: "0.75rem",
                          borderRadius: "8px",
                        }}
                      >
                        <Box
                          sx={{
                            fontSize: "0.75rem",
                            fontWeight: "600",
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            color: "var(--mui-palette-text-secondary)",
                          }}
                        >
                          {t("统计保留")}
                        </Box>
                        <Box
                          sx={{
                            marginTop: "0.375rem",
                            wordBreak: "break-all",
                            fontSize: "0.875rem",
                            color: "var(--mui-palette-text-primary)",
                          }}
                        >
                          {t(
                            props.systemConfig
                              ? `${props.systemConfig.retention.stats_daily_retention_days} 天`
                              : "—",
                          )}
                        </Box>
                      </Box>
                      <Box
                        sx={{
                          borderStyle: "solid",
                          borderWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                          backgroundColor:
                            "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                          padding: "0.75rem",
                          borderRadius: "8px",
                        }}
                      >
                        <Box
                          sx={{
                            fontSize: "0.75rem",
                            fontWeight: "600",
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            color: "var(--mui-palette-text-secondary)",
                          }}
                        >
                          {t("清理间隔")}
                        </Box>
                        <Box
                          sx={{
                            marginTop: "0.375rem",
                            wordBreak: "break-all",
                            fontSize: "0.875rem",
                            color: "var(--mui-palette-text-primary)",
                          }}
                        >
                          {t(
                            props.systemConfig
                              ? formatMs(
                                  props.systemConfig.retention
                                    .cleanup_interval_ms,
                                )
                              : "—",
                          )}
                        </Box>
                      </Box>
                      <Box
                        sx={{
                          borderStyle: "solid",
                          borderWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                          backgroundColor:
                            "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                          padding: "0.75rem",
                          borderRadius: "8px",
                        }}
                      >
                        <Box
                          sx={{
                            fontSize: "0.75rem",
                            fontWeight: "600",
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            color: "var(--mui-palette-text-secondary)",
                          }}
                        >
                          {t("删除批次")}
                        </Box>
                        <Box
                          sx={{
                            marginTop: "0.375rem",
                            wordBreak: "break-all",
                            fontSize: "0.875rem",
                            color: "var(--mui-palette-text-primary)",
                          }}
                        >
                          {t(
                            props.systemConfig
                              ? String(
                                  props.systemConfig.retention.delete_batch,
                                )
                              : "—",
                          )}
                        </Box>
                      </Box>
                      <Box
                        sx={{
                          borderStyle: "solid",
                          borderWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                          backgroundColor:
                            "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                          padding: "0.75rem",
                          borderRadius: "8px",
                        }}
                      >
                        <Box
                          sx={{
                            fontSize: "0.75rem",
                            fontWeight: "600",
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            color: "var(--mui-palette-text-secondary)",
                          }}
                        >
                          {t("归档")}
                        </Box>
                        <Box
                          sx={{
                            marginTop: "0.375rem",
                            wordBreak: "break-all",
                            fontSize: "0.875rem",
                            color: "var(--mui-palette-text-primary)",
                          }}
                        >
                          {t(
                            props.systemConfig?.retention.archive_enabled
                              ? "开启"
                              : "已关闭",
                          )}
                        </Box>
                      </Box>
                      <Box
                        sx={{
                          borderStyle: "solid",
                          borderWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 70%, transparent)",
                          backgroundColor:
                            "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
                          padding: "0.75rem",
                          borderRadius: "8px",
                        }}
                      >
                        <Box
                          sx={{
                            fontSize: "0.75rem",
                            fontWeight: "600",
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            color: "var(--mui-palette-text-secondary)",
                          }}
                        >
                          {t("归档目录")}
                        </Box>
                        <Box
                          sx={{
                            marginTop: "0.375rem",
                            wordBreak: "break-all",
                            fontSize: "0.875rem",
                            color: "var(--mui-palette-text-primary)",
                          }}
                        >
                          {t(props.systemConfig?.retention.archive_dir ?? "—")}
                        </Box>
                      </Box>
                    </Box>
                  </>
                }
              </AccordionDetails>
            </Accordion>

            <Accordion
              expanded={openSection === "pricing"}
              onChange={() => toggleSection("pricing")}
              disableGutters
            >
              <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
                <Box>
                  <Typography component="h2" variant="h2">
                    {t("价格与成本")}
                  </Typography>
                  <Typography color="text.secondary">
                    {t("管理模型单价与成本统计。")}
                  </Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                {
                  <>
                    <Typography color="text.secondary">
                      {t("价格管理已移至模型中心。")}
                    </Typography>
                    <Button
                      component={Link}
                      to="/models/prices"
                      variant="outlined"
                    >
                      {t("前往价格管理")}
                    </Button>
                  </>
                }
              </AccordionDetails>
            </Accordion>
          </Box>
        </AccordionDetails>
      </Accordion>
    </Box>
  );
}

function RuntimeSettingControl(props: { setting: RuntimeSettingView }) {
  const { t } = useI18n();
  const setting = props.setting;
  if (typeof setting.value === "boolean") {
    return (
      <Box
        sx={{
          display: "flex",
          minHeight: "2.25rem",
          alignItems: "center",
          gap: "0.625rem",
          borderStyle: "solid",
          borderWidth: "1px",
          borderColor:
            "color-mix(in oklab, var(--mui-palette-divider) 60%, transparent)",
          backgroundColor:
            "color-mix(in oklab, var(--mui-palette-action-hover) 20%, transparent)",
          paddingInline: "0.75rem",
          paddingBlock: "0.5rem",
          fontSize: "0.875rem",
          color: "var(--mui-palette-text-secondary)",
          borderRadius: "8px",
        }}
        component="label"
      >
        <Checkbox
          name={`runtime_${setting.key}`}
          defaultChecked={setting.value}
          disabled={!setting.editable}
        />
        <Box component="span">
          {t(
            setting.key === "encrypted_content_recovery"
              ? "启用加密内容恢复"
              : setting.value
                ? "开启"
                : "关闭",
          )}
        </Box>
      </Box>
    );
  }
  if (typeof setting.value === "number") {
    return (
      <TextField
        name={`runtime_${setting.key}`}
        type="number"
        defaultValue={String(setting.value)}
        disabled={!setting.editable}
      />
    );
  }
  return (
    <TextField
      name={`runtime_${setting.key}`}
      defaultValue={String(setting.value ?? "")}
      disabled={!setting.editable}
    />
  );
}
function formatSettingValue(value: RuntimeSettingView["value"]) {
  if (typeof value === "boolean") return value ? "开启" : "关闭";
  if (value === null) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
