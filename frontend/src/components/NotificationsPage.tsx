import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  BellRing,
  CalendarClock,
  Check,
  Copy,
  Eye,
  Mail,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  Webhook,
} from 'lucide-react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormHelperText from '@mui/material/FormHelperText';
import FormLabel from '@mui/material/FormLabel';
import InputBase from '@mui/material/InputBase';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import { DetailDrawer } from '@/components/console/DetailDrawer';
import { PageHeader } from '@/components/console/PageHeader';
import { StatusBadge, type StatusTone } from '@/components/console/StatusBadge';
import {
  createNotificationChannel,
  createNotificationRule,
  deleteNotificationChannel,
  deleteNotificationRule,
  loadNotificationDelivery,
  loadNotificationChannels,
  loadNotificationDeliveries,
  loadNotificationRules,
  loadNotificationSummary,
  previewNotificationSchedule,
  retryNotificationDelivery,
  runNotificationRule,
  testNotificationChannel,
  updateNotificationChannel,
  updateNotificationRule,
} from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { getLocale, t } from '@/lib/i18n';
import type {
  ApiKeyWorkspace,
  ConnectionSettings,
  NotificationAlertMetric,
  NotificationAlertOperator,
  NotificationAlertScope,
  NotificationChannel,
  NotificationChannelInput,
  NotificationDelivery,
  NotificationDeliveryDetail,
  NotificationLocale,
  NotificationRule,
  NotificationRuleInput,
  NotificationRuleKind,
  NotificationSmtpSecurity,
  NotificationSummary,
  NotificationWebhookFormat,
  ProviderWorkspace,
} from '@/lib/types';

interface NotificationsPageProps {
  settings: ConnectionSettings;
  providers: ProviderWorkspace[];
  apiKeys: ApiKeyWorkspace[];
  onMessage: (message: string) => void;
}

interface ChannelDraft {
  id: number | null;
  kind: 'smtp' | 'webhook';
  name: string;
  enabled: boolean;
  host: string;
  port: string;
  security: NotificationSmtpSecurity;
  username: string;
  savedUsername: string;
  password: string;
  hasPassword: boolean;
  fromName: string;
  fromEmail: string;
  recipients: string;
  webhookUrl: string;
  webhookUrlMasked: string;
  webhookFormat: NotificationWebhookFormat;
  savedWebhookFormat: NotificationWebhookFormat;
  signingSecret: string;
  hasSigningSecret: boolean;
  headers: string;
}

interface RuleDraft {
  id: number | null;
  kind: NotificationRuleKind;
  name: string;
  enabled: boolean;
  channelIds: number[];
  locale: NotificationLocale;
  cron: string;
  timezone: string;
  topN: string;
  metric: NotificationAlertMetric;
  scopeKind: NotificationAlertScope;
  scopeId: string;
  operator: NotificationAlertOperator;
  threshold: string;
  windowMinutes: string;
  minimumRequests: string;
  triggerAfter: string;
  recoverAfter: string;
  cooldownMinutes: string;
  sendRecovery: boolean;
}

const EMPTY_SUMMARY: NotificationSummary = {
  enabled_channels: 0,
  enabled_rules: 0,
  firing_alerts: 0,
  failed_deliveries_24h: 0,
};

const METRICS: NotificationAlertMetric[] = [
  'cpu_usage_percent',
  'memory_usage_percent',
  'unhealthy_provider_count',
  'request_count',
  'error_rate_percent',
  'total_tokens',
  'estimated_cost_usd',
];

const OPERATORS: NotificationAlertOperator[] = ['gt', 'gte', 'lt', 'lte'];

function defaultLocale(): NotificationLocale {
  return getLocale() === 'en' ? 'en-US' : 'zh-CN';
}

function emptyChannelDraft(kind: 'smtp' | 'webhook'): ChannelDraft {
  return {
    id: null,
    kind,
    name: '',
    enabled: true,
    host: '',
    port: kind === 'smtp' ? '587' : '',
    security: 'starttls',
    username: '',
    savedUsername: '',
    password: '',
    hasPassword: false,
    fromName: 'little-gate',
    fromEmail: '',
    recipients: '',
    webhookUrl: '',
    webhookUrlMasked: '',
    webhookFormat: 'generic',
    savedWebhookFormat: 'generic',
    signingSecret: '',
    hasSigningSecret: false,
    headers: '',
  };
}

function channelDraftFrom(channel: NotificationChannel): ChannelDraft {
  if (channel.kind === 'smtp') {
    return {
      ...emptyChannelDraft('smtp'),
      id: channel.id,
      name: channel.name,
      enabled: channel.enabled,
      host: channel.config.host,
      port: String(channel.config.port),
      security: channel.config.security,
      username: channel.config.username ?? '',
      savedUsername: channel.config.username ?? '',
      hasPassword: channel.config.has_password,
      fromName: channel.config.from_name ?? '',
      fromEmail: channel.config.from_email,
      recipients: channel.config.recipients.join('\n'),
    };
  }
  return {
    ...emptyChannelDraft('webhook'),
    id: channel.id,
    name: channel.name,
    enabled: channel.enabled,
    webhookUrl: '',
    webhookUrlMasked: channel.config.url_masked,
    webhookFormat: channel.config.format,
    savedWebhookFormat: channel.config.format,
    hasSigningSecret: channel.config.has_signing_secret,
    headers: channel.config.headers.map((header) => `${header.name}:`).join('\n'),
  };
}

function emptyRuleDraft(kind: NotificationRuleKind): RuleDraft {
  return {
    id: null,
    kind,
    name: '',
    enabled: true,
    channelIds: [],
    locale: defaultLocale(),
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    topN: '20',
    metric: 'error_rate_percent',
    scopeKind: 'global',
    scopeId: '',
    operator: 'gte',
    threshold: '5',
    windowMinutes: '15',
    minimumRequests: '20',
    triggerAfter: '3',
    recoverAfter: '2',
    cooldownMinutes: '30',
    sendRecovery: true,
  };
}

function ruleDraftFrom(rule: NotificationRule): RuleDraft {
  if (rule.kind === 'scheduled_report') {
    return {
      ...emptyRuleDraft('scheduled_report'),
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      channelIds: rule.channel_ids,
      locale: rule.config.locale,
      cron: rule.config.cron,
      timezone: rule.config.timezone,
      topN: String(rule.config.top_n),
    };
  }
  return {
    ...emptyRuleDraft('threshold_alert'),
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    channelIds: rule.channel_ids,
    locale: rule.config.locale,
    metric: rule.config.metric,
    scopeKind: rule.config.scope_kind,
    scopeId: rule.config.scope_id === null ? '' : String(rule.config.scope_id),
    operator: rule.config.operator,
    threshold: String(rule.config.threshold),
    windowMinutes: String(rule.config.window_minutes),
    minimumRequests: String(rule.config.minimum_requests),
    triggerAfter: String(rule.config.trigger_after),
    recoverAfter: String(rule.config.recover_after),
    cooldownMinutes: String(rule.config.cooldown_minutes),
    sendRecovery: rule.config.send_recovery,
  };
}

