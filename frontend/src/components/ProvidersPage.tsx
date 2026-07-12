import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, Copy, GripVertical, Plus, RefreshCw, Save, ShieldCheck, Stethoscope, Trash2 } from "lucide-react";
import { DetailDrawer } from '@/components/console/DetailDrawer';
import { EmptyState } from '@/components/console/EmptyState';
import { PageHeader } from '@/components/console/PageHeader';
import { StatsGrid, type StatItem } from '@/components/console/StatsGrid';
import { StatusBadge } from '@/components/console/StatusBadge';
import { t } from '@/lib/i18n';
import { addUpstreamKeyModels, createEndpoint, createModelAlias, createModelAliasTarget, createProvider, createProviderKey, deleteEndpoint, deleteModelAlias, deleteModelAliasTarget, deleteProviderKey, deleteUpstreamKeyModel, deleteProviderModel, loadGatewayModelPolicies, loadProviderModels, loadUpstreamKeyModels, syncUpstreamKeyModels, syncProviderModels, testEndpointConnection, updateGatewayModelPolicy, updateEndpoint, updateProvider, updateModelAlias, updateModelAliasTarget, updateUpstreamKeyModel, updateProviderModel, updateProviderKey } from '../lib/api';
import { formatDateTime, formatMs } from '../lib/format';
import type { ConnectionSettings, CreateEndpointInput, CreateProviderInput, CreateProviderKeyInput, GatewayModelPolicy, ModelAlias, ProviderModel, ProviderWorkspace, UpstreamEndpointSummary, UpstreamKeyMeta, UpstreamKeyModel, UpdateEndpointInput, UpdateProviderInput, UpdateProviderKeyInput } from '../lib/types';
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
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
import TableContainer from "@mui/material/TableContainer";
import Typography from "@mui/material/Typography";
interface ProvidersPageProps {
  settings: ConnectionSettings;
  items: ProviderWorkspace[];
  aliases: ModelAlias[];
  onRefresh: (successMessage?: string) => Promise<void>;
  onMessage: (message: string) => void;
}
interface DraftInputRow {
  id: string;
  value: string;
}
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
function parseModelList(raw: string): string[] {
  const items = raw.split(/[\s,]+/g).map(value => value.trim()).filter(value => value.length > 0);
  const unique = Array.from(new Set(items));
  unique.sort((a, b) => a.localeCompare(b));
  return unique;
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
  value: 'openai_compatible',
  label: 'OpenAI Compatible',
  description: '兼容 OpenAI 协议的第三方或自建服务'
}, {
  value: 'openai_compatible_responses',
  label: 'OpenAI Compatible (Responses)',
  description: '仅用于响应式接口的兼容服务'
}] as const;
const BETA_FEATURE_RESPONSES_HTTP_TO_WS = 'responses-http-to-ws';
function providerHasBetaFeature(item: ProviderWorkspace, feature: string) {
  return item.provider.beta_features?.includes(feature) ?? false;
}
export function ProvidersPage(props: ProvidersPageProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createBaseUrls, setCreateBaseUrls] = useState<DraftInputRow[]>([createDraftInputRow('url')]);
  const [createApiKeys, setCreateApiKeys] = useState<DraftInputRow[]>([createDraftInputRow('key')]);
  const [createSubmitError, setCreateSubmitError] = useState<string | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<number | null>(null);
  const [providerTypeDraft, setProviderTypeDraft] = useState('');
  const [draggingEndpointId, setDraggingEndpointId] = useState<number | null>(null);
  const [draggingKeyId, setDraggingKeyId] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    status: number | null;
    url: string;
    message: string | null;
  } | null>(null);
  const selected = props.items.find(item => item.provider.id === selectedProviderId) ?? null;
  const [createProviderType, setCreateProviderType] = useState<string>('openai');
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
    setCreateBaseUrls([createDraftInputRow('url')]);
    setCreateApiKeys([createDraftInputRow('key')]);
    setCreateSubmitError(null);
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
    if (createApiKeyValues().length === 0) {
      missing.push('API 密钥');
    }
    return missing;
  };
  const createFormHint = () => {
    if (!isLive()) {
      return t('请先连接后台。');
    }
    if (createMissingFields().length === 0) {
      return t('将按当前顺序创建服务地址和访问密钥。');
    }
    return t('请先填写：{{fields}}。', {
      fields: createMissingFields().map(field => t(field)).join(', ')
    });
  };
  const [providerModels, setProviderModels] = useState<ProviderModel[] | null>(null);
  const [providerModelsError, setProviderModelsError] = useState<string | null>(null);
  const [modelAliasDraft, setModelAliasDraft] = useState<Record<number, string>>({});
  const [selectedUpstreamKeyId, setSelectedUpstreamKeyId] = useState<number | null>(null);
  const [upstreamKeyModels, setUpstreamKeyModels] = useState<UpstreamKeyModel[] | null>(null);
  const [upstreamKeyModelsError, setUpstreamKeyModelsError] = useState<string | null>(null);
  const [upstreamKeyModelsDraft, setUpstreamKeyModelsDraft] = useState('');
  const [gatewayModelPolicies, setGatewayModelPolicies] = useState<GatewayModelPolicy[] | null>(null);
  const [gatewayModelPoliciesError, setGatewayModelPoliciesError] = useState<string | null>(null);
  const disabledGatewayModels = () => {
    const policies = gatewayModelPolicies ?? [];
    return new Set(policies.filter(policy => !policy.enabled).map(policy => policy.model_name));
  };
  const providerTypeDescription = (value: string) => PROVIDER_TYPE_OPTIONS.find(option => option.value === value)?.description ?? '—';
  const stats = (): StatItem[] => {
    const totalEndpoints = props.items.reduce((sum, item) => sum + item.endpoints.length, 0);
    const unhealthy = props.items.filter(item => !item.provider.health?.available || item.provider.health?.state === 'open').length;
    const degraded = props.items.filter(item => item.provider.health?.state === 'half_open').length;
    const healthy = props.items.filter(item => item.provider.health?.state === 'closed' && item.provider.health.available).length;
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
  const submitProviderCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ensureLive()) return;
    const formData = new FormData(event.currentTarget);
    const payload: CreateProviderInput = {
      name: createName.trim(),
      provider_type: createProviderType || readString(formData, 'provider_type') || 'openai',
      enabled: readBool(formData, 'enabled'),
      priority: 100,
      weight: 1,
      supports_include_usage: readBool(formData, 'supports_include_usage'),
      websocket_enabled: readBool(formData, 'websocket_enabled'),
      beta_features: readBool(formData, 'responses_http_to_ws') ? [BETA_FEATURE_RESPONSES_HTTP_TO_WS] : [],
      key_selection_strategy: 'round_robin'
    };
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
    if (apiKeys.length === 0) {
      const message = 'API 密钥不能为空。';
      setCreateSubmitError(message);
      props.onMessage(message);
      return;
    }
    setBusy('create-provider');
    try {
      const created = await createProvider(props.settings, payload);
      const providerId = created.id;
      const work: Promise<unknown>[] = [];
      baseUrls.forEach((baseUrl, index) => {
        const endpointPayload: CreateEndpointInput = {
          name: `地址 ${index + 1}`,
          enabled: true,
          base_url: baseUrl,
          priority: priorityForIndex(index),
          weight: 1
        };
        work.push(createEndpoint(props.settings, providerId, endpointPayload));
      });
      apiKeys.forEach((apiKey, index) => {
        const keyPayload: CreateProviderKeyInput = {
          name: `密钥 ${index + 1}`,
          secret: apiKey,
          enabled: true,
          priority: priorityForIndex(index),
          weight: 1
        };
        work.push(createProviderKey(props.settings, providerId, keyPayload));
      });
      await Promise.all(work);
      setCreateOpen(false);
      resetCreateForm();
      await props.onRefresh(t('上游 {{name}} 已创建。', {
        name: payload.name
      }));
      setSelectedProviderId(providerId);
    } catch (error) {
      console.error('Failed to create provider', error);
      const message = error instanceof Error ? error.message : '创建上游失败。';
      setCreateSubmitError(message);
      props.onMessage(message);
    } finally {
      setBusy(null);
    }
  };
  const submitProviderUpdate = async (event: FormEvent<HTMLFormElement>, item: ProviderWorkspace) => {
    event.preventDefault();
    if (!ensureLive()) return;
    const formData = new FormData(event.currentTarget);
    const payload: UpdateProviderInput = {
      name: readString(formData, 'provider_name'),
      provider_type: readString(formData, 'provider_type') || item.provider.provider_type,
      enabled: readBool(formData, 'provider_enabled'),
      priority: item.provider.priority,
      weight: item.provider.weight,
      supports_include_usage: readBool(formData, 'supports_include_usage'),
      websocket_enabled: readBool(formData, 'provider_websocket_enabled'),
      beta_features: readBool(formData, 'provider_responses_http_to_ws') ? [BETA_FEATURE_RESPONSES_HTTP_TO_WS] : [],
      key_selection_strategy: item.provider.key_selection_strategy || 'round_robin'
    };
    setBusy(`provider-${item.provider.id}`);
    try {
      await updateProvider(props.settings, item.provider.id, payload);
      await props.onRefresh(t('上游 {{name}} 已更新。', {
        name: payload.name ?? item.provider.name
      }));
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新上游失败。');
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
    setBusy(`endpoint-create-${item.provider.id}`);
    try {
      await createEndpoint(props.settings, item.provider.id, payload);
      await props.onRefresh(t('目标 {{name}} 已创建。', {
        name: payload.name
      }));
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '创建目标失败。');
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
    setBusy(`endpoint-${endpointId}`);
    try {
      await updateEndpoint(props.settings, endpointId, payload);
      await props.onRefresh(t('目标 {{name}} 已更新。', {
        name: payload.name ?? ''
      }));
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新目标失败。');
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
    setBusy(`key-create-${item.provider.id}`);
    try {
      await createProviderKey(props.settings, item.provider.id, payload);
      await props.onRefresh(t('上游密钥 {{name}} 已创建。', {
        name: payload.name
      }));
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '创建上游密钥失败。');
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
    setBusy(`key-${keyId}`);
    try {
      await updateProviderKey(props.settings, keyId, payload);
      await props.onRefresh(t('上游密钥 {{name}} 已更新。', {
        name: payload.name ?? ''
      }));
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新上游密钥失败。');
    } finally {
      setBusy(null);
    }
  };
  const reorderEndpoints = async (item: ProviderWorkspace, targetId: number) => {
    const sourceId = draggingEndpointId;
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
      await Promise.all(next.map((endpoint, index) => updateEndpoint(props.settings, endpoint.id, {
        name: endpoint.name,
        base_url: endpoint.base_url,
        enabled: endpoint.enabled,
        priority: priorityForIndex(index),
        weight: endpoint.weight
      })));
      await props.onRefresh('服务地址顺序已更新。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新服务地址顺序失败。');
    } finally {
      setBusy(null);
    }
  };
  const reorderKeys = async (item: ProviderWorkspace, targetId: number) => {
    const sourceId = draggingKeyId;
    setDraggingKeyId(null);
    if (sourceId === null || sourceId === targetId || !ensureLive()) return;
    const sourceIndex = item.keys.findIndex(key => key.id === sourceId);
    const targetIndex = item.keys.findIndex(key => key.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const next = [...item.keys];
    const [source] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, source);
    setBusy(`key-reorder-${item.provider.id}`);
    try {
      await Promise.all(next.map((key, index) => updateProviderKey(props.settings, key.id, {
        name: key.name,
        enabled: key.enabled,
        priority: priorityForIndex(index),
        weight: key.weight
      })));
      await props.onRefresh('API 密钥顺序已更新。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新 API 密钥顺序失败。');
    } finally {
      setBusy(null);
    }
  };
  const removeEndpoint = async (endpoint: UpstreamEndpointSummary) => {
    if (!ensureLive()) return;
    if (!window.confirm(t('确认删除服务地址 {{name}}？', {
      name: endpoint.name
    }))) return;
    setBusy(`endpoint-delete-${endpoint.id}`);
    try {
      await deleteEndpoint(props.settings, endpoint.id);
      await props.onRefresh('服务地址已删除。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '删除服务地址失败。');
    } finally {
      setBusy(null);
    }
  };
  const removeProviderKey = async (key: UpstreamKeyMeta) => {
    if (!ensureLive()) return;
    if (!window.confirm(t('确认删除 API 密钥 {{name}}？', {
      name: key.name
    }))) return;
    setBusy(`key-delete-${key.id}`);
    try {
      await deleteProviderKey(props.settings, key.id);
      await props.onRefresh('API 密钥已删除。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '删除 API 密钥失败。');
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
      props.onMessage(result.ok ? '目标可达。' : '目标不可达。');
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
    setProviderModels(null);
    setProviderModelsError(null);
    setModelAliasDraft({});
    setSelectedUpstreamKeyId(null);
    setUpstreamKeyModels(null);
    setUpstreamKeyModelsError(null);
    setUpstreamKeyModelsDraft('');
    setProviderTypeDraft('');
  }, [selectedProviderId]);
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
  useEffect(() => {
    const item = selected;
    const upstreamKeyId = selectedUpstreamKeyId;
    if (!item || upstreamKeyId === null || !isLive()) return;
    let cancelled = false;
    setUpstreamKeyModels(null);
    setUpstreamKeyModelsError(null);
    setUpstreamKeyModelsDraft('');
    void loadUpstreamKeyModels(props.settings, upstreamKeyId).then(models => {
      if (cancelled) return;
      setUpstreamKeyModels(models);
    }).catch(error => {
      if (cancelled) return;
      setUpstreamKeyModels([]);
      setUpstreamKeyModelsError(error instanceof Error ? error.message : '加载密钥模型失败。');
    });
    return () => {
      cancelled = true;
    };
  }, [selected?.provider.id, selectedUpstreamKeyId, props.settings]);
  useEffect(() => {
    const item = selected;
    if (!item || !isLive()) return;
    const providerId = item.provider.id;
    let cancelled = false;
    setProviderModels(null);
    setProviderModelsError(null);
    void loadProviderModels(props.settings, providerId).then(models => {
      if (cancelled) return;
      setProviderModels(models);
      setModelAliasDraft(current => {
        const next: Record<number, string> = {};
        for (const model of models) {
          next[model.id] = current[model.id] ?? model.alias ?? '';
        }
        return next;
      });
    }).catch(error => {
      if (cancelled) return;
      setProviderModels([]);
      setProviderModelsError(error instanceof Error ? error.message : '加载模型失败。');
    });
    return () => {
      cancelled = true;
    };
  }, [selected?.provider.id, props.settings]);
  useEffect(() => {
    if (!isLive()) return;
    let cancelled = false;
    setGatewayModelPoliciesError(null);
    void loadGatewayModelPolicies(props.settings).then(policies => {
      if (cancelled) return;
      setGatewayModelPolicies(policies);
    }).catch(error => {
      if (cancelled) return;
      setGatewayModelPolicies([]);
      setGatewayModelPoliciesError(error instanceof Error ? error.message : '加载全局模型策略失败。');
    });
    return () => {
      cancelled = true;
    };
  }, [props.settings]);
  const syncKeyModels = async (upstreamKeyId: number) => {
    if (!ensureLive()) return;
    setBusy(`key-models-sync-${upstreamKeyId}`);
    try {
      const models = await syncUpstreamKeyModels(props.settings, upstreamKeyId);
      setUpstreamKeyModels(models);
      setUpstreamKeyModelsError(null);
      props.onMessage(t('已同步 {{count}} 个密钥模型。', {
        count: models.length
      }));
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '同步密钥模型失败。');
    } finally {
      setBusy(null);
    }
  };
  const addKeyModels = async (upstreamKeyId: number) => {
    if (!ensureLive()) return;
    const models = parseModelList(upstreamKeyModelsDraft);
    if (models.length === 0) {
      props.onMessage('请先输入至少一个模型名称。');
      return;
    }
    setBusy(`key-models-add-${upstreamKeyId}`);
    try {
      const updated = await addUpstreamKeyModels(props.settings, upstreamKeyId, models);
      setUpstreamKeyModels(updated);
      setUpstreamKeyModelsError(null);
      setUpstreamKeyModelsDraft('');
      props.onMessage(t('已写入 {{count}} 个模型。', {
        count: models.length
      }));
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '写入密钥模型失败。');
    } finally {
      setBusy(null);
    }
  };
  const toggleKeyModelEnabled = async (model: UpstreamKeyModel, enabled: boolean) => {
    if (!ensureLive()) return;
    setBusy(`key-model-${model.id}`);
    setUpstreamKeyModels(current => current ? current.map(row => row.id === model.id ? {
      ...row,
      enabled
    } : row) : current);
    try {
      await updateUpstreamKeyModel(props.settings, model.id, {
        enabled
      });
    } catch (error) {
      setUpstreamKeyModels(current => current ? current.map(row => row.id === model.id ? {
        ...row,
        enabled: model.enabled
      } : row) : current);
      props.onMessage(error instanceof Error ? error.message : '更新密钥模型状态失败。');
    } finally {
      setBusy(null);
    }
  };
  const removeKeyModel = async (model: UpstreamKeyModel) => {
    if (!ensureLive()) return;
    if (!window.confirm(t('确认删除密钥模型 {{name}}？', {
      name: model.model_name
    }))) return;
    setBusy(`key-model-${model.id}`);
    try {
      await deleteUpstreamKeyModel(props.settings, model.id);
      setUpstreamKeyModels(current => current ? current.filter(row => row.id !== model.id) : current);
      props.onMessage('已删除密钥模型。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '删除密钥模型失败。');
    } finally {
      setBusy(null);
    }
  };
  const syncModels = async (item: ProviderWorkspace) => {
    if (!ensureLive()) return;
    setBusy(`models-sync-${item.provider.id}`);
    try {
      const models = await syncProviderModels(props.settings, item.provider.id);
      setProviderModels(models);
      setProviderModelsError(null);
      setModelAliasDraft(current => {
        const next: Record<number, string> = {};
        for (const model of models) {
          next[model.id] = current[model.id] ?? model.alias ?? '';
        }
        return next;
      });
      props.onMessage(t('已同步 {{count}} 个模型。', {
        count: models.length
      }));
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '同步模型失败。');
    } finally {
      setBusy(null);
    }
  };
  const saveModelAlias = async (model: ProviderModel) => {
    const item = selected;
    if (!item || !ensureLive()) return;
    const trimmed = (modelAliasDraft[model.id] ?? '').trim();
    const nextAlias = trimmed.length > 0 ? trimmed : null;
    const existingAlias = (model.alias ?? '').trim() || null;
    if (nextAlias === existingAlias) return;
    setBusy(`provider-model-${model.id}`);
    try {
      await updateProviderModel(props.settings, model.id, {
        alias: trimmed
      });
      setProviderModels(current => current ? current.map(row => row.id === model.id ? {
        ...row,
        alias: nextAlias
      } : row) : current);
      setModelAliasDraft(current => ({
        ...current,
        [model.id]: nextAlias ?? ''
      }));
      props.onMessage('已保存别名。');
    } catch (error) {
      setModelAliasDraft(current => ({
        ...current,
        [model.id]: model.alias ?? ''
      }));
      props.onMessage(error instanceof Error ? error.message : '保存别名失败。');
    } finally {
      setBusy(null);
    }
  };
  const toggleModelEnabled = async (model: ProviderModel, enabled: boolean) => {
    const item = selected;
    if (!item || !ensureLive()) return;
    setBusy(`provider-model-${model.id}`);
    setProviderModels(current => current ? current.map(row => row.id === model.id ? {
      ...row,
      enabled
    } : row) : current);
    try {
      await updateProviderModel(props.settings, model.id, {
        enabled
      });
    } catch (error) {
      setProviderModels(current => current ? current.map(row => row.id === model.id ? {
        ...row,
        enabled: model.enabled
      } : row) : current);
      props.onMessage(error instanceof Error ? error.message : '更新模型状态失败。');
    } finally {
      setBusy(null);
    }
  };
  const toggleGatewayModelEnabled = async (upstreamModel: string, enabled: boolean) => {
    if (!ensureLive()) return;
    setBusy(`gateway-model-${upstreamModel}`);
    try {
      await updateGatewayModelPolicy(props.settings, {
        model_name: upstreamModel,
        enabled
      });
      const policies = await loadGatewayModelPolicies(props.settings);
      setGatewayModelPolicies(policies);
      setGatewayModelPoliciesError(null);
      props.onMessage(enabled ? '已取消全局禁用。' : '已全局禁用该模型。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新全局模型策略失败。');
    } finally {
      setBusy(null);
    }
  };
  const removeModel = async (model: ProviderModel) => {
    const item = selected;
    if (!item || !ensureLive()) return;
    if (!window.confirm(t('确认删除模型 {{name}}？', {
      name: model.upstream_model
    }))) return;
    setBusy(`provider-model-${model.id}`);
    try {
      await deleteProviderModel(props.settings, model.id);
      setProviderModels(current => current ? current.filter(row => row.id !== model.id) : current);
      setModelAliasDraft(current => {
        const next = {
          ...current
        };
        delete next[model.id];
        return next;
      });
      props.onMessage('已删除模型。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '删除模型失败。');
    } finally {
      setBusy(null);
    }
  };
  const submitAliasCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ensureLive()) return;
    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const name = readString(formData, 'alias_name');
    if (!name) {
      props.onMessage('模型名称不能为空。');
      return;
    }
    setBusy('alias-create');
    try {
      await createModelAlias(props.settings, {
        name,
        enabled: readBool(formData, 'alias_enabled'),
        mode: (readString(formData, 'alias_mode') || 'ordered') as 'ordered' | 'weighted'
      });
      (event.currentTarget as HTMLFormElement).reset();
      await props.onRefresh(t('模型 {{name}} 已创建。', {
        name
      }));
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '创建模型失败。');
    } finally {
      setBusy(null);
    }
  };
  const submitAliasUpdate = async (event: FormEvent<HTMLFormElement>, alias: ModelAlias) => {
    event.preventDefault();
    if (!ensureLive()) return;
    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const name = readString(formData, `alias_name_${alias.id}`);
    if (!name) {
      props.onMessage('模型名称不能为空。');
      return;
    }
    setBusy(`alias-${alias.id}`);
    try {
      await updateModelAlias(props.settings, alias.id, {
        name,
        enabled: readBool(formData, `alias_enabled_${alias.id}`),
        mode: (readString(formData, `alias_mode_${alias.id}`) || alias.mode) as 'ordered' | 'weighted'
      });
      await props.onRefresh(t('模型 {{name}} 已更新。', {
        name
      }));
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新模型失败。');
    } finally {
      setBusy(null);
    }
  };
  const submitAliasTargetCreate = async (event: FormEvent<HTMLFormElement>, alias: ModelAlias) => {
    event.preventDefault();
    if (!ensureLive()) return;
    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const upstreamModel = readString(formData, `alias_target_model_${alias.id}`);
    const providerId = readInt(formData, `alias_target_provider_${alias.id}`, 0);
    if (!upstreamModel || providerId <= 0) {
      props.onMessage('请选择上游并填写模型。');
      return;
    }
    setBusy(`alias-target-create-${alias.id}`);
    try {
      await createModelAliasTarget(props.settings, alias.id, {
        provider_id: providerId,
        upstream_model: upstreamModel,
        enabled: true,
        priority: readInt(formData, `alias_target_priority_${alias.id}`, 100),
        weight: readInt(formData, `alias_target_weight_${alias.id}`, 1)
      });
      (event.currentTarget as HTMLFormElement).reset();
      await props.onRefresh('模型目标已添加。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '添加模型目标失败。');
    } finally {
      setBusy(null);
    }
  };
  const toggleAliasTarget = async (targetId: number, enabled: boolean) => {
    if (!ensureLive()) return;
    setBusy(`alias-target-${targetId}`);
    try {
      await updateModelAliasTarget(props.settings, targetId, {
        enabled
      });
      await props.onRefresh(enabled ? '模型目标已启用。' : '模型目标已停用。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新模型目标失败。');
    } finally {
      setBusy(null);
    }
  };
  const removeAliasTarget = async (targetId: number) => {
    if (!ensureLive()) return;
    if (!window.confirm('确认删除这个模型目标？')) return;
    setBusy(`alias-target-${targetId}`);
    try {
      await deleteModelAliasTarget(props.settings, targetId);
      await props.onRefresh('模型目标已删除。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '删除模型目标失败。');
    } finally {
      setBusy(null);
    }
  };
  const removeAlias = async (alias: ModelAlias) => {
    if (!ensureLive()) return;
    if (!window.confirm(t('确认删除模型 {{name}}？', {
      name: alias.name
    }))) return;
    setBusy(`alias-${alias.id}`);
    try {
      await deleteModelAlias(props.settings, alias.id);
      await props.onRefresh('模型已删除。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '删除模型失败。');
    } finally {
      setBusy(null);
    }
  };
  return <Box className="section-stack">
      <PageHeader title="上游" description="查看连接目标、流量去向与健康状态。" actions={<Button type="button" disabled={!isLive()} className="rounded-none text-xs tracking-wider" onClick={() => {
      resetCreateForm();
      setCreateOpen(true);
    }}>
            <Plus className="mr-2 size-3" />
            {t('CREATE PROVIDER')}
          </Button>} />

      <StatsGrid items={stats()} />

      {!isLive() ? <Alert className="rounded-none border-border/40 bg-muted/20">
          <AlertTitle className="font-mono text-xs uppercase tracking-widest">{t("未连接后台")}</AlertTitle>
          <Typography className="mt-2 text-sm leading-5 text-muted-foreground opacity-80" component="div">{t("当前不能创建或修改上游，请先连接后台。")}</Typography>
        </Alert> : null}

      <Card>
        <Box className="flex flex-col gap-3 p-6 pb-6">
          <Typography className="text-xl font-medium tracking-tight text-foreground" component="div">{t("上游列表")}</Typography>
          <Typography className="mt-1 font-mono text-xs uppercase tracking-wider text-muted-foreground" component="div">{t('查看目标与健康状态。')}</Typography>
        </Box>
        <CardContent className="p-0 border-t border-border/40">
          {props.items.length > 0 ? <TableContainer><Table>
              <TableHead>
                <TableRow className="border-b border-border hover:bg-transparent">
                  <TableCell className="font-mono text-[0.65rem] uppercase tracking-widest h-10">{t("上游")}</TableCell>
                  <TableCell className="font-mono text-[0.65rem] uppercase tracking-widest h-10">{t("状态")}</TableCell>
                  <TableCell className="font-mono text-[0.65rem] uppercase tracking-widest h-10">{t("目标")}</TableCell>
                  <TableCell className="font-mono text-[0.65rem] uppercase tracking-widest h-10">{t("密钥")}</TableCell>
                  <TableCell className="font-mono text-[0.65rem] uppercase tracking-widest h-10">{t("优先级 / 权重")}</TableCell>
                  <TableCell className="font-mono text-[0.65rem] uppercase tracking-widest h-10">{t("最近错误")}</TableCell>
                  <TableCell className="font-mono text-[0.65rem] uppercase tracking-widest h-10 text-right">{t("操作")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {props.items.map(item => {
              const health = healthStatus(item.provider.health?.state, item.provider.health?.available);
              return <TableRow key={item.provider.id} className="cursor-pointer border-b border-border/40 hover:bg-muted/30 transition-colors" onClick={() => setSelectedProviderId(item.provider.id)}>
                        <TableCell>
                          <Box className="flex flex-col gap-1">
                            <Box className="text-sm font-medium text-foreground truncate max-w-[150px]" component="strong">{item.provider.name}</Box>
                            <Box className="font-mono text-[0.65rem] leading-[1.428571] uppercase tracking-widest text-muted-foreground opacity-70 truncate max-w-[150px]" component="span">{item.provider.provider_type}</Box>
                          </Box>
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone={health.tone}>{health.label}</StatusBadge>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{item.endpoints.length}</TableCell>
                        <TableCell className="font-mono text-xs">{item.keys.length}</TableCell>
                        <TableCell className="font-mono text-xs">
                          P{item.provider.priority} / W{item.provider.weight}
                        </TableCell>
                        <TableCell className="font-mono text-[0.65rem] uppercase tracking-widest opacity-80">{item.provider.health?.last_error_type ?? '—'}</TableCell>
                        <TableCell className="text-right">
                          <Button type="button" size="sm" variant="ghost" className="font-mono text-xs hover:bg-transparent hover:text-primary px-0 shrink-0" onClick={event => {
                    event.stopPropagation();
                    setSelectedProviderId(item.provider.id);
                  }}>{t("[ DETAILS ]")}</Button>
                        </TableCell>
                      </TableRow>;
            })}
              </TableBody>
            </Table></TableContainer> : <EmptyState title="NO PROVIDERS" description="先连接一个可用目标，再逐步补充更多目标和密钥。" action={<Button type="button" disabled={!isLive()} variant="ghost" onClick={() => {
          resetCreateForm();
          setCreateOpen(true);
        }}>
                    {t('CREATE PROVIDER')}
                  </Button>} />}
        </CardContent>
      </Card>

      <Card className="rounded-none border border-border bg-background shadow-none">
        <Box className="flex flex-col gap-3 p-6 pb-6">
          <Typography className="text-xl font-medium tracking-tight text-foreground" component="div">{t("模型配置")}</Typography>
          <Typography className="mt-1 font-mono text-xs uppercase tracking-wider text-muted-foreground" component="div">{t('用一个模型名称管理多个上游目标。')}</Typography>
        </Box>
        <CardContent className="grid gap-6 border-t border-border/40 pt-6">
          <Box className="grid gap-4 xl:grid-cols-[minmax(160px,1fr)_150px_120px_120px]" onSubmit={event => void submitAliasCreate(event)} component="form">
            <InputBase name="alias_name" placeholder={t("gpt-5")} className="bg-background" />
            <Select name="alias_mode" defaultValue="ordered">
              <MenuItem value="ordered">按顺序</MenuItem>
              <MenuItem value="weighted">按权重</MenuItem>
            </Select>
            <Box className="flex min-h-10 items-center gap-3 border border-border/40 px-3 text-sm text-muted-foreground" component="label">
              <Checkbox name="alias_enabled" defaultChecked />
              <Box component="span">{t('启用')}</Box>
            </Box>
            <Button type="submit" disabled={busy === 'alias-create'}>
              {busy === 'alias-create' ? '创建中…' : '新增模型'}
            </Button>
          </Box>

          {props.aliases.length > 0 ? <Box className="grid gap-5">
              {props.aliases.map(alias => <Box key={alias.id} className="border border-border/40 bg-muted/5 p-5">
                    <Box className="grid gap-4 xl:grid-cols-[minmax(160px,1fr)_150px_120px_160px]" onSubmit={event => void submitAliasUpdate(event, alias)} component="form">
                      <InputBase name={`alias_name_${alias.id}`} defaultValue={alias.name} className="bg-background" />
                      <Select name={`alias_mode_${alias.id}`} defaultValue={alias.mode}>
                        <MenuItem value="ordered">按顺序</MenuItem>
                        <MenuItem value="weighted">按权重</MenuItem>
                      </Select>
                      <Box className="check-row min-h-10 py-2" component="label">
                        <Checkbox name={`alias_enabled_${alias.id}`} defaultChecked={alias.enabled} />
                        <Box component="span">{t('启用')}</Box>
                      </Box>
                      <Box className="flex gap-2">
                        <Button type="submit" size="sm" disabled={busy === `alias-${alias.id}`}>{t("保存")}</Button>
                        <Button type="button" size="sm" variant="ghost" aria-label={t('删除模型')} onClick={() => void removeAlias(alias)}>
                          <Trash2 className="size-4" />
                        </Button>
                      </Box>
                    </Box>

                    <Box className="mt-5 overflow-x-auto border border-border/30">
                      <TableContainer><Table>
                        <TableHead>
                          <TableRow>
                            <TableCell>{t("上游")}</TableCell>
                            <TableCell>{t("模型")}</TableCell>
                            <TableCell>{t("优先级")}</TableCell>
                            <TableCell>{t("权重")}</TableCell>
                            <TableCell>{t("状态")}</TableCell>
                            <TableCell className="text-right">{t("操作")}</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {alias.targets.length > 0 ? alias.targets.map(target => <TableRow key={target.id}>
                                  <TableCell>{props.items.find(item => item.provider.id === target.provider_id)?.provider.name ?? `#${target.provider_id}`}</TableCell>
                                  <TableCell className="font-mono text-xs">{target.upstream_model}</TableCell>
                                  <TableCell className="font-mono text-xs">{target.priority}</TableCell>
                                  <TableCell className="font-mono text-xs">{target.weight}</TableCell>
                                  <TableCell>
                                    <StatusBadge tone={target.enabled ? 'normal' : 'warning'}>{target.enabled ? '启用' : '停用'}</StatusBadge>
                                  </TableCell>
                                  <TableCell className="text-right">
                                    <Box className="flex justify-end gap-2">
                                      <Button type="button" size="sm" variant="ghost" onClick={() => void toggleAliasTarget(target.id, !target.enabled)}>
                                        {t(target.enabled ? '停用' : '启用')}
                                      </Button>
                                      <Button type="button" size="sm" variant="ghost" aria-label={t('删除目标')} onClick={() => void removeAliasTarget(target.id)}>
                                        <Trash2 className="size-4" />
                                      </Button>
                                    </Box>
                                  </TableCell>
                                </TableRow>) : <TableRow>
                                <TableCell colSpan={6} className="text-center text-muted-foreground">
                                  {t('暂无目标。')}
                                </TableCell>
                              </TableRow>}
                        </TableBody>
                      </Table></TableContainer>
                    </Box>

                    <Box className="mt-4 grid gap-4 xl:grid-cols-[180px_minmax(160px,1fr)_110px_110px_120px]" onSubmit={event => void submitAliasTargetCreate(event, alias)} component="form">
                      <Select displayEmpty name={`alias_target_provider_${alias.id}`} defaultValue="">
                        <MenuItem value="">选择上游</MenuItem>
                        {props.items.map(item => <MenuItem key={item.provider.id} value={item.provider.id}>{item.provider.name}</MenuItem>)}
                      </Select>
                      <InputBase name={`alias_target_model_${alias.id}`} placeholder={t("上游模型名称")} className="bg-background" />
                      <InputBase name={`alias_target_priority_${alias.id}`} type="number" defaultValue="100" className="bg-background" />
                      <InputBase name={`alias_target_weight_${alias.id}`} type="number" defaultValue="1" className="bg-background" />
                      <Button type="submit" disabled={busy === `alias-target-create-${alias.id}`}>{t("添加目标")}</Button>
                    </Box>
                  </Box>)}
            </Box> : <EmptyState title="暂无模型配置" description="新增一个模型名称后，再为它添加上游目标。" />}
        </CardContent>
      </Card>

      <DetailDrawer open={createOpen} title="NEW PROVIDER" description="填写必要信息即可创建。" onClose={() => setCreateOpen(false)}>
        <Box className="flex flex-col gap-6" onSubmit={event => void submitProviderCreate(event)} component="form">
          <Box className="grid gap-6 md:grid-cols-2">
            <FormControl>
              <FormLabel>{t("名称")}</FormLabel>
              <InputBase name="name" value={createName} onChange={event => {
              setCreateName(event.target.value);
              setCreateSubmitError(null);
            }} placeholder={t("openai-prod")} className="bg-background" />
            </FormControl>
            <FormControl>
              <FormLabel>{t("类型")}</FormLabel>
              <Select name="provider_type" value={createProviderType} onChange={event => setCreateProviderType(event.target.value)}>
                {PROVIDER_TYPE_OPTIONS.map(option => <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>)}
              </Select>
              <FormHelperText className="mt-2">{providerTypeDescription(createProviderType)}</FormHelperText>
            </FormControl>
          </Box>
          <Box className="grid gap-6">
            <FormControl>
              <Box className="flex items-center justify-between gap-3">
                <FormLabel>{t("服务地址")}</FormLabel>
                <Button type="button" size="icon" variant="ghost" aria-label={t('添加服务地址')} onClick={addCreateBaseUrl}>
                  <Plus className="size-4" />
                </Button>
              </Box>
              <Box className="grid gap-3">
                {createBaseUrls.map((row, index) => <Box key={row.id} className="grid gap-2 sm:grid-cols-[2rem_minmax(0,1fr)_2.5rem]">
                      <Box className="flex h-10 items-center justify-center font-mono text-xs text-muted-foreground">{index + 1}</Box>
                      <InputBase type="url" value={row.value} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={event => updateCreateBaseUrl(row.id, event.target.value)} placeholder={t("https://api.example.com")} className="bg-background" />
                      <Button type="button" size="icon" variant="ghost" aria-label={t('移除服务地址')} onClick={() => removeCreateBaseUrl(row.id)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </Box>)}
              </Box>
            </FormControl>
            <FormControl>
              <Box className="flex items-center justify-between gap-3">
                <FormLabel>{t("API 密钥")}</FormLabel>
                <Button type="button" size="icon" variant="ghost" aria-label={t('添加 API 密钥')} onClick={addCreateApiKey}>
                  <Plus className="size-4" />
                </Button>
              </Box>
              <Box className="grid gap-3">
                {createApiKeys.map((row, index) => <Box key={row.id} className="grid gap-2 sm:grid-cols-[2rem_minmax(0,1fr)_2.5rem]">
                      <Box className="flex h-10 items-center justify-center font-mono text-xs text-muted-foreground">{index + 1}</Box>
                      <InputBase type="password" value={row.value} autoComplete="new-password" autoCapitalize="none" spellCheck={false} onChange={event => updateCreateApiKey(row.id, event.target.value)} placeholder={t("sk-...")} className="bg-background" />
                      <Button type="button" size="icon" variant="ghost" aria-label={t('移除 API 密钥')} onClick={() => removeCreateApiKey(row.id)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </Box>)}
              </Box>
            </FormControl>
          </Box>
          <Box className="grid gap-4 md:grid-cols-4">
            <Box className="flex items-center gap-3 border border-border/40 bg-transparent px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors" component="label">
              <Checkbox name="enabled" defaultChecked />
              <Box component="span">{t('创建后启用')}</Box>
            </Box>
            <Box className="flex items-center gap-3 border border-border/40 bg-transparent px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors" component="label">
              <Checkbox name="supports_include_usage" defaultChecked />
              <Box component="span">{t('补充用量')}</Box>
            </Box>
            <Box className="flex items-center gap-3 border border-border/40 bg-transparent px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors" component="label">
              <Checkbox name="websocket_enabled" />
              <Box component="span">{t('WebSocket')}</Box>
            </Box>
            <Box className="flex items-center gap-3 border border-border/40 bg-transparent px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors" component="label">
              <Checkbox name="responses_http_to_ws" />
              <Box component="span">{t('HTTP→WS Beta')}</Box>
            </Box>
          </Box>
          <Box className="border border-border/40 bg-transparent p-4 text-sm text-muted-foreground font-mono">
            {createFormHint()}
          </Box>
          {createSubmitError ? <Alert className="rounded-none border-border/40 bg-muted/20" severity="error" variant="outlined">
              <AlertTitle className="font-mono text-xs uppercase tracking-widest">{t("创建失败")}</AlertTitle>
              <Typography className="text-[0.8rem] leading-relaxed text-muted-foreground mt-2 opacity-80" component="div">{createSubmitError}</Typography>
            </Alert> : null}
          <Box className="flex justify-end border-t border-border/40 pt-6 mt-2">
            <Button type="submit" disabled={busy === 'create-provider' || createMissingFields().length > 0} className="rounded-none font-mono text-xs tracking-widest px-8">
              {busy === 'create-provider' ? 'CREATING...' : 'CREATE'}
            </Button>
          </Box>
        </Box>
      </DetailDrawer>

      <DetailDrawer open={!!selected} title={selected?.provider.name ?? '上游详情'} description={selected ? '连接目标、健康状态与编辑入口。' : undefined} onClose={() => {
      setSelectedProviderId(null);
      setTestResult(null);
    }}>
        {selected ? (itemSignal => {
        const item = itemSignal;
        const health = healthStatus(item.provider.health?.state, item.provider.health?.available);
        return <Box className="flex flex-col gap-8">
                <Box className="grid gap-6 md:grid-cols-4 border-b border-border/40 pb-8">
                  <Box className="flex flex-col gap-2 border-l border-border/40 pl-4 border-l-2 border-l-primary">
                      <Box className="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground opacity-70">{t('状态')}</Box>
                      <Box className="mt-2">
                        <StatusBadge tone={health.tone}>{health.label}</StatusBadge>
                      </Box>
                  </Box>
                  <Box className="flex flex-col gap-2 border-l border-border/40 pl-4 border-l-2 border-l-primary/20">
                      <Box className="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground opacity-70">{t('目标')}</Box>
                      <Box className="mt-2 text-2xl font-medium tracking-tight text-foreground">{item.endpoints.length}</Box>
                  </Box>
                  <Box className="flex flex-col gap-2 border-l border-border/40 pl-4 border-l-2 border-l-primary/20">
                      <Box className="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground opacity-70">{t('上游密钥')}</Box>
                      <Box className="mt-2 text-2xl font-medium tracking-tight text-foreground">{item.keys.length}</Box>
                  </Box>
                  <Box className="flex flex-col gap-2 border-l border-border/40 pl-4 border-l-2 border-l-primary/20">
                      <Box className="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground opacity-70">{t('最近成功')}</Box>
                      <Box className="mt-2 font-mono text-sm tracking-tight pt-1 text-muted-foreground">
                        {item.provider.health?.last_success_at_ms ? formatDateTime(item.provider.health.last_success_at_ms) : '—'}
                      </Box>
                  </Box>
                </Box>

                <Box className="flex flex-col gap-6" onSubmit={event => void submitProviderUpdate(event, item)} component="form">
                  <Box className="flex items-center gap-3 border-b border-border/40 pb-4">
                    <ShieldCheck className="size-4 opacity-70" />
                    <Box className="text-base font-medium tracking-tight text-foreground uppercase" component="h3">{t('上游信息')}</Box>
                  </Box>
                  <Box className="grid gap-6 pt-4 md:grid-cols-2">
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
                      <FormHelperText>{providerTypeDescription(providerTypeDraft || item.provider.provider_type)}</FormHelperText>
                    </FormControl>
                  </Box>
                  <Box className="grid gap-4 md:grid-cols-4">
                    <Box className="flex items-center gap-3 border border-border/40 bg-transparent px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors" component="label">
                      <Checkbox name="provider_enabled" defaultChecked={item.provider.enabled} />
                      <Box component="span">{t('启用上游')}</Box>
                    </Box>
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
                  <Box className="flex justify-end pt-4 border-t border-border/40 mt-2">
                    <Button type="submit" disabled={busy === `provider-${item.provider.id}`}>
                      {busy === `provider-${item.provider.id}` ? '保存中…' : t('SAVE PROVIDER')}
                    </Button>
                  </Box>
                </Box>

                <Box className="grid gap-4 mt-8" component="section">
                  <Box className="flex items-center justify-between border-b border-border/40 pb-4">
                    <Box className="flex items-center gap-3">
                      <Stethoscope className="size-4 opacity-70" />
                      <Box className="text-base font-medium tracking-tight text-foreground uppercase" component="h3">{t('服务地址')}</Box>
                    </Box>
                    <StatusBadge tone="normal">{String(item.endpoints.length)}</StatusBadge>
                  </Box>
                  <Box className="grid gap-3">
                    {item.endpoints.map((endpoint, index) => {
                const endpointHealth = healthStatus(endpoint.health?.state, endpoint.health?.available);
                return <Box key={endpoint.id} className="grid gap-3 border border-border/40 bg-muted/5 p-3 xl:grid-cols-[2.5rem_minmax(9rem,0.45fr)_minmax(18rem,1fr)_7rem_12rem]" onSubmit={event => void submitEndpointUpdate(event, endpoint.id)} onDragOver={event => event.preventDefault()} onDrop={() => void reorderEndpoints(item, endpoint.id)} component="form">
                            <Button type="button" size="icon" className="flex size-10 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing" aria-label={t('调整服务地址顺序')} title={t('调整服务地址顺序')} draggable onDragStart={() => setDraggingEndpointId(endpoint.id)} onDragEnd={() => setDraggingEndpointId(null)} variant="ghost">
                              <GripVertical className="size-4" />
                            </Button>
                            <InputBase name={`endpoint_name_${endpoint.id}`} defaultValue={endpoint.name || `地址 ${index + 1}`} autoComplete="off" className="bg-background" />
                            <InputBase name={`endpoint_base_url_${endpoint.id}`} defaultValue={endpoint.base_url} autoComplete="off" autoCapitalize="none" spellCheck={false} className="bg-background font-mono text-xs" />
                            <Box className="check-row h-10 px-3 py-0" component="label">
                              <Checkbox name={`endpoint_enabled_${endpoint.id}`} defaultChecked={endpoint.enabled} />
                              <Box component="span">{t('启用')}</Box>
                            </Box>
                            <Box className="flex items-center justify-end gap-2">
                              <StatusBadge tone={endpointHealth.tone}>{endpointHealth.label}</StatusBadge>
                              <Button type="button" size="icon" variant="ghost" className="min-w-0" aria-label={t('测试连接')} disabled={busy === `test-${endpoint.id}`} onClick={() => void handleTestEndpoint(endpoint.id)}>
                                <Stethoscope className="size-4" />
                              </Button>
                              <Button type="submit" size="icon" variant="ghost" className="min-w-0" aria-label={t('保存服务地址')} disabled={busy === `endpoint-${endpoint.id}`}>
                                <Save className="size-4" />
                              </Button>
                              <Button type="button" size="icon" variant="ghost" className="min-w-0" aria-label={t('删除服务地址')} disabled={busy === `endpoint-delete-${endpoint.id}`} onClick={() => void removeEndpoint(endpoint)}>
                                <Trash2 className="size-4" />
                              </Button>
                            </Box>
                          </Box>;
              })}
                    <Box className="grid gap-3 border border-dashed border-border/60 bg-transparent p-3 xl:grid-cols-[2.5rem_minmax(9rem,0.45fr)_minmax(18rem,1fr)_7rem_8rem]" onSubmit={event => void submitEndpointCreate(event, item)} component="form">
                      <Box className="flex size-10 items-center justify-center font-mono text-xs text-muted-foreground">{item.endpoints.length + 1}</Box>
                      <InputBase name="endpoint_name" placeholder={`地址 ${item.endpoints.length + 1}`} autoComplete="off" />
                      <InputBase name="endpoint_base_url" placeholder={t("https://api.example.com")} autoComplete="off" autoCapitalize="none" spellCheck={false} className="font-mono text-xs" />
                      <Box className="check-row h-10 px-3 py-0" component="label">
                        <Checkbox name="endpoint_enabled" defaultChecked />
                        <Box component="span">{t('启用')}</Box>
                      </Box>
                      <Button type="submit" disabled={busy === `endpoint-create-${item.provider.id}`}>
                        <Plus className="size-4" />
                        {t('添加')}
                      </Button>
                    </Box>
                  </Box>
                </Box>

                <Box className="grid gap-4 mt-8" component="section">
                  <Box className="flex items-center justify-between border-b border-border/40 pb-4">
                    <Box className="flex items-center gap-3">
                      <AlertCircle className="size-4 opacity-70" />
                      <Box className="text-base font-medium tracking-tight text-foreground uppercase" component="h3">{t('API 密钥')}</Box>
                    </Box>
                    <StatusBadge tone="normal">{String(item.keys.length)}</StatusBadge>
                  </Box>
                  <Box className="grid gap-3">
                    {item.keys.map((key, index) => {
                const keyHealth = healthStatus(key.health?.state, key.health?.available);
                return <Box key={key.id} className="grid gap-3 border border-border/40 bg-muted/5 p-3 xl:grid-cols-[2.5rem_minmax(9rem,0.45fr)_minmax(18rem,1fr)_7rem_10rem]" onSubmit={event => void submitKeyUpdate(event, key.id)} onDragOver={event => event.preventDefault()} onDrop={() => void reorderKeys(item, key.id)} component="form">
                            <Button type="button" className="flex size-10 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing" aria-label={t('调整 API 密钥顺序')} title={t('调整 API 密钥顺序')} draggable onDragStart={() => setDraggingKeyId(key.id)} onDragEnd={() => setDraggingKeyId(null)} variant="ghost">
                              <GripVertical className="size-4" />
                            </Button>
                            <InputBase name={`upstream_key_name_${key.id}`} defaultValue={key.name || `密钥 ${index + 1}`} autoComplete="off" className="bg-background" />
                            <InputBase name={`upstream_key_secret_${key.id}`} type="password" autoComplete="new-password" placeholder={t("留空表示不修改")} className="bg-background font-mono text-xs" />
                            <Box className="check-row h-10 px-3 py-0" component="label">
                              <Checkbox name={`upstream_key_enabled_${key.id}`} defaultChecked={key.enabled} />
                              <Box component="span">{t('启用')}</Box>
                            </Box>
                            <Box className="flex items-center justify-end gap-2">
                              <StatusBadge tone={keyHealth.tone}>{keyHealth.label}</StatusBadge>
                              <Button type="submit" size="icon" variant="ghost" aria-label={t('保存 API 密钥')} disabled={busy === `key-${key.id}`}>
                                <Save className="size-4" />
                              </Button>
                              <Button type="button" size="icon" variant="ghost" aria-label={t('删除 API 密钥')} disabled={busy === `key-delete-${key.id}`} onClick={() => void removeProviderKey(key)}>
                                <Trash2 className="size-4" />
                              </Button>
                            </Box>
                          </Box>;
              })}
                    <Box className="grid gap-3 border border-dashed border-border/60 bg-transparent p-3 xl:grid-cols-[2.5rem_minmax(9rem,0.45fr)_minmax(18rem,1fr)_7rem_8rem]" onSubmit={event => void submitKeyCreate(event, item)} component="form">
                      <Box className="flex size-10 items-center justify-center font-mono text-xs text-muted-foreground">{item.keys.length + 1}</Box>
                      <InputBase name="upstream_key_name" placeholder={`密钥 ${item.keys.length + 1}`} autoComplete="off" />
                      <InputBase name="upstream_key_secret" type="password" placeholder={t("sk-...")} autoComplete="new-password" className="font-mono text-xs" />
                      <Box className="check-row h-10 px-3 py-0" component="label">
                        <Checkbox name="upstream_key_enabled" defaultChecked />
                        <Box component="span">{t('启用')}</Box>
                      </Box>
                      <Button type="submit" disabled={busy === `key-create-${item.provider.id}`}>
                        <Plus className="size-4" />
                        {t('添加')}
                      </Button>
                    </Box>
                  </Box>
                </Box>

                <Box className="grid gap-6 mt-8" component="section">
                  <Box className="flex items-center justify-between border-b border-border/40 pb-4">
                    <Box className="flex items-center gap-3">
                      <ShieldCheck className="size-4 opacity-70" />
                      <Box className="text-base font-medium tracking-tight text-foreground uppercase" component="h3">{t('密钥模型限制')}</Box>
                    </Box>
                  </Box>

                  {isLive() ? <Card className="rounded-none border border-border bg-background shadow-none">
                      <Box className="flex flex-row items-start justify-between gap-6 p-6 pb-6">
                        <Box className="grid gap-2">
                          <Typography className="text-xl font-medium tracking-tight text-foreground" component="div">{t("按密钥限制模型")}</Typography>
                          <Typography className="mt-1 font-mono text-[0.65rem] uppercase leading-5 tracking-wider text-muted-foreground" component="div">{t('未设置时允许所有模型；设置后只允许列表中的模型。')}</Typography>
                        </Box>
                        <Box className="flex flex-wrap items-center gap-3">
                          <Select displayEmpty value={selectedUpstreamKeyId === null ? '' : String(selectedUpstreamKeyId)} onChange={event => {
                    const raw = event.target.value.trim();
                    const parsed = Number.parseInt(raw, 10);
                    setSelectedUpstreamKeyId(Number.isFinite(parsed) ? parsed : null);
                  }} disabled={item.keys.length === 0} className="w-[240px]">
                            <MenuItem value="">{t('选择密钥…')}</MenuItem>
                            {item.keys.map(key => <MenuItem key={key.id} value={String(key.id)}>{key.name} (#{key.id})</MenuItem>)}
                          </Select>
                          <Button type="button" size="sm" className="rounded-none text-xs tracking-wider" onClick={() => {
                    const keyId = selectedUpstreamKeyId;
                    if (keyId === null) {
                      props.onMessage('请先选择一个密钥。');
                      return;
                    }
                    void syncKeyModels(keyId);
                  }} disabled={selectedUpstreamKeyId === null || busy === `key-models-sync-${selectedUpstreamKeyId ?? 0}`}>
                            <RefreshCw className="mr-2 size-3" />
                            {t('SYNC')}
                          </Button>
                        </Box>
                      </Box>
                      <CardContent className="grid gap-6 border-t border-border/40 pt-6">
                        {upstreamKeyModelsError ? (message => <Box className="border border-border/40 bg-background px-4 py-4 font-mono text-xs text-muted-foreground opacity-80">{message}</Box>)(upstreamKeyModelsError) : null}

                        {item.keys.length > 0 ? <><Box className="flex flex-col gap-4 border border-dashed border-border/60 bg-transparent p-6">
                            <FormControl>
                              <FormLabel>{t("添加模型（逗号或空格分隔）")}</FormLabel>
                              <Box className="flex items-center gap-2">
                                <InputBase value={upstreamKeyModelsDraft} placeholder={t("gpt-4.1, o4-mini …")} disabled={selectedUpstreamKeyId === null || busy === `key-models-add-${selectedUpstreamKeyId ?? 0}`} onChange={event => setUpstreamKeyModelsDraft(event.target.value)} className="font-mono text-sm" />
                                <Button type="button" size="sm" className="rounded-none font-mono text-[0.65rem] uppercase tracking-widest px-6 whitespace-nowrap" onClick={() => {
                          const keyId = selectedUpstreamKeyId;
                          if (keyId === null) {
                            props.onMessage('请先选择一个密钥。');
                            return;
                          }
                          void addKeyModels(keyId);
                        }} disabled={selectedUpstreamKeyId === null || busy === `key-models-add-${selectedUpstreamKeyId ?? 0}`}>
                                  {t('添加模型')}
                                </Button>
                              </Box>
                            </FormControl>
                          </Box><TableContainer className="border-border/40 bg-muted/5">
                            {(() => {
                      const keyId = selectedUpstreamKeyId;
                      if (keyId === null) {
                        return <Box className="px-6 py-8 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground opacity-60">
                                    {t('请选择一个密钥。')}
                                  </Box>;
                      }
                      const models = upstreamKeyModels;
                      if (models === null) {
                        return <Box className="px-6 py-8 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground opacity-60">
                                    {t('读取中…')}
                                  </Box>;
                      }
                      if (models.length === 0) {
                        return <Box className="px-6 py-8 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground opacity-60">
                                    {t('当前未限制模型；同步或添加后将按列表限制。')}
                                  </Box>;
                      }
                      return <Table>
                                  <TableHead>
                                    <TableRow className="border-b border-border/40 hover:bg-transparent bg-background">
                                      <TableCell className="h-10">{t("模型")}</TableCell>
                                      <TableCell className="h-10">{t("启用")}</TableCell>
                                      <TableCell className="h-10 text-right">{t("操作")}</TableCell>
                                    </TableRow>
                                  </TableHead>
                                  <TableBody>
                                    {models.map(model => <TableRow key={model.id} className={`border-b border-border/40 hover:bg-muted/30 transition-colors ${model.enabled ? '' : 'opacity-50'}`}>
                                          <TableCell className="font-mono text-sm max-w-[200px] truncate" title={model.model_name}>{model.model_name}</TableCell>
                                          <TableCell>
                                            <Checkbox checked={model.enabled} disabled={busy === `key-model-${model.id}`} onChange={event => void toggleKeyModelEnabled(model, event.currentTarget.checked)} />
                                          </TableCell>
                                          <TableCell className="text-right">
                                            <Button type="button" size="sm" variant="ghost" className="font-mono text-[0.65rem] uppercase tracking-widest hover:bg-transparent hover:text-destructive px-0 shrink-0" onClick={() => void removeKeyModel(model)} disabled={busy === `key-model-${model.id}`}>
                                              {t('移除')}
                                            </Button>
                                          </TableCell>
                                        </TableRow>)}
                                  </TableBody>
                                </Table>;
                    })()}
                          </TableContainer></> : <Box className="border border-dashed border-border/60 bg-transparent px-4 py-6 text-sm text-muted-foreground opacity-70">
                              {t('还没有上游密钥，请先创建。')}
                            </Box>}
                      </CardContent>
                    </Card> : <Card className="rounded-none border border-border bg-background shadow-none">
                        <CardContent className="p-6 font-mono text-xs uppercase tracking-widest text-muted-foreground opacity-70">
                          连接后台后可为每个上游密钥设置可用模型。
                        </CardContent>
                      </Card>}
                </Box>

                <Box className="grid gap-6 mt-8 pb-8" component="section">
                  <Box className="flex items-center justify-between border-b border-border/40 pb-4">
                    <Box className="flex items-center gap-3">
                      <RefreshCw className="size-4 opacity-70" />
                      <Box className="text-base font-medium tracking-tight text-foreground uppercase" component="h3">{t('模型')}</Box>
                    </Box>
                  </Box>

                  {isLive() ? <Card className="rounded-none border border-border bg-background shadow-none">
                      <Box className="flex flex-row items-start justify-between gap-6 p-6 pb-6">
                        <Box className="grid gap-2">
                          <Typography className="text-xl font-medium tracking-tight text-foreground" component="div">{t("可用模型")}</Typography>
                          <Typography className="mt-1 font-mono text-[0.65rem] uppercase leading-5 tracking-wider text-muted-foreground" component="div">{t('同步模型并管理显示名称与启用状态。')}</Typography>
                        </Box>
                        <Button type="button" size="sm" className="rounded-none text-xs tracking-wider" onClick={() => void syncModels(item)} disabled={busy === `models-sync-${item.provider.id}`}>
                          <RefreshCw className="mr-2 size-3" />
                          {t('SYNC MODELS')}
                        </Button>
                      </Box>
                      <CardContent className="grid gap-0 border-t border-border/40 p-0">
                        {providerModelsError ? (message => <Box className="border-b border-border/40 bg-background px-6 py-4 font-mono text-xs text-muted-foreground opacity-80">{message}</Box>)(providerModelsError) : null}
                        {gatewayModelPoliciesError ? (message => <Box className="border-b border-border/40 bg-background px-6 py-4 font-mono text-xs text-muted-foreground opacity-80">
                               {t('模型开关：{{message}}', {
                    message: message
                  })}
                             </Box>)(gatewayModelPoliciesError) : null}

                        {(() => {
                  const models = providerModels;
                  if (models === null) {
                    return <Box className="px-6 py-8 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground opacity-60">
                                {t('读取中…')}
                              </Box>;
                  }
                  if (models.length === 0) {
                    return <Box className="px-6 py-8 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground opacity-60">
                                {t('NO MODELS. CLICK SYNC TO FETCH.')}
                              </Box>;
                  }
                  return <TableContainer><Table>
                              <TableHead>
                                <TableRow className="border-b border-border/40 hover:bg-transparent bg-muted/5">
                                  <TableCell className="h-10">{t("上游名称")}</TableCell>
                                  <TableCell className="h-10 w-[240px]">{t("显示名称")}</TableCell>
                                  <TableCell className="h-10 text-center w-[80px]">{t("启用")}</TableCell>
                                  <TableCell className="h-10 text-center w-[80px]">{t("全局")}</TableCell>
                                  <TableCell className="h-10 text-right w-[100px]">{t("操作")}</TableCell>
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                {models.map(model => {
                        const globallyDisabled = () => disabledGatewayModels().has(model.upstream_model);
                        return <TableRow key={model.id} className={`border-b border-border/40 hover:bg-muted/30 transition-colors ${model.enabled && !globallyDisabled() ? '' : 'opacity-50'}`}>
                                      <TableCell className="font-mono text-sm max-w-[200px] truncate" title={model.upstream_model}>{model.upstream_model}</TableCell>
                                      <TableCell className="p-2">
                                        <Box className="flex items-center">
                                          <InputBase value={modelAliasDraft[model.id] ?? model.alias ?? ''} placeholder={t("无别名")} disabled={busy === `provider-model-${model.id}`} className="h-8 font-mono text-xs border-transparent bg-transparent hover:border-border/40 focus:border-primary px-2 transition-colors" onChange={event => setModelAliasDraft(current => ({
                                ...current,
                                [model.id]: (event.currentTarget as HTMLInputElement).value
                              }))} onBlur={() => void saveModelAlias(model)} />
                                        </Box>
                                      </TableCell>
                                      <TableCell className="text-center">
                                        <Checkbox checked={model.enabled} disabled={busy === `provider-model-${model.id}`} onChange={event => void toggleModelEnabled(model, event.currentTarget.checked)} />
                                      </TableCell>
                                      <TableCell className="text-center">
                                        <Checkbox checked={!globallyDisabled()} disabled={busy === `gateway-model-${model.upstream_model}` || gatewayModelPolicies === null} onChange={event => void toggleGatewayModelEnabled(model.upstream_model, event.currentTarget.checked)} />
                                      </TableCell>
                                      <TableCell className="text-right p-2">
                                        <Button type="button" size="icon" variant="ghost" className="size-8 hover:text-destructive opacity-70 hover:opacity-100" aria-label={t('删除模型')} onClick={() => void removeModel(model)} disabled={busy === `provider-model-${model.id}`}>
                                          <Trash2 className="size-3" />
                                        </Button>
                                      </TableCell>
                                    </TableRow>;
                      })}
                              </TableBody>
                            </Table></TableContainer>;
                })()}
                      </CardContent>
                    </Card> : <Card className="rounded-none border border-border bg-background shadow-none">
                        <CardContent className="p-6 font-mono text-xs uppercase tracking-widest text-muted-foreground opacity-70">
                          连接后台后可同步模型，并管理显示名称和启用状态。
                        </CardContent>
                      </Card>}
                </Box>

                {testResult ? (result => <Card className="rounded-none border border-border bg-background shadow-none mb-8">
                      <Box className="flex flex-col gap-3 p-6 pb-4">
                        <Typography className="text-lg font-medium tracking-tight text-foreground" component="div">{t("最近测试结果")}</Typography>
                      </Box>
                      <CardContent className="grid gap-2 font-mono text-sm border-t border-border/40 pt-4">
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
              </Box>;
      })(selected) : null}
      </DetailDrawer>
    </Box>;
}
