import { routingAvailabilityLabel } from "@/lib/routingAvailability";
import ChevronRight from "@mui/icons-material/ChevronRightOutlined";
import Copy from "@mui/icons-material/ContentCopyOutlined";
import Trash2 from "@mui/icons-material/DeleteOutlined";
import KeyRound from "@mui/icons-material/KeyOutlined";
import LogIn from "@mui/icons-material/LoginOutlined";
import MoreHorizontal from "@mui/icons-material/MoreHorizOutlined";
import ExternalLink from "@mui/icons-material/OpenInNewOutlined";
import Power from "@mui/icons-material/PowerSettingsNewOutlined";
import Globe2 from "@mui/icons-material/PublicOutlined";
import RefreshCw from "@mui/icons-material/RefreshOutlined";
import Send from "@mui/icons-material/SendOutlined";
import Chip from "@mui/material/Chip";
import { useEffect,useMemo,useRef,useState,type FormEvent } from "react";
import { UpstreamKeyModels } from "./UpstreamKeyModels";

import {
cancelCodexOAuthSession,
deleteProviderKey,
loadCodexOAuthSession,
refreshCodexOAuthQuota,
startCodexOAuthSession,
submitCodexOAuthCallback,
updateProviderKey,
} from "@/lib/api";
import { formatDateTime,quotaTextColor } from "@/lib/format";
import { getIntlLocale,t,useI18n } from "@/lib/i18n";
import type {
CodexOAuthFlow,
CodexOAuthSession,
CodexQuotaCredits,
CodexQuotaWindow,
ConnectionSettings,
ProviderWorkspace,
UpstreamKeyMeta,
} from "@/lib/types";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Collapse from "@mui/material/Collapse";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import ListItemIcon from "@mui/material/ListItemIcon";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";

interface CodexOAuthLoginDialogProps {
  open: boolean;
  attemptId: number;
  settings: ConnectionSettings;
  providerId: number;
  replaceKeyId: number | null;
  onClose: () => void;
  onCompleted: (session: CodexOAuthSession) => Promise<void> | void;
  onMessage: (message: string) => void;
}