function parseHeaders(raw: string) {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(':');
      if (separator <= 0) throw new Error(t('Webhook 请求头必须使用“名称: 值”格式。'));
      return {
        name: line.slice(0, separator).trim(),
        value: line.slice(separator + 1).trim(),
      };
    });
}

function channelInputFromDraft(draft: ChannelDraft): NotificationChannelInput {
  const name = draft.name.trim();
  if (!name) throw new Error(t('通道名称不能为空。'));
  if (draft.kind === 'smtp') {
    const port = Number(draft.port);
    const recipients = draft.recipients
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (!draft.host.trim() || !draft.fromEmail.trim() || recipients.length === 0) {
      throw new Error(t('请完整填写 SMTP 主机、发件地址和收件人。'));
    }
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(t('SMTP 端口必须在 1–65535 之间。'));
    }
    return {
      name,
      enabled: draft.enabled,
      kind: 'smtp',
      config: {
        host: draft.host.trim(),
        port,
        security: draft.security,
        username: draft.username.trim() || null,
        password: draft.password || null,
        from_name: draft.fromName.trim() || null,
        from_email: draft.fromEmail.trim(),
        recipients,
      },
    };
  }
  if (draft.id === null && !draft.webhookUrl.trim()) throw new Error(t('Webhook 地址不能为空。'));
  if (
    draft.id !== null
    && draft.savedWebhookFormat !== 'generic'
    && draft.webhookFormat === 'generic'
    && draft.signingSecret.trim().length < 32
  ) {
    throw new Error(t('切换到通用 JSON 时，请填写至少 32 个字符的新签名密钥。'));
  }
  return {
    name,
    enabled: draft.enabled,
    kind: 'webhook',
    config: {
      url: draft.webhookUrl.trim(),
      format: draft.webhookFormat,
      signing_secret: draft.signingSecret.trim(),
      headers: parseHeaders(draft.headers),
    },
  };
}

function positiveInteger(raw: string, label: string) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(t('{{label}} 必须是正整数。', { label }));
  }
  return value;
}

function finiteNumber(raw: string, label: string) {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(t('{{label}} 必须是有效数字。', { label }));
  return value;
}

function ruleInputFromDraft(draft: RuleDraft): NotificationRuleInput {
  const name = draft.name.trim();
  if (!name) throw new Error(t('规则名称不能为空。'));
  if (draft.channelIds.length === 0) throw new Error(t('请至少选择一个通知通道。'));
  if (draft.kind === 'scheduled_report') {
    return {
      name,
      enabled: draft.enabled,
      channel_ids: draft.channelIds,
      kind: 'scheduled_report',
      config: {
        cron: draft.cron.trim(),
        timezone: draft.timezone.trim(),
        locale: draft.locale,
        top_n: positiveInteger(draft.topN, t('Top N')),
      },
    };
  }
  const scopeId = draft.scopeKind === 'global' ? null : positiveInteger(draft.scopeId, t('范围 ID'));
  return {
    name,
    enabled: draft.enabled,
    channel_ids: draft.channelIds,
    kind: 'threshold_alert',
    config: {
      metric: draft.metric,
      scope_kind: draft.scopeKind,
      scope_id: scopeId,
      operator: draft.operator,
      threshold: finiteNumber(draft.threshold, t('阈值')),
      window_minutes: positiveInteger(draft.windowMinutes, t('统计窗口')),
      minimum_requests: positiveInteger(draft.minimumRequests, t('最少请求数')),
      trigger_after: positiveInteger(draft.triggerAfter, t('连续触发次数')),
      recover_after: positiveInteger(draft.recoverAfter, t('连续恢复次数')),
      cooldown_minutes: positiveInteger(draft.cooldownMinutes, t('提醒冷却')),
      send_recovery: draft.sendRecovery,
      locale: draft.locale,
    },
  };
}

function deliveryTone(status: string): StatusTone {
  if (status === 'succeeded') return 'normal';
  if (status === 'failed') return 'error';
  if (status === 'pending' || status === 'sending') return 'warning';
  return 'disabled';
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: '等待发送',
    sending: '正在发送',
    succeeded: '发送成功',
    failed: '发送失败',
    skipped: '已跳过',
  };
  return labels[status] ?? status;
}

function webhookFormatLabel(format: NotificationWebhookFormat) {
  const labels: Record<NotificationWebhookFormat, string> = {
    generic: '通用 JSON',
    feishu: '飞书',
    wecom: '企业微信',
    dingtalk: '钉钉',
    slack: 'Slack',
    discord: 'Discord',
  };
  return labels[format];
}

