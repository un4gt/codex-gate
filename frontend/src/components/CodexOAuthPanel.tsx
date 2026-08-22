import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChevronRight, Copy, ExternalLink, Globe2, KeyRound, LogIn, MoreHorizontal, Power, RefreshCw, Send, Trash2 } from 'lucide-react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import FormLabel from '@mui/material/FormLabel';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import LinearProgress from '@mui/material/LinearProgress';
import ListItemIcon from '@mui/material/ListItemIcon';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { QuotaBar, quotaTextClass } from '@/components/console/QuotaBar';
import { StatusBadge, type StatusTone } from '@/components/console/StatusBadge';
import {
  cancelCodexOAuthSession,
  deleteProviderKey,
  loadCodexOAuthSession,
  refreshCodexOAuthQuota,
  startCodexOAuthSession,
  submitCodexOAuthCallback,
  updateProviderKey,
} from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { getIntlLocale, t } from '@/lib/i18n';
import type {
  CodexOAuthSession,
  CodexOAuthFlow,
  CodexQuotaCredits,
  CodexQuotaWindow,
  ConnectionSettings,
  ProviderWorkspace,
  UpstreamKeyMeta,
} from '@/lib/types';

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
  const [flow, setFlow] = useState<CodexOAuthFlow>('browser');
  const [session, setSession] = useState<CodexOAuthSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState('');
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
      if (activeAttemptRef.current === attemptKey) activeAttemptRef.current = null;
    };
    if (startedAttemptRef.current === attemptKey) return deactivate;
    startedAttemptRef.current = attemptKey;
    completedSessionRef.current = null;
    setSession(null);
    setError(null);
    setCallbackUrl('');
    setStarting(true);
    void startCodexOAuthSession(props.settings, props.providerId, props.replaceKeyId, flow)
      .then(next => {
        if (activeAttemptRef.current === attemptKey) {
          setSession(next);
          return;
        }
        void cancelCodexOAuthSession(props.settings, next.session_id).catch(cause => {
          props.onMessage(cause instanceof Error ? cause.message : t('取消 OAuth 登录失败。'));
        });
      })
      .catch(cause => {
        if (activeAttemptRef.current === attemptKey) {
          setError(cause instanceof Error ? cause.message : t('启动 OAuth 登录失败。'));
        }
      })
      .finally(() => {
        if (activeAttemptRef.current === attemptKey) setStarting(false);
      });
    return deactivate;
  }, [flow, props.attemptId, props.onMessage, props.open, props.providerId, props.replaceKeyId, props.settings]);

  useEffect(() => {
    if (!props.open) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [props.open]);

  useEffect(() => {
    const sessionId = session?.session_id;
    if (!props.open || !sessionId || session.status !== 'pending') return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await loadCodexOAuthSession(props.settings, sessionId);
        if (disposed) return;
        setError(null);
        setSession(next);
        if (next.status === 'pending') {
          timer = window.setTimeout(() => void poll(), Math.max(500, next.poll_interval_ms));
        }
      } catch (cause) {
        if (disposed) return;
        setError(cause instanceof Error ? cause.message : t('读取登录状态失败。'));
        timer = window.setTimeout(() => void poll(), Math.max(1_000, session.poll_interval_ms));
      }
    };
    timer = window.setTimeout(() => void poll(), Math.max(500, session.poll_interval_ms));
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [props.open, props.settings, session?.poll_interval_ms, session?.session_id, session?.status]);

  useEffect(() => {
    if (session?.status !== 'completed') return;
    if (completedSessionRef.current === session.session_id) return;
    completedSessionRef.current = session.session_id;
    void props.onCompleted(session);
  }, [props.onCompleted, session]);

  const cancelAndClose = async () => {
    const current = session;
    if (current?.status === 'pending') {
      try {
        await cancelCodexOAuthSession(props.settings, current.session_id);
      } catch (cause) {
        props.onMessage(cause instanceof Error ? cause.message : t('取消 OAuth 登录失败。'));
      }
    }
    props.onClose();
  };
  const switchFlow = async (nextFlow: CodexOAuthFlow) => {
    if (nextFlow === flow || switching) return;
    setSwitching(true);
    const current = session;
    if (current?.status === 'pending') {
      try {
        await cancelCodexOAuthSession(props.settings, current.session_id);
      } catch (cause) {
        props.onMessage(cause instanceof Error ? cause.message : t('取消 OAuth 登录失败。'));
      }
    }
    startedAttemptRef.current = null;
    setSession(null);
    setError(null);
    setCallbackUrl('');
    setFlow(nextFlow);
    setSwitching(false);
  };
  const submitCallback = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const current = session;
    const redirectUrl = callbackUrl.trim();
    if (!current || current.flow !== 'browser' || current.status !== 'pending' || !redirectUrl) return;
    setSubmittingCallback(true);
    setError(null);
    try {
      const next = await submitCodexOAuthCallback(props.settings, current.session_id, redirectUrl);
      setSession(next);
      setCallbackUrl('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('提交回调地址失败。'));
    } finally {
      setSubmittingCallback(false);
    }
  };
  const copyCode = async () => {
    if (!session?.user_code || !navigator.clipboard) {
      props.onMessage(t('当前环境不支持剪贴板。'));
      return;
    }
    try {
      await navigator.clipboard.writeText(session.user_code);
      props.onMessage(t('验证码已复制。'));
    } catch (cause) {
      props.onMessage(cause instanceof Error ? cause.message : t('复制验证码失败。'));
    }
  };
  const remainingSeconds = session
    ? Math.max(0, Math.ceil((session.expires_at_ms - nowMs) / 1_000))
    : 0;
  const terminal = session && session.status !== 'pending';
  const activeFlow = session?.flow ?? flow;
  const alertSeverity = session?.status === 'completed'
    ? 'success'
    : session && ['failed', 'expired'].includes(session.status)
      ? 'error'
      : session?.status === 'cancelled'
        ? 'warning'
        : 'info';

  return (
    <Dialog
      open={props.open}
      fullWidth
      maxWidth="sm"
      aria-labelledby="codex-oauth-login-title"
      aria-describedby="codex-oauth-login-description"
      onClose={() => void cancelAndClose()}
    >
      <DialogTitle id="codex-oauth-login-title">{t('OpenAI Codex OAuth 登录')}</DialogTitle>
      <DialogContent className="grid gap-3.5">
        <Typography id="codex-oauth-login-description" className="text-[0.8125rem] leading-5 text-muted-foreground">
          {t('授权码和 OAuth Token 不会写入日志。')}
        </Typography>

        <ToggleButtonGroup
          exclusive
          fullWidth
          value={activeFlow}
          aria-label={t('OAuth 登录方式')}
          disabled={starting || switching || Boolean(terminal)}
          onChange={(_event, value: CodexOAuthFlow | null) => {
            if (value) void switchFlow(value);
          }}
        >
          <ToggleButton value="browser" className="gap-1.5">
            <Globe2 className="size-3.5" aria-hidden="true" />
            {t('浏览器登录')}
          </ToggleButton>
          <ToggleButton value="device" className="gap-1.5">
            <KeyRound className="size-3.5" aria-hidden="true" />
            {t('设备码登录')}
          </ToggleButton>
        </ToggleButtonGroup>

        {starting || switching ? <LinearProgress aria-label={t('正在启动 OAuth 登录')} /> : null}

        {session && activeFlow === 'browser' ? (
          <Box className="grid gap-3 rounded border border-border bg-muted/10 p-3.5">
            <Box className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
              <Typography className="font-mono text-[0.6875rem] text-muted-foreground" component="div">
                {t('剩余 {{seconds}} 秒', { seconds: remainingSeconds })}
              </Typography>
              <Button
                component="a"
                href={session.verification_uri}
                target="_blank"
                rel="noopener noreferrer"
                size="sm"
                disabled={session.status !== 'pending' || session.stage !== 'waiting_for_user'}
              >
                <ExternalLink className="mr-1.5 size-3.5" aria-hidden="true" />
                {t('打开 OpenAI 登录页')}
              </Button>
            </Box>
            <Box className="grid gap-2.5" component="form" onSubmit={event => void submitCallback(event)}>
              <FormControl>
                <FormLabel htmlFor="codex-oauth-callback-url">{t('回调地址')}</FormLabel>
                <InputBase
                  id="codex-oauth-callback-url"
                  value={callbackUrl}
                  disabled={session.status !== 'pending' || session.stage !== 'waiting_for_user'}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="http://localhost:1455/auth/callback?code=...&state=..."
                  className="font-mono text-xs"
                  onChange={event => setCallbackUrl(event.target.value)}
                />
              </FormControl>
              <Box className="flex justify-end">
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={!callbackUrl.trim() || submittingCallback || session.status !== 'pending' || session.stage !== 'waiting_for_user'}
                >
                  <Send className="mr-1.5 size-3.5" aria-hidden="true" />
                  {t(submittingCallback ? '提交中…' : '提交回调地址')}
                </Button>
              </Box>
            </Box>
          </Box>
        ) : null}

        {session?.user_code && activeFlow === 'device' ? (
          <Box className="grid gap-2.5 rounded border border-border bg-muted/10 p-4 text-center">
            <Typography className="font-mono text-2xl font-semibold tracking-[0.16em] text-foreground" component="div">
              {session.user_code}
            </Typography>
            <Box className="flex flex-wrap justify-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void copyCode()}>
                <Copy className="mr-1.5 size-3.5" aria-hidden="true" />
                {t('复制验证码')}
              </Button>
              <Button
                component="a"
                href={session.verification_uri}
                target="_blank"
                rel="noopener noreferrer"
                size="sm"
              >
                <ExternalLink className="mr-1.5 size-3.5" aria-hidden="true" />
                {t('打开 OpenAI 登录页')}
              </Button>
            </Box>
            <Typography className="font-mono text-[0.6875rem] text-muted-foreground" component="div">
              {t('剩余 {{seconds}} 秒', { seconds: remainingSeconds })}
            </Typography>
          </Box>
        ) : null}

        <Box aria-live="polite">
          <Alert severity={error ? 'error' : alertSeverity} variant="outlined">
            <AlertTitle>
              {loginStatusTitle(session, error, starting || switching)}
            </AlertTitle>
            <Typography className="text-[0.8125rem] leading-5" component="div">
              {loginStatusMessage(session, error, activeFlow)}
            </Typography>
          </Alert>
        </Box>

        {session?.warnings?.length ? (
          <Alert severity="warning" variant="outlined">
            <AlertTitle>{t('登录后检查有警告')}</AlertTitle>
            <Box className="grid gap-1 text-[0.8125rem]" component="ul">
              {session.warnings.map(warning => <Box key={warning} component="li">{warning}</Box>)}
            </Box>
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button type="button" variant="outline" size="sm" onClick={() => void cancelAndClose()}>
          {t(terminal ? '关闭' : '取消')}
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
  if (error) return t('登录请求失败');
  if (busy) return t('正在启动 OAuth 登录');
  if (!session) return t('准备登录');
  if (session.status === 'completed') return t('登录成功');
  if (session.status === 'cancelled') return t('登录已取消');
  if (session.status === 'expired') return t('登录已过期');
  if (session.status === 'failed') return t('登录失败');
  if (session.stage === 'exchanging') return t('正在交换 OAuth Token');
  if (session.stage === 'finalizing') return t('正在同步账号数据');
  return t('等待登录确认');
}

function loginStatusMessage(
  session: CodexOAuthSession | null,
  error: string | null,
  flow: CodexOAuthFlow,
) {
  if (error) return error;
  if (!session) return t('正在建立安全登录会话。');
  if (session.error_message) return session.error_message;
  if (session.status === 'completed') return t('账号凭据已安全保存。');
  if (session.status === 'cancelled') return t('本次 OAuth 登录已取消。');
  if (session.status === 'expired') return t('登录会话已过期，请重新发起。');
  if (session.status === 'failed') return t('OpenAI 未能完成本次登录。');
  if (session.stage === 'exchanging') return t('已收到授权回调，正在交换 OAuth Token。');
  if (session.stage === 'finalizing') return t('凭据已保存，正在刷新额度和模型。');
  return flow === 'browser'
    ? t('同机回调会自动完成；远程部署请粘贴浏览器地址栏中的回调地址。')
    : t('打开 OpenAI 登录页并输入下方验证码。');
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
  const [busy, setBusy] = useState<string | null>(null);
  const [loginTarget, setLoginTarget] = useState<LoginTarget | null>(null);
  const [pendingDelete, setPendingDelete] = useState<UpstreamKeyMeta | null>(null);
  const [expandOverrides, setExpandOverrides] = useState<Record<number, boolean>>({});
  const loginSequenceRef = useRef(0);
  const accounts = props.item.keys;
  // 单账号时详情默认摊开；多账号默认收起，让整页保持可扫描的行密度。
  const expandedByDefault = accounts.length === 1;
  const summary = useMemo(() => {
    const routable = accounts.filter(key => {
      const oauth = key.codex_oauth;
      return key.enabled && oauth?.auth_status === 'active' && oauth.quota?.allowed !== false;
    }).length;
    return { total: accounts.length, routable };
  }, [accounts]);

  const isExpanded = (keyId: number) => expandOverrides[keyId] ?? expandedByDefault;
  const toggleExpanded = (keyId: number) => setExpandOverrides(prev => ({
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
      await props.onRefresh(t('账号 {{name}} 的余量已刷新。', { name: key.name }));
    } catch (cause) {
      props.onMessage(cause instanceof Error ? cause.message : t('刷新余量失败。'));
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
      await props.onRefresh(t('账号 {{name}} 已{{state}}。', {
        name: key.name,
        state: t(key.enabled ? '禁用' : '启用'),
      }));
    } catch (cause) {
      props.onMessage(cause instanceof Error ? cause.message : t('更新账号状态失败。'));
    } finally {
      setBusy(null);
    }
  };
  const removeAccount = async (key: UpstreamKeyMeta) => {
    setPendingDelete(null);
    setBusy(`delete-${key.id}`);
    try {
      await deleteProviderKey(props.settings, key.id);
      await props.onRefresh(t('OAuth 账号 {{name}} 已删除。', { name: key.name }));
    } catch (cause) {
      props.onMessage(cause instanceof Error ? cause.message : t('删除 OAuth 账号失败。'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Box className="grid gap-3" component="section" aria-labelledby="codex-oauth-accounts-title">
      <Box className="flex flex-wrap items-end justify-between gap-3">
        <Box>
          <Typography id="codex-oauth-accounts-title" className="text-sm font-semibold text-foreground" component="h3">
            {t('OAuth 账号')}
          </Typography>
          <Typography className="mt-1 text-[0.8125rem] leading-5 text-muted-foreground" component="p">
            {accounts.length === 0
              ? t('账号会与现有密钥一同参与调度。')
              : t('{{total}} 个账号 · {{routable}} 个正在参与路由', summary)}
          </Typography>
        </Box>
        <Button type="button" size="sm" onClick={() => openLogin(null)}>
          <LogIn className="mr-1.5 size-3.5" aria-hidden="true" />
          {t('登录新账号')}
        </Button>
      </Box>

      {accounts.length === 0 ? (
        <Alert severity="info">
          <AlertTitle>{t('尚未登录 Codex 账号')}</AlertTitle>
          {t('登录一个账号后即可同步模型、查看余量并参与 Responses 路由。')}
        </Alert>
      ) : (
        <Box className="grid gap-1.5">
          {accounts.map(key => (
            <CodexAccountRow
              key={key.id}
              item={key}
              busy={busy}
              expanded={isExpanded(key.id)}
              onToggleExpand={() => toggleExpanded(key.id)}
              onRefresh={() => void refreshQuota(key)}
              onRelogin={() => openLogin(key.id)}
              onToggle={() => void toggleAccount(key)}
              onDelete={() => setPendingDelete(key)}
            />
          ))}
        </Box>
      )}

      <Dialog
        open={pendingDelete !== null}
        maxWidth="xs"
        fullWidth
        aria-labelledby="codex-oauth-delete-title"
        onClose={() => setPendingDelete(null)}
      >
        <DialogTitle id="codex-oauth-delete-title">{t('删除 OAuth 账号')}</DialogTitle>
        <DialogContent>
          <DialogContentText className="text-[0.8125rem] leading-5 text-muted-foreground">
            {t('将移除 {{name}} 的凭据，该账号会立即退出路由。此操作不可撤销。', {
              name: pendingDelete?.codex_oauth?.email_masked ?? pendingDelete?.name ?? '',
            })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button type="button" variant="outline" size="sm" onClick={() => setPendingDelete(null)}>
            {t('取消')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => { if (pendingDelete) void removeAccount(pendingDelete); }}
          >
            {t('删除')}
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
          onCompleted={async session => {
            await props.onRefresh(t(
              session.operation === 'updated' ? 'Codex OAuth 账号已更新。' : 'Codex OAuth 账号已创建。',
            ));
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
  onDelete: () => void;
}) {
  const account = props.item.codex_oauth;
  const status = account?.auth_status ?? 'reauth_required';
  const statusView = authStatusView(status);
  const quota = account?.quota;
  const quotaBlocked = quota?.allowed === false;
  const detailId = `codex-account-detail-${props.item.id}`;
  const planLabel = formatPlan(account?.plan_type ?? quota?.plan_type);
  const windows = quota
    ? [
        { label: windowLabel(quota.primary_window, t('主要额度')), window: quota.primary_window },
        { label: windowLabel(quota.secondary_window, t('次级额度')), window: quota.secondary_window },
        { label: windowLabel(quota.code_review_window, t('代码审查额度')), window: quota.code_review_window },
      ].filter((entry): entry is { label: string; window: CodexQuotaWindow } => entry.window !== null)
    : [];
  const health = accountHealth(props.item, status, quotaBlocked);
  const flagged = health === 'attention' || health === 'error';

  return (
    <Box
      className={`border bg-background ${flagged ? 'border-warning-border' : 'border-border'}`}
      style={{ borderRadius: 'var(--radius)' }}
    >
      <Box className="flex items-center gap-2 px-2.5 py-2">
        <Box
          component="button"
          type="button"
          aria-expanded={props.expanded}
          aria-controls={detailId}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left"
          onClick={props.onToggleExpand}
        >
          <ChevronRight
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ${props.expanded ? 'rotate-90' : ''}`}
            aria-hidden="true"
          />
          <Box className={`size-1.5 shrink-0 rounded-full ${statusDotClass(health)}`} component="span" aria-hidden="true" />
          <Typography className="truncate text-[0.8125rem] font-semibold text-foreground" component="span">
            {account?.email_masked ?? props.item.name}
          </Typography>
          {planLabel ? (
            <Typography className="shrink-0 text-[0.6875rem] text-muted-foreground" component="span">
              {planLabel}
            </Typography>
          ) : null}
          <Typography className="hidden shrink-0 font-mono text-[0.6875rem] text-muted-foreground xl:inline" component="span">
            {account?.account_id_suffix ?? t('旧凭据')}
          </Typography>
        </Box>

        {/* 展开后详情里有完整额度条，行内速览让位，避免同一标签出现两次 */}
        {props.expanded ? null : (
          <Box className="hidden shrink-0 items-center gap-3 md:flex">
            {windows.slice(0, 2).map(entry => (
              <QuotaGlance key={entry.label} label={entry.label} window={entry.window} />
            ))}
          </Box>
        )}

        <Box className="flex shrink-0 items-center gap-1.5">
          {quotaBlocked ? <StatusBadge tone="warning">额度不可用</StatusBadge> : null}
          {status === 'active' ? null : <StatusBadge tone={statusView.tone}>{statusView.label}</StatusBadge>}
          {props.item.enabled ? null : <StatusBadge tone="disabled">已禁用</StatusBadge>}
          <AccountActions
            enabled={props.item.enabled}
            busy={props.busy}
            keyId={props.item.id}
            onRefresh={props.onRefresh}
            onRelogin={props.onRelogin}
            onToggle={props.onToggle}
            onDelete={props.onDelete}
          />
        </Box>
      </Box>

      <Collapse in={props.expanded} unmountOnExit>
        <Box id={detailId} className="grid gap-3 border-t border-border/60 px-3 py-3">
          {quotaBlocked ? (
            <Alert severity="warning">
              <AlertTitle>{t('当前额度不可用')}</AlertTitle>
              {t('该账号会暂时退出路由；额度恢复后将自动重新参与。')}
            </Alert>
          ) : null}

          {account?.last_error ? (
            <Alert severity={status === 'active' ? 'warning' : 'error'}>
              <AlertTitle>{t('最近错误')}</AlertTitle>
              {account.last_error}
            </Alert>
          ) : null}

          {!quota ? (
            <Alert severity="info">{t('尚无缓存余量，请手动刷新。')}</Alert>
          ) : windows.length > 0 ? (
            <Box className="grid gap-2.5" aria-label={t('Codex 额度窗口')}>
              {windows.map(entry => (
                <QuotaWindowRow key={entry.label} label={entry.label} window={entry.window} />
              ))}
            </Box>
          ) : null}

          <Box className="grid gap-x-4 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-4">
            <Meta label={t('订阅计划')} value={planLabel ?? '—'} />
            <Meta label={t('Token 到期')} value={formatOptionalDate(account?.token_expires_at_ms)} />
            <Meta label={t('最近刷新')} value={formatOptionalDate(account?.last_refresh_at_ms)} />
            <Meta label={t('余量检查')} value={formatOptionalDate(account?.quota_checked_at_ms)} />
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
  onDelete: () => void;
}) {
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
        aria-label={t('账号操作')}
        aria-haspopup="menu"
        onClick={event => setAnchor(event.currentTarget)}
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </IconButton>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem disabled={refreshing} onClick={run(props.onRefresh)}>
          <ListItemIcon>
            <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
          </ListItemIcon>
          {t('刷新余量')}
        </MenuItem>
        <MenuItem onClick={run(props.onRelogin)}>
          <ListItemIcon>
            <LogIn className="size-3.5" aria-hidden="true" />
          </ListItemIcon>
          {t('重新登录')}
        </MenuItem>
        <MenuItem disabled={props.busy === `toggle-${props.keyId}`} onClick={run(props.onToggle)}>
          <ListItemIcon>
            <Power className="size-3.5" aria-hidden="true" />
          </ListItemIcon>
          {t(props.enabled ? '禁用账号' : '启用账号')}
        </MenuItem>
        <MenuItem
          disabled={props.busy === `delete-${props.keyId}`}
          className="text-danger"
          onClick={run(props.onDelete)}
        >
          <ListItemIcon>
            <Trash2 className="size-3.5 text-danger" aria-hidden="true" />
          </ListItemIcon>
          {t('删除')}
        </MenuItem>
      </Menu>
    </>
  );
}

function Meta(props: { label: string; value: string }) {
  return (
    <Box className="min-w-0">
      <Typography className="text-[0.6875rem] leading-4 text-muted-foreground" component="div">{props.label}</Typography>
      <Typography className="mt-0.5 truncate font-mono text-[0.8125rem] text-foreground" title={props.value} component="div">
        {props.value}
      </Typography>
    </Box>
  );
}

function CreditsMeta(props: { credits: CodexQuotaCredits }) {
  const { credits } = props;
  const balance = credits.unlimited
    ? t('无限')
    : credits.balance != null
      ? formatQuantity(credits.balance)
      : null;
  return (
    <>
      {balance === null ? null : <Meta label={t('Credits 余额')} value={balance} />}
      {credits.reset_credits == null ? null : (
        <Meta label={t('重置 Credits')} value={formatQuantity(credits.reset_credits)} />
      )}
      {credits.subscription_end_at_ms == null ? null : (
        <Meta label={t('订阅截止')} value={formatDateTime(credits.subscription_end_at_ms)} />
      )}
    </>
  );
}

/** 折叠行里的额度速览：窄、无边框，只求一眼看出健康度。 */
function QuotaGlance(props: { label: string; window: CodexQuotaWindow }) {
  const remaining = Math.max(0, Math.min(100, props.window.remaining_percent));
  return (
    <Box className="w-24">
      <Box className="flex items-baseline justify-between gap-1">
        <Typography className="truncate text-[0.625rem] leading-4 text-muted-foreground" component="span">
          {props.label}
        </Typography>
        <Typography
          className={`shrink-0 font-mono text-[0.6875rem] font-medium leading-4 ${quotaTextClass(remaining)}`}
          component="span"
        >
          {Math.round(remaining)}%
        </Typography>
      </Box>
      <Box className="mt-0.5">
        <QuotaBar dense remainingPercent={remaining} label={props.label} />
      </Box>
    </Box>
  );
}

function QuotaWindowRow(props: { label: string; window: CodexQuotaWindow }) {
  const remaining = Math.max(0, Math.min(100, props.window.remaining_percent));
  return (
    <Box className="grid gap-1.5">
      <Box className="flex flex-wrap items-baseline justify-between gap-2">
        <Typography className="text-[0.8125rem] font-medium text-foreground" component="div">{props.label}</Typography>
        <Typography className="font-mono text-[0.6875rem] text-muted-foreground" component="div">
          <Box className={`font-medium ${quotaTextClass(remaining)}`} component="span">
            {t('剩余 {{percent}}%', { percent: Math.round(remaining) })}
          </Box>
          {props.window.reset_at_ms
            ? ` · ${t('重置于 {{time}}', { time: formatDateTime(props.window.reset_at_ms) })}`
            : ''}
        </Typography>
      </Box>
      <QuotaBar remainingPercent={remaining} label={props.label} />
    </Box>
  );
}

type AccountHealth = 'ok' | 'attention' | 'error' | 'off';

function accountHealth(item: UpstreamKeyMeta, status: string, quotaBlocked: boolean): AccountHealth {
  if (!item.enabled) return 'off';
  if (status === 'forbidden') return 'error';
  if (status !== 'active') return 'attention';
  return quotaBlocked ? 'attention' : 'ok';
}

function statusDotClass(health: AccountHealth) {
  if (health === 'ok') return 'bg-success';
  if (health === 'attention') return 'bg-warning';
  if (health === 'error') return 'bg-danger';
  return 'bg-muted-foreground/40';
}

/** 订阅计划来自接口原样小写（如 plus），作为产品名展示时首字母大写。 */
function formatPlan(plan: string | null | undefined) {
  if (!plan) return null;
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function formatQuantity(value: number) {
  return new Intl.NumberFormat(getIntlLocale(), { maximumFractionDigits: 2 }).format(value);
}

function windowLabel(window: CodexQuotaWindow | null, fallback: string) {
  if (!window?.window_seconds) return fallback;
  if (window.window_seconds === 18_000) return t('5 小时额度');
  if (window.window_seconds === 604_800) return t('7 天额度');
  const hours = window.window_seconds / 3_600;
  if (hours < 48) {
    return t('{{hours}} 小时额度', {
      hours: new Intl.NumberFormat(getIntlLocale(), { maximumFractionDigits: 1 }).format(hours),
    });
  }
  const days = window.window_seconds / 86_400;
  return t('{{days}} 天额度', {
    days: new Intl.NumberFormat(getIntlLocale(), { maximumFractionDigits: 1 }).format(days),
  });
}

function formatOptionalDate(value: number | null | undefined) {
  return value ? formatDateTime(value) : '—';
}

function authStatusView(status: string): { label: string; tone: StatusTone } {
  if (status === 'active') return { label: t('认证正常'), tone: 'normal' };
  if (status === 'forbidden') return { label: t('无权限'), tone: 'error' };
  return { label: t('需要重新登录'), tone: 'warning' };
}