export function CodexOAuthLoginDialog(props: CodexOAuthLoginDialogProps) {
  const { t } = useI18n();
  const [flow, setFlow] = useState<CodexOAuthFlow>("browser");
  const [session, setSession] = useState<CodexOAuthSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [submittingCallback, setSubmittingCallback] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const startedAttemptRef = useRef<string | null>(null);
  const activeAttemptRef = useRef<string | null>(null);
  const completedSessionRef = useRef<string | null>(null);

  useEffect(() => {
    const attemptKey = `${props.attemptId}:${flow}`;
    if (!props.open) return;
    activeAttemptRef.current = attemptKey;
    const deactivate = () => {
      if (activeAttemptRef.current === attemptKey)
        activeAttemptRef.current = null;
    };
    if (startedAttemptRef.current === attemptKey) return deactivate;
    startedAttemptRef.current = attemptKey;
    completedSessionRef.current = null;
    setSession(null);
    setError(null);
    setCallbackUrl("");
    setStarting(true);
    void startCodexOAuthSession(
      props.settings,
      props.providerId,
      props.replaceKeyId,
      flow,
    )
      .then((next) => {
        if (activeAttemptRef.current === attemptKey) {
          setSession(next);
          return;
        }
        void cancelCodexOAuthSession(props.settings, next.session_id).catch(
          (cause) => {
            props.onMessage(
              cause instanceof Error
                ? cause.message
                : t("取消 OAuth 登录失败。"),
            );
          },
        );
      })
      .catch((cause) => {
        if (activeAttemptRef.current === attemptKey) {
          setError(
            cause instanceof Error ? cause.message : t("启动 OAuth 登录失败。"),
          );
        }
      })
      .finally(() => {
        if (activeAttemptRef.current === attemptKey) setStarting(false);
      });
    return deactivate;
  }, [
    flow,
    props.attemptId,
    props.onMessage,
    props.open,
    props.providerId,
    props.replaceKeyId,
    props.settings,
  ]);

  useEffect(() => {
    if (!props.open) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [props.open]);

  useEffect(() => {
    const sessionId = session?.session_id;
    if (!props.open || !sessionId || session.status !== "pending") return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await loadCodexOAuthSession(props.settings, sessionId);
        if (disposed) return;
        setError(null);
        setSession(next);
        if (next.status === "pending") {
          timer = window.setTimeout(
            () => void poll(),
            Math.max(500, next.poll_interval_ms),
          );
        }
      } catch (cause) {
        if (disposed) return;
        setError(
          cause instanceof Error ? cause.message : t("读取登录状态失败。"),
        );
        timer = window.setTimeout(
          () => void poll(),
          Math.max(1_000, session.poll_interval_ms),
        );
      }
    };
    timer = window.setTimeout(
      () => void poll(),
      Math.max(500, session.poll_interval_ms),
    );
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    props.open,
    props.settings,
    session?.poll_interval_ms,
    session?.session_id,
    session?.status,
  ]);

  useEffect(() => {
    if (session?.status !== "completed") return;
    if (completedSessionRef.current === session.session_id) return;
    completedSessionRef.current = session.session_id;
    void props.onCompleted(session);
  }, [props.onCompleted, session]);

  const cancelAndClose = async () => {
    const current = session;
    if (current?.status === "pending") {
      try {
        await cancelCodexOAuthSession(props.settings, current.session_id);
      } catch (cause) {
        props.onMessage(
          cause instanceof Error ? cause.message : t("取消 OAuth 登录失败。"),
        );
      }
    }
    props.onClose();
  };
  const switchFlow = async (nextFlow: CodexOAuthFlow) => {
    if (nextFlow === flow || switching) return;
    setSwitching(true);
    const current = session;
    if (current?.status === "pending") {
      try {
        await cancelCodexOAuthSession(props.settings, current.session_id);
      } catch (cause) {
        props.onMessage(
          cause instanceof Error ? cause.message : t("取消 OAuth 登录失败。"),
        );
      }
    }
    startedAttemptRef.current = null;
    setSession(null);
    setError(null);
    setCallbackUrl("");
    setFlow(nextFlow);
    setSwitching(false);
  };
  const submitCallback = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const current = session;
    const redirectUrl = callbackUrl.trim();
    if (
      !current ||
      current.flow !== "browser" ||
      current.status !== "pending" ||
      !redirectUrl
    )
      return;
    setSubmittingCallback(true);
    setError(null);
    try {
      const next = await submitCodexOAuthCallback(
        props.settings,
        current.session_id,
        redirectUrl,
      );
      setSession(next);
      setCallbackUrl("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("提交回调地址失败。"),
      );
    } finally {
      setSubmittingCallback(false);
    }
  };
  const copyCode = async () => {
    if (!session?.user_code || !navigator.clipboard) {
      props.onMessage(t("当前环境不支持剪贴板。"));
      return;
    }
    try {
      await navigator.clipboard.writeText(session.user_code);
      props.onMessage(t("验证码已复制。"));
    } catch (cause) {
      props.onMessage(
        cause instanceof Error ? cause.message : t("复制验证码失败。"),
      );
    }
  };
  const remainingSeconds = session
    ? Math.max(0, Math.ceil((session.expires_at_ms - nowMs) / 1_000))
    : 0;
  const terminal = session && session.status !== "pending";
  const activeFlow = session?.flow ?? flow;
  const alertSeverity =
    session?.status === "completed"
      ? "success"
      : session && ["failed", "expired"].includes(session.status)
        ? "error"
        : session?.status === "cancelled"
          ? "warning"
          : "info";

  return (
    <Dialog
      open={props.open}
      fullWidth
      maxWidth="sm"
      aria-labelledby="codex-oauth-login-title"
      aria-describedby="codex-oauth-login-description"
      onClose={() => void cancelAndClose()}
    >
      <DialogTitle id="codex-oauth-login-title">
        {t("OpenAI Codex OAuth 登录")}
      </DialogTitle>
      <DialogContent sx={{ display: "grid", gap: "0.875rem" }}>
        <Typography
          id="codex-oauth-login-description"
          sx={{
            fontSize: "0.875rem",
            lineHeight: "1.25rem",
            color: "var(--mui-palette-text-secondary)",
          }}
        >
          {t("授权码和 OAuth Token 不会写入日志。")}
        </Typography>

        <ToggleButtonGroup
          exclusive
          fullWidth
          value={activeFlow}
          aria-label={t("OAuth 登录方式")}
          disabled={starting || switching || Boolean(terminal)}
          onChange={(_event, value: CodexOAuthFlow | null) => {
            if (value) void switchFlow(value);
          }}
        >
          <ToggleButton value="browser" sx={{ gap: "0.375rem" }}>
            <Globe2
              sx={{ width: "0.875rem", height: "0.875rem" }}
              aria-hidden="true"
            />
            {t("浏览器登录")}
          </ToggleButton>
          <ToggleButton value="device" sx={{ gap: "0.375rem" }}>
            <KeyRound
              sx={{ width: "0.875rem", height: "0.875rem" }}
              aria-hidden="true"
            />
            {t("设备码登录")}
          </ToggleButton>
        </ToggleButtonGroup>

        {starting || switching ? (
          <LinearProgress aria-label={t("正在启动 OAuth 登录")} />
        ) : null}

        {session && activeFlow === "browser" ? (
          <Box
            sx={{
              display: "grid",
              gap: "0.75rem",
              borderRadius: "8px",
              borderStyle: "solid",
              borderWidth: "1px",
              borderColor: "var(--mui-palette-divider)",
              backgroundColor:
                "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
              padding: "0.875rem",
            }}
          >
            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                gap: "0.625rem",
                "@media (width >= 40rem)": {
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                },
              }}
            >
              <Typography
                sx={{
                  fontSize: "0.75rem",
                  color: "var(--mui-palette-text-secondary)",
                }}
                component="div"
              >
                {t("剩余 {{seconds}} 秒", { seconds: remainingSeconds })}
              </Typography>
              <Button
                component="a"
                href={session.verification_uri}
                target="_blank"
                rel="noopener noreferrer"
                size="small"
                disabled={
                  session.status !== "pending" ||
                  session.stage !== "waiting_for_user"
                }
              >
                <ExternalLink
                  sx={{
                    marginRight: "0.375rem",
                    width: "0.875rem",
                    height: "0.875rem",
                  }}
                  aria-hidden="true"
                />
                {t("打开 OpenAI 登录页")}
              </Button>
            </Box>
            <Box
              sx={{ display: "grid", gap: "0.625rem" }}
              component="form"
              onSubmit={(event) => void submitCallback(event)}
            >
              <FormControl>
                <TextField
                  id="codex-oauth-callback-url"
                  value={callbackUrl}
                  disabled={
                    session.status !== "pending" ||
                    session.stage !== "waiting_for_user"
                  }
                  autoComplete="off"
                  placeholder="http://localhost:1455/auth/callback?code=...&state=..."
                  sx={{
                    fontSize: "0.75rem",
                    lineHeight: "calc(1 / 0.75)",
                  }}
                  onChange={(event) => setCallbackUrl(event.target.value)}
                  label={t("回调地址")}
                  slotProps={{
                    htmlInput: { autoCapitalize: "none", spellCheck: false },
                  }}
                />
              </FormControl>
              <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
                <Button
                  type="submit"
                  variant="outlined"
                  size="small"
                  disabled={
                    !callbackUrl.trim() ||
                    submittingCallback ||
                    session.status !== "pending" ||
                    session.stage !== "waiting_for_user"
                  }
                >
                  <Send
                    sx={{
                      marginRight: "0.375rem",
                      width: "0.875rem",
                      height: "0.875rem",
                    }}
                    aria-hidden="true"
                  />
                  {t(submittingCallback ? "提交中…" : "提交回调地址")}
                </Button>
              </Box>
            </Box>
          </Box>
        ) : null}

        {session?.user_code && activeFlow === "device" ? (
          <Box
            sx={{
              display: "grid",
              gap: "0.625rem",
              borderRadius: "8px",
              borderStyle: "solid",
              borderWidth: "1px",
              borderColor: "var(--mui-palette-divider)",
              backgroundColor:
                "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
              padding: "1rem",
              textAlign: "center",
            }}
          >
            <Typography
              sx={{
                fontSize: "1.5rem",
                lineHeight: "calc(2 / 1.5)",
                fontWeight: "600",
                letterSpacing: "0.16em",
                color: "var(--mui-palette-text-primary)",
              }}
              component="div"
            >
              {session.user_code}
            </Typography>
            <Box
              sx={{
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "center",
                gap: "0.5rem",
              }}
            >
              <Button
                type="button"
                variant="outlined"
                size="small"
                onClick={() => void copyCode()}
              >
                <Copy
                  sx={{
                    marginRight: "0.375rem",
                    width: "0.875rem",
                    height: "0.875rem",
                  }}
                  aria-hidden="true"
                />
                {t("复制验证码")}
              </Button>
              <Button
                component="a"
                href={session.verification_uri}
                target="_blank"
                rel="noopener noreferrer"
                size="small"
              >
                <ExternalLink
                  sx={{
                    marginRight: "0.375rem",
                    width: "0.875rem",
                    height: "0.875rem",
                  }}
                  aria-hidden="true"
                />
                {t("打开 OpenAI 登录页")}
              </Button>
            </Box>
            <Typography
              sx={{
                fontSize: "0.75rem",
                color: "var(--mui-palette-text-secondary)",
              }}
              component="div"
            >
              {t("剩余 {{seconds}} 秒", { seconds: remainingSeconds })}
            </Typography>
          </Box>
        ) : null}

        <Box aria-live="polite">
          <Alert severity={error ? "error" : alertSeverity} variant="outlined">
            <AlertTitle>
              {loginStatusTitle(session, error, starting || switching)}
            </AlertTitle>
            <Typography
              sx={{ fontSize: "0.875rem", lineHeight: "1.25rem" }}
              component="div"
            >
              {loginStatusMessage(session, error, activeFlow)}
            </Typography>
          </Alert>
        </Box>

        {session?.warnings?.length ? (
          <Alert severity="warning" variant="outlined">
            <AlertTitle>{t("登录后检查有警告")}</AlertTitle>
            <Box
              sx={{ display: "grid", gap: "0.25rem", fontSize: "0.875rem" }}
              component="ul"
            >
              {session.warnings.map((warning) => (
                <Box key={warning} component="li">
                  {warning}
                </Box>
              ))}
            </Box>
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button
          type="button"
          variant="outlined"
          size="small"
          onClick={() => void cancelAndClose()}
        >
          {t(terminal ? "关闭" : "取消")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function loginStatusTitle(
  session: CodexOAuthSession | null,
  error: string | null,
  busy: boolean,
) {
  if (error) return t("登录请求失败");
  if (busy) return t("正在启动 OAuth 登录");
  if (!session) return t("准备登录");
  if (session.status === "completed") return t("登录成功");
  if (session.status === "cancelled") return t("登录已取消");
  if (session.status === "expired") return t("登录已过期");
  if (session.status === "failed") return t("登录失败");
  if (session.stage === "exchanging") return t("正在交换 OAuth Token");
  if (session.stage === "finalizing") return t("正在同步账号数据");
  return t("等待登录确认");
}

function loginStatusMessage(
  session: CodexOAuthSession | null,
  error: string | null,
  flow: CodexOAuthFlow,
) {
  if (error) return error;
  if (!session) return t("正在建立安全登录会话。");
  if (session.error_message) return session.error_message;
  if (session.status === "completed") return t("账号凭据已安全保存。");
  if (session.status === "cancelled") return t("本次 OAuth 登录已取消。");
  if (session.status === "expired") return t("登录会话已过期，请重新发起。");
  if (session.status === "failed") return t("OpenAI 未能完成本次登录。");
  if (session.stage === "exchanging")
    return t("已收到授权回调，正在交换 OAuth Token。");
  if (session.stage === "finalizing")
    return t("凭据已保存，正在刷新额度和模型。");
  return flow === "browser"
    ? t("同机回调会自动完成；远程部署请粘贴浏览器地址栏中的回调地址。")
    : t("打开 OpenAI 登录页并输入下方验证码。");
}

interface CodexOAuthPanelProps {
  settings: ConnectionSettings;
  item: ProviderWorkspace;
  onRefresh: (successMessage?: string) => Promise<void>;
  onMessage: (message: string) => void;
}

interface LoginTarget {
  keyId: number | null;
  attemptId: number;
}

export function CodexOAuthPanel(props: CodexOAuthPanelProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [loginTarget, setLoginTarget] = useState<LoginTarget | null>(null);
  const [modelAccount, setModelAccount] = useState<UpstreamKeyMeta | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] = useState<UpstreamKeyMeta | null>(
    null,
  );
  const [expandOverrides, setExpandOverrides] = useState<
    Record<number, boolean>
  >({});
  const loginSequenceRef = useRef(0);
  const accounts = props.item.keys;
  // 单账号时详情默认摊开；多账号默认收起，让整页保持可扫描的行密度。
  const expandedByDefault = accounts.length === 1;
  const summary = useMemo(() => {
    const routable = accounts.filter(
      (key) => key.routing_availability?.available,
    ).length;
    return { total: accounts.length, routable };
  }, [accounts]);

  const isExpanded = (keyId: number) =>
    expandOverrides[keyId] ?? expandedByDefault;
  const toggleExpanded = (keyId: number) =>
    setExpandOverrides((prev) => ({
      ...prev,
      [keyId]: !(prev[keyId] ?? expandedByDefault),
    }));
  const openLogin = (keyId: number | null) => {
    loginSequenceRef.current += 1;
    setLoginTarget({ keyId, attemptId: loginSequenceRef.current });
  };
  const refreshQuota = async (key: UpstreamKeyMeta) => {
    setBusy(`quota-${key.id}`);
    try {
      await refreshCodexOAuthQuota(props.settings, key.id);
      await props.onRefresh(
        t("账号 {{name}} 的余量已刷新。", { name: key.name }),
      );
    } catch (cause) {
      props.onMessage(
        cause instanceof Error ? cause.message : t("刷新余量失败。"),
      );
    } finally {
      setBusy(null);
    }
  };
  const toggleAccount = async (key: UpstreamKeyMeta) => {
    setBusy(`toggle-${key.id}`);
    try {
      await updateProviderKey(props.settings, key.id, {
        name: key.name,
        enabled: !key.enabled,
        priority: key.priority,
        weight: key.weight,
      });
      await props.onRefresh(
        t("账号 {{name}} 已{{state}}。", {
          name: key.name,
          state: t(key.enabled ? "禁用" : "启用"),
        }),
      );
    } catch (cause) {
      props.onMessage(
        cause instanceof Error ? cause.message : t("更新账号状态失败。"),
      );
    } finally {
      setBusy(null);
    }
  };
  const removeAccount = async (key: UpstreamKeyMeta) => {
    setPendingDelete(null);
    setBusy(`delete-${key.id}`);
    try {
      await deleteProviderKey(props.settings, key.id);
      await props.onRefresh(
        t("OAuth 账号 {{name}} 已删除。", { name: key.name }),
      );
    } catch (cause) {
      props.onMessage(
        cause instanceof Error ? cause.message : t("删除 OAuth 账号失败。"),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <Box
      sx={{ display: "grid", gap: "0.75rem" }}
      component="section"
      aria-labelledby="codex-oauth-accounts-title"
    >
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: "0.75rem",
        }}
      >
        <Box>
          <Typography
            id="codex-oauth-accounts-title"
            sx={{
              fontSize: "0.875rem",
              lineHeight: "calc(1.25 / 0.875)",
              fontWeight: "600",
              color: "var(--mui-palette-text-primary)",
            }}
            component="h3"
          >
            {t("OAuth 账号")}
          </Typography>
          <Typography
            sx={{
              marginTop: "0.25rem",
              fontSize: "0.875rem",
              lineHeight: "1.25rem",
              color: "var(--mui-palette-text-secondary)",
            }}
            component="p"
          >
            {accounts.length === 0
              ? t("账号会与现有密钥一同参与调度。")
              : t("{{total}} 个账号 · {{routable}} 个正在参与路由", summary)}
          </Typography>
        </Box>
        <Button type="button" size="small" onClick={() => openLogin(null)}>
          <LogIn
            sx={{
              marginRight: "0.375rem",
              width: "0.875rem",
              height: "0.875rem",
            }}
            aria-hidden="true"
          />
          {t("登录新账号")}
        </Button>
      </Box>

      {!props.item.provider.routing_availability?.available ? (
        <Alert severity="warning">
          {routingAvailabilityLabel(props.item.provider.routing_availability)}
        </Alert>
      ) : null}
      {accounts.length === 0 ? (
        <Alert severity="info">
          <AlertTitle>{t("尚未登录 Codex 账号")}</AlertTitle>
          {t("登录一个账号后即可同步模型、查看余量并参与 Responses 路由。")}
        </Alert>
      ) : (
        <Box sx={{ display: "grid", gap: "0.375rem" }}>
          {accounts.map((key) => (
            <CodexAccountRow
              key={key.id}
              item={key}
              busy={busy}
              expanded={isExpanded(key.id)}
              onToggleExpand={() => toggleExpanded(key.id)}
              onRefresh={() => void refreshQuota(key)}
              onRelogin={() => openLogin(key.id)}
              onToggle={() => void toggleAccount(key)}
              onModels={() => setModelAccount(key)}
              onDelete={() => setPendingDelete(key)}
            />
          ))}
        </Box>
      )}

      <Dialog
        open={modelAccount !== null}
        onClose={() => setModelAccount(null)}
        maxWidth="sm"
        fullWidth
        aria-labelledby="account-models-title"
      >
        <DialogTitle id="account-models-title">
          {t("模型限制")} · {modelAccount?.name}
        </DialogTitle>
        <DialogContent>
          {modelAccount ? (
            <UpstreamKeyModels
              key={modelAccount.id}
              settings={props.settings}
              keyId={modelAccount.id}
              onChanged={() => props.onRefresh()}
            />
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setModelAccount(null)}>{t("关闭")}</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={pendingDelete !== null}
        maxWidth="xs"
        fullWidth
        aria-labelledby="codex-oauth-delete-title"
        onClose={() => setPendingDelete(null)}
      >
        <DialogTitle id="codex-oauth-delete-title">
          {t("删除 OAuth 账号")}
        </DialogTitle>
        <DialogContent>
          <DialogContentText
            sx={{
              fontSize: "0.875rem",
              lineHeight: "1.25rem",
              color: "var(--mui-palette-text-secondary)",
            }}
          >
            {t(
              "将移除 {{name}} 的凭据，该账号会立即退出路由。此操作不可撤销。",
              {
                name:
                  pendingDelete?.codex_oauth?.email_masked ??
                  pendingDelete?.name ??
                  "",
              },
            )}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            type="button"
            variant="outlined"
            size="small"
            onClick={() => setPendingDelete(null)}
          >
            {t("取消")}
          </Button>
          <Button
            type="button"
            variant="contained"
            color="error"
            size="small"
            onClick={() => {
              if (pendingDelete) void removeAccount(pendingDelete);
            }}
          >
            {t("删除")}
          </Button>
        </DialogActions>
      </Dialog>

      {loginTarget ? (
        <CodexOAuthLoginDialog
          open
          attemptId={loginTarget.attemptId}
          settings={props.settings}
          providerId={props.item.provider.id}
          replaceKeyId={loginTarget.keyId}
          onClose={() => setLoginTarget(null)}
          onMessage={props.onMessage}
          onCompleted={async (session) => {
            await props.onRefresh(
              t(
                session.operation === "updated"
                  ? "Codex OAuth 账号已更新。"
                  : "Codex OAuth 账号已创建。",
              ),
            );
          }}
        />
      ) : null}
    </Box>
  );
}

function CodexAccountRow(props: {
  item: UpstreamKeyMeta;
  busy: string | null;
  expanded: boolean;
  onToggleExpand: () => void;
  onRefresh: () => void;
  onRelogin: () => void;
  onToggle: () => void;
  onModels: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const account = props.item.codex_oauth;
  const status = account?.auth_status ?? "reauth_required";

  const quota = account?.quota;
  const quotaBlocked = quota?.allowed === false;
  const detailId = `codex-account-detail-${props.item.id}`;
  const planLabel = formatPlan(account?.plan_type ?? quota?.plan_type);
  const windows = quota
    ? [
        {
          label: windowLabel(quota.primary_window, t("主要额度")),
          window: quota.primary_window,
        },
        {
          label: windowLabel(quota.secondary_window, t("次级额度")),
          window: quota.secondary_window,
        },
        {
          label: windowLabel(quota.code_review_window, t("代码审查额度")),
          window: quota.code_review_window,
        },
      ].filter(
        (entry): entry is { label: string; window: CodexQuotaWindow } =>
          entry.window !== null,
      )
    : [];
  const health = accountHealth(props.item, status, quotaBlocked);
  const flagged = health === "attention" || health === "error";

  return (
    <Box
      sx={{
        ...{
          borderStyle: "solid",
          borderWidth: "1px",
          backgroundColor: "var(--mui-palette-background-default)",
        },
        ...(flagged
          ? {
              borderColor:
                "color-mix(in srgb, var(--mui-palette-warning-main) 35%, var(--mui-palette-divider))",
            }
          : { borderColor: "var(--mui-palette-divider)" }),
        ...{},
      }}
      style={{ borderRadius: "8px" }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          paddingInline: "0.625rem",
          paddingBlock: "0.5rem",
        }}
      >
        <Box
          component="button"
          type="button"
          aria-expanded={props.expanded}
          aria-controls={detailId}
          sx={{
            display: "flex",
            minWidth: "0",
            flex: "1",
            cursor: "pointer",
            alignItems: "center",
            gap: "0.5rem",
            borderStyle: "solid",
            borderWidth: "0px",
            backgroundColor: "transparent",
            padding: "0",
            textAlign: "left",
          }}
          onClick={props.onToggleExpand}
        >
          <ChevronRight
            sx={{
              ...{
                width: "0.875rem",
                height: "0.875rem",
                flexShrink: "0",
                color: "var(--mui-palette-text-secondary)",
                transitionProperty: "transform, translate, scale, rotate",
                transitionTimingFunction: "ease",
                transitionDuration: "120ms",
              },
              ...(props.expanded ? { rotate: "90deg" } : {}),
              ...{},
            }}
            aria-hidden="true"
          />
          <Box
            sx={{
              ...{
                width: "0.375rem",
                height: "0.375rem",
                flexShrink: "0",
                borderRadius: "999px",
              },
              ...{ bgcolor: statusDotColor(health) },
              ...{},
            }}
            component="span"
            aria-hidden="true"
          />
          <Typography
            sx={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: "0.875rem",
              fontWeight: "600",
              color: "var(--mui-palette-text-primary)",
            }}
            component="span"
          >
            {account?.email_masked ?? props.item.name}
          </Typography>
          {planLabel ? (
            <Typography
              sx={{
                flexShrink: "0",
                fontSize: "0.75rem",
                color: "var(--mui-palette-text-secondary)",
              }}
              component="span"
            >
              {planLabel}
            </Typography>
          ) : null}
          <Typography
            sx={{
              display: "none",
              flexShrink: "0",
              fontSize: "0.75rem",
              color: "var(--mui-palette-text-secondary)",
              "@media (width >= 80rem)": { display: "inline" },
            }}
            component="span"
          >
            {account?.account_id_suffix ?? t("旧凭据")}
          </Typography>
        </Box>

        {/* 展开后详情里有完整额度条，行内速览让位，避免同一标签出现两次 */}
        {props.expanded ? null : (
          <Box
            sx={{
              display: "none",
              flexShrink: "0",
              alignItems: "center",
              gap: "0.75rem",
              "@media (width >= 48rem)": { display: "flex" },
            }}
          >
            {windows.slice(0, 2).map((entry) => (
              <QuotaGlance
                key={entry.label}
                label={entry.label}
                window={entry.window}
              />
            ))}
          </Box>
        )}

        <Box
          sx={{
            display: "flex",
            flexShrink: "0",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "0.375rem",
          }}
        >
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
              )[
                props.item.routing_availability?.available
                  ? "normal"
                  : "warning"
              ]
            }
            label={t(routingAvailabilityLabel(props.item.routing_availability))}
          />
          <AccountActions
            enabled={props.item.enabled}
            busy={props.busy}
            keyId={props.item.id}
            onRefresh={props.onRefresh}
            onRelogin={props.onRelogin}
            onToggle={props.onToggle}
            onModels={props.onModels}
            onDelete={props.onDelete}
          />
        </Box>
      </Box>

      <Collapse in={props.expanded} unmountOnExit>
        <Box
          id={detailId}
          sx={{
            display: "grid",
            gap: "0.75rem",
            borderTopStyle: "solid",
            borderTopWidth: "1px",
            borderColor:
              "color-mix(in oklab, var(--mui-palette-divider) 60%, transparent)",
            paddingInline: "0.75rem",
            paddingBlock: "0.75rem",
          }}
        >
          {quotaBlocked ? (
            <Alert severity="warning">
              <AlertTitle>{t("当前额度不可用")}</AlertTitle>
              {t("该账号会暂时退出路由；额度恢复后将自动重新参与。")}
            </Alert>
          ) : null}

          {account?.last_error ? (
            <Alert severity={status === "active" ? "warning" : "error"}>
              <AlertTitle>{t("最近错误")}</AlertTitle>
              {account.last_error}
            </Alert>
          ) : null}

          {!quota ? (
            <Alert severity="info">{t("尚无缓存余量，请手动刷新。")}</Alert>
          ) : windows.length > 0 ? (
            <Box
              sx={{ display: "grid", gap: "0.625rem" }}
              aria-label={t("Codex 额度窗口")}
            >
              {windows.map((entry) => (
                <QuotaWindowRow
                  key={entry.label}
                  label={entry.label}
                  window={entry.window}
                />
              ))}
            </Box>
          ) : null}

          <Box
            sx={{
              display: "grid",
              columnGap: "1rem",
              rowGap: "0.625rem",
              "@media (width >= 40rem)": {
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              },
              "@media (width >= 64rem)": {
                gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
              },
            }}
          >
            <Box sx={{ minWidth: "0" }}>
              <Typography
                sx={{
                  fontSize: "0.75rem",
                  lineHeight: "1rem",
                  color: "var(--mui-palette-text-secondary)",
                }}
                component="div"
              >
                {t("订阅计划")}
              </Typography>
              <Typography
                sx={{
                  marginTop: "0.125rem",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: "0.875rem",
                  color: "var(--mui-palette-text-primary)",
                }}
                title={planLabel ?? "—"}
                component="div"
              >
                {planLabel ?? "—"}
              </Typography>
            </Box>
            <Box sx={{ minWidth: "0" }}>
              <Typography
                sx={{
                  fontSize: "0.75rem",
                  lineHeight: "1rem",
                  color: "var(--mui-palette-text-secondary)",
                }}
                component="div"
              >
                {t("Token 到期")}
              </Typography>
              <Typography
                sx={{
                  marginTop: "0.125rem",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: "0.875rem",
                  color: "var(--mui-palette-text-primary)",
                }}
                title={formatOptionalDate(account?.token_expires_at_ms)}
                component="div"
              >
                {formatOptionalDate(account?.token_expires_at_ms)}
              </Typography>
            </Box>
            <Box sx={{ minWidth: "0" }}>
              <Typography
                sx={{
                  fontSize: "0.75rem",
                  lineHeight: "1rem",
                  color: "var(--mui-palette-text-secondary)",
                }}
                component="div"
              >
                {t("最近刷新")}
              </Typography>
              <Typography
                sx={{
                  marginTop: "0.125rem",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: "0.875rem",
                  color: "var(--mui-palette-text-primary)",
                }}
                title={formatOptionalDate(account?.last_refresh_at_ms)}
                component="div"
              >
                {formatOptionalDate(account?.last_refresh_at_ms)}
              </Typography>
            </Box>
            <Box sx={{ minWidth: "0" }}>
              <Typography
                sx={{
                  fontSize: "0.75rem",
                  lineHeight: "1rem",
                  color: "var(--mui-palette-text-secondary)",
                }}
                component="div"
              >
                {t("余量检查")}
              </Typography>
              <Typography
                sx={{
                  marginTop: "0.125rem",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: "0.875rem",
                  color: "var(--mui-palette-text-primary)",
                }}
                title={formatOptionalDate(account?.quota_checked_at_ms)}
                component="div"
              >
                {formatOptionalDate(account?.quota_checked_at_ms)}
              </Typography>
            </Box>
            {quota ? <CreditsMeta credits={quota.credits} /> : null}
          </Box>
        </Box>
      </Collapse>
    </Box>
  );
}