function prettyJson(raw: string | null) {
  if (!raw) return '—';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function formatOptionalDateTime(value: number | null) {
  return value === null ? '—' : formatDateTime(value);
}

function DetailValue(props: { label: string; children: ReactNode; mono?: boolean }) {
  return <Box className="min-w-0">
      <Typography className="text-xs text-muted-foreground" component="div">{t(props.label)}</Typography>
      <Box className={`mt-1 break-words text-sm text-foreground${props.mono ? ' font-mono' : ''}`}>{props.children}</Box>
    </Box>;
}

function DiagnosticBody(props: { title: string; value: string }) {
  return <Box>
      <Typography className="mb-2 text-sm font-semibold" component="h3">{t(props.title)}</Typography>
      <Box component="pre" className="max-h-80 overflow-auto whitespace-pre-wrap break-all border border-border bg-muted/20 p-4 font-mono text-xs leading-5 text-foreground">{props.value}</Box>
    </Box>;
}

function DeliveryDetailDrawer(props: {
  delivery: NotificationDelivery | null;
  detail: NotificationDeliveryDetail | null;
  loading: boolean;
  error: string;
  onClose: () => void;
}) {
  const delivery = props.detail ?? props.delivery;
  return <DetailDrawer
      open={props.delivery !== null}
      title="投递详情"
      description={delivery?.id}
      onClose={props.onClose}
    >
      {props.loading ? <Box className="flex min-h-28 items-center justify-center"><CircularProgress size={20} /></Box> : null}
      {props.error ? <Alert severity="error">{props.error}</Alert> : null}
      {!props.loading && delivery ? <Box className="grid gap-4">
          <Box className="grid gap-3 sm:grid-cols-2">
            <DetailValue label="状态"><StatusBadge tone={deliveryTone(delivery.status)}>{t(statusLabel(delivery.status))}</StatusBadge></DetailValue>
            <DetailValue label="HTTP 状态">{props.detail?.last_http_status ?? '—'}</DetailValue>
            <DetailValue label="事件">{t(delivery.event_type)}</DetailValue>
            <DetailValue label="尝试次数">{delivery.attempts}</DetailValue>
            <DetailValue label="规则">{delivery.rule_name}</DetailValue>
            <DetailValue label="通道">{delivery.channel_name}</DetailValue>
            <DetailValue label="创建时间">{formatDateTime(delivery.created_at_ms)}</DetailValue>
            <DetailValue label="最近尝试">{formatOptionalDateTime(delivery.last_attempt_at_ms)}</DetailValue>
            <DetailValue label="送达时间">{formatOptionalDateTime(delivery.delivered_at_ms)}</DetailValue>
            <DetailValue label="下次尝试">{formatOptionalDateTime(delivery.next_attempt_at_ms)}</DetailValue>
            <DetailValue label="投递 ID" mono>{delivery.id}</DetailValue>
            <DetailValue label="运行 ID" mono>{delivery.run_id}</DetailValue>
          </Box>
          {delivery.last_error_code || delivery.last_error_message ? <>
              <Divider />
              <Box className="grid gap-4 sm:grid-cols-2">
                <DetailValue label="错误代码" mono>{delivery.last_error_code ?? '—'}</DetailValue>
                <DetailValue label="错误信息">{delivery.last_error_message ?? '—'}</DetailValue>
              </Box>
            </> : null}
          {props.detail ? <>
              <Divider />
              <DiagnosticBody title="实际请求体" value={prettyJson(props.detail.last_request_body)} />
              <DiagnosticBody title="平台响应体" value={prettyJson(props.detail.last_response_body)} />
              <DiagnosticBody title="事件载荷" value={JSON.stringify(props.detail.event_payload, null, 2) ?? '—'} />
            </> : null}
        </Box> : null}
    </DetailDrawer>;
}

function metricLabel(metric: NotificationAlertMetric) {
  const labels: Record<NotificationAlertMetric, string> = {
    cpu_usage_percent: 'CPU 使用率',
    memory_usage_percent: '内存使用率',
    unhealthy_provider_count: '异常上游数量',
    request_count: '请求数',
    error_rate_percent: '错误率',
    total_tokens: 'Token 总量',
    estimated_cost_usd: '估算成本（USD）',
  };
  return labels[metric];
}

function operatorLabel(operator: NotificationAlertOperator) {
  return ({ gt: '>', gte: '≥', lt: '<', lte: '≤' } as const)[operator];
}

function SummaryCard(props: { label: string; value: number; warning?: boolean }) {
  return <Card className={props.warning ? 'border-amber-500/40' : ''}>
      {/* 主题里 CardContent 的 paddingTop 为 0（默认上方有卡片头），这里单独使用需补回上内距 */}
      <CardContent className="flex h-full flex-col justify-center pt-4">
        <Box className="surface-label">{t(props.label)}</Box>
        <Box className="mt-1.5 text-xl font-semibold tracking-tight text-foreground">{props.value}</Box>
      </CardContent>
    </Card>;
}

function SectionTitle(props: { title: string; description: string; action: ReactNode }) {
  return <Box className="flex flex-col gap-2.5 sm:flex-row sm:items-end sm:justify-between">
      <Box>
        <Typography className="text-sm font-semibold text-foreground" component="h2">{t(props.title)}</Typography>
        <Typography className="mt-0.5 text-[0.8125rem] leading-5 text-muted-foreground" component="p">{t(props.description)}</Typography>
      </Box>
      {props.action}
    </Box>;
}

export function NotificationsPage(props: NotificationsPageProps) {
  const [summary, setSummary] = useState<NotificationSummary>(EMPTY_SUMMARY);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [deliveries, setDeliveries] = useState<NotificationDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [generatedSecret, setGeneratedSecret] = useState('');
  const [channelDraft, setChannelDraft] = useState<ChannelDraft | null>(null);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  const [schedulePreview, setSchedulePreview] = useState<number[]>([]);
  const [selectedDelivery, setSelectedDelivery] = useState<NotificationDelivery | null>(null);
  const [deliveryDetail, setDeliveryDetail] = useState<NotificationDeliveryDetail | null>(null);
  const [deliveryDetailLoading, setDeliveryDetailLoading] = useState(false);
  const [deliveryDetailError, setDeliveryDetailError] = useState('');
  const detailRequestId = useRef(0);

  const scheduledRules = useMemo(
    () => rules.filter((rule): rule is Extract<NotificationRule, { kind: 'scheduled_report' }> => rule.kind === 'scheduled_report'),
    [rules],
  );
  const alertRules = useMemo(
    () => rules.filter((rule): rule is Extract<NotificationRule, { kind: 'threshold_alert' }> => rule.kind === 'threshold_alert'),
    [rules],
  );
  const providerOptions = useMemo(
    () => props.providers.map((item) => ({ id: item.provider.id, name: item.provider.name })),
    [props.providers],
  );
  const apiKeyOptions = useMemo(
    () => props.apiKeys.map((item) => ({ id: item.apiKey.id, name: item.apiKey.name })),
    [props.apiKeys],
  );
  const hasPendingDeliveries = deliveries.some((item) => item.status === 'pending' || item.status === 'sending');

  const refreshAll = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError('');
    try {
      const [nextSummary, nextChannels, nextRules, nextDeliveries] = await Promise.all([
        loadNotificationSummary(props.settings),
        loadNotificationChannels(props.settings),
        loadNotificationRules(props.settings),
        loadNotificationDeliveries(props.settings, { limit: 50 }),
      ]);
      setSummary(nextSummary);
      setChannels(nextChannels);
      setRules(nextRules);
      setDeliveries(nextDeliveries.items);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('读取通知配置失败。'));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [props.settings]);

  const refreshHistory = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const [nextSummary, nextDeliveries] = await Promise.all([
        loadNotificationSummary(props.settings),
        loadNotificationDeliveries(props.settings, { limit: 50 }),
      ]);
      setSummary(nextSummary);
      setDeliveries(nextDeliveries.items);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('刷新发送历史失败。'));
    }
  }, [props.settings]);

  const openDeliveryDetail = useCallback(async (delivery: NotificationDelivery) => {
    const requestId = detailRequestId.current + 1;
    detailRequestId.current = requestId;
    setSelectedDelivery(delivery);
    setDeliveryDetail(null);
    setDeliveryDetailError('');
    setDeliveryDetailLoading(true);
    try {
      const detail = await loadNotificationDelivery(props.settings, delivery.id);
      if (detailRequestId.current === requestId) setDeliveryDetail(detail);
    } catch (detailError) {
      if (detailRequestId.current === requestId) {
        setDeliveryDetailError(detailError instanceof Error ? detailError.message : t('读取投递详情失败。'));
      }
    } finally {
      if (detailRequestId.current === requestId) setDeliveryDetailLoading(false);
    }
  }, [props.settings]);

  const closeDeliveryDetail = useCallback(() => {
    detailRequestId.current += 1;
    setSelectedDelivery(null);
    setDeliveryDetail(null);
    setDeliveryDetailError('');
    setDeliveryDetailLoading(false);
  }, []);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!hasPendingDeliveries) return undefined;
    const timer = window.setInterval(() => void refreshHistory(), 5_000);
    const onVisibility = () => {
      if (!document.hidden) void refreshHistory();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [hasPendingDeliveries, refreshHistory]);

  const runAction = async (key: string, action: () => Promise<void>, success: string) => {
    setBusy(key);
    setError('');
    try {
      await action();
      props.onMessage(success);
      await refreshAll(false);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : t('通知操作失败。'));
    } finally {
      setBusy(null);
    }
  };

  const submitChannel = async (event: FormEvent) => {
    event.preventDefault();
    if (!channelDraft) return;
    let input: NotificationChannelInput;
    try {
      input = channelInputFromDraft(channelDraft);
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : t('通道配置不完整。'));
      return;
    }
    setBusy('channel-save');
    setError('');
    try {
      if (channelDraft.id === null) {
        const response = await createNotificationChannel(props.settings, input);
        setGeneratedSecret(response.generated_signing_secret ?? '');
        props.onMessage(t('通知通道已创建。'));
      } else {
        await updateNotificationChannel(props.settings, channelDraft.id, input);
        props.onMessage(t('通知通道已更新。'));
      }
      setChannelDraft(null);
      await refreshAll(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('保存通知通道失败。'));
    } finally {
      setBusy(null);
    }
  };

  const submitRule = async (event: FormEvent) => {
    event.preventDefault();
    if (!ruleDraft) return;
    let input: NotificationRuleInput;
    try {
      input = ruleInputFromDraft(ruleDraft);
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : t('规则配置不完整。'));
      return;
    }
    setBusy('rule-save');
    setError('');
    try {
      if (ruleDraft.id === null) {
        await createNotificationRule(props.settings, input);
        props.onMessage(t('通知规则已创建。'));
      } else {
        await updateNotificationRule(props.settings, ruleDraft.id, input);
        props.onMessage(t('通知规则已更新。'));
      }
      setRuleDraft(null);
      setSchedulePreview([]);
      await refreshAll(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('保存通知规则失败。'));
    } finally {
      setBusy(null);
    }
  };

  const toggleChannel = (channel: NotificationChannel) => {
    void runAction(
      `channel-toggle-${channel.id}`,
      async () => { await updateNotificationChannel(props.settings, channel.id, { enabled: !channel.enabled }); },
      channel.enabled ? t('通知通道已禁用。') : t('通知通道已启用。'),
    );
  };

  const toggleRule = (rule: NotificationRule) => {
    void runAction(
      `rule-toggle-${rule.id}`,
      async () => { await updateNotificationRule(props.settings, rule.id, { enabled: !rule.enabled }); },
      rule.enabled ? t('通知规则已禁用。') : t('通知规则已启用。'),
    );
  };

  if (loading) {
    return <Box className="flex min-h-64 items-center justify-center" aria-live="polite">
        <CircularProgress size={28} aria-label={t('正在加载通知配置')} />
      </Box>;
  }

  return <Box className="section-stack">
      <PageHeader title="通知" description="配置定时报表、阈值告警与投递通道。" actions={<Box className="flex w-full justify-end">
          <Button type="button" variant="outline" onClick={() => void refreshAll()} disabled={busy !== null}>
            <RefreshCw className="mr-1.5 size-3.5" />{t('刷新')}
          </Button>
        </Box>} />

      <Box aria-live="polite">
        {error ? <Alert severity="error" onClose={() => setError('')}>{error}</Alert> : null}
        {generatedSecret ? <Alert severity="warning" action={<Box className="flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => {
                void navigator.clipboard.writeText(generatedSecret);
                props.onMessage(t('Webhook 签名密钥已复制。'));
              }}><Copy className="mr-1.5 size-3" />{t('复制')}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setGeneratedSecret('')}>{t('我已保存')}</Button>
            </Box>}>
            <Typography className="font-semibold" component="div">{t('请立即保存 Webhook 签名密钥')}</Typography>
            <Box className="mt-2 break-all font-mono text-xs" component="code">{generatedSecret}</Box>
            <Typography className="mt-2 text-sm" component="p">{t('此密钥仅显示一次，之后管理 API 只返回已配置状态。')}</Typography>
          </Alert> : null}
      </Box>

      <Box className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="启用通道" value={summary.enabled_channels} />
        <SummaryCard label="启用规则" value={summary.enabled_rules} />
        <SummaryCard label="正在告警" value={summary.firing_alerts} warning={summary.firing_alerts > 0} />
        <SummaryCard label="24 小时失败投递" value={summary.failed_deliveries_24h} warning={summary.failed_deliveries_24h > 0} />
      </Box>

      <Card>
        <CardContent className="flex flex-col gap-4">
          <SectionTitle title="投递通道" description="SMTP 邮件由 Rust 后端投递；Webhook 支持通用 JSON 与常用消息平台格式。" action={<Box className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setChannelDraft(emptyChannelDraft('smtp'))}><Mail className="mr-1.5 size-3.5" />{t('添加 SMTP')}</Button>
              <Button type="button" size="sm" onClick={() => setChannelDraft(emptyChannelDraft('webhook'))}><Webhook className="mr-1.5 size-3.5" />{t('添加 Webhook')}</Button>
            </Box>} />
          {channels.length === 0 ? <Alert severity="info">{t('尚未配置通知通道。请先添加 SMTP 或 Webhook。')}</Alert> : <Box className="grid gap-4 xl:grid-cols-2">
              {channels.map((channel) => <Box key={channel.id} className="surface-tile flex flex-col gap-4">
                  <Box className="flex items-start justify-between gap-3">
                    <Box className="flex min-w-0 items-center gap-3">
                      <Box className="flex size-8 shrink-0 items-center justify-center rounded border border-border bg-background" aria-hidden="true">
                        {channel.kind === 'smtp' ? <Mail className="size-4" /> : <Webhook className="size-4" />}
                      </Box>
                      <Box className="min-w-0">
                        <Typography className="truncate font-semibold" component="h3">{channel.name}</Typography>
                        <Typography className="mt-1 truncate text-xs text-muted-foreground" component="p">
                          {channel.kind === 'smtp' ? `${channel.config.host}:${channel.config.port}` : `${t(webhookFormatLabel(channel.config.format))} · ${channel.config.url_masked}`}
                        </Typography>
                      </Box>
                    </Box>
                    <StatusBadge tone={channel.enabled ? 'normal' : 'disabled'}>{channel.enabled ? '已启用' : '已禁用'}</StatusBadge>
                  </Box>
                  <Box className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                    <Box>{channel.kind === 'smtp' ? t('{{count}} 个收件人', { count: channel.config.recipients.length }) : t('{{format}} 消息格式', { format: t(webhookFormatLabel(channel.config.format)) })}</Box>
                    <Box>{t('更新于 {{time}}', { time: formatDateTime(channel.updated_at_ms) })}</Box>
                  </Box>
                  <Divider />
                  <Box className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void runAction(
                      `channel-test-${channel.id}`,
                      async () => { await testNotificationChannel(props.settings, channel.id, defaultLocale()); },
                      t('测试通知已进入发送队列。'),
                    )}><Send className="mr-1.5 size-3" />{t('发送测试')}</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setChannelDraft(channelDraftFrom(channel))}><Pencil className="mr-1.5 size-3" />{t('编辑')}</Button>
                    <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => toggleChannel(channel)}>{channel.enabled ? t('禁用') : t('启用')}</Button>
                    <Button type="button" size="sm" color="error" variant="ghost" disabled={busy !== null} onClick={() => {
                      if (!window.confirm(t('确认删除通知通道 {{name}}？', { name: channel.name }))) return;
                      void runAction(`channel-delete-${channel.id}`, async () => { await deleteNotificationChannel(props.settings, channel.id); }, t('通知通道已删除。'));
                    }}><Trash2 className="mr-1.5 size-3" />{t('删除')}</Button>
                  </Box>
                </Box>)}
            </Box>}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4">
          <SectionTitle title="定时报表" description="使用标准 5 段 Cron 与独立 IANA 时区；停机期间遗漏窗口会合并为一份报表。" action={<Button type="button" size="sm" onClick={() => setRuleDraft(emptyRuleDraft('scheduled_report'))}><Plus className="mr-1.5 size-3.5" />{t('添加定时报表')}</Button>} />
          <RuleCards rules={scheduledRules} channels={channels} busy={busy} onEdit={(rule) => setRuleDraft(ruleDraftFrom(rule))} onToggle={toggleRule} onDelete={(rule) => {
            if (!window.confirm(t('确认删除通知规则 {{name}}？', { name: rule.name }))) return;
            void runAction(`rule-delete-${rule.id}`, async () => { await deleteNotificationRule(props.settings, rule.id); }, t('通知规则已删除。'));
          }} onRun={(rule) => void runAction(`rule-run-${rule.id}`, async () => { await runNotificationRule(props.settings, rule.id); }, t('报表已进入发送队列。'))} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4">
          <SectionTitle title="阈值告警" description="支持首次触发、冷却提醒和恢复通知；每分钟评估一次。" action={<Button type="button" size="sm" onClick={() => setRuleDraft(emptyRuleDraft('threshold_alert'))}><BellRing className="mr-1.5 size-3.5" />{t('添加阈值告警')}</Button>} />
          <RuleCards rules={alertRules} channels={channels} busy={busy} onEdit={(rule) => setRuleDraft(ruleDraftFrom(rule))} onToggle={toggleRule} onDelete={(rule) => {
            if (!window.confirm(t('确认删除通知规则 {{name}}？', { name: rule.name }))) return;
            void runAction(`rule-delete-${rule.id}`, async () => { await deleteNotificationRule(props.settings, rule.id); }, t('通知规则已删除。'));
          }} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4">
          <SectionTitle title="发送历史" description="保留 90 天。失败投递可单独重试；待发送任务存在时每 5 秒自动刷新。" action={<Button type="button" size="sm" variant="outline" onClick={() => void refreshHistory()}><RefreshCw className="mr-1.5 size-3" />{t('刷新历史')}</Button>} />
          <TableContainer className="max-w-full overflow-x-auto border border-border/60">
            <Table size="small" aria-label={t('通知发送历史')}>
              <TableHead><TableRow>
                <TableCell>{t('时间')}</TableCell><TableCell>{t('事件')}</TableCell><TableCell>{t('规则')}</TableCell><TableCell>{t('通道')}</TableCell><TableCell>{t('状态')}</TableCell><TableCell>{t('尝试')}</TableCell><TableCell>{t('错误')}</TableCell><TableCell align="right">{t('操作')}</TableCell>
              </TableRow></TableHead>
              <TableBody>
                {deliveries.length === 0 ? <TableRow><TableCell colSpan={8}><Box className="py-5 text-center text-[0.8125rem] text-muted-foreground">{t('暂无发送历史。')}</Box></TableCell></TableRow> : deliveries.map((delivery) => <TableRow key={delivery.id} hover>
                    <TableCell className="whitespace-nowrap">{formatDateTime(delivery.created_at_ms)}</TableCell>
                    <TableCell className="whitespace-nowrap">{t(delivery.event_type)}</TableCell>
                    <TableCell>{delivery.rule_name}</TableCell>
                    <TableCell>{delivery.channel_name}</TableCell>
                    <TableCell><StatusBadge tone={deliveryTone(delivery.status)}>{t(statusLabel(delivery.status))}</StatusBadge></TableCell>
                    <TableCell>{delivery.attempts}</TableCell>
                    <TableCell className="max-w-72"><Box className="truncate text-xs text-muted-foreground" title={delivery.last_error_message ?? undefined}>{delivery.last_error_message ?? '—'}</Box></TableCell>
                    <TableCell align="right"><Box className="flex min-w-28 justify-end gap-1">
                        <Tooltip title={t('查看详情')}><Button type="button" size="icon" variant="ghost" aria-label={t('查看详情')} onClick={() => void openDeliveryDetail(delivery)}><Eye className="size-4" /></Button></Tooltip>
                        {delivery.status === 'failed' ? <Tooltip title={t('重试')}><Button type="button" size="icon" variant="outline" aria-label={t('重试')} disabled={busy !== null} onClick={() => void runAction(
                          `delivery-retry-${delivery.id}`,
                          async () => { await retryNotificationDelivery(props.settings, delivery.id); },
                          t('失败投递已重新排队。'),
                        )}><RotateCcw className="size-3" /></Button></Tooltip> : null}
                      </Box></TableCell>
                  </TableRow>)}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>

      <ChannelDialog draft={channelDraft} busy={busy === 'channel-save'} onChange={setChannelDraft} onClose={() => setChannelDraft(null)} onSubmit={submitChannel} />
      <RuleDialog draft={ruleDraft} channels={channels} providers={providerOptions} apiKeys={apiKeyOptions} busy={busy === 'rule-save'} preview={schedulePreview} onChange={setRuleDraft} onClose={() => { setRuleDraft(null); setSchedulePreview([]); }} onSubmit={submitRule} onPreview={async () => {
        if (!ruleDraft || ruleDraft.kind !== 'scheduled_report') return;
        setBusy('schedule-preview');
        setError('');
        try {
          const response = await previewNotificationSchedule(props.settings, ruleDraft.cron, ruleDraft.timezone);
          setSchedulePreview(response.occurrences_ms);
        } catch (previewError) {
          setError(previewError instanceof Error ? previewError.message : t('Cron 预览失败。'));
        } finally {
          setBusy(null);
        }
      }} />
      <DeliveryDetailDrawer delivery={selectedDelivery} detail={deliveryDetail} loading={deliveryDetailLoading} error={deliveryDetailError} onClose={closeDeliveryDetail} />
    </Box>;
}

