import Plus from "@mui/icons-material/AddOutlined";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
import Copy from "@mui/icons-material/ContentCopyOutlined";
import Trash2 from "@mui/icons-material/DeleteOutlined";
import Power from "@mui/icons-material/PowerSettingsNewOutlined";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Drawer from "@mui/material/Drawer";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import { useState,type FormEvent } from "react";

import { useI18n } from "@/lib/i18n";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import FormControl from "@mui/material/FormControl";
import FormHelperText from "@mui/material/FormHelperText";
import FormLabel from "@mui/material/FormLabel";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { createApiKey,deleteApiKey,updateApiKey } from "../lib/api";
import {
formatCompactInteger,
formatDateTime,
formatDateTimeLocalInput,
parseDateTimeLocalInput,
} from "../lib/format";
import type {
ApiKeyWorkspace,
ConnectionSettings,
CreateApiKeyInput,
CreatedApiKey,
ProviderWorkspace,
UpdateApiKeyInput,
} from "../lib/types";
interface ApiKeysPageProps {
  settings: ConnectionSettings;
  items: ApiKeyWorkspace[];
  providers: ProviderWorkspace[];
  onRefresh: (successMessage?: string) => Promise<void>;
  onMessage: (message: string) => void;
}
function readString(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}
function readBool(formData: FormData, key: string): boolean {
  return formData.get(key) === "on";
}
function isExpiringSoon(expiresAtMs: number | null) {
  return (
    typeof expiresAtMs === "number" &&
    expiresAtMs > Date.now() &&
    expiresAtMs - Date.now() < 7 * 24 * 60 * 60 * 1000
  );
}
function keyStatus(item: ApiKeyWorkspace) {
  if (!item.apiKey.enabled)
    return {
      label: "停用",
      tone: "disabled" as const,
    };
  if (
    item.apiKey.expires_at_ms !== null &&
    item.apiKey.expires_at_ms <= Date.now()
  )
    return { label: "已过期", tone: "error" as const };
  if (isExpiringSoon(item.apiKey.expires_at_ms))
    return {
      label: "即将过期",
      tone: "warning" as const,
    };
  return {
    label: "启用",
    tone: "normal" as const,
  };
}
export function ApiKeysPage(props: ApiKeysPageProps) {
  const { t } = useI18n();
  const [removeItem, setRemoveItem] = useState<ApiKeyWorkspace | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [createGroupIds, setCreateGroupIds] = useState<number[]>([]);
  const [editGroupIds, setEditGroupIds] = useState<number[]>([]);
  const selected =
    props.items.find((item) => item.apiKey.id === selectedId) ?? null;
  const openCreateDrawer = () => {
    setCreated(null);
    setFormError(null);
    setCreateGroupIds([]);
    setCreateOpen(true);
  };
  const openDetails = (item: ApiKeyWorkspace) => {
    setFormError(null);
    setSelectedId(item.apiKey.id);
    setEditGroupIds(item.apiKey.allowed_provider_ids ?? []);
  };
  const closeCreateDrawer = () => {
    setCreateOpen(false);
    setCreated(null);
  };
  const ensureLive = () => {
    if (!props.settings.adminToken.trim()) {
      props.onMessage("请先填写管理员口令。");
      return false;
    }
    return true;
  };
  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ensureLive()) return;
    const formData = new FormData(event.currentTarget);
    const payload: CreateApiKeyInput = {
      name: readString(formData, "name"),
      enabled: readBool(formData, "enabled"),
      log_enabled: readBool(formData, "log_enabled"),
      expires_at_ms: parseDateTimeLocalInput(
        readString(formData, "expires_at"),
      ),
      allowed_provider_ids: createGroupIds,
    };
    if (!payload.name) {
      props.onMessage("密钥名称不能为空。");
      return;
    }
    setBusy("create");
    try {
      const result = await createApiKey(props.settings, payload);
      setCreated(result);
      await props.onRefresh(
        t("密钥 {{name}} 已创建。", {
          name: payload.name,
        }),
      );
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "创建访问密钥失败。",
      );
    } finally {
      setBusy(null);
    }
  };
  const submitUpdate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const current = selected;
    if (!current || !ensureLive()) return;
    const formData = new FormData(event.currentTarget);
    const payload: UpdateApiKeyInput = {
      name: readString(formData, "name"),
      enabled: readBool(formData, "enabled"),
      log_enabled: readBool(formData, "log_enabled"),
      expires_at_ms: parseDateTimeLocalInput(
        readString(formData, "expires_at"),
      ),
      allowed_provider_ids: editGroupIds,
    };
    if (!payload.name) {
      props.onMessage("密钥名称不能为空。");
      return;
    }
    setBusy(`update-${current.apiKey.id}`);
    try {
      await updateApiKey(props.settings, current.apiKey.id, payload);
      await props.onRefresh(
        t("密钥 {{name}} 已更新。", {
          name: payload.name,
        }),
      );
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "更新密钥失败。");
    } finally {
      setBusy(null);
    }
  };
  const toggleEnabled = async (item: ApiKeyWorkspace, enabled: boolean) => {
    if (!ensureLive()) return;
    setBusy(`toggle-${item.apiKey.id}`);
    try {
      await updateApiKey(props.settings, item.apiKey.id, {
        enabled,
      });
      await props.onRefresh(
        t(enabled ? "密钥 {{name}} 已启用。" : "密钥 {{name}} 已停用。", {
          name: item.apiKey.name,
        }),
      );
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "更新状态失败。");
    } finally {
      setBusy(null);
    }
  };
  const handleDelete = async (item: ApiKeyWorkspace) => {
    if (!ensureLive()) return;
    setBusy(`delete-${item.apiKey.id}`);
    try {
      await deleteApiKey(props.settings, item.apiKey.id);
      setRemoveItem(null);
      setSelectedId((current) => (current === item.apiKey.id ? null : current));
      await props.onRefresh(
        t("密钥 {{name}} 已删除。", {
          name: item.apiKey.name,
        }),
      );
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "删除密钥失败。");
    } finally {
      setBusy(null);
    }
  };
  const stats = () => [
    {
      label: "密钥总数",
      value: formatCompactInteger(props.items.length),
      hint: "当前已创建的访问密钥",
    },
    {
      label: "启用中",
      value: formatCompactInteger(
        props.items.filter(
          (item) =>
            item.apiKey.enabled &&
            (item.apiKey.expires_at_ms === null ||
              item.apiKey.expires_at_ms > Date.now()),
        ).length,
      ),
      hint: "可立即发起请求",
    },
    {
      label: "即将过期",
      value: formatCompactInteger(
        props.items.filter((item) => isExpiringSoon(item.apiKey.expires_at_ms))
          .length,
      ),
      hint: "7 天内到期",
    },
    {
      label: "记录日志",
      value: formatCompactInteger(
        props.items.filter((item) => item.apiKey.log_enabled).length,
      ),
      hint: "开启请求元数据",
    },
  ];
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <Stack
        component="header"
        direction="row"
        sx={{ justifyContent: "flex-end", flexWrap: "wrap", gap: 1.5 }}
      >
        {
          <Button type="button" onClick={openCreateDrawer}>
            <Plus />
            {t("创建访问密钥")}
          </Button>
        }
      </Stack>

      <Grid container spacing={2} aria-label={undefined} aria-busy={false}>
        {stats().map((item) => (
          <Grid key={item.label} size={{ xs: 12, sm: 6, xl: 3 }}>
            <Card sx={{ height: "100%" }}>
              <CardContent>
                <Typography color="text.secondary" variant="body2">
                  {t(item.label)}
                </Typography>
                <Typography component="div" variant="h1" sx={{ my: 1 }}>
                  {item.value}
                </Typography>
                {item.hint ? (
                  <Typography variant="caption" color="text.secondary">
                    {t(item.hint)}
                  </Typography>
                ) : null}
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

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
            {t("访问密钥列表")}
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
            {t("用于客户端连接本应用，与上游 API Key 分开管理。")}
          </Typography>
        </Box>
        <CardContent>
          {props.items.length > 0 ? (
            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>{t("密钥")}</TableCell>
                    <TableCell>{t("状态")}</TableCell>
                    <TableCell>{t("允许使用的上游")}</TableCell>
                    <TableCell>{t("日志")}</TableCell>
                    <TableCell>{t("到期")}</TableCell>
                    <TableCell sx={{ textAlign: "right" }}>
                      {t("操作")}
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {props.items.map((item) => {
                    const status = keyStatus(item);
                    return (
                      <TableRow
                        key={item.apiKey.id}
                        sx={{ cursor: "pointer" }}
                        onClick={() => openDetails(item)}
                      >
                        <TableCell>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.25rem",
                            }}
                          >
                            <Box
                              sx={{
                                fontSize: "0.875rem",
                                lineHeight: "calc(1.25 / 0.875)",
                                fontWeight: "500",
                                color: "var(--mui-palette-text-primary)",
                              }}
                              component="strong"
                            >
                              {item.apiKey.name}
                            </Box>
                            <Box
                              sx={{
                                fontSize: "0.75rem",
                                lineHeight: "calc(1 / 0.75)",
                                color: "var(--mui-palette-text-secondary)",
                              }}
                              component="span"
                            >
                              #{item.apiKey.id}
                            </Box>
                          </Box>
                        </TableCell>
                        <TableCell>
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
                              )[status.tone]
                            }
                            label={t(status.label)}
                          />
                        </TableCell>
                        <TableCell
                          sx={{
                            fontSize: "0.75rem",
                            lineHeight: "calc(1 / 0.75)",
                            color: "var(--mui-palette-text-secondary)",
                          }}
                        >
                          {props.providers
                            .filter((p) =>
                              item.apiKey.allowed_provider_ids?.includes(
                                p.provider.id,
                              ),
                            )
                            .map((p) => p.provider.name)
                            .join(", ") || "—"}
                        </TableCell>
                        <TableCell>
                          {t(item.apiKey.log_enabled ? "开启" : "关闭")}
                        </TableCell>
                        <TableCell>
                          {item.apiKey.expires_at_ms
                            ? formatDateTime(item.apiKey.expires_at_ms)
                            : t("不过期")}
                        </TableCell>
                        <TableCell sx={{ textAlign: "right" }}>
                          <Box
                            sx={{
                              display: "flex",
                              justifyContent: "flex-end",
                              gap: "0.5rem",
                            }}
                          >
                            <Button
                              type="button"
                              size="small"
                              variant="text"
                              onClick={(event) => {
                                event.stopPropagation();
                                openDetails(item);
                              }}
                            >
                              {t("查看")}
                            </Button>
                            <Button
                              type="button"
                              size="small"
                              variant="text"
                              aria-label={
                                item.apiKey.enabled
                                  ? t("停用密钥")
                                  : t("启用密钥")
                              }
                              disabled={busy === `toggle-${item.apiKey.id}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                void toggleEnabled(item, !item.apiKey.enabled);
                              }}
                            >
                              <Power />
                            </Button>
                          </Box>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          ) : (
            <Box sx={{ py: 6, px: 2, textAlign: "center" }}>
              <Typography variant="subtitle1">{t("还没有密钥")}</Typography>
              <Typography color="text.secondary" sx={{ mt: 1 }}>
                {t("先创建第一条访问密钥，再提供给接入方使用。")}
              </Typography>
              <Box sx={{ mt: 2 }}>
                {
                  <Button type="button" onClick={openCreateDrawer}>
                    {t("创建访问密钥")}
                  </Button>
                }
              </Box>
            </Box>
          )}
        </CardContent>
      </Card>

      <Drawer
        anchor="right"
        open={createOpen}
        onClose={closeCreateDrawer}
        slotProps={{
          paper: {
            role: "dialog",
            "aria-modal": true,
            "aria-label": t("创建访问密钥"),
            sx: { width: { xs: "100%", sm: 720 }, maxWidth: "100%" },
          },
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "flex-start",
            gap: 2,
            p: 3,
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              component="h2"
              variant="h2"
              sx={{ overflowWrap: "anywhere" }}
            >
              {t("创建访问密钥")}
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 1 }}>
              {"填写必要信息后立即生成。"}
            </Typography>
          </Box>
          <IconButton aria-label={t("关闭")} onClick={closeCreateDrawer}>
            <CloseOutlined />
          </IconButton>
        </Box>
        <Box
          sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: { xs: 2, sm: 3 } }}
        >
          <Box
            sx={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
            onSubmit={(event) => void submitCreate(event)}
            component="form"
          >
            {formError ? <Alert severity="error">{formError}</Alert> : null}
            <Box sx={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <FormControl>
                <TextField
                  name="name"
                  placeholder={t("team-default")}
                  label={t("名称")}
                />
              </FormControl>
              <FormControl>
                <TextField
                  label={t("到期时间")}
                  name="expires_at"
                  type="datetime-local"
                />
                <FormHelperText>{t("留空表示不过期。")}</FormHelperText>
              </FormControl>
              <Box>
                <FormControl fullWidth>
                  <FormLabel>{t("允许使用的上游")}</FormLabel>
                  <Select
                    multiple
                    value={createGroupIds}
                    onChange={(event) => {
                      const value = event.target.value;
                      setCreateGroupIds(
                        (typeof value === "string" ? value.split(",") : value)
                          .map(Number)
                          .filter(Number.isFinite),
                      );
                    }}
                    renderValue={(selectedIds) =>
                      props.providers
                        .map((item) => item.provider)
                        .filter((group) => selectedIds.includes(group.id))
                        .map((group) => group.name)
                        .join(", ")
                    }
                  >
                    {props.providers
                      .map((item) => item.provider)
                      .map((group) => (
                        <MenuItem key={group.id} value={group.id}>
                          <Checkbox
                            checked={createGroupIds.includes(group.id)}
                          />
                          <ListItemText primary={group.name} />
                        </MenuItem>
                      ))}
                  </Select>
                  <FormHelperText>
                    {t(
                      "仅允许所选上游；空列表表示无权限，新上游不会自动加入。",
                    )}
                  </FormHelperText>
                </FormControl>
              </Box>
            </Box>
            <Box
              sx={{
                display: "grid",
                gap: "0.75rem",
                "@media (width >= 48rem)": {
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                },
              }}
            >
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
                <Checkbox name="enabled" defaultChecked />
                <Box component="span">{t("创建后立即启用")}</Box>
              </Box>
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
                <Checkbox name="log_enabled" defaultChecked />
                <Box component="span">{t("记录请求元数据")}</Box>
              </Box>
            </Box>
            <Button
              loading={Boolean(busy === "create")}
              type="submit"
              disabled={busy === "create" || created !== null}
            >
              {t(busy === "create" ? "创建中…" : "创建访问密钥")}
            </Button>
            {created
              ? ((createdKey) => (
                  <Card
                    sx={{
                      borderColor:
                        "color-mix(in srgb, var(--mui-palette-success-main) 35%, var(--mui-palette-divider))",
                      backgroundColor:
                        "color-mix(in srgb, var(--mui-palette-success-main) 8%, var(--mui-palette-background-paper))",
                    }}
                  >
                    <CardContent
                      sx={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.5rem",
                        padding: "1rem",
                      }}
                    >
                      <Box
                        sx={{
                          fontSize: "0.875rem",
                          lineHeight: "calc(1.25 / 0.875)",
                          fontWeight: "500",
                          color: "var(--mui-palette-text-primary)",
                        }}
                      >
                        {t("明文密钥只展示一次")}
                      </Box>
                      <Box
                        sx={{
                          wordBreak: "break-all",
                          fontSize: "0.875rem",
                          lineHeight: "calc(1.25 / 0.875)",
                          color: "var(--mui-palette-text-primary)",
                        }}
                        component="code"
                      >
                        {createdKey.api_key}
                      </Box>
                      <Box>
                        <Button
                          type="button"
                          size="small"
                          variant="outlined"
                          onClick={() =>
                            void navigator.clipboard
                              .writeText(createdKey.api_key)
                              .then(() => props.onMessage(t("新密钥已复制。")))
                          }
                        >
                          <Copy />
                          {t("复制")}
                        </Button>
                      </Box>
                    </CardContent>
                  </Card>
                ))(created)
              : null}
          </Box>
        </Box>
      </Drawer>

      <Drawer
        anchor="right"
        open={!!selected}
        onClose={() => setSelectedId(null)}
        slotProps={{
          paper: {
            role: "dialog",
            "aria-modal": true,
            "aria-label": t(selected?.apiKey.name ?? "密钥详情"),
            sx: { width: { xs: "100%", sm: 720 }, maxWidth: "100%" },
          },
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "flex-start",
            gap: 2,
            p: 3,
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              component="h2"
              variant="h2"
              sx={{ overflowWrap: "anywhere" }}
            >
              {t(selected?.apiKey.name ?? "密钥详情")}
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 1 }}>
              {selected ? `查看并维护 #${selected.apiKey.id}` : undefined}
            </Typography>
          </Box>
          <IconButton
            aria-label={t("关闭")}
            onClick={() => setSelectedId(null)}
          >
            <CloseOutlined />
          </IconButton>
        </Box>
        <Box
          sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: { xs: 2, sm: 3 } }}
        >
          {selected
            ? ((item) => {
                const data = item;
                const status = keyStatus(data);
                return (
                  <Box
                    sx={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "1rem",
                    }}
                  >
                    <Box
                      sx={{
                        display: "grid",
                        gap: "0.625rem",
                        "@media (width >= 48rem)": {
                          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
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
                          {t("状态")}
                        </Box>
                        <Box sx={{ marginTop: "0.375rem" }}>
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
                              )[status.tone]
                            }
                            label={t(status.label)}
                          />
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
                          {t("请求元数据")}
                        </Box>
                        <Box
                          sx={{
                            marginTop: "0.375rem",
                            fontSize: "0.875rem",
                            lineHeight: "calc(1.25 / 0.875)",
                            fontWeight: "600",
                            color: "var(--mui-palette-text-primary)",
                          }}
                        >
                          {t(data.apiKey.log_enabled ? "开启" : "关闭")}
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
                          {t("到期")}
                        </Box>
                        <Box
                          sx={{
                            marginTop: "0.375rem",
                            fontSize: "0.875rem",
                            lineHeight: "calc(1.25 / 0.875)",
                            fontWeight: "600",
                            color: "var(--mui-palette-text-primary)",
                          }}
                        >
                          {data.apiKey.expires_at_ms
                            ? formatDateTime(data.apiKey.expires_at_ms)
                            : t("不过期")}
                        </Box>
                      </Box>
                    </Box>

                    <Box
                      sx={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.75rem",
                      }}
                      onSubmit={(event) => void submitUpdate(event)}
                      component="form"
                    >
                      {formError ? (
                        <Alert severity="error">{formError}</Alert>
                      ) : null}
                      <Box
                        sx={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "1rem",
                        }}
                      >
                        <FormControl>
                          <TextField
                            label={t("名称")}
                            name="name"
                            defaultValue={data.apiKey.name}
                          />
                        </FormControl>
                        <FormControl>
                          <TextField
                            label={t("到期时间")}
                            name="expires_at"
                            type="datetime-local"
                            defaultValue={formatDateTimeLocalInput(
                              data.apiKey.expires_at_ms,
                            )}
                          />
                        </FormControl>
                        <Box>
                          <FormControl fullWidth>
                            <FormLabel>{t("允许使用的上游")}</FormLabel>
                            <Select
                              multiple
                              value={editGroupIds}
                              onChange={(event) => {
                                const value = event.target.value;
                                setEditGroupIds(
                                  (typeof value === "string"
                                    ? value.split(",")
                                    : value
                                  )
                                    .map(Number)
                                    .filter(Number.isFinite),
                                );
                              }}
                              renderValue={(selectedIds) =>
                                props.providers
                                  .map((item) => item.provider)
                                  .filter((group) =>
                                    selectedIds.includes(group.id),
                                  )
                                  .map((group) => group.name)
                                  .join(", ")
                              }
                            >
                              {props.providers
                                .map((item) => item.provider)
                                .map((group) => (
                                  <MenuItem key={group.id} value={group.id}>
                                    <Checkbox
                                      checked={editGroupIds.includes(group.id)}
                                    />
                                    <ListItemText primary={group.name} />
                                  </MenuItem>
                                ))}
                            </Select>
                          </FormControl>
                        </Box>
                      </Box>

                      <Box
                        sx={{
                          display: "grid",
                          gap: "0.75rem",
                          "@media (width >= 48rem)": {
                            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                          },
                        }}
                      >
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
                            name="enabled"
                            defaultChecked={data.apiKey.enabled}
                          />
                          <Box component="span">{t("启用密钥")}</Box>
                        </Box>
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
                            name="log_enabled"
                            defaultChecked={data.apiKey.log_enabled}
                          />
                          <Box component="span">{t("记录请求元数据")}</Box>
                        </Box>
                      </Box>

                      <Box
                        sx={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "0.5rem",
                        }}
                      >
                        <Button
                          loading={Boolean(busy === `update-${data.apiKey.id}`)}
                          type="submit"
                          disabled={busy === `update-${data.apiKey.id}`}
                        >
                          {t(
                            busy === `update-${data.apiKey.id}`
                              ? "保存中…"
                              : "保存更改",
                          )}
                        </Button>
                        <Button
                          type="button"
                          variant="outlined"
                          disabled={busy === `toggle-${data.apiKey.id}`}
                          onClick={() =>
                            void toggleEnabled(data, !data.apiKey.enabled)
                          }
                        >
                          <Power />
                          {t(data.apiKey.enabled ? "停用" : "启用")}
                        </Button>
                        <Button
                          type="button"
                          variant="outlined"
                          disabled={busy === `delete-${data.apiKey.id}`}
                          onClick={() => {
                            setFormError(null);
                            setRemoveItem(data);
                          }}
                        >
                          <Trash2 />
                          {t("删除")}
                        </Button>
                      </Box>
                    </Box>
                  </Box>
                );
              })(selected)
            : null}
        </Box>
      </Drawer>
      <Dialog
        open={removeItem !== null}
        onClose={busy !== null ? undefined : () => setRemoveItem(null)}
        aria-label={t("删除访问密钥")}
      >
        <DialogTitle>{t("删除访问密钥")}</DialogTitle>
        <DialogContent>
          {formError ? <Alert severity="error">{formError}</Alert> : null}
          <DialogContentText>
            {removeItem
              ? t("删除密钥“{{name}}”？该操作不可撤销。", {
                  name: removeItem.apiKey.name,
                })
              : ""}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            autoFocus
            variant="outlined"
            disabled={busy !== null}
            onClick={() => setRemoveItem(null)}
          >
            {t("取消")}
          </Button>
          <Button
            color="error"
            loading={busy !== null}
            onClick={() => {
              if (removeItem) void handleDelete(removeItem);
            }}
          >
            {t("确认删除")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