function AccountActions(props: {
  enabled: boolean;
  busy: string | null;
  keyId: number;
  onRefresh: () => void;
  onRelogin: () => void;
  onToggle: () => void;
  onModels: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = () => setAnchor(null);
  const run = (action: () => void) => () => {
    close();
    action();
  };
  const refreshing = props.busy === `quota-${props.keyId}`;

  return (
    <>
      <IconButton
        size="small"
        aria-label={t("账号操作")}
        aria-haspopup="menu"
        onClick={(event) => setAnchor(event.currentTarget)}
      >
        <MoreHorizontal
          sx={{ width: "1rem", height: "1rem" }}
          aria-hidden="true"
        />
      </IconButton>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={close}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <MenuItem disabled={refreshing} onClick={run(props.onRefresh)}>
          <ListItemIcon>
            <RefreshCw
              sx={{
                ...{ width: "0.875rem", height: "0.875rem" },
                ...(refreshing ? { animation: "none" } : {}),
                ...{},
              }}
              aria-hidden="true"
            />
          </ListItemIcon>
          {t("刷新余量")}
        </MenuItem>
        <MenuItem onClick={run(props.onModels)}>{t("模型限制")}</MenuItem>
        <MenuItem onClick={run(props.onRelogin)}>
          <ListItemIcon>
            <LogIn
              sx={{ width: "0.875rem", height: "0.875rem" }}
              aria-hidden="true"
            />
          </ListItemIcon>
          {t("重新登录")}
        </MenuItem>
        <MenuItem
          disabled={props.busy === `toggle-${props.keyId}`}
          onClick={run(props.onToggle)}
        >
          <ListItemIcon>
            <Power
              sx={{ width: "0.875rem", height: "0.875rem" }}
              aria-hidden="true"
            />
          </ListItemIcon>
          {t(props.enabled ? "禁用账号" : "启用账号")}
        </MenuItem>
        <MenuItem
          disabled={props.busy === `delete-${props.keyId}`}
          sx={{ color: "var(--mui-palette-error-main)" }}
          onClick={run(props.onDelete)}
        >
          <ListItemIcon>
            <Trash2
              sx={{
                width: "0.875rem",
                height: "0.875rem",
                color: "var(--mui-palette-error-main)",
              }}
              aria-hidden="true"
            />
          </ListItemIcon>
          {t("删除")}
        </MenuItem>
      </Menu>
    </>
  );
}

function CreditsMeta(props: { credits: CodexQuotaCredits }) {
  const { t } = useI18n();
  const { credits } = props;
  const balance = credits.unlimited
    ? t("无限")
    : credits.balance != null
      ? formatQuantity(credits.balance)
      : null;
  return (
    <>
      {balance === null ? null : (
        <Box sx={{ minWidth: "0" }}>
          <Typography
            sx={{
              fontSize: "0.75rem",
              lineHeight: "1rem",
              color: "var(--mui-palette-text-secondary)",
            }}
            component="div"
          >
            {t("Credits 余额")}
          </Typography>
          <Typography
            sx={{
              marginTop: "0.125rem",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: "0.875rem",
              color: "var(--mui-palette-text-primary)",
            }}
            title={balance}
            component="div"
          >
            {balance}
          </Typography>
        </Box>
      )}
      {credits.reset_credits == null ? null : (
        <Box sx={{ minWidth: "0" }}>
          <Typography
            sx={{
              fontSize: "0.75rem",
              lineHeight: "1rem",
              color: "var(--mui-palette-text-secondary)",
            }}
            component="div"
          >
            {t("重置 Credits")}
          </Typography>
          <Typography
            sx={{
              marginTop: "0.125rem",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: "0.875rem",
              color: "var(--mui-palette-text-primary)",
            }}
            title={formatQuantity(credits.reset_credits)}
            component="div"
          >
            {formatQuantity(credits.reset_credits)}
          </Typography>
        </Box>
      )}
      {credits.subscription_end_at_ms == null ? null : (
        <Box sx={{ minWidth: "0" }}>
          <Typography
            sx={{
              fontSize: "0.75rem",
              lineHeight: "1rem",
              color: "var(--mui-palette-text-secondary)",
            }}
            component="div"
          >
            {t("订阅截止")}
          </Typography>
          <Typography
            sx={{
              marginTop: "0.125rem",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: "0.875rem",
              color: "var(--mui-palette-text-primary)",
            }}
            title={formatDateTime(credits.subscription_end_at_ms)}
            component="div"
          >
            {formatDateTime(credits.subscription_end_at_ms)}
          </Typography>
        </Box>
      )}
    </>
  );
}

/** 折叠行里的额度速览：窄、无边框，只求一眼看出健康度。 */
function QuotaGlance(props: { label: string; window: CodexQuotaWindow }) {
  const remaining = Math.max(0, Math.min(100, props.window.remaining_percent));
  return (
    <Box sx={{ width: "6rem" }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "0.25rem",
        }}
      >
        <Typography
          sx={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: "0.75rem",
            lineHeight: "1rem",
            color: "var(--mui-palette-text-secondary)",
          }}
          component="span"
        >
          {props.label}
        </Typography>
        <Typography
          sx={{
            flexShrink: 0,
            fontSize: 12,
            fontWeight: 500,
            color: quotaTextColor(remaining),
          }}
          component="span"
        >
          {Math.round(remaining)}%
        </Typography>
      </Box>
      <Box sx={{ marginTop: "0.125rem" }}>
        <LinearProgress
          variant="determinate"
          value={Math.max(0, Math.min(100, remaining))}
          aria-label={props.label}
          color={
            remaining >= 50 ? "success" : remaining >= 20 ? "warning" : "error"
          }
          sx={{ width: "100%", height: 4 }}
        />
      </Box>
    </Box>
  );
}