function RuleCards(props: {
  rules: NotificationRule[];
  channels: NotificationChannel[];
  busy: string | null;
  onEdit: (rule: NotificationRule) => void;
  onToggle: (rule: NotificationRule) => void;
  onDelete: (rule: NotificationRule) => void;
  onRun?: (rule: NotificationRule) => void;
}) {
  const channelNames = useMemo(() => new Map(props.channels.map((channel) => [channel.id, channel.name])), [props.channels]);
  if (props.rules.length === 0) return <Alert severity="info">{t('尚未配置此类通知规则。')}</Alert>;
  return <Box className="grid gap-4 xl:grid-cols-2">
      {props.rules.map((rule) => <Box key={rule.id} className="surface-tile flex flex-col gap-4">
          <Box className="flex items-start justify-between gap-3">
            <Box>
              <Typography className="font-semibold" component="h3">{rule.name}</Typography>
              <Typography className="mt-1 text-xs text-muted-foreground" component="p">
                {rule.kind === 'scheduled_report'
                  ? t('{{cron}} · {{timezone}}', { cron: rule.config.cron, timezone: rule.config.timezone })
                  : t('{{metric}} {{operator}} {{threshold}} · {{minutes}} 分钟窗口', { metric: t(metricLabel(rule.config.metric)), operator: operatorLabel(rule.config.operator), threshold: rule.config.threshold, minutes: rule.config.window_minutes })}
              </Typography>
            </Box>
            <StatusBadge tone={rule.enabled ? 'normal' : 'disabled'}>{rule.enabled ? '已启用' : '已禁用'}</StatusBadge>
          </Box>
          <Box className="text-sm leading-6 text-muted-foreground">
            {t('通道：{{channels}}', { channels: rule.channel_ids.map((id) => channelNames.get(id) ?? `#${id}`).join(', ') })}
            {rule.kind === 'scheduled_report' ? <Box component="p">{t('下次执行：{{time}}', { time: formatDateTime(rule.next_run_at_ms) })}</Box> : null}
            {rule.kind === 'threshold_alert' ? <Box className="mt-2 flex items-center gap-2" component="p">
                <Box component="span">{t('告警状态：')}</Box>
                <StatusBadge tone={rule.alert_state?.state === 'firing' ? 'error' : rule.alert_state?.state === 'pending' ? 'warning' : 'normal'}>
                  {rule.alert_state?.state === 'firing' ? '告警中' : rule.alert_state?.state === 'pending' ? '等待连续确认' : '正常'}
                </StatusBadge>
              </Box> : null}
          </Box>
          <Divider />
          <Box className="flex flex-wrap gap-2">
            {props.onRun ? <Button type="button" size="sm" variant="outline" disabled={props.busy !== null || !rule.enabled} onClick={() => props.onRun?.(rule)}><Play className="mr-1.5 size-3" />{t('立即运行')}</Button> : null}
            <Button type="button" size="sm" variant="ghost" onClick={() => props.onEdit(rule)}><Pencil className="mr-1.5 size-3" />{t('编辑')}</Button>
            <Button type="button" size="sm" variant="ghost" disabled={props.busy !== null} onClick={() => props.onToggle(rule)}>{rule.enabled ? t('禁用') : t('启用')}</Button>
            <Button type="button" size="sm" color="error" variant="ghost" disabled={props.busy !== null} onClick={() => props.onDelete(rule)}><Trash2 className="mr-1.5 size-3" />{t('删除')}</Button>
          </Box>
        </Box>)}
    </Box>;
}

