import { Link, useSearchParams } from 'react-router';
import { UpstreamKeyModels } from './UpstreamKeyModels';
import { routingAvailabilityLabel } from '@/lib/routingAvailability';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, ArrowDown, AlertCircle, Check, ChevronRight, Copy, GripVertical, Plus, RefreshCw, Save, ShieldCheck, Stethoscope, Trash2 } from "lucide-react";
import { ConfirmAction } from '@/components/console/ConfirmAction';
import { RecoveryNotice } from '@/components/console/RecoveryNotice';
import { DetailDrawer } from '@/components/console/DetailDrawer';
import { EmptyState } from '@/components/console/EmptyState';
import { PageHeader } from '@/components/console/PageHeader';
import { StatsGrid, type StatItem } from '@/components/console/StatsGrid';
import { StatusBadge } from '@/components/console/StatusBadge';
import {
  RequestOverridesEditor,
  createRequestOverridesDraft,
  parseRequestOverridesDraft,
  type RequestOverridesDraft,
} from '@/components/console/RequestOverridesEditor';
import { CodexOAuthLoginDialog, CodexOAuthPanel } from '@/components/CodexOAuthPanel';
import { useI18n } from '@/lib/i18n';
import { createEndpoint, createProvider, createProviderGroup, createProviderKey, deleteEndpoint, deleteProvider, deleteProviderGroup, deleteProviderKey, resetProviderCircuit, reorderProviderChildren, syncProviderModels, testEndpointConnection, updateEndpoint, updateProvider, updateProviderGroup, updateProviderKey } from '../lib/api';
import { formatDateTime, formatMs } from '../lib/format';
import type { ConnectionSettings, CreateEndpointInput, CreateProviderInput, CreateProviderKeyInput, ProviderGroup, ProviderWorkspace, UpstreamEndpointSummary, UpstreamKeyMeta, UpdateEndpointInput, UpdateProviderInput, UpdateProviderKeyInput } from '../lib/types';
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormHelperText from "@mui/material/FormHelperText";
import FormLabel from "@mui/material/FormLabel";
import InputBase from "@mui/material/InputBase";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TableContainer from "@/components/console/ScrollableTable";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
interface ProvidersPageProps {
  loading?: boolean;
  settings: ConnectionSettings;
  items: ProviderWorkspace[];
  groups?: ProviderGroup[];
  onRefresh: (successMessage?: string) => Promise<void>;
  onMessage: (message: string) => void;
}
interface DraftInputRow {
  id: string;
  value: string;
}
type ProviderCreateStage = 'editing' | 'provider' | 'models' | 'sync_failed' | 'complete';
interface CreatedProviderResources {
  providerId: number;
  endpointIds: number[];
  keyIds: number[];
}
const MAX_PROVIDER_ROUTING_VALUE = 2_147_483_647;
const NON_NEGATIVE_INTEGER_PATTERN = /^\d+$/;
let draftInputSeq = 0;
function createDraftInputRow(prefix: string): DraftInputRow {
  draftInputSeq += 1;
  return {
    id: `${prefix}-${draftInputSeq}`,
    value: ''
  };
}
function readString(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim();
}
function readInt(formData: FormData, key: string, fallback: number): number {
  const raw = String(formData.get(key) ?? '').trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function readBool(formData: FormData, key: string): boolean {
  return formData.get(key) === 'on';
}
function parseProviderRoutingValue(raw: string, minimum: number): number | null {
  const value = raw.trim();
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > MAX_PROVIDER_ROUTING_VALUE) return null;
  return parsed;
}
function healthStatus(state?: string, available?: boolean) {
  if (!available || state === 'open') return {
    label: '异常',
    tone: 'error' as const
  };
  if (state === 'half_open') return {
    label: '警告',
    tone: 'warning' as const
  };
  return {
    label: '正常',
    tone: 'normal' as const
  };
}
function priorityForIndex(index: number) {
  return 100 + index * 10;
}
const PROVIDER_TYPE_OPTIONS = [{
  value: 'openai',
  label: 'OpenAI',
  description: '官方 OpenAI 服务'
}, {
  value: 'openai_codex_oauth',
  label: 'OpenAI Codex OAuth',
  description: '通过 OAuth 登录连接 ChatGPT Codex，仅支持 Responses 协议'
}, {
  value: 'openai_compatible',
  label: 'OpenAI Compatible',
  description: '兼容 OpenAI 协议的第三方或自建服务'
}, {
  value: 'openai_compatible_responses',
  label: 'OpenAI Compatible (Responses)',
  description: '仅用于响应式接口的兼容服务'
}] as const;
const CODEX_PROVIDER_TYPE = 'openai_codex_oauth';
const CODEX_DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const BETA_FEATURE_RESPONSES_HTTP_TO_WS = 'responses-http-to-ws';
function providerHasBetaFeature(item: ProviderWorkspace, feature: string) {
  return item.provider.beta_features?.includes(feature) ?? false;
}
export function ProvidersPage(props: ProvidersPageProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const showProviderTable = useMediaQuery(theme.breakpoints.up('sm'));
  const providerGroups = props.groups ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [removeAction, setRemoveAction] = useState<{ title: string; run: () => Promise<void> } | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createPriority, setCreatePriority] = useState('100');
  const [createWeight, setCreateWeight] = useState('1');
  const [createGroupIds, setCreateGroupIds] = useState<number[]>([]);
  const [createBaseUrls, setCreateBaseUrls] = useState<DraftInputRow[]>([createDraftInputRow('url')]);
  const [createApiKeys, setCreateApiKeys] = useState<DraftInputRow[]>([createDraftInputRow('key')]);
  const [createSubmitError, setCreateSubmitError] = useState<string | null>(null);
  const [createStage, setCreateStage] = useState<ProviderCreateStage>('editing');
  const [createResources, setCreateResources] = useState<CreatedProviderResources | null>(null);
  const [createSyncedCount, setCreateSyncedCount] = useState<number | null>(null);
  const [createFormVersion, setCreateFormVersion] = useState(0);
  const [createOverridesDraft, setCreateOverridesDraft] = useState<RequestOverridesDraft>(
    () => createRequestOverridesDraft(),
  );
  const [createdCodexLogin, setCreatedCodexLogin] = useState<{
    providerId: number;
    attemptId: number;
  } | null>(null);
  const createdCodexLoginSequenceRef = useRef(0);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedProviderId = searchParams.has('provider_id') ? Number(searchParams.get('provider_id')) : null;
  const setSelectedProviderId = (id: number | null) => setSearchParams(current => {
    const next = new URLSearchParams(current);
    if (id === null) next.delete('provider_id');
    else next.set('provider_id', String(id));
    return next;
  }, { replace: id === null });
  const [providerTypeDraft, setProviderTypeDraft] = useState('');
  const [providerPriorityDraft, setProviderPriorityDraft] = useState('');
  const [providerWeightDraft, setProviderWeightDraft] = useState('');
  const [providerGroupPriorities, setProviderGroupPriorities] = useState<Record<number, string>>({});
  const [providerRequestOverridesDraft, setProviderRequestOverridesDraft] = useState<RequestOverridesDraft>(
    () => createRequestOverridesDraft(),
  );
  const [providerSubmitError, setProviderSubmitError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteProviderError, setDeleteProviderError] = useState<string | null>(null);
  const deleteCancelButtonRef = useRef<HTMLButtonElement>(null);
  const [draggingEndpointId, setDraggingEndpointId] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    status: number | null;
    url: string;
    message: string | null;
  } | null>(null);
  const selected = props.items.find(item => item.provider.id === selectedProviderId) ?? null;
  const [createProviderType, setCreateProviderType] = useState<string>('openai');
  const isCreateCodex = createProviderType === CODEX_PROVIDER_TYPE;
  const createPriorityValue = parseProviderRoutingValue(createPriority, 0);
  const createWeightValue = parseProviderRoutingValue(createWeight, 1);
  const providerPriorityValue = parseProviderRoutingValue(providerPriorityDraft, 0);
  const providerWeightValue = parseProviderRoutingValue(providerWeightDraft, 1);
  const ensureLive = () => {
    if (!props.settings.adminToken.trim()) {
      props.onMessage('请先填写管理员口令。');
      return false;
    }
    return true;
  };
  const isLive = () => Boolean(props.settings.adminToken.trim());
  const resetCreateForm = () => {
    setCreateProviderType('openai');
    setCreateName('');
    setCreatePriority('100');
    setCreateWeight('1');
    setCreateGroupIds(providerGroups.filter(group => group.is_default).map(group => group.id));
    setCreateBaseUrls([createDraftInputRow('url')]);
    setCreateApiKeys([createDraftInputRow('key')]);
    setCreateOverridesDraft(createRequestOverridesDraft());
    setCreateSubmitError(null);
    setCreateStage('editing');
    setCreateResources(null);
    setCreateSyncedCount(null);
    setCreateFormVersion(version => version + 1);
  };
  const createBaseUrlValues = () => createBaseUrls.map(row => row.value.trim()).filter(Boolean);
  const createApiKeyValues = () => createApiKeys.map(row => row.value.trim()).filter(Boolean);
  const updateCreateBaseUrl = (rowId: string, value: string) => {
    setCreateBaseUrls(rows => rows.map(row => row.id === rowId ? {
      ...row,
      value
    } : row));
    setCreateSubmitError(null);
  };
  const updateCreateApiKey = (rowId: string, value: string) => {
    setCreateApiKeys(rows => rows.map(row => row.id === rowId ? {
      ...row,
      value
    } : row));
    setCreateSubmitError(null);
  };
  const updateCreateProviderType = (providerType: string) => {
    setCreateProviderType(providerType);
    if (providerType === CODEX_PROVIDER_TYPE) {
      setCreateBaseUrls([{
        id: createDraftInputRow('url').id,
        value: CODEX_DEFAULT_BASE_URL,
      }]);
      setCreateApiKeys([createDraftInputRow('key')]);
    }
    setCreateSubmitError(null);
  };
  const addCreateBaseUrl = () => setCreateBaseUrls(rows => [...rows, createDraftInputRow('url')]);
  const addCreateApiKey = () => setCreateApiKeys(rows => [...rows, createDraftInputRow('key')]);
  const removeCreateBaseUrl = (rowId: string) => {
    setCreateBaseUrls(rows => rows.length > 1 ? rows.filter(row => row.id !== rowId) : rows.map(row => ({
      ...row,
      value: ''
    })));
    setCreateSubmitError(null);
  };
  const removeCreateApiKey = (rowId: string) => {
    setCreateApiKeys(rows => rows.length > 1 ? rows.filter(row => row.id !== rowId) : rows.map(row => ({
      ...row,
      value: ''
    })));
    setCreateSubmitError(null);
  };
  const createMissingFields = () => {
    if (!isLive()) {
      return ['连接后台'];
    }
    const missing: string[] = [];
    if (!createName.trim()) {
      missing.push('名称');
    }
    if (createBaseUrlValues().length === 0) {
      missing.push('服务地址');
    }
    if (!isCreateCodex && createApiKeyValues().length === 0) {
      missing.push('API 密钥');
    }
    if (createPriorityValue === null) {
      missing.push('优先级');
    }
    if (createWeightValue === null) {
      missing.push('权重');
    }
    if (providerGroups.length > 0 && createGroupIds.length === 0) {
      missing.push('调度组');
    }
    return missing;
  };
  const createFormHint = () => {
    if (!isLive()) {
      return t('请先连接后台。');
    }
    if (createStage === 'complete') {
      return t('模型同步完成，可以关闭并查看上游详情。');
    }
    if (createStage === 'sync_failed') {
      return t('配置已完整保存。可重试同步，或完成后在详情中修改连接信息。');
    }
    if (createStage === 'provider') {
      return t('正在创建上游基本配置…');
    }
    if (createStage === 'models') {
      return t('正在从上游同步模型…');
    }
    if (createMissingFields().length === 0) {
      return t(isCreateCodex
        ? '将创建上游和默认服务地址，然后启动 OpenAI OAuth 登录。'
        : '将创建上游、保存连接信息并同步模型。');
    }
    return t('请先填写：{{fields}}。', {
      fields: createMissingFields().map(field => t(field)).join(', ')
    });
  };
  const createIsBusy = ['provider', 'connections', 'models'].includes(createStage);
  const createIsPersisted = createResources !== null;
  const createFieldsDisabled = createIsBusy || createIsPersisted;
  const [selectedUpstreamKeyId, setSelectedUpstreamKeyId] = useState<number | null>(null);
  const providerTypeDescription = (value: string) => PROVIDER_TYPE_OPTIONS.find(option => option.value === value)?.description ?? '—';
  const stats = (): StatItem[] => {
    const totalEndpoints = props.items.reduce((sum, item) => sum + item.endpoints.length, 0);
    const unhealthy = props.items.filter(item => !item.provider.routing_availability?.available).length;
    const degraded = props.items.filter(item => item.provider.health?.state === 'half_open').length;
    const healthy = props.items.filter(item => item.provider.routing_availability?.available).length;
    return [{
      label: '上游总数',
      value: String(props.items.length),
      hint: '已配置的连接目标'
    }, {
      label: '健康',
      value: String(healthy),
      hint: t('{{count}} 警告', {
        count: degraded
      }),
      tone: healthy > 0 ? 'success' : 'default' as const
    }, {
      label: '异常',
      value: String(unhealthy),
      hint: '优先检查这些目标',
      tone: unhealthy > 0 ? 'warning' : 'success' as const
    }, {
      label: '节点数',
      value: String(totalEndpoints),
      hint: '全部节点'
    }];
  };
  const providerPayloadFromForm = (formData: FormData): CreateProviderInput | null => {
    if (createPriorityValue === null || createWeightValue === null) {
      const message = createPriorityValue === null
        ? '优先级必须是 0 到 2147483647 之间的整数。'
        : '权重必须是 1 到 2147483647 之间的整数。';
      setCreateSubmitError(message);
      props.onMessage(message);
      return null;
    }
    const parsedRequestOverrides = parseRequestOverridesDraft(createOverridesDraft);
    if (!parsedRequestOverrides.ok) {
      setCreateSubmitError(parsedRequestOverrides.error);
      props.onMessage(parsedRequestOverrides.error);
      return null;
    }
    return {
      name: createName.trim(),
      provider_type: createProviderType || readString(formData, 'provider_type') || 'openai',
      enabled: readBool(formData, 'enabled'),
      priority: createPriorityValue,
      weight: createWeightValue,
      supports_include_usage: readBool(formData, 'supports_include_usage'),
      websocket_enabled: isCreateCodex || readBool(formData, 'websocket_enabled'),
      beta_features: isCreateCodex || readBool(formData, 'responses_http_to_ws')
        ? [BETA_FEATURE_RESPONSES_HTTP_TO_WS]
        : [],
      request_overrides: parsedRequestOverrides.value,
      key_selection_strategy: 'round_robin',
      groups: createGroupIds.length > 0
        ? createGroupIds.map(groupId => ({
            group_id: groupId,
            priority_override: null
          }))
        : undefined,
      max_attempts: 2,
      max_concurrency: null,
      circuit_breaker_enabled: true,
      circuit_breaker_failure_threshold: 3,
      circuit_breaker_open_ms: 30_000,
      circuit_breaker_half_open_success_threshold: 2
    };
  };
  const syncCreatedProvider = async (resources: CreatedProviderResources, providerName: string) => {
    setCreateStage('models');
    setCreateSubmitError(null);
    try {
      const models = await syncProviderModels(props.settings, resources.providerId);
      setCreateSyncedCount(models.length);
      setCreateStage('complete');
      props.onMessage(t('上游 {{name}} 已创建并同步 {{count}} 个模型。', {
        name: providerName,
        count: models.length
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : '同步模型失败。';
      setCreateStage('sync_failed');
      setCreateSubmitError(message);
      props.onMessage(message);
    }
  };
  const submitProviderCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ensureLive()) return;
    const formData = new FormData(event.currentTarget);
    const payload = providerPayloadFromForm(formData);
    if (!payload) return;
    setCreateSubmitError(null);
    if (!payload.name) {
      const message = '上游名称不能为空。';
      setCreateSubmitError(message);
      props.onMessage(message);
      return;
    }
    const baseUrls = createBaseUrlValues();
    if (baseUrls.length === 0) {
      const message = '服务地址不能为空。';
      setCreateSubmitError(message);
      props.onMessage(message);
      return;
    }
    const apiKeys = createApiKeyValues();
    if (!isCreateCodex && apiKeys.length === 0) {
      const message = 'API 密钥不能为空。';
      setCreateSubmitError(message);
      props.onMessage(message);
      return;
    }
    if (createResources) {
      await syncCreatedProvider(createResources, payload.name);
      return;
    }
    setCreateStage('provider');
    try {
      const created = await createProvider(props.settings, {
        ...payload,
        endpoints: baseUrls.map((base_url, index) => ({ name: `地址 ${index + 1}`, base_url, enabled: true, priority: priorityForIndex(index), weight: 1 })),
        keys: (isCreateCodex ? [] : apiKeys).map((secret, index) => ({ name: `密钥 ${index + 1}`, secret, enabled: true, priority: priorityForIndex(index), weight: 1 })),
      });
      const providerId = created.id;
      const resources = { providerId, endpointIds: created.endpoint_ids, keyIds: created.key_ids };
      setCreateBaseUrls(baseUrls.map(value => ({ id: createDraftInputRow('url').id, value })));
      setCreateApiKeys(apiKeys.map(value => ({ id: createDraftInputRow('key').id, value })));
      setCreateResources(resources);
      if (isCreateCodex) {
        const providerName = payload.name;
        setCreateStage('complete');
        setCreateOpen(false);
        resetCreateForm();
        try {
          await props.onRefresh(t('上游 {{name}} 已创建，请完成 Codex OAuth 登录。', {
            name: providerName,
          }));
        } finally {
          setSelectedProviderId(providerId);
          createdCodexLoginSequenceRef.current += 1;
          setCreatedCodexLogin({
            providerId,
            attemptId: createdCodexLoginSequenceRef.current,
          });
        }
        return;
      }
      await syncCreatedProvider(resources, payload.name);
    } catch (error) {
      console.error('Failed to create provider', error);
      const message = error instanceof Error ? error.message : '创建上游失败。';
      setCreateStage('editing');
      setCreateSubmitError(message);
      props.onMessage(message);
    }
  };
  const finishProviderCreate = async () => {
    const resources = createResources;
    const stage = createStage;
    const name = createName.trim();
    setCreateOpen(false);
    resetCreateForm();
    if (!resources) return;
    await props.onRefresh(stage === 'complete'
      ? t('上游 {{name}} 已创建并完成模型同步。', { name })
      : t('上游 {{name}} 已创建，模型可稍后继续同步。', { name }));
    setSelectedProviderId(resources.providerId);
  };
  const submitProviderUpdate = async (event: FormEvent<HTMLFormElement>, item: ProviderWorkspace) => {
    event.preventDefault();
    if (!ensureLive()) return;
    if (providerPriorityValue === null || providerWeightValue === null) {
      const message = providerPriorityValue === null
        ? '优先级必须是 0 到 2147483647 之间的整数。'
        : '权重必须是 1 到 2147483647 之间的整数。';
      setProviderSubmitError(message);
      props.onMessage(message);
      return;
    }
    const formData = new FormData(event.currentTarget);
    const groups = Object.entries(providerGroupPriorities).map(([groupId, rawPriority]) => {
      const trimmed = rawPriority.trim();
      return {
        group_id: Number(groupId),
        priority_override: trimmed ? parseProviderRoutingValue(trimmed, 0) : null
      };
    });
    if ((providerGroups.length > 0 && groups.length === 0) || groups.some(group => group.priority_override === null
      && providerGroupPriorities[group.group_id]?.trim())) {
      const message = groups.length === 0
        ? '请至少选择一个调度组。'
        : '分组优先级覆盖必须是非负整数。';
      setProviderSubmitError(message);
      props.onMessage(message);
      return;
    }
    const maxConcurrencyRaw = readString(formData, 'provider_max_concurrency');
    const parsedRequestOverrides = parseRequestOverridesDraft(providerRequestOverridesDraft);
    if (!parsedRequestOverrides.ok) {
      setProviderSubmitError(parsedRequestOverrides.error);
      props.onMessage(parsedRequestOverrides.error);
      return;
    }
    const payload: UpdateProviderInput = {
      name: readString(formData, 'provider_name'),
      provider_type: readString(formData, 'provider_type') || item.provider.provider_type,
      enabled: readBool(formData, 'provider_enabled'),
      priority: providerPriorityValue,
      weight: providerWeightValue,
      supports_include_usage: readBool(formData, 'supports_include_usage'),
      websocket_enabled: readBool(formData, 'provider_websocket_enabled'),
      beta_features: readBool(formData, 'provider_responses_http_to_ws') ? [BETA_FEATURE_RESPONSES_HTTP_TO_WS] : [],
      request_overrides: parsedRequestOverrides.value,
      groups: providerGroups.length > 0 ? groups : undefined,
      max_attempts: readInt(formData, 'provider_max_attempts', item.provider.max_attempts),
      max_concurrency: maxConcurrencyRaw
        ? readInt(formData, 'provider_max_concurrency', item.provider.max_concurrency ?? 1)
        : null,
      circuit_breaker_enabled: readBool(formData, 'provider_circuit_breaker_enabled'),
      circuit_breaker_failure_threshold: readInt(
        formData,
        'provider_circuit_breaker_failure_threshold',
        item.provider.circuit_breaker_failure_threshold,
      ),
      circuit_breaker_open_ms: Math.round(Number(formData.get('provider_circuit_breaker_open_seconds') ?? item.provider.circuit_breaker_open_ms / 1000) * 1000),
      circuit_breaker_half_open_success_threshold: readInt(
        formData,
        'provider_circuit_breaker_half_open_success_threshold',
        item.provider.circuit_breaker_half_open_success_threshold,
      )
    };
    setProviderSubmitError(null);
    setBusy(`provider-${item.provider.id}`);
    try {
      await updateProvider(props.settings, item.provider.id, payload);
      await props.onRefresh(t('上游 {{name}} 已更新。', {
        name: payload.name ?? item.provider.name
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : '更新上游失败。';
      setProviderSubmitError(message);
      props.onMessage(message);
    } finally {
      setBusy(null);
    }
  };
  const closeDeleteProviderDialog = () => {
    if (selected && busy === `provider-delete-${selected.provider.id}`) return;
    setDeleteConfirmOpen(false);
    setDeleteProviderError(null);
  };
  const removeProvider = async (item: ProviderWorkspace) => {
    if (!ensureLive()) return;
    const providerName = item.provider.name;
    setBusy(`provider-delete-${item.provider.id}`);
    setDeleteProviderError(null);
    try {
      await deleteProvider(props.settings, item.provider.id);
      setDeleteConfirmOpen(false);
      setSelectedProviderId(null);
      setTestResult(null);
      await props.onRefresh(t('上游 {{name}} 已删除。', {
        name: providerName
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除上游失败。';
      setDeleteProviderError(message);
      props.onMessage(message);
    } finally {
      setBusy(null);
    }
  };
  const submitEndpointCreate = async (event: FormEvent<HTMLFormElement>, item: ProviderWorkspace) => {
    event.preventDefault();
    if (!ensureLive()) return;
    const formData = new FormData(event.currentTarget);
    const nextIndex = item.endpoints.length;
    const payload: CreateEndpointInput = {
      name: readString(formData, 'endpoint_name') || `地址 ${nextIndex + 1}`,
      base_url: readString(formData, 'endpoint_base_url'),
      enabled: readBool(formData, 'endpoint_enabled'),
      priority: priorityForIndex(nextIndex),
      weight: 1
    };
    if (!payload.base_url) {
      props.onMessage('服务地址不能为空。');
      return;
    }
    setConnectionError(null);
    setBusy(`endpoint-create-${item.provider.id}`);
    try {
      await createEndpoint(props.settings, item.provider.id, payload);
      await props.onRefresh(t('目标 {{name}} 已创建。', {
        name: payload.name
      }));
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : '创建目标失败。');
    } finally {
      setBusy(null);
    }
  };
  const submitEndpointUpdate = async (event: FormEvent<HTMLFormElement>, endpointId: number) => {
    event.preventDefault();
    if (!ensureLive()) return;
    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const current = selected?.endpoints.find(endpoint => endpoint.id === endpointId);
    const payload: UpdateEndpointInput = {
      name: readString(formData, `endpoint_name_${endpointId}`) || current?.name || '地址',
      base_url: readString(formData, `endpoint_base_url_${endpointId}`),
      enabled: readBool(formData, `endpoint_enabled_${endpointId}`),
      priority: current?.priority ?? 100,
      weight: current?.weight ?? 1
    };
    setConnectionError(null);
    setBusy(`endpoint-${endpointId}`);
    try {
      await updateEndpoint(props.settings, endpointId, payload);
      await props.onRefresh(t('目标 {{name}} 已更新。', {
        name: payload.name ?? ''
      }));
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : '更新目标失败。');
    } finally {
      setBusy(null);
    }
  };
  const submitKeyCreate = async (event: FormEvent<HTMLFormElement>, item: ProviderWorkspace) => {
    event.preventDefault();
    if (!ensureLive()) return;
    const formData = new FormData(event.currentTarget);
    const nextIndex = item.keys.length;
    const payload: CreateProviderKeyInput = {
      name: readString(formData, 'upstream_key_name') || `密钥 ${nextIndex + 1}`,
      secret: readString(formData, 'upstream_key_secret'),
      enabled: readBool(formData, 'upstream_key_enabled'),
      priority: priorityForIndex(nextIndex),
      weight: 1
    };
    if (!payload.secret) {
      props.onMessage('API 密钥不能为空。');
      return;
    }
    setConnectionError(null);
    setBusy(`key-create-${item.provider.id}`);
    try {
      await createProviderKey(props.settings, item.provider.id, payload);
      await props.onRefresh(t('上游密钥 {{name}} 已创建。', {
        name: payload.name
      }));
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : '创建上游密钥失败。');
    } finally {
      setBusy(null);
    }
  };
  const submitKeyUpdate = async (event: FormEvent<HTMLFormElement>, keyId: number) => {
    event.preventDefault();
    if (!ensureLive()) return;
    const formData = new FormData(event.currentTarget);
    const current = selected?.keys.find(key => key.id === keyId);
    const payload: UpdateProviderKeyInput = {
      name: readString(formData, `upstream_key_name_${keyId}`) || current?.name || '密钥',
      secret: readString(formData, `upstream_key_secret_${keyId}`) || undefined,
      enabled: readBool(formData, `upstream_key_enabled_${keyId}`),
      priority: current?.priority ?? 100,
      weight: current?.weight ?? 1
    };
    setConnectionError(null);
    setBusy(`key-${keyId}`);
    try {
      await updateProviderKey(props.settings, keyId, payload);
      await props.onRefresh(t('上游密钥 {{name}} 已更新。', {
        name: payload.name ?? ''
      }));
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : '更新上游密钥失败。');
    } finally {
      setBusy(null);
    }
  };
  const reorderEndpoints = async (item: ProviderWorkspace, targetId: number, movingId = draggingEndpointId) => {
    const sourceId = movingId;
    setDraggingEndpointId(null);
    if (sourceId === null || sourceId === targetId || !ensureLive()) return;
    const sourceIndex = item.endpoints.findIndex(endpoint => endpoint.id === sourceId);
    const targetIndex = item.endpoints.findIndex(endpoint => endpoint.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const next = [...item.endpoints];
    const [source] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, source);
    setBusy(`endpoint-reorder-${item.provider.id}`);
    try {
      await reorderProviderChildren(props.settings, item.provider.id, 'endpoints', next.map(endpoint => endpoint.id));
      await props.onRefresh('服务地址顺序已更新。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新服务地址顺序失败。');
    } finally {
      setBusy(null);
    }
  };
  const reorderKeys = async (item: ProviderWorkspace, targetId: number, movingId: number) => {
    if (item.provider.key_selection_strategy !== 'ordered') return;
    const sourceId = movingId;
    if (sourceId === null || sourceId === targetId || !ensureLive()) return;
    const sourceIndex = item.keys.findIndex(key => key.id === sourceId);
    const targetIndex = item.keys.findIndex(key => key.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const next = [...item.keys];
    const [source] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, source);
    setBusy(`key-reorder-${item.provider.id}`);
    try {
      await reorderProviderChildren(props.settings, item.provider.id, 'keys', next.map(key => key.id));
      await props.onRefresh('API 密钥顺序已更新。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新 API 密钥顺序失败。');
    } finally {
      setBusy(null);
    }
  };
  const removeEndpoint = async (endpoint: UpstreamEndpointSummary) => {
    if (!ensureLive()) return;
    setBusy(`endpoint-delete-${endpoint.id}`);
    try {
      await deleteEndpoint(props.settings, endpoint.id);
      setRemoveAction(null);
      await props.onRefresh('服务地址已删除。');
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : '删除服务地址失败。');
    } finally {
      setBusy(null);
    }
  };
  const removeProviderKey = async (key: UpstreamKeyMeta) => {
    if (!ensureLive()) return;
    setBusy(`key-delete-${key.id}`);
    try {
      await deleteProviderKey(props.settings, key.id);
      setRemoveAction(null);
      await props.onRefresh('API 密钥已删除。');
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : '删除 API 密钥失败。');
    } finally {
      setBusy(null);
    }
  };
  const handleTestEndpoint = async (endpointId: number) => {
    if (!ensureLive()) return;
    setBusy(`test-${endpointId}`);
    try {
      const result = await testEndpointConnection(props.settings, endpointId);
      setTestResult(result);
      props.onMessage(result.ok ? '地址可达；请同步模型验证认证信息。' : '地址不可达。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '连接测试失败。');
    } finally {
      setBusy(null);
    }
  };
  const copyValue = async (label: string, value: string) => {
    if (!navigator?.clipboard) {
      props.onMessage('当前环境不支持剪贴板。');
      return;
    }
    await navigator.clipboard.writeText(value);
    props.onMessage(t('{{label}} 已复制。', {
      label: t(label)
    }));
  };
  useEffect(() => {
    setSelectedUpstreamKeyId(null);
    setConnectionError(null);
    setProviderTypeDraft('');
    setProviderPriorityDraft(selected ? String(selected.provider.priority) : '');
    setProviderWeightDraft(selected ? String(selected.provider.weight) : '');
    setProviderGroupPriorities(selected
      ? Object.fromEntries(selected.provider.groups.map(group => [
          group.group_id,
          group.priority_override === null ? '' : String(group.priority_override)
        ]))
      : {});
    setProviderRequestOverridesDraft(
      createRequestOverridesDraft(selected?.provider.request_overrides),
    );
    setProviderSubmitError(null);
    setDeleteConfirmOpen(false);
    setDeleteProviderError(null);
  }, [selectedProviderId, selected?.provider.id]);
  useEffect(() => {
    const item = selected;
    if (!item) return;
    setProviderTypeDraft(item.provider.provider_type);
  }, [selectedProviderId, selected?.provider.provider_type]);
  useEffect(() => {
    const item = selected;
    if (!item) return;
    const keys = item.keys;
    if (keys.length === 0) {
      setSelectedUpstreamKeyId(null);
      return;
    }
    const current = selectedUpstreamKeyId;
    if (current !== null && keys.some(key => key.id === current)) {
      return;
    }
    setSelectedUpstreamKeyId(keys[0].id);
  }, [selectedProviderId, selected?.keys, selectedUpstreamKeyId]);
  const submitGroupCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ensureLive()) return;
    const form = event.currentTarget;
    const name = readString(new FormData(form), 'provider_group_name');
    if (!name) {
      props.onMessage('调度组名称不能为空。');
      return;
    }
    setBusy('provider-group-create');
    try {
      await createProviderGroup(props.settings, name);
      form.reset();
      await props.onRefresh(`调度组 ${name} 已创建。`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '创建调度组失败。');
    } finally {
      setBusy(null);
    }
  };
  const saveGroup = async (event: FormEvent<HTMLFormElement>, group: ProviderGroup) => {
    event.preventDefault();
    if (!ensureLive() || group.is_default) return;
    const name = readString(new FormData(event.currentTarget), `provider_group_name_${group.id}`);
    if (!name) {
      props.onMessage('调度组名称不能为空。');
      return;
    }
    setBusy(`provider-group-${group.id}`);
    try {
      await updateProviderGroup(props.settings, group.id, name);
      await props.onRefresh(`调度组 ${name} 已更新。`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新调度组失败。');
    } finally {
      setBusy(null);
    }
  };
  const removeGroup = async (group: ProviderGroup) => {
    if (!ensureLive() || group.is_default) return;
    setBusy(`provider-group-${group.id}`);
    try {
      await deleteProviderGroup(props.settings, group.id);
      setRemoveAction(null);
      await props.onRefresh(`调度组 ${group.name} 已删除。`);
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : '删除调度组失败。');
    } finally {
      setBusy(null);
    }
  };
  const resetCircuit = async (providerId: number) => {
    if (!ensureLive()) return;
    setBusy(`provider-circuit-${providerId}`);
    try {
      await resetProviderCircuit(props.settings, providerId);
      await props.onRefresh('上游熔断状态已重置。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '重置熔断失败。');
    } finally {
      setBusy(null);
    }
  };
  const syncModelsForProvider = async (providerId: number, providerName: string) => {
    if (!ensureLive()) return;
    setBusy(`models-sync-${providerId}`);
    try {
      const models = await syncProviderModels(props.settings, providerId);
      props.onMessage(t('上游 {{name}} 已同步 {{count}} 个模型。', {
        name: providerName,
        count: models.length
      }));
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '同步模型失败。');
    } finally {
      setBusy(null);
    }
  };
  return <Box className="section-stack">
      <PageHeader actions={<Button type="button" disabled={!isLive()} className="text-xs tracking-wider" onClick={() => {
      resetCreateForm();
      setCreateOpen(true);
    }}>
            <Plus className="mr-2 size-3" />
            {t('CREATE PROVIDER')}
          </Button>} />

      <StatsGrid ariaLabel="上游摘要" items={stats()} variant="compact" />

      {!isLive() ? <Alert className="border-border/40 bg-muted/20">
          <AlertTitle className="font-mono text-xs uppercase tracking-widest">{t("未连接后台")}</AlertTitle>
          <Typography className="mt-2 text-sm leading-5 text-muted-foreground opacity-80" component="div">{t("当前不能创建或修改上游，请先连接后台。")}</Typography>
        </Alert> : null}

      <Card>
        <Box className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 p-4">
          <Typography className="text-sm font-semibold text-foreground" component="div">{t("上游列表")}</Typography>
          <Typography className="font-mono text-[0.6875rem] uppercase tracking-wider text-muted-foreground" component="div">{t('查看目标与健康状态。')}</Typography>
        </Box>
        <CardContent className="p-0 border-t border-border/40">
          {props.items.length > 0 ? <>{showProviderTable ? <TableContainer><Table>
              <TableHead>
                <TableRow className="border-b border-border hover:bg-transparent">
                  <TableCell className="font-mono uppercase tracking-widest">{t("上游")}</TableCell>
                  <TableCell className="font-mono uppercase tracking-widest">{t("运行状态")}</TableCell>
                  <TableCell className="font-mono uppercase tracking-widest">{t("目标")}</TableCell>
                  <TableCell className="font-mono uppercase tracking-widest">{t("密钥")}</TableCell>
                  <TableCell className="font-mono uppercase tracking-widest">{t("优先级 / 权重")}</TableCell>
                  <TableCell className="font-mono uppercase tracking-widest">{t("最近错误")}</TableCell>
                  <TableCell className="font-mono uppercase tracking-widest text-right">{t("操作")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {props.items.map(item => {
              const health = healthStatus(
                item.provider.runtime?.state ?? item.provider.health?.state,
                item.provider.routing_availability?.available ?? item.provider.runtime?.available ?? item.provider.health?.available,
              );
              return <TableRow key={item.provider.id} className="cursor-pointer border-b border-border/40 hover:bg-muted/30 transition-colors" onClick={() => setSelectedProviderId(item.provider.id)}>
                        <TableCell>
                          <Box className="flex flex-col gap-1">
                            <Box className="text-sm font-medium text-foreground truncate max-w-[150px]" component="strong">{item.provider.name}</Box>
                            <Box className="font-mono text-[0.6875rem] leading-[1.428571] text-muted-foreground opacity-70 truncate max-w-[220px]" component="span">
                              {item.provider.provider_type} · {item.provider.groups.map(group => group.group_name).join(', ') || '—'}
                            </Box>
                          </Box>
                        </TableCell>
                        <TableCell>
                          <Box className="flex min-w-[9rem] items-center gap-2">
                            <StatusBadge tone={health.tone}>{routingAvailabilityLabel(item.provider.routing_availability)}</StatusBadge>
                            <Box className="font-mono text-[0.6875rem] text-muted-foreground" component="span">
                              {item.provider.runtime?.in_flight ?? 0}/{item.provider.max_concurrency ?? '∞'} · {item.provider.runtime?.latency_ewma_ms == null ? '—' : formatMs(item.provider.runtime.latency_ewma_ms)}
                            </Box>
                          </Box>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{item.endpoints.length}</TableCell>
                        <TableCell className="font-mono text-xs">{item.keys.length}</TableCell>
                        <TableCell className="font-mono text-xs">
                          P{item.provider.priority} / W{item.provider.weight}
                        </TableCell>
                        <TableCell className="font-mono text-[0.6875rem] uppercase tracking-widest opacity-80">{item.provider.runtime?.last_error_type ?? item.provider.health?.last_error_type ?? '—'}</TableCell>
                        <TableCell className="text-right">
                          <Box className="flex items-center justify-end gap-1">
                            <Tooltip title={t('同步模型')}>
                              <span>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  aria-label={t('同步上游 {{name}} 的模型', { name: item.provider.name })}
                                  disabled={busy !== null || item.endpoints.length === 0 || item.keys.length === 0}
                                  onClick={event => {
                                    event.stopPropagation();
                                    void syncModelsForProvider(item.provider.id, item.provider.name);
                                  }}
                                >
                                  <RefreshCw className={`size-3.5 ${busy === `models-sync-${item.provider.id}` ? 'animate-spin' : ''}`} />
                                </Button>
                              </span>
                            </Tooltip>
                            <Button type="button" size="sm" variant="ghost" className="font-mono text-xs hover:bg-transparent hover:text-primary px-0 shrink-0" onClick={event => {
                              event.stopPropagation();
                              setSelectedProviderId(item.provider.id);
                            }}>{t("[ DETAILS ]")}</Button>
                          </Box>
                        </TableCell>
                      </TableRow>;
            })}
              </TableBody>
            </Table></TableContainer> : <Box className="divide-y divide-border/40">
              {props.items.map(item => {
                const health = healthStatus(
                  item.provider.runtime?.state ?? item.provider.health?.state,
                  item.provider.routing_availability?.available ?? item.provider.runtime?.available ?? item.provider.health?.available,
                );
                const lastError = item.provider.runtime?.last_error_type ?? item.provider.health?.last_error_type;
                return <Box key={item.provider.id} className="flex min-w-0 items-stretch">
                  <ButtonBase
                    component="button"
                    type="button"
                    aria-label={t('查看上游 {{name}} 详情', { name: item.provider.name })}
                    className="min-w-0 flex-1 touch-manipulation items-stretch px-4 py-3 text-left"
                    onClick={() => setSelectedProviderId(item.provider.id)}
                  >
                    <Box className="flex min-w-0 flex-1 flex-col gap-2">
                    <Box className="flex min-w-0 items-center gap-2">
                      <Box className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" component="strong">{item.provider.name}</Box>
                      <StatusBadge tone={health.tone}>{routingAvailabilityLabel(item.provider.routing_availability)}</StatusBadge>
                      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    </Box>
                    <Box className="truncate font-mono text-[0.7rem] text-muted-foreground" component="span">
                      {item.provider.provider_type} · {item.provider.groups.map(group => group.group_name).join(', ') || '—'}
                    </Box>
                    <Box className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.7rem] text-muted-foreground" component="span">
                      <Box component="span">P{item.provider.priority} / W{item.provider.weight}</Box>
                      <Box component="span">{t('目标')} {item.endpoints.length} · {t('密钥')} {item.keys.length}</Box>
                      <Box component="span">
                        {t('并发')} {item.provider.runtime?.in_flight ?? 0}/{item.provider.max_concurrency ?? '∞'} · {item.provider.runtime?.latency_ewma_ms == null ? '—' : formatMs(item.provider.runtime.latency_ewma_ms)}
                      </Box>
                      {lastError ? <Box className="text-destructive" component="span">{lastError}</Box> : null}
                    </Box>
                    </Box>
                  </ButtonBase>
                  <Box className="flex w-14 shrink-0 items-center justify-center border-l border-border/40">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={t('同步上游 {{name}} 的模型', { name: item.provider.name })}
                      disabled={busy !== null || item.endpoints.length === 0 || item.keys.length === 0}
                      onClick={() => void syncModelsForProvider(item.provider.id, item.provider.name)}
                    >
                      <RefreshCw className={`size-4 ${busy === `models-sync-${item.provider.id}` ? 'animate-spin' : ''}`} />
                    </Button>
                  </Box>
                </Box>;
              })}
            </Box>}</> : <EmptyState title="NO PROVIDERS" description="先连接一个可用目标，再逐步补充更多目标和密钥。" action={<Button type="button" disabled={!isLive()} variant="ghost" onClick={() => {
          resetCreateForm();
          setCreateOpen(true);
        }}>
                    {t('CREATE PROVIDER')}
                  </Button>} />}
        </CardContent>
      </Card>

      <Card>
        <Box className="flex flex-col gap-3 p-5 pb-4">
          <Typography className="text-base font-medium text-foreground" component="div">{t('调度组')}</Typography>
          <Typography className="text-xs text-muted-foreground" component="div">{t('访问密钥只会使用与其调度组相交的上游。')}</Typography>
        </Box>
        <CardContent className="border-t border-border/40 p-0">
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('名称')}</TableCell>
                  <TableCell>{t('上游')}</TableCell>
                  <TableCell>{t('访问密钥')}</TableCell>
                  <TableCell className="text-right">{t('操作')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {providerGroups.map(group => <TableRow key={group.id}>
                    <TableCell>
                      {group.is_default ? <Box className="font-mono text-xs">{group.name}</Box> : <Box className="flex items-center gap-2" component="form" onSubmit={event => void saveGroup(event, group)}>
                          <InputBase name={`provider_group_name_${group.id}`} defaultValue={group.name} className="h-8 max-w-64 bg-background text-sm" />
                          <Button type="submit" size="icon" variant="ghost" aria-label={t('保存调度组')} disabled={busy === `provider-group-${group.id}`}>
                            <Save className="size-3.5" />
                          </Button>
                        </Box>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{group.provider_count}</TableCell>
                    <TableCell className="font-mono text-xs">{group.api_key_count}</TableCell>
                    <TableCell className="text-right">
                      <Button type="button" size="icon" variant="ghost" aria-label={t('删除调度组')} disabled={group.is_default || busy === `provider-group-${group.id}`} onClick={() => { setRemoveError(null); setRemoveAction({ title: t('删除调度组'), run: () => removeGroup(group) }); }}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>)}
                <TableRow>
                  <TableCell colSpan={4}>
                    <Box className="flex max-w-lg items-center gap-2" component="form" onSubmit={event => void submitGroupCreate(event)}>
                      <InputBase name="provider_group_name" placeholder={t('新调度组名称')} className="h-9 bg-background text-sm" />
                      <Button type="submit" size="sm" disabled={busy === 'provider-group-create'}>
                        <Plus className="size-3.5" />
                        {t('添加')}
                      </Button>
                    </Box>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>

      <DetailDrawer open={createOpen} title="NEW PROVIDER" description="填写连接信息并同步模型。" onClose={() => {
        if (!createIsBusy) void finishProviderCreate();
      }}>
        <Box key={createFormVersion} className="flex flex-col gap-4" onSubmit={event => void submitProviderCreate(event)} component="form">
          <Box className="grid gap-4 md:grid-cols-2">
            <FormControl>
              <FormLabel>{t("名称")}</FormLabel>
              <InputBase name="name" value={createName} disabled={createFieldsDisabled} onChange={event => {
              setCreateName(event.target.value);
              setCreateSubmitError(null);
            }} placeholder={t("openai-prod")} className="bg-background" />
            </FormControl>
            <FormControl>
              <FormLabel>{t("类型")}</FormLabel>
              <Select
                name="provider_type"
                value={createProviderType}
                disabled={createFieldsDisabled}
                inputProps={{ 'aria-label': t('类型') }}
                onChange={event => updateCreateProviderType(event.target.value)}
              >
                {PROVIDER_TYPE_OPTIONS.map(option => <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>)}
              </Select>
              <FormHelperText className="mt-1">{t(providerTypeDescription(createProviderType))}</FormHelperText>
            </FormControl>
          </Box>
          <Box className="grid gap-4">
            <FormControl>
              <Box className="flex items-center justify-between gap-2.5">
                <FormLabel>{t("服务地址")}</FormLabel>
                <Button type="button" size="icon" variant="ghost" aria-label={t('添加服务地址')} disabled={createIsPersisted || createFieldsDisabled} onClick={addCreateBaseUrl}>
                  <Plus className="size-4" />
                </Button>
              </Box>
              <Box className="grid gap-3">
                {createBaseUrls.map((row, index) => <Box key={row.id} className="grid grid-cols-[1.25rem_minmax(0,1fr)_2.75rem] items-center gap-2 sm:grid-cols-[2rem_minmax(0,1fr)_2.75rem]">
                      <Box className="flex h-10 items-center justify-center font-mono text-xs text-muted-foreground">{index + 1}</Box>
                      <InputBase inputProps={{ 'aria-label': t('服务地址 {{number}}', { number: index + 1 }) }} type="url" value={row.value} disabled={createFieldsDisabled} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={event => updateCreateBaseUrl(row.id, event.target.value)} placeholder={t("https://api.example.com/v1")} className="bg-background" />
                      <Button type="button" size="icon" variant="ghost" aria-label={t('移除服务地址')} disabled={createIsPersisted || createFieldsDisabled} onClick={() => removeCreateBaseUrl(row.id)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </Box>)}
              </Box>
            </FormControl>
            {isCreateCodex ? <Alert severity="info" variant="outlined">
                <AlertTitle>{t('使用 OAuth 账号')}</AlertTitle>
                {t('创建后将打开 OAuth 登录，不需要在此填写 API 密钥。')}
                <Typography className="mt-1 text-sm" component="div">
                  {t('Codex 创建时默认启用 WebSocket 和 HTTP→WS，之后可在上游设置中修改。')}
                </Typography>
              </Alert> : <FormControl>
                <Box className="flex items-center justify-between gap-3">
                  <FormLabel>{t("API 密钥")}</FormLabel>
                  <Button type="button" size="icon" variant="ghost" aria-label={t('添加 API 密钥')} disabled={createIsPersisted || createFieldsDisabled} onClick={addCreateApiKey}>
                    <Plus className="size-4" />
                  </Button>
                </Box>
                <Box className="grid gap-3">
                  {createApiKeys.map((row, index) => <Box key={row.id} className="grid grid-cols-[1.25rem_minmax(0,1fr)_2.75rem] items-center gap-2 sm:grid-cols-[2rem_minmax(0,1fr)_2.75rem]">
                        <Box className="flex h-10 items-center justify-center font-mono text-xs text-muted-foreground">{index + 1}</Box>
                        <InputBase inputProps={{ 'aria-label': t('上游 API Key {{number}}', { number: index + 1 }) }} type="password" value={row.value} disabled={createFieldsDisabled} autoComplete="new-password" autoCapitalize="none" spellCheck={false} onChange={event => updateCreateApiKey(row.id, event.target.value)} placeholder={t("sk-...")} className="bg-background" />
                        <Button type="button" size="icon" variant="ghost" aria-label={t('移除 API 密钥')} disabled={createIsPersisted || createFieldsDisabled} onClick={() => removeCreateApiKey(row.id)}>
                          <Trash2 className="size-4" />
                        </Button>
                      </Box>)}
                </Box>
              </FormControl>}
          </Box>
          <Box component="details" className="border border-border/40">
            <Box component="summary" className="cursor-pointer p-4 text-sm font-medium">{t('高级设置')}</Box>
            <Box className="grid gap-4 p-4 md:grid-cols-2">
            <FormControl error={createPriorityValue === null}>
              <FormLabel htmlFor="create-provider-priority">{t('优先级')}</FormLabel>
              <InputBase
                id="create-provider-priority"
                name="priority"
                type="number"
                value={createPriority}
                disabled={createFieldsDisabled}
                slotProps={{
                  input: {
                    inputMode: 'numeric',
                    max: MAX_PROVIDER_ROUTING_VALUE,
                    min: 0,
                    step: 1
                  }
                }}
                className="bg-background font-mono"
                onChange={event => {
                  setCreatePriority(event.target.value);
                  setCreateSubmitError(null);
                }}
              />
              <FormHelperText>{t(createPriorityValue === null ? '优先级必须是 0 到 2147483647 之间的整数。' : '数值越小，路由优先级越高。')}</FormHelperText>
            </FormControl>
            <FormControl error={createWeightValue === null}>
              <FormLabel htmlFor="create-provider-weight">{t('权重')}</FormLabel>
              <InputBase
                id="create-provider-weight"
                name="weight"
                type="number"
                value={createWeight}
                disabled={createFieldsDisabled}
                slotProps={{
                  input: {
                    inputMode: 'numeric',
                    max: MAX_PROVIDER_ROUTING_VALUE,
                    min: 1,
                    step: 1
                  }
                }}
                className="bg-background font-mono"
                onChange={event => {
                  setCreateWeight(event.target.value);
                  setCreateSubmitError(null);
                }}
              />
              <FormHelperText>{t(createWeightValue === null ? '权重必须是 1 到 2147483647 之间的整数。' : '仅在相同优先级的健康上游之间决定相对流量比例。')}</FormHelperText>
            </FormControl>
            <FormControl className="md:col-span-2">
              <FormLabel>{t('调度组')}</FormLabel>
              <Select
                multiple
                value={createGroupIds}
                disabled={createFieldsDisabled}
                onChange={event => {
                  const value = event.target.value;
                  setCreateGroupIds(
                    (typeof value === 'string' ? value.split(',') : value)
                      .map(Number)
                      .filter(Number.isFinite),
                  );
                  setCreateSubmitError(null);
                }}
                renderValue={selectedIds => providerGroups
                  .filter(group => selectedIds.includes(group.id))
                  .map(group => group.name)
                  .join(', ')}
              >
                {providerGroups.map(group => <MenuItem key={group.id} value={group.id}>
                    <Checkbox checked={createGroupIds.includes(group.id)} />
                    <Box component="span">{group.name}</Box>
                  </MenuItem>)}
              </Select>
            </FormControl>
            </Box>
          <Box className="grid gap-4 md:grid-cols-4">
            <Box className="flex items-center gap-3 border border-border/40 bg-transparent px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors" component="label">
              <Checkbox name="enabled" defaultChecked disabled={createFieldsDisabled} />
              <Box component="span">{t('创建后启用')}</Box>
            </Box>
            <Box className="flex items-center gap-3 border border-border/40 bg-transparent px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors" component="label">
              <Checkbox name="supports_include_usage" defaultChecked disabled={createFieldsDisabled} />
              <Box component="span">{t('补充用量')}</Box>
            </Box>
            <Box className="flex items-center gap-3 border border-border/40 bg-transparent px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors" component="label">
              <Checkbox key={`websocket-${createProviderType}`} name="websocket_enabled" defaultChecked={isCreateCodex} disabled={createFieldsDisabled || isCreateCodex} />
              <Box component="span">{t('WebSocket')}</Box>
            </Box>
            <Box className="flex items-center gap-3 border border-border/40 bg-transparent px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors" component="label">
              <Checkbox key={`bridge-${createProviderType}`} name="responses_http_to_ws" defaultChecked={isCreateCodex} disabled={createFieldsDisabled || isCreateCodex} />
              <Box component="span">{t('HTTP→WS Beta')}</Box>
            </Box>
          </Box>
          </Box>
          <Box className="border border-border/40" component="details">
            <Box className="cursor-pointer px-4 py-3 text-sm font-medium" component="summary">
              {t('请求覆写（可选）')}
              <Box className="ml-2 text-xs font-normal text-muted-foreground" component="span">
                {t('Codex-only 中转可在首次模型同步前应用兼容预设。')}
              </Box>
            </Box>
            <Box className="border-t border-border/40 p-4">
              <RequestOverridesEditor
                value={createOverridesDraft}
                disabled={createFieldsDisabled}
                onChange={next => {
                  setCreateOverridesDraft(next);
                  setCreateSubmitError(null);
                }}
              />
            </Box>
          </Box>
          <Box className="grid gap-2 sm:grid-cols-3" aria-label={t('创建进度')}>
            {[t('保存配置'), t('模型同步')].map((label, index) => {
              const activeIndex = createStage === 'provider' ? 0
                : createStage === 'models' || createStage === 'sync_failed' ? 1
                  : createStage === 'complete' ? 2 : -1;
              const failed = createStage === 'sync_failed' && index === 1;
              const complete = createStage === 'complete' || index < activeIndex;
              const active = createIsBusy && index === activeIndex;
              return <Box key={label} className="flex min-h-12 items-center justify-between gap-3 border border-border/40 bg-muted/5 px-3 py-2">
                <Box className="flex min-w-0 items-center gap-2 text-sm">
                  {complete ? <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />
                    : active ? <RefreshCw className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
                      : <Box className="size-2 shrink-0 rounded-full bg-muted-foreground/35" component="span" />}
                  <Box className="truncate" component="span">{label}</Box>
                </Box>
                <StatusBadge tone={failed ? 'error' : complete ? 'normal' : active ? 'warning' : 'disabled'}>
                  {t(failed ? '失败' : complete ? '完成' : active ? '进行中' : '等待')}
                </StatusBadge>
              </Box>;
            })}
          </Box>
          <Box className="border border-border/40 bg-transparent p-4 text-sm text-muted-foreground font-mono" aria-live="polite">
            {createFormHint()}
          </Box>
          {createStage === 'complete' ? <Alert className="border-border/40 bg-muted/20" severity="success" variant="outlined">
              <AlertTitle className="font-mono text-xs uppercase tracking-widest">{t('模型同步完成')}</AlertTitle>
              <Typography className="mt-2 text-[0.8rem] leading-relaxed text-muted-foreground opacity-80" component="div">
                {t('已同步 {{count}} 个模型。', { count: createSyncedCount ?? 0 })}
              </Typography>
            </Alert> : null}
          {createSubmitError ? <Alert className="border-border/40 bg-muted/20" severity="error" variant="outlined">
              <AlertTitle className="font-mono text-xs uppercase tracking-widest">{t(createStage === 'sync_failed' ? '同步失败' : '创建失败')}</AlertTitle>
              <Typography className="text-[0.8rem] leading-relaxed text-muted-foreground mt-1.5 opacity-80" component="div">{createSubmitError}</Typography>
            </Alert> : null}
          <Box className="flex flex-wrap justify-end gap-2 border-t border-border/40 pt-4 mt-1">
            {createIsPersisted ? <Button type="button" variant="outline" disabled={createIsBusy} onClick={() => void finishProviderCreate()}>
              {t('完成')}
            </Button> : null}
            {createStage !== 'complete' ? <Button type="submit" disabled={createIsBusy || createMissingFields().length > 0} className="font-mono text-xs tracking-widest px-5">
              <RefreshCw className={`mr-1.5 size-3.5 ${createIsBusy ? 'animate-spin' : ''}`} aria-hidden="true" />
              {t(createStage === 'sync_failed'
                ? '重试同步'
                : createIsBusy
                  ? '处理中…'
                  : isCreateCodex
                    ? '创建并登录'
                    : '创建并同步')}
            </Button> : null}
          </Box>
        </Box>
      </DetailDrawer>

      {selectedProviderId !== null && !selected && !props.loading ? <Alert severity="warning" action={<Button onClick={() => setSelectedProviderId(null)}>{t('关闭')}</Button>}>{t('未找到该上游。')}</Alert> : null}
      <DetailDrawer open={!!selected} title={selected?.provider.name ?? '上游详情'} description={selected ? '连接目标、健康状态与编辑入口。' : undefined} onClose={() => {
      setSelectedProviderId(null);
      setTestResult(null);
    }}>
        {selected ? (itemSignal => {
        const item = itemSignal;
        const health = healthStatus(
          item.provider.runtime?.state ?? item.provider.health?.state,
          item.provider.routing_availability?.available ?? item.provider.runtime?.available ?? item.provider.health?.available,
        );
        return <Box key={item.provider.id} className="flex flex-col gap-5">
                <Box className="grid grid-cols-2 gap-4 md:grid-cols-4 border-b border-border/40 pb-5">
                  <Box className="flex flex-col gap-1.5 border-l border-border/40 pl-3 border-l-2 border-l-primary">
                      <Box className="font-mono text-[0.6875rem] uppercase tracking-widest text-muted-foreground opacity-70">{t('状态')}</Box>
                      <Box className="mt-1.5">
                        <StatusBadge tone={health.tone}>{routingAvailabilityLabel(item.provider.routing_availability)}</StatusBadge>
                      </Box>
                  </Box>
                  <Box className="flex flex-col gap-1.5 border-l border-border/40 pl-3 border-l-2 border-l-primary/20">
                      <Box className="font-mono text-[0.6875rem] uppercase tracking-widest text-muted-foreground opacity-70">{t('并发')}</Box>
                      <Box className="mt-1.5 text-lg font-medium tracking-tight text-foreground">{item.provider.runtime?.in_flight ?? 0}/{item.provider.max_concurrency ?? '∞'}</Box>
                  </Box>
                  <Box className="flex flex-col gap-1.5 border-l border-border/40 pl-3 border-l-2 border-l-primary/20">
                      <Box className="font-mono text-[0.6875rem] uppercase tracking-widest text-muted-foreground opacity-70">{t('EWMA')}</Box>
                      <Box className="mt-1.5 text-lg font-medium tracking-tight text-foreground">{item.provider.runtime?.latency_ewma_ms == null ? '—' : formatMs(item.provider.runtime.latency_ewma_ms)}</Box>
                  </Box>
                  <Box className="flex flex-col gap-1.5 border-l border-border/40 pl-3 border-l-2 border-l-primary/20">
                      <Box className="font-mono text-[0.6875rem] uppercase tracking-widest text-muted-foreground opacity-70">{t('亲和会话')}</Box>
                      <Box className="mt-1.5 font-mono text-[0.8125rem] tracking-tight pt-0.5 text-muted-foreground">
                        {item.provider.affinity_sessions ?? 0}
                      </Box>
                  </Box>
                </Box>

                <Alert severity="info">{t('同一上游代表一家服务，所有地址与 Key 共享搭配。地址按主备顺序使用，Key 可选择轮流或主备。')}</Alert>
                <RecoveryNotice until={item.provider.routing_availability?.retry_at_ms} message={item.provider.runtime?.last_error_message ?? item.provider.health?.last_error_message} />
                {connectionError ? <Alert severity="error">{connectionError}</Alert> : null}
                <Box className="grid gap-4" component="section">
                  <Box className="flex items-center justify-between border-b border-border/40 pb-3">
                    <Box className="flex items-center gap-3">
                      <Stethoscope className="size-4 opacity-70" />
                      <Box className="text-sm font-semibold tracking-normal text-foreground uppercase" component="h3">{t('服务地址')}</Box>
                    </Box>
                    <StatusBadge tone="normal">{String(item.endpoints.length)}</StatusBadge>
                  </Box>
                  <Box className="grid gap-3">
                    {item.endpoints.map((endpoint, index) => {
                const endpointHealth = healthStatus(endpoint.health?.state, endpoint.health?.available);
                return <Box key={endpoint.id} className="grid min-w-0 gap-3 border border-border/40 p-4 sm:grid-cols-2" onSubmit={event => void submitEndpointUpdate(event, endpoint.id)} onDragOver={event => event.preventDefault()} onDrop={() => void reorderEndpoints(item, endpoint.id)} component="form">
                  <Box className="flex flex-wrap items-center gap-2 sm:col-span-2">
                    <Button type="button" size="icon" variant="ghost" aria-label={t('调整服务地址顺序')} draggable onDragStart={() => setDraggingEndpointId(endpoint.id)} onDragEnd={() => setDraggingEndpointId(null)}><GripVertical className="size-4" /></Button>
                    <Typography variant="body2">{t(index === 0 ? '主地址' : '备用地址')}</Typography>
                    <StatusBadge tone={endpoint.enabled ? endpointHealth.tone : 'disabled'}>{t(endpoint.enabled ? endpointHealth.label : '停用')}</StatusBadge>
                    <Button type="button" size="icon" variant="ghost" aria-label={t('上移')} disabled={index === 0 || busy !== null} onClick={() => void reorderEndpoints(item, item.endpoints[index - 1].id, endpoint.id)}><ArrowUp className="size-4" /></Button>
                    <Button type="button" size="icon" variant="ghost" aria-label={t('下移')} disabled={index === item.endpoints.length - 1 || busy !== null} onClick={() => void reorderEndpoints(item, item.endpoints[index + 1].id, endpoint.id)}><ArrowDown className="size-4" /></Button>
                  </Box>
                  <FormControl><FormLabel htmlFor={`endpoint-name-${endpoint.id}`}>{t('名称')}</FormLabel><InputBase id={`endpoint-name-${endpoint.id}`} name={`endpoint_name_${endpoint.id}`} defaultValue={endpoint.name || `地址 ${index + 1}`} autoComplete="off" /></FormControl>
                  <FormControl><FormLabel htmlFor={`endpoint-url-${endpoint.id}`}>{t('服务地址')}</FormLabel><InputBase id={`endpoint-url-${endpoint.id}`} name={`endpoint_base_url_${endpoint.id}`} type="url" required defaultValue={endpoint.base_url} autoComplete="off" autoCapitalize="none" spellCheck={false} /></FormControl>
                  <Box className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
                    <Box className="check-row" component="label"><Checkbox name={`endpoint_enabled_${endpoint.id}`} defaultChecked={endpoint.enabled} /><Box component="span">{t('启用')}</Box></Box>
                    <Box className="flex flex-wrap gap-1">
                      <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void handleTestEndpoint(endpoint.id)}>{t('测试地址')}</Button>
                      <Button type="submit" disabled={busy !== null} aria-label={t('保存服务地址')}><Save className="mr-1 size-4" />{t('保存')}</Button>
                      <Button type="button" size="icon" color="error" aria-label={t('删除服务地址')} disabled={busy !== null} onClick={() => { setRemoveError(null); setRemoveAction({ title: t('确认删除服务地址 {{name}}？', { name: endpoint.name }), run: () => removeEndpoint(endpoint) }); }}><Trash2 className="size-4" /></Button>
                    </Box>
                  </Box>
                  <Box className="sm:col-span-2"><RecoveryNotice until={endpoint.health?.open_until_ms} message={endpoint.health?.last_error_message} /></Box>
                </Box>;
              })}
                    <Box className="grid gap-3 border border-dashed border-border/60 p-4 sm:grid-cols-2" onSubmit={event => void submitEndpointCreate(event, item)} component="form">
                      <FormControl><FormLabel htmlFor="new-endpoint-name">{t('名称')}</FormLabel><InputBase id="new-endpoint-name" name="endpoint_name" placeholder={t('备用地址')} autoComplete="off" /></FormControl>
                      <FormControl><FormLabel htmlFor="new-endpoint-url">{t('服务地址')}</FormLabel><InputBase id="new-endpoint-url" name="endpoint_base_url" type="url" required placeholder="https://api.example.com/v1" autoComplete="off" /></FormControl>
                      <Box className="check-row" component="label"><Checkbox name="endpoint_enabled" defaultChecked /><Box component="span">{t('启用')}</Box></Box>
                      <Button type="submit" disabled={busy !== null}><Plus className="mr-1 size-4" />{t('添加服务地址')}</Button>
                    </Box>
                  </Box>
                </Box>

                {item.provider.provider_type === CODEX_PROVIDER_TYPE ? <Box className="mt-5">
                    <CodexOAuthPanel
                      settings={props.settings}
                      item={item}
                      onRefresh={props.onRefresh}
                      onMessage={props.onMessage}
                    />
                  </Box> : <>
                <Box className="grid gap-3 mt-5" component="section">
                  <Box className="flex items-center justify-between border-b border-border/40 pb-3">
                    <Box className="flex items-center gap-3">
                      <AlertCircle className="size-4 opacity-70" />
                      <Box className="text-sm font-semibold tracking-normal text-foreground uppercase" component="h3">{t('API 密钥')}</Box>
                    </Box>
                    <StatusBadge tone="normal">{String(item.keys.length)}</StatusBadge>
                  </Box>
                  <FormControl>
                    <FormLabel id="provider-key-strategy-label">{t('Key 使用方式')}</FormLabel>
                    <Select labelId="provider-key-strategy-label" value={item.provider.key_selection_strategy ?? 'round_robin'} disabled={busy !== null} onChange={event => {
                      const strategy = event.target.value as CreateProviderInput['key_selection_strategy'];
                      setBusy(`strategy-${item.provider.id}`);
                      setConnectionError(null);
                      void updateProvider(props.settings, item.provider.id, { key_selection_strategy: strategy })
                        .then(() => props.onRefresh())
                        .catch(error => setConnectionError(error instanceof Error ? error.message : t('保存失败')))
                        .finally(() => setBusy(null));
                    }}>
                      <MenuItem value="round_robin">{t('轮流使用')}</MenuItem>
                      <MenuItem value="ordered">{t('主备顺序')}</MenuItem>
                      {item.provider.key_selection_strategy === 'weighted' ? <MenuItem value="weighted">{t('加权分配（兼容旧配置）')}</MenuItem> : null}
                    </Select>
                    <FormHelperText>{t(item.provider.key_selection_strategy === 'ordered' ? '优先使用前面的可用 Key，失败后切换备用 Key。' : '在可用 Key 之间依次轮换；冷却中的 Key 会自动跳过。')}</FormHelperText>
                  </FormControl>
                  <Box className="grid gap-3">
                    {item.keys.map((key, index) => {
                const quotaCooling = (key.quota?.cooldown_until_ms ?? 0) > Date.now();
                const keyHealth = quotaCooling
                  ? { label: '限流冷却', tone: 'warning' as const }
                  : healthStatus(key.health?.state, key.health?.available);
                return <Box key={key.id} className="grid min-w-0 gap-3 border border-border/40 p-4 sm:grid-cols-2" onSubmit={event => void submitKeyUpdate(event, key.id)} component="form">
                  <Box className="flex flex-wrap items-center gap-2 sm:col-span-2">
                    <StatusBadge tone={key.enabled ? keyHealth.tone : 'disabled'}>{t(key.enabled ? keyHealth.label : '停用')}</StatusBadge>
                    {item.provider.key_selection_strategy === 'ordered' ? <>
                      <Typography variant="body2">{t(index === 0 ? '主 Key' : '备用 Key')}</Typography>
                      <Button type="button" size="icon" variant="ghost" aria-label={t('上移')} disabled={index === 0 || busy !== null} onClick={() => void reorderKeys(item, item.keys[index - 1].id, key.id)}><ArrowUp className="size-4" /></Button>
                      <Button type="button" size="icon" variant="ghost" aria-label={t('下移')} disabled={index === item.keys.length - 1 || busy !== null} onClick={() => void reorderKeys(item, item.keys[index + 1].id, key.id)}><ArrowDown className="size-4" /></Button>
                    </> : null}
                  </Box>
                  <FormControl><FormLabel htmlFor={`key-name-${key.id}`}>{t('名称')}</FormLabel><InputBase id={`key-name-${key.id}`} name={`upstream_key_name_${key.id}`} defaultValue={key.name || `密钥 ${index + 1}`} autoComplete="off" /></FormControl>
                  <FormControl><FormLabel htmlFor={`key-secret-${key.id}`}>{t('替换 API Key')}</FormLabel><InputBase id={`key-secret-${key.id}`} name={`upstream_key_secret_${key.id}`} type="password" autoComplete="new-password" placeholder={t('留空表示不修改')} /></FormControl>
                  <Box className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
                    <Box className="check-row" component="label"><Checkbox name={`upstream_key_enabled_${key.id}`} defaultChecked={key.enabled} /><Box component="span">{t('启用')}</Box></Box>
                    <Box className="flex gap-1">
                      <Button type="submit" aria-label={t('保存 API 密钥')} disabled={busy !== null}><Save className="mr-1 size-4" />{t('保存')}</Button>
                      <Button type="button" size="icon" color="error" aria-label={t('删除 API 密钥')} disabled={busy !== null} onClick={() => { setRemoveError(null); setRemoveAction({ title: t('确认删除 API 密钥 {{name}}？', { name: key.name }), run: () => removeProviderKey(key) }); }}><Trash2 className="size-4" /></Button>
                    </Box>
                  </Box>
                  <Box className="sm:col-span-2"><RecoveryNotice until={Math.max(key.health?.open_until_ms ?? 0, key.quota?.cooldown_until_ms ?? 0) || null} message={key.health?.last_error_message} /></Box>
                </Box>;
              })}
                    <Box className="grid gap-3 border border-dashed border-border/60 p-4 sm:grid-cols-2" onSubmit={event => void submitKeyCreate(event, item)} component="form">
                      <FormControl><FormLabel htmlFor="new-key-name">{t('名称')}</FormLabel><InputBase id="new-key-name" name="upstream_key_name" placeholder={t('备用 Key')} autoComplete="off" /></FormControl>
                      <FormControl><FormLabel htmlFor="new-key-secret">{t('上游 API Key')}</FormLabel><InputBase id="new-key-secret" name="upstream_key_secret" type="password" required placeholder="sk-..." autoComplete="new-password" /></FormControl>
                      <Box className="check-row" component="label"><Checkbox name="upstream_key_enabled" defaultChecked /><Box component="span">{t('启用')}</Box></Box>
                      <Button type="submit" disabled={busy !== null}><Plus className="mr-1 size-4" />{t('添加 API 密钥')}</Button>
                    </Box>
                  </Box>
                </Box>

                <Box component="details" sx={{ mt: 3 }}>
                  <Box component="summary" sx={{ cursor: 'pointer', mb: 2 }}>{t('密钥模型限制')}</Box>
                  <Select displayEmpty value={selectedUpstreamKeyId === null ? '' : String(selectedUpstreamKeyId)} onChange={event => setSelectedUpstreamKeyId(Number(event.target.value) || null)} sx={{ width: '100%', maxWidth: 320 }}>
                    <MenuItem value="">{t('选择密钥…')}</MenuItem>
                    {item.keys.map(key => <MenuItem key={key.id} value={String(key.id)}>{key.name}</MenuItem>)}
                  </Select>
                  {isLive() && selectedUpstreamKeyId !== null ? <UpstreamKeyModels key={selectedUpstreamKeyId} settings={props.settings} keyId={selectedUpstreamKeyId} onChanged={() => props.onRefresh()} /> : null}
                </Box>
                </>}

                <Box className="grid gap-4 mt-5 pb-5" component="section">
                  <Box className="flex items-center justify-between border-b border-border/40 pb-3">
                    <Box className="flex items-center gap-2.5">
                      <RefreshCw className="size-4 opacity-70" />
                      <Box className="text-sm font-semibold tracking-normal text-foreground uppercase" component="h3">{t('模型')}</Box>
                    </Box>
                  </Box>

                  <Card className="border border-border bg-background shadow-none">
                    <CardContent className="flex flex-col items-start justify-between gap-3 p-4 sm:flex-row sm:items-center">
                      <Box className="grid gap-1.5">
                        <Typography className="text-sm font-semibold tracking-normal text-foreground" component="div">{t('可用模型')}</Typography>
                        <Typography className="text-[0.8125rem] leading-5 text-muted-foreground" component="p">{t('模型库存、显示名称、别名目标和协议能力已集中到模型页。')}</Typography>
                      </Box>
                      <Box className="flex shrink-0 flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy !== null || item.endpoints.length === 0 || item.keys.length === 0}
                          onClick={() => void syncModelsForProvider(item.provider.id, item.provider.name)}
                        >
                          <RefreshCw className={`mr-1.5 size-3 ${busy === `models-sync-${item.provider.id}` ? 'animate-spin' : ''}`} aria-hidden="true" />
                          {t('同步模型')}
                        </Button>
                        <Button
                          component={Link}
                          to={`/models?provider_id=${item.provider.id}`}
                          size="sm"
                          disabled={!isLive()}
                          className="text-xs tracking-wider"
                        >
                          {t('在模型页管理')}
                          <ChevronRight className="ml-1.5 size-3" aria-hidden="true" />
                        </Button>
                      </Box>
                    </CardContent>
                  </Card>
                </Box>

                {testResult ? (result => <Card className="border border-border bg-background shadow-none mb-5">
                      <Box className="flex flex-col gap-2 p-4 pb-3">
                        <Typography className="text-sm font-semibold tracking-normal text-foreground" component="div">{t('地址连通测试（不验证 Key）')}</Typography>
                      </Box>
                      <CardContent className="grid gap-1.5 font-mono text-[0.8125rem] border-t border-border/40 pt-3">
                        <Box>{t('地址：{{url}}', {
                  url: result.url
                })}</Box>
                        <Box>{t('状态：{{status}}', {
                  status: result.status ?? t('连接失败')
                })}</Box>
                        <Box>{t('消息：{{message}}', {
                  message: result.message ?? t('无返回内容')
                })}</Box>
                      </CardContent>
                    </Card>)(testResult) : null}

                <Box className="flex flex-col gap-4" onSubmit={event => void submitProviderUpdate(event, item)} component="form">
                  <Box className="flex items-center gap-2.5 border-b border-border/40 pb-3">
                    <ShieldCheck className="size-4 opacity-70" />
                    <Box className="text-sm font-semibold tracking-normal text-foreground uppercase" component="h3">{t('上游信息')}</Box>
                  </Box>
                  <Box className="grid gap-4 pt-3 md:grid-cols-2">
                    <FormControl>
                      <FormLabel>{t("名称")}</FormLabel>
                      <InputBase name="provider_name" defaultValue={item.provider.name} className="bg-background" />
                    </FormControl>
                    <FormControl>
                      <FormLabel>{t("类型")}</FormLabel>
                      <Select name="provider_type" value={providerTypeDraft || item.provider.provider_type} onChange={event => setProviderTypeDraft(event.target.value)}>
                        {PROVIDER_TYPE_OPTIONS.map(option => <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>)}
                        {!PROVIDER_TYPE_OPTIONS.some(option => option.value === item.provider.provider_type) ? <MenuItem value={item.provider.provider_type}>{item.provider.provider_type}</MenuItem> : null}
                      </Select>
                      <FormHelperText>{t(providerTypeDescription(providerTypeDraft || item.provider.provider_type))}</FormHelperText>
                    </FormControl>
                  </Box>
                    <Box className="flex items-center gap-3 border border-border/40 bg-transparent px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors" component="label">
                      <Checkbox name="provider_enabled" defaultChecked={item.provider.enabled} />
                      <Box component="span">{t('启用上游')}</Box>
                    </Box>
                  <Box component="details" className="border border-border/40">
                    <Box component="summary" className="cursor-pointer p-4 text-sm font-medium">{t('高级设置')}</Box>
                    <Box className="grid gap-4 p-4 md:grid-cols-2">
                    <FormControl error={providerPriorityValue === null}>
                      <FormLabel htmlFor="provider-priority">{t('优先级')}</FormLabel>
                      <InputBase
                        id="provider-priority"
                        name="provider_priority"
                        type="number"
                        value={providerPriorityDraft}
                        slotProps={{
                          input: {
                            inputMode: 'numeric',
                            max: MAX_PROVIDER_ROUTING_VALUE,
                            min: 0,
                            step: 1
                          }
                        }}
                        className="bg-background font-mono"
                        onChange={event => {
                          setProviderPriorityDraft(event.target.value);
                          setProviderSubmitError(null);
                        }}
                      />
                      <FormHelperText>{t(providerPriorityValue === null ? '优先级必须是 0 到 2147483647 之间的整数。' : '数值越小，路由优先级越高。')}</FormHelperText>
                    </FormControl>
                    <FormControl error={providerWeightValue === null}>
                      <FormLabel htmlFor="provider-weight">{t('权重')}</FormLabel>
                      <InputBase
                        id="provider-weight"
                        name="provider_weight"
                        type="number"
                        value={providerWeightDraft}
                        slotProps={{
                          input: {
                            inputMode: 'numeric',
                            max: MAX_PROVIDER_ROUTING_VALUE,
                            min: 1,
                            step: 1
                          }
                        }}
                        className="bg-background font-mono"
                        onChange={event => {
                          setProviderWeightDraft(event.target.value);
                          setProviderSubmitError(null);
                        }}
                      />
                      <FormHelperText>{t(providerWeightValue === null ? '权重必须是 1 到 2147483647 之间的整数。' : '仅在相同优先级的健康上游之间决定相对流量比例。')}</FormHelperText>
                    </FormControl>
                  </Box>
                  <FormControl>
                    <FormLabel>{t('调度组与优先级覆盖')}</FormLabel>
                    <Box className="grid gap-2 md:grid-cols-2">
                      {providerGroups.map(group => {
                        const selected = Object.prototype.hasOwnProperty.call(providerGroupPriorities, group.id);
                        return <Box key={group.id} className="grid min-h-10 grid-cols-[2rem_minmax(0,1fr)_8rem] items-center gap-2 border border-border/40 px-3">
                            <Checkbox
                              checked={selected}
                              onChange={event => setProviderGroupPriorities(current => {
                                if (event.currentTarget.checked) {
                                  return {
                                    ...current,
                                    [group.id]: ''
                                  };
                                }
                                const next = {
                                  ...current
                                };
                                delete next[group.id];
                                return next;
                              })}
                            />
                            <Box className="truncate text-sm" component="span">{group.name}</Box>
                            <InputBase
                              type="number"
                              value={providerGroupPriorities[group.id] ?? ''}
                              disabled={!selected}
                              placeholder={t('沿用全局')}
                              slotProps={{ input: { min: 0, step: 1 } }}
                              className="h-8 bg-background font-mono text-xs"
                              onChange={event => setProviderGroupPriorities(current => ({
                                ...current,
                                [group.id]: event.target.value
                              }))}
                            />
                          </Box>;
                      })}
                    </Box>
                  </FormControl>
                  <Box className="grid gap-4 md:grid-cols-4">

                    <Box className="flex items-center gap-3 border border-border/40 bg-transparent px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors" component="label">
                      <Checkbox name="supports_include_usage" defaultChecked={item.provider.supports_include_usage} />
                      <Box component="span">{t('补充用量信息')}</Box>
                    </Box>
                    <Box className="flex items-center gap-3 border border-border/40 bg-transparent px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors" component="label">
                      <Checkbox name="provider_websocket_enabled" defaultChecked={item.provider.websocket_enabled} />
                      <Box component="span">{t('启用 WebSocket 传输')}</Box>
                    </Box>
                    <Box className="flex items-center gap-3 border border-border/40 bg-transparent px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors" component="label">
                      <Checkbox name="provider_responses_http_to_ws" defaultChecked={providerHasBetaFeature(item, BETA_FEATURE_RESPONSES_HTTP_TO_WS)} />
                      <Box component="span">{t('HTTP→WS Beta')}</Box>
                    </Box>
                  </Box>
                  <RequestOverridesEditor
                    value={providerRequestOverridesDraft}
                    disabled={busy === `provider-${item.provider.id}`}
                    onChange={next => {
                      setProviderRequestOverridesDraft(next);
                      setProviderSubmitError(null);
                    }}
                  />
                  <Box className="border border-border/40" component="details">
                    <Box className="cursor-pointer px-4 py-3 text-sm font-medium" component="summary">
                      {t('故障保护与重试')}
                    </Box>
                    <Box className="grid gap-4 border-t border-border/40 p-4 md:grid-cols-2">
                      <Alert severity="info" className="md:col-span-2">{t('每次请求最多尝试 3 次（含切换与认证重放），重试前等待约 0.5–1.25 秒。地址或 Key 首次故障即冷却 30 秒，反复失败递增，默认最多 5 分钟。上游要求更长等待时以其为准；全部不可用时立即返回错误和 Retry-After。')}</Alert>
                      <Typography variant="body2" className="md:col-span-2">{t('以下旧配置继续保留，单个上游的尝试次数仍受全请求 3 次上限约束。关闭服务级熔断不会关闭地址与 Key 的冷却保护。')}</Typography>
                      <FormControl>
                        <FormLabel>{t('每个上游尝试次数')}</FormLabel>
                        <InputBase name="provider_max_attempts" type="number" defaultValue={item.provider.max_attempts} slotProps={{ input: { min: 1, max: 10, step: 1 } }} className="bg-background font-mono" />
                      </FormControl>
                      <FormControl>
                        <FormLabel>{t('最大并发')}</FormLabel>
                        <InputBase name="provider_max_concurrency" type="number" defaultValue={item.provider.max_concurrency ?? ''} placeholder={t('不限制')} slotProps={{ input: { min: 1, max: 100000, step: 1 } }} className="bg-background font-mono" />
                      </FormControl>
                      <FormControl>
                        <FormLabel>{t('熔断失败阈值')}</FormLabel>
                        <InputBase name="provider_circuit_breaker_failure_threshold" type="number" defaultValue={item.provider.circuit_breaker_failure_threshold} slotProps={{ input: { min: 1, max: 100, step: 1 } }} className="bg-background font-mono" />
                      </FormControl>
                      <FormControl>
                        <FormLabel>{t('服务熔断时长（秒）')}</FormLabel>
                        <InputBase name="provider_circuit_breaker_open_seconds" type="number" defaultValue={item.provider.circuit_breaker_open_ms / 1000} slotProps={{ input: { min: 1, max: 86400, step: 0.001 } }} className="bg-background font-mono" />
                      </FormControl>
                      <FormControl>
                        <FormLabel>{t('半开恢复成功次数')}</FormLabel>
                        <InputBase name="provider_circuit_breaker_half_open_success_threshold" type="number" defaultValue={item.provider.circuit_breaker_half_open_success_threshold} slotProps={{ input: { min: 1, max: 20, step: 1 } }} className="bg-background font-mono" />
                      </FormControl>
                      <Box className="flex items-end gap-2">
                        <Box className="check-row h-10 flex-1" component="label">
                          <Checkbox name="provider_circuit_breaker_enabled" defaultChecked={item.provider.circuit_breaker_enabled} />
                          <Box component="span">{t('启用 Provider 熔断')}</Box>
                        </Box>
                        <Button type="button" variant="outline" size="sm" disabled={busy === `provider-circuit-${item.provider.id}`} onClick={() => void resetCircuit(item.provider.id)}>
                          <RefreshCw className="size-3.5" />
                          {t('重置故障状态')}
                        </Button>
                      </Box>
                      <Typography variant="caption" color="text.secondary" className="sm:col-span-2">{t('重置会清除连接故障，保留上游要求的限流等待时间。')}</Typography>
                    </Box>
                  </Box>
                  </Box>
                  {providerSubmitError ? <Alert className="border-border/40 bg-muted/20" severity="error" variant="outlined">
                      <AlertTitle className="font-mono text-xs uppercase tracking-widest">{t('保存失败')}</AlertTitle>
                      <Typography className="mt-2 text-[0.8rem] leading-relaxed text-muted-foreground opacity-80" component="div">{providerSubmitError}</Typography>
                    </Alert> : null}
                  <Box className="flex justify-end pt-4 border-t border-border/40 mt-2">
                    <Button type="submit" disabled={busy === `provider-${item.provider.id}` || providerPriorityValue === null || providerWeightValue === null}>
                      {busy === `provider-${item.provider.id}` ? '保存中…' : t('SAVE PROVIDER')}
                    </Button>
                  </Box>
                </Box>

                <Box className="mt-5 rounded border border-destructive/40 bg-destructive/5 p-4" component="section">
                  <Box className="flex flex-col gap-3.5 sm:flex-row sm:items-center sm:justify-between">
                    <Box className="min-w-0">
                      <Typography className="text-sm font-semibold tracking-normal text-destructive" component="h3">{t('危险操作')}</Typography>
                      <Typography className="mt-1.5 text-[0.8125rem] leading-5 text-muted-foreground" component="p">{t('永久删除此上游及其运行配置。历史数据会保留。')}</Typography>
                    </Box>
                    <Button type="button" variant="destructive" className="shrink-0" disabled={busy === `provider-delete-${item.provider.id}`} onClick={() => {
                      setDeleteProviderError(null);
                      setDeleteConfirmOpen(true);
                    }}>
                      <Trash2 className="size-4" />
                      {t('删除整个上游')}
                    </Button>
                  </Box>
                </Box>
              </Box>;
      })(selected) : null}
      </DetailDrawer>

      <ConfirmAction open={removeAction !== null} title={removeAction?.title ?? ''} error={removeError} busy={busy !== null} onClose={() => setRemoveAction(null)} onConfirm={() => void removeAction?.run()} />
      {createdCodexLogin ? <CodexOAuthLoginDialog
          open
          attemptId={createdCodexLogin.attemptId}
          settings={props.settings}
          providerId={createdCodexLogin.providerId}
          replaceKeyId={null}
          onClose={() => setCreatedCodexLogin(null)}
          onMessage={props.onMessage}
          onCompleted={async session => {
            await props.onRefresh(t(
              session.operation === 'updated' ? 'Codex OAuth 账号已更新。' : 'Codex OAuth 账号已创建。',
            ));
          }}
        /> : null}

      <Dialog
        aria-describedby="delete-provider-description"
        aria-labelledby="delete-provider-title"
        fullWidth
        maxWidth="sm"
        open={deleteConfirmOpen && selected !== null}
        onClose={closeDeleteProviderDialog}
        slotProps={{
          paper: {
            className: 'border border-destructive/40 bg-card shadow-none'
          },
          transition: {
            onEntered: () => deleteCancelButtonRef.current?.focus()
          }
        }}
      >
        <DialogTitle id="delete-provider-title" className="border-b border-border/40 px-4 py-3.5 text-base font-semibold tracking-normal text-foreground">
          {t('删除上游“{{name}}”？', {
            name: selected?.provider.name ?? ''
          })}
        </DialogTitle>
        <DialogContent className="px-4 py-3.5">
          <Typography id="delete-provider-description" className="text-[0.8125rem] leading-5 text-muted-foreground" component="p">
            {t('此操作不可撤销。以下运行配置将被永久删除：')}
          </Typography>
          <Box className="mt-3 grid list-disc gap-1.5 rounded border border-border/50 bg-muted/10 py-2.5 pl-7 pr-3 text-[0.8125rem] text-foreground" component="ul">
            <Box component="li">{t('{{count}} 个服务地址', {
              count: selected?.endpoints.length ?? 0
            })}</Box>
            <Box component="li">{t('{{count}} 个上游密钥及其模型', {
              count: selected?.keys.length ?? 0
            })}</Box>
            <Box component="li">{t('Provider 模型、模型路由关联与别名目标')}</Box>
          </Box>
          <Typography className="mt-3 text-[0.8125rem] leading-5 text-muted-foreground" component="p">{t('请求日志、统计与价格历史将保留。')}</Typography>
          {deleteProviderError ? <Alert className="mt-3 border-border/40 bg-muted/20" severity="error" variant="outlined">
              <AlertTitle className="font-mono text-xs uppercase tracking-widest">{t('删除失败')}</AlertTitle>
              <Typography className="mt-1.5 text-[0.8rem] leading-relaxed text-muted-foreground opacity-80" component="div">{deleteProviderError}</Typography>
            </Alert> : null}
        </DialogContent>
        <DialogActions className="gap-2 border-t border-border/40 px-4 py-3">
          <Button ref={deleteCancelButtonRef} autoFocus type="button" variant="outline" disabled={selected ? busy === `provider-delete-${selected.provider.id}` : false} onClick={closeDeleteProviderDialog}>{t('取消')}</Button>
          <Button type="button" variant="destructive" disabled={!selected || busy === `provider-delete-${selected?.provider.id ?? 0}`} onClick={() => selected ? void removeProvider(selected) : undefined}>
            <Trash2 className="size-4" />
            {selected && busy === `provider-delete-${selected.provider.id}` ? t('删除中…') : t('确认删除')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>;
}