function QuotaWindowRow(props: { label: string; window: CodexQuotaWindow }) {
  const { t } = useI18n();
  const remaining = Math.max(0, Math.min(100, props.window.remaining_percent));
  return (
    <Box sx={{ display: "grid", gap: "0.375rem" }}>
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "0.5rem",
        }}
      >
        <Typography
          sx={{
            fontSize: "0.875rem",
            fontWeight: "500",
            color: "var(--mui-palette-text-primary)",
          }}
          component="div"
        >
          {props.label}
        </Typography>
        <Typography
          sx={{
            fontSize: "0.75rem",
            color: "var(--mui-palette-text-secondary)",
          }}
          component="div"
        >
          <Box
            sx={{ fontWeight: 500, color: quotaTextColor(remaining) }}
            component="span"
          >
            {t("剩余 {{percent}}%", { percent: Math.round(remaining) })}
          </Box>
          {props.window.reset_at_ms
            ? ` · ${t("重置于 {{time}}", { time: formatDateTime(props.window.reset_at_ms) })}`
            : ""}
        </Typography>
      </Box>
      <LinearProgress
        variant="determinate"
        value={Math.max(0, Math.min(100, remaining))}
        aria-label={props.label}
        color={
          remaining >= 50 ? "success" : remaining >= 20 ? "warning" : "error"
        }
        sx={{ width: "100%", height: 6 }}
      />
    </Box>
  );
}