function ChannelDialog(props: {
  draft: ChannelDraft | null;
  busy: boolean;
  onChange: (draft: ChannelDraft | null) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const draft = props.draft;
  const smtpUsernameChanged = draft !== null
    && draft.id !== null
    && draft.kind === 'smtp'
    && draft.username.trim() !== draft.savedUsername.trim();
  const webhookFormatChanged = draft !== null
    && draft.id !== null
    && draft.kind === 'webhook'
    && draft.webhookFormat !== draft.savedWebhookFormat;
  const update = <K extends keyof ChannelDraft>(key: K, value: ChannelDraft[K]) => {
    if (draft) props.onChange({ ...draft, [key]: value });
  };
  return <Dialog open={draft !== null} onClose={props.busy ? undefined : props.onClose} fullWidth maxWidth="md" aria-labelledby="channel-dialog-title">
      {draft ? <Box component="form" onSubmit={props.onSubmit}>
          <DialogTitle id="channel-dialog-title">{t(draft.id === null ? '添加通知通道' : '编辑通知通道')}</DialogTitle>
          <DialogContent className="grid gap-5 pt-2">
            <Box className="grid gap-4 md:grid-cols-2">
              <FormControl><FormLabel>{t('通道名称')}</FormLabel><InputBase value={draft.name} onChange={(event) => update('name', event.target.value)} inputProps={{ 'aria-label': t('通道名称') }} autoFocus /></FormControl>
              <FormControl><FormLabel>{t('通道类型')}</FormLabel><InputBase value={draft.kind === 'smtp' ? 'SMTP' : 'Webhook'} inputProps={{ 'aria-label': t('通道类型') }} disabled /></FormControl>
            </Box>
            <FormControlLabel control={<Switch checked={draft.enabled} onChange={(event) => update('enabled', event.target.checked)} />} label={t('创建后立即启用')} />
            {draft.kind === 'smtp' ? <>
                <Box className="grid gap-4 md:grid-cols-3">
                  <FormControl className="md:col-span-2"><FormLabel>{t('SMTP 主机')}</FormLabel><InputBase value={draft.host} onChange={(event) => update('host', event.target.value)} inputProps={{ 'aria-label': t('SMTP 主机') }} placeholder="smtp.example.com" /></FormControl>
                  <FormControl><FormLabel>{t('端口')}</FormLabel><InputBase value={draft.port} onChange={(event) => update('port', event.target.value)} inputProps={{ 'aria-label': t('端口') }} inputMode="numeric" /></FormControl>
                </Box>
                <FormControl><FormLabel>{t('连接安全')}</FormLabel><Select value={draft.security} inputProps={{ 'aria-label': t('连接安全') }} onChange={(event) => update('security', event.target.value as NotificationSmtpSecurity)}>
                    <MenuItem value="starttls">STARTTLS</MenuItem><MenuItem value="tls">TLS</MenuItem><MenuItem value="none">{t('无加密')}</MenuItem>
                  </Select></FormControl>
                <Box className="grid gap-4 md:grid-cols-2">
                  <FormControl><FormLabel>{t('用户名（可选）')}</FormLabel><InputBase value={draft.username} onChange={(event) => update('username', event.target.value)} inputProps={{ 'aria-label': t('用户名（可选）') }} /></FormControl>
                  <FormControl><FormLabel>{t(draft.id === null ? '密码（可选）' : '新密码（留空则保留）')}</FormLabel><InputBase name={`notification_smtp_password_${draft.id ?? 'new'}`} type="password" value={draft.password} autoComplete="new-password" onChange={(event) => update('password', event.target.value)} inputProps={{ 'aria-label': t(draft.id === null ? '密码（可选）' : '新密码（留空则保留）') }} />{draft.id !== null ? <FormHelperText>{t(smtpUsernameChanged ? '用户名已更改；原密码不会沿用，请按需重新填写。' : draft.hasPassword ? '当前密码已配置；留空保留原值。' : '当前未配置密码。')}</FormHelperText> : null}</FormControl>
                </Box>
                <Box className="grid gap-4 md:grid-cols-2">
                  <FormControl><FormLabel>{t('发件人名称')}</FormLabel><InputBase value={draft.fromName} onChange={(event) => update('fromName', event.target.value)} inputProps={{ 'aria-label': t('发件人名称') }} /></FormControl>
                  <FormControl><FormLabel>{t('发件邮箱')}</FormLabel><InputBase type="email" value={draft.fromEmail} onChange={(event) => update('fromEmail', event.target.value)} inputProps={{ 'aria-label': t('发件邮箱') }} /></FormControl>
                </Box>
                <FormControl><FormLabel>{t('收件人')}</FormLabel><InputBase multiline minRows={3} value={draft.recipients} onChange={(event) => update('recipients', event.target.value)} inputProps={{ 'aria-label': t('收件人') }} placeholder={t('每行一个邮箱，也可使用逗号分隔')} /><FormHelperText>{t('支持 1–50 个收件人。')}</FormHelperText></FormControl>
              </> : <>
                <Box className="grid gap-4 md:grid-cols-2">
                  <FormControl><FormLabel>{t('消息格式')}</FormLabel><Select value={draft.webhookFormat} inputProps={{ 'aria-label': t('消息格式') }} onChange={(event) => {
                    const webhookFormat = event.target.value as NotificationWebhookFormat;
                    props.onChange({ ...draft, webhookFormat, signingSecret: webhookFormat === draft.webhookFormat ? draft.signingSecret : '' });
                  }}>
                      {(['generic', 'feishu', 'wecom', 'dingtalk', 'slack', 'discord'] as NotificationWebhookFormat[]).map((format) => <MenuItem key={format} value={format}>{t(webhookFormatLabel(format))}</MenuItem>)}
                    </Select><FormHelperText>{t(draft.webhookFormat === 'generic' ? '发送版本化 little-gate 事件 JSON。' : '发送该平台机器人可直接接收的文本消息。')}</FormHelperText></FormControl>
                  <FormControl><FormLabel>{t(draft.id === null ? 'Webhook 地址' : '新 Webhook 地址（留空则保留）')}</FormLabel><InputBase name={`notification_webhook_url_${draft.id ?? 'new'}`} type="url" value={draft.webhookUrl} autoComplete="off" onChange={(event) => update('webhookUrl', event.target.value)} inputProps={{ 'aria-label': t(draft.id === null ? 'Webhook 地址' : '新 Webhook 地址（留空则保留）') }} placeholder="https://example.com/hooks/little-gate" />{draft.id !== null ? <FormHelperText>{t('当前地址：{{url}}', { url: draft.webhookUrlMasked })}</FormHelperText> : null}</FormControl>
                </Box>
                {draft.webhookFormat === 'generic' ? <FormControl><FormLabel>{t(draft.id === null ? '签名密钥（留空自动生成）' : webhookFormatChanged ? '新签名密钥（至少 32 个字符）' : '新签名密钥（留空则保留）')}</FormLabel><InputBase name={`notification_webhook_secret_${draft.id ?? 'new'}`} type="password" value={draft.signingSecret} autoComplete="new-password" onChange={(event) => update('signingSecret', event.target.value)} inputProps={{ 'aria-label': t(draft.id === null ? '签名密钥（留空自动生成）' : webhookFormatChanged ? '新签名密钥（至少 32 个字符）' : '新签名密钥（留空则保留）') }} />{draft.id !== null ? <FormHelperText>{t(webhookFormatChanged ? '消息格式已更改；原签名密钥不会沿用，请重新填写。' : draft.hasSigningSecret ? '当前签名密钥已配置；留空保留原值。' : '当前未配置签名密钥。')}</FormHelperText> : null}<FormHelperText>{t('请求使用 X-Little-Gate-Signature: v1=<HMAC-SHA256>。')}</FormHelperText></FormControl> : null}
                {draft.webhookFormat === 'feishu' ? <FormControl><FormLabel>{t(draft.id === null || webhookFormatChanged ? '飞书签名密钥（可选）' : '新飞书签名密钥（留空则保留）')}</FormLabel><InputBase name={`notification_feishu_secret_${draft.id ?? 'new'}`} type="password" value={draft.signingSecret} autoComplete="new-password" onChange={(event) => update('signingSecret', event.target.value)} inputProps={{ 'aria-label': t(draft.id === null || webhookFormatChanged ? '飞书签名密钥（可选）' : '新飞书签名密钥（留空则保留）') }} />{draft.id !== null ? <FormHelperText>{t(webhookFormatChanged ? '消息格式已更改；原签名密钥不会沿用，请按需重新填写。' : draft.hasSigningSecret ? '当前签名密钥已配置；留空保留原值。' : '当前未配置签名密钥。')}</FormHelperText> : null}<FormHelperText>{t('仅在飞书机器人启用了签名校验时填写。')}</FormHelperText></FormControl> : null}
                <FormControl><FormLabel>{t('自定义请求头')}</FormLabel><InputBase name={`notification_webhook_headers_${draft.id ?? 'new'}`} multiline minRows={3} value={draft.headers} autoComplete="off" onChange={(event) => update('headers', event.target.value)} inputProps={{ 'aria-label': t('自定义请求头') }} placeholder={'X-Team: platform\nX-Environment: production'} /><FormHelperText>{t('每行使用“名称: 值”格式；签名和内容相关请求头不可覆盖。')}</FormHelperText>{draft.id !== null && draft.headers.trim() ? <FormHelperText>{t('已有请求头值不会回显；保留名称并将值留空可保留原值。')}</FormHelperText> : null}</FormControl>
              </>}
          </DialogContent>
          <DialogActions><Button type="button" variant="ghost" onClick={props.onClose} disabled={props.busy}>{t('取消')}</Button><Button type="submit" disabled={props.busy}>{props.busy ? <CircularProgress size={16} /> : <Check className="mr-1.5 size-3.5" />}{t('保存')}</Button></DialogActions>
        </Box> : null}
    </Dialog>;
}

function RuleDialog(props: {
  draft: RuleDraft | null;
  channels: NotificationChannel[];
  providers: Array<{ id: number; name: string }>;
  apiKeys: Array<{ id: number; name: string }>;
  busy: boolean;
  preview: number[];
  onChange: (draft: RuleDraft | null) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  onPreview: () => Promise<void>;
}) {
  const draft = props.draft;
  const update = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => {
    if (draft) props.onChange({ ...draft, [key]: value });
  };
  const scopeOptions = draft?.scopeKind === 'provider' ? props.providers : draft?.scopeKind === 'client_key' ? props.apiKeys : [];
  return <Dialog open={draft !== null} onClose={props.busy ? undefined : props.onClose} fullWidth maxWidth="md" aria-labelledby="rule-dialog-title">
      {draft ? <Box component="form" onSubmit={props.onSubmit}>
          <DialogTitle id="rule-dialog-title">{t(draft.id === null ? (draft.kind === 'scheduled_report' ? '添加定时报表' : '添加阈值告警') : '编辑通知规则')}</DialogTitle>
          <DialogContent className="grid gap-5 pt-2">
            {props.channels.length === 0 ? <Alert severity="warning">{t('请先创建至少一个通知通道。')}</Alert> : null}
            <Box className="grid gap-4 md:grid-cols-2">
              <FormControl><FormLabel>{t('规则名称')}</FormLabel><InputBase value={draft.name} onChange={(event) => update('name', event.target.value)} inputProps={{ 'aria-label': t('规则名称') }} autoFocus /></FormControl>
              <FormControl><FormLabel>{t('通知语言')}</FormLabel><Select value={draft.locale} inputProps={{ 'aria-label': t('通知语言') }} onChange={(event) => update('locale', event.target.value as NotificationLocale)}><MenuItem value="zh-CN">简体中文</MenuItem><MenuItem value="en-US">English</MenuItem></Select></FormControl>
            </Box>
            <FormControl><FormLabel>{t('投递通道')}</FormLabel><Select multiple value={draft.channelIds} inputProps={{ 'aria-label': t('投递通道') }} onChange={(event) => update('channelIds', event.target.value as number[])} renderValue={(selected) => selected.map((id) => props.channels.find((channel) => channel.id === id)?.name ?? `#${id}`).join(', ')}>
                {props.channels.map((channel) => <MenuItem key={channel.id} value={channel.id}><Checkbox checked={draft.channelIds.includes(channel.id)} />{channel.name}</MenuItem>)}
              </Select></FormControl>
            <FormControlLabel control={<Switch checked={draft.enabled} onChange={(event) => update('enabled', event.target.checked)} />} label={t('创建后立即启用')} />
            {draft.kind === 'scheduled_report' ? <>
                <Box className="grid gap-4 md:grid-cols-2">
                  <FormControl><FormLabel>{t('Cron（5 段）')}</FormLabel><InputBase value={draft.cron} onChange={(event) => update('cron', event.target.value)} inputProps={{ 'aria-label': t('Cron（5 段）') }} className="font-mono" /><FormHelperText>{t('分钟 小时 日期 月份 星期')}</FormHelperText></FormControl>
                  <FormControl><FormLabel>{t('IANA 时区')}</FormLabel><InputBase value={draft.timezone} onChange={(event) => update('timezone', event.target.value)} inputProps={{ 'aria-label': t('IANA 时区') }} /></FormControl>
                </Box>
                <Box className="grid gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
                  <FormControl><FormLabel>{t('邮件 Top N')}</FormLabel><InputBase value={draft.topN} onChange={(event) => update('topN', event.target.value)} inputProps={{ 'aria-label': t('邮件 Top N') }} inputMode="numeric" /><FormHelperText>{t('范围 5–100')}</FormHelperText></FormControl>
                  <Box className="flex flex-col justify-end gap-2"><Button type="button" variant="outline" onClick={() => void props.onPreview()}><CalendarClock className="mr-1.5 size-3.5" />{t('预览未来执行时间')}</Button>
                    {props.preview.length > 0 ? <Box className="grid gap-1 text-xs text-muted-foreground" aria-live="polite">{props.preview.map((value) => <Box key={value}>{formatDateTime(value)}</Box>)}</Box> : null}
                  </Box>
                </Box>
              </> : <>
                <Box className="grid gap-4 md:grid-cols-3">
                  <FormControl><FormLabel>{t('指标')}</FormLabel><Select value={draft.metric} inputProps={{ 'aria-label': t('指标') }} onChange={(event) => {
                    const metric = event.target.value as NotificationAlertMetric;
                    const serverMetric = metric === 'cpu_usage_percent' || metric === 'memory_usage_percent' || metric === 'unhealthy_provider_count';
                    props.onChange({ ...draft, metric, scopeKind: serverMetric ? 'global' : draft.scopeKind, scopeId: serverMetric ? '' : draft.scopeId });
                  }}>{METRICS.map((metric) => <MenuItem key={metric} value={metric}>{t(metricLabel(metric))}</MenuItem>)}</Select></FormControl>
                  <FormControl><FormLabel>{t('运算符')}</FormLabel><Select value={draft.operator} inputProps={{ 'aria-label': t('运算符') }} onChange={(event) => update('operator', event.target.value as NotificationAlertOperator)}>{OPERATORS.map((operator) => <MenuItem key={operator} value={operator}>{operatorLabel(operator)}</MenuItem>)}</Select></FormControl>
                  <FormControl><FormLabel>{t('阈值')}</FormLabel><InputBase value={draft.threshold} onChange={(event) => update('threshold', event.target.value)} inputProps={{ 'aria-label': t('阈值') }} inputMode="decimal" /></FormControl>
                </Box>
                <Box className="grid gap-4 md:grid-cols-2">
                  <FormControl><FormLabel>{t('统计范围')}</FormLabel><Select value={draft.scopeKind} inputProps={{ 'aria-label': t('统计范围') }} disabled={draft.metric === 'cpu_usage_percent' || draft.metric === 'memory_usage_percent' || draft.metric === 'unhealthy_provider_count'} onChange={(event) => props.onChange({ ...draft, scopeKind: event.target.value as NotificationAlertScope, scopeId: '' })}><MenuItem value="global">{t('全局')}</MenuItem><MenuItem value="provider">{t('上游 Provider')}</MenuItem><MenuItem value="client_key">{t('客户端访问 Key')}</MenuItem></Select></FormControl>
                  {draft.scopeKind !== 'global' ? <FormControl><FormLabel>{t('范围对象')}</FormLabel><Select value={draft.scopeId} inputProps={{ 'aria-label': t('范围对象') }} onChange={(event) => update('scopeId', String(event.target.value))}>{scopeOptions.map((option) => <MenuItem key={option.id} value={String(option.id)}>{option.name}</MenuItem>)}</Select></FormControl> : <Box />}
                </Box>
                <Box className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <NumberField label="统计窗口（分钟）" value={draft.windowMinutes} onChange={(value) => update('windowMinutes', value)} />
                  <NumberField label="最少请求数" value={draft.minimumRequests} onChange={(value) => update('minimumRequests', value)} />
                  <NumberField label="连续触发次数" value={draft.triggerAfter} onChange={(value) => update('triggerAfter', value)} />
                  <NumberField label="连续恢复次数" value={draft.recoverAfter} onChange={(value) => update('recoverAfter', value)} />
                  <NumberField label="提醒冷却（分钟）" value={draft.cooldownMinutes} onChange={(value) => update('cooldownMinutes', value)} />
                  <FormControlLabel control={<Checkbox checked={draft.sendRecovery} onChange={(event) => update('sendRecovery', event.target.checked)} />} label={t('发送恢复通知')} />
                </Box>
              </>}
          </DialogContent>
          <DialogActions><Button type="button" variant="ghost" onClick={props.onClose} disabled={props.busy}>{t('取消')}</Button><Button type="submit" disabled={props.busy || props.channels.length === 0}>{props.busy ? <CircularProgress size={16} /> : <Check className="mr-1.5 size-3.5" />}{t('保存')}</Button></DialogActions>
        </Box> : null}
    </Dialog>;
}

function NumberField(props: { label: string; value: string; onChange: (value: string) => void }) {
  return <FormControl><FormLabel>{t(props.label)}</FormLabel><InputBase value={props.value} onChange={(event) => props.onChange(event.target.value)} inputProps={{ 'aria-label': t(props.label) }} inputMode="numeric" /></FormControl>;
}