type AccountHealth = "ok" | "attention" | "error" | "off";

function accountHealth(
  item: UpstreamKeyMeta,
  status: string,
  quotaBlocked: boolean,
): AccountHealth {
  if (!item.enabled) return "off";
  if (item.routing_availability)
    return item.routing_availability.available ? "ok" : "attention";
  if (status === "forbidden") return "error";
  if (status !== "active") return "attention";
  return quotaBlocked ? "attention" : "ok";
}

function statusDotColor(health: AccountHealth) {
  if (health === "ok") return "success.main";
  if (health === "attention") return "warning.main";
  if (health === "error") return "error.main";
  return "text.disabled";
}

/** 订阅计划来自接口原样小写（如 plus），作为产品名展示时首字母大写。 */
function formatPlan(plan: string | null | undefined) {
  if (!plan) return null;
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function formatQuantity(value: number) {
  return new Intl.NumberFormat(getIntlLocale(), {
    maximumFractionDigits: 2,
  }).format(value);
}

function windowLabel(window: CodexQuotaWindow | null, fallback: string) {
  if (!window?.window_seconds) return fallback;
  if (window.window_seconds === 18_000) return t("5 小时额度");
  if (window.window_seconds === 604_800) return t("7 天额度");
  const hours = window.window_seconds / 3_600;
  if (hours < 48) {
    return t("{{hours}} 小时额度", {
      hours: new Intl.NumberFormat(getIntlLocale(), {
        maximumFractionDigits: 1,
      }).format(hours),
    });
  }
  const days = window.window_seconds / 86_400;
  return t("{{days}} 天额度", {
    days: new Intl.NumberFormat(getIntlLocale(), {
      maximumFractionDigits: 1,
    }).format(days),
  });
}

function formatOptionalDate(value: number | null | undefined) {
  return value ? formatDateTime(value) : "—";
}
