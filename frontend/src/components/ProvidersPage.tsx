import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { AlertCircle, Copy, Plus, RefreshCw, Save, ShieldCheck, Stethoscope, Trash2 } from 'lucide-solid';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DetailDrawer } from '@/components/console/DetailDrawer';
import { EmptyState } from '@/components/console/EmptyState';
import { PageHeader } from '@/components/console/PageHeader';
import { StatsGrid, type StatItem } from '@/components/console/StatsGrid';
import { StatusBadge } from '@/components/console/StatusBadge';
import {
  addUpstreamKeyModels,
  createEndpoint,
  createProvider,
  createProviderKey,
  deleteUpstreamKeyModel,
  deleteProviderModel,
  getCodexOauthRequest,
  loadGatewayModelPolicies,
  loadProviderModels,
  loadUpstreamKeyModels,
  startCodexOauth,
  syncUpstreamKeyModels,
  syncProviderModels,
  testEndpointConnection,
  updateGatewayModelPolicy,
  updateEndpoint,
  updateProvider,
  updateUpstreamKeyModel,
  updateProviderModel,
  updateProviderKey,
} from '../lib/api';
import { formatDateTime, formatMs } from '../lib/format';
import type {
  CodexOauthRequestView,
  CodexOauthStartResponse,
  ConnectionSettings,
  CreateEndpointInput,
  CreateProviderInput,
  CreateProviderKeyInput,
  GatewayModelPolicy,
  ProviderModel,
  ProviderWorkspace,
  UpstreamKeyModel,
  UpdateEndpointInput,
  UpdateProviderInput,
  UpdateProviderKeyInput,
} from '../lib/types';

interface ProvidersPageProps {
  settings: ConnectionSettings;
  items: ProviderWorkspace[];
  onRefresh: (successMessage?: string) => Promise<void>;
  onMessage: (message: string) => void;
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
  const items = raw
    .split(/[\s,]+/g)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const unique = Array.from(new Set(items));
  unique.sort((a, b) => a.localeCompare(b));
  return unique;
}

function healthStatus(state?: string, available?: boolean) {
  if (!available || state === 'open') return { label: '异常', tone: 'error' as const };
  if (state === 'half_open') return { label: '警告', tone: 'warning' as const };
  return { label: '正常', tone: 'normal' as const };
}

const PROVIDER_TYPE_OPTIONS = [
  { value: 'openai', label: 'OpenAI', description: '官方 OpenAI 服务' },
  { value: 'openai_compatible', label: 'OpenAI Compatible', description: '兼容 OpenAI 协议的第三方或自建服务' },
  { value: 'openai_codex_oauth', label: 'OpenAI Codex OAuth', description: '通过 Codex 登录获取授权' },
  { value: 'openai_compatible_responses', label: 'OpenAI Compatible (Responses)', description: '仅用于响应式接口的兼容服务' },
] as const;

export function ProvidersPage(props: ProvidersPageProps) {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [createOpen, setCreateOpen] = createSignal(false);
  const [createName, setCreateName] = createSignal('');
  const [createBaseUrl, setCreateBaseUrl] = createSignal('');
  const [createApiKey, setCreateApiKey] = createSignal('');
  const [createSubmitError, setCreateSubmitError] = createSignal<string | null>(null);
  const [selectedProviderId, setSelectedProviderId] = createSignal<number | null>(null);
  const [testResult, setTestResult] = createSignal<{ ok: boolean; status: number | null; url: string; message: string | null } | null>(null);

  const selected = createMemo(() => props.items.find((item) => item.provider.id === selectedProviderId()) ?? null);
  const [createProviderType, setCreateProviderType] = createSignal<string>('openai');

  const ensureLive = () => {
    if (!props.settings.adminToken.trim()) {
      props.onMessage('请先填写管理员口令。');
      return false;
    }
    return true;
  };

  const isLive = () => Boolean(props.settings.adminToken.trim());
  const isCodexOAuthCreate = createMemo(() => createProviderType() === 'openai_codex_oauth');

  const resetCreateForm = () => {
    setCreateProviderType('openai');
    setCreateName('');
    setCreateBaseUrl('');
    setCreateApiKey('');
    setCreateSubmitError(null);
  };

  const createMissingFields = createMemo(() => {
    if (!isLive()) {
      return ['连接后台'];
    }

    const missing: string[] = [];
    if (!createName().trim()) {
      missing.push('名称');
    }
    if (!createBaseUrl().trim()) {
      missing.push('服务地址');
    }
    if (!isCodexOAuthCreate() && !createApiKey().trim()) {
      missing.push('API 密钥');
    }
    return missing;
  });

  const createFormHint = createMemo(() => {
    if (!isLive()) {
      return '请先连接后台。';
    }
    if (createMissingFields().length === 0) {
      return '名称、服务地址和首个密钥会一起创建。';
    }
    return `请先填写：${createMissingFields().join('、')}。`;
  });

  const [providerModels, setProviderModels] = createSignal<ProviderModel[] | null>(null);
  const [providerModelsError, setProviderModelsError] = createSignal<string | null>(null);
  const [modelAliasDraft, setModelAliasDraft] = createSignal<Record<number, string>>({});

  const [selectedUpstreamKeyId, setSelectedUpstreamKeyId] = createSignal<number | null>(null);
  const [upstreamKeyModels, setUpstreamKeyModels] = createSignal<UpstreamKeyModel[] | null>(null);
  const [upstreamKeyModelsError, setUpstreamKeyModelsError] = createSignal<string | null>(null);
  const [upstreamKeyModelsDraft, setUpstreamKeyModelsDraft] = createSignal('');

  const [gatewayModelPolicies, setGatewayModelPolicies] = createSignal<GatewayModelPolicy[] | null>(null);
  const [gatewayModelPoliciesError, setGatewayModelPoliciesError] = createSignal<string | null>(null);
  const disabledGatewayModels = createMemo(() => {
    const policies = gatewayModelPolicies() ?? [];
    return new Set(policies.filter((policy) => !policy.enabled).map((policy) => policy.model_name));
  });

  const [codexOauthStart, setCodexOauthStart] = createSignal<CodexOauthStartResponse | null>(null);
  const [codexOauthView, setCodexOauthView] = createSignal<CodexOauthRequestView | null>(null);

  const providerTypeDescription = (value: string) =>
    PROVIDER_TYPE_OPTIONS.find((option) => option.value === value)?.description ?? '—';

  const stats = createMemo<StatItem[]>(() => {
    const totalEndpoints = props.items.reduce((sum, item) => sum + item.endpoints.length, 0);
    const unhealthy = props.items.filter((item) => !item.provider.health?.available || item.provider.health?.state === 'open').length;
    const degraded = props.items.filter((item) => item.provider.health?.state === 'half_open').length;
    const healthy = props.items.filter((item) => item.provider.health?.state === 'closed' && item.provider.health.available).length;
    return [
      { label: '上游总数', value: String(props.items.length), hint: '已配置的连接目标' },
      { label: '健康', value: String(healthy), hint: `${degraded} 警告`, tone: healthy > 0 ? 'success' : 'default' as const },
      { label: '异常', value: String(unhealthy), hint: '优先检查这些目标', tone: unhealthy > 0 ? 'warning' : 'success' as const },
      { label: '节点数', value: String(totalEndpoints), hint: '全部节点' },
    ];
  });

  const submitProviderCreate = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!ensureLive()) return;

    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const payload: CreateProviderInput = {
      name: createName().trim(),
      provider_type: readString(formData, 'provider_type') || 'openai',
      enabled: readBool(formData, 'enabled'),
      priority: readInt(formData, 'priority', 100),
      weight: readInt(formData, 'weight', 1),
      supports_include_usage: readBool(formData, 'supports_include_usage'),
      websocket_enabled: readBool(formData, 'websocket_enabled'),
    };
    setCreateSubmitError(null);
    if (!payload.name) {
      const message = '上游名称不能为空。';
      setCreateSubmitError(message);
      props.onMessage(message);
      return;
    }

    const baseUrl = createBaseUrl().trim();
    if (!baseUrl) {
      const message = '服务地址不能为空。';
      setCreateSubmitError(message);
      props.onMessage(message);
      return;
    }

    const isCodexOAuth = payload.provider_type === 'openai_codex_oauth';
    const apiKey = createApiKey().trim();
    if (!isCodexOAuth && !apiKey) {
      const message = 'API 密钥不能为空。';
      setCreateSubmitError(message);
      props.onMessage(message);
      return;
    }

    setBusy('create-provider');
    try {
      const created = await createProvider(props.settings, payload);
      const providerId = created.id;

      const endpointPayload: CreateEndpointInput = {
        name: `${payload.name}-primary`,
        base_url: baseUrl,
        enabled: true,
        priority: 100,
        weight: 1,
      };

      const work: Promise<unknown>[] = [createEndpoint(props.settings, providerId, endpointPayload)];
      if (!isCodexOAuth) {
        const keyPayload: CreateProviderKeyInput = {
          name: `${payload.name}-key`,
          secret: apiKey,
          enabled: true,
          priority: 100,
          weight: 1,
        };
        work.push(createProviderKey(props.settings, providerId, keyPayload));
      }

      await Promise.all(work);
      setCreateOpen(false);
      resetCreateForm();
      await props.onRefresh(`上游 ${payload.name} 已创建。`);
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

  const submitProviderUpdate = async (event: SubmitEvent, item: ProviderWorkspace) => {
    event.preventDefault();
    if (!ensureLive()) return;

    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const payload: UpdateProviderInput = {
      name: readString(formData, 'provider_name'),
      provider_type: readString(formData, 'provider_type') || item.provider.provider_type,
      enabled: readBool(formData, 'provider_enabled'),
      priority: readInt(formData, 'provider_priority', item.provider.priority),
      weight: readInt(formData, 'provider_weight', item.provider.weight),
      supports_include_usage: readBool(formData, 'supports_include_usage'),
      websocket_enabled: readBool(formData, 'provider_websocket_enabled'),
    };

    setBusy(`provider-${item.provider.id}`);
    try {
      await updateProvider(props.settings, item.provider.id, payload);
      await props.onRefresh(`上游 ${payload.name} 已更新。`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新上游失败。');
    } finally {
      setBusy(null);
    }
  };

  const submitEndpointCreate = async (event: SubmitEvent, item: ProviderWorkspace) => {
    event.preventDefault();
    if (!ensureLive()) return;
    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const payload: CreateEndpointInput = {
      name: readString(formData, 'endpoint_name'),
      base_url: readString(formData, 'endpoint_base_url'),
      enabled: readBool(formData, 'endpoint_enabled'),
      priority: readInt(formData, 'endpoint_priority', 100),
      weight: readInt(formData, 'endpoint_weight', 1),
    };
    if (!payload.name || !payload.base_url) {
      props.onMessage('目标名称和服务地址不能为空。');
      return;
    }
    setBusy(`endpoint-create-${item.provider.id}`);
    try {
      await createEndpoint(props.settings, item.provider.id, payload);
      await props.onRefresh(`目标 ${payload.name} 已创建。`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '创建目标失败。');
    } finally {
      setBusy(null);
    }
  };

  const submitEndpointUpdate = async (event: SubmitEvent, endpointId: number) => {
    event.preventDefault();
    if (!ensureLive()) return;
    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const payload: UpdateEndpointInput = {
      name: readString(formData, `endpoint_name_${endpointId}`),
      base_url: readString(formData, `endpoint_base_url_${endpointId}`),
      enabled: readBool(formData, `endpoint_enabled_${endpointId}`),
      priority: readInt(formData, `endpoint_priority_${endpointId}`, 100),
      weight: readInt(formData, `endpoint_weight_${endpointId}`, 1),
    };
    setBusy(`endpoint-${endpointId}`);
    try {
      await updateEndpoint(props.settings, endpointId, payload);
      await props.onRefresh(`目标 ${payload.name} 已更新。`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新目标失败。');
    } finally {
      setBusy(null);
    }
  };

  const submitKeyCreate = async (event: SubmitEvent, item: ProviderWorkspace) => {
    event.preventDefault();
    if (!ensureLive()) return;
    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const payload: CreateProviderKeyInput = {
      name: readString(formData, 'upstream_key_name'),
      secret: readString(formData, 'upstream_key_secret'),
      enabled: readBool(formData, 'upstream_key_enabled'),
      priority: readInt(formData, 'upstream_key_priority', 100),
      weight: readInt(formData, 'upstream_key_weight', 1),
    };
    if (!payload.name || !payload.secret) {
      props.onMessage('密钥名称和密钥不能为空。');
      return;
    }
    setBusy(`key-create-${item.provider.id}`);
    try {
      await createProviderKey(props.settings, item.provider.id, payload);
      await props.onRefresh(`上游密钥 ${payload.name} 已创建。`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '创建上游密钥失败。');
    } finally {
      setBusy(null);
    }
  };

  const submitKeyUpdate = async (event: SubmitEvent, keyId: number) => {
    event.preventDefault();
    if (!ensureLive()) return;
    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const payload: UpdateProviderKeyInput = {
      name: readString(formData, `upstream_key_name_${keyId}`),
      secret: readString(formData, `upstream_key_secret_${keyId}`) || undefined,
      enabled: readBool(formData, `upstream_key_enabled_${keyId}`),
      priority: readInt(formData, `upstream_key_priority_${keyId}`, 100),
      weight: readInt(formData, `upstream_key_weight_${keyId}`, 1),
    };
    setBusy(`key-${keyId}`);
    try {
      await updateProviderKey(props.settings, keyId, payload);
      await props.onRefresh(`上游密钥 ${payload.name} 已更新。`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新上游密钥失败。');
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
      props.onMessage(result.ok ? '连接测试成功。' : '连接测试失败。');
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
    props.onMessage(`${label} 已复制。`);
  };

  createEffect(() => {
    selectedProviderId();
    setProviderModels(null);
    setProviderModelsError(null);
    setModelAliasDraft({});
    setSelectedUpstreamKeyId(null);
    setUpstreamKeyModels(null);
    setUpstreamKeyModelsError(null);
    setUpstreamKeyModelsDraft('');
    setCodexOauthStart(null);
    setCodexOauthView(null);
  });

  createEffect(() => {
    const item = selected();
    if (!item) return;

    const keys = item.keys;
    if (keys.length === 0) {
      setSelectedUpstreamKeyId(null);
      return;
    }

    const current = selectedUpstreamKeyId();
    if (current !== null && keys.some((key) => key.id === current)) {
      return;
    }
    setSelectedUpstreamKeyId(keys[0].id);
  });

  createEffect(() => {
    const item = selected();
    const upstreamKeyId = selectedUpstreamKeyId();
    if (!item || upstreamKeyId === null || !isLive()) return;

    let cancelled = false;
    setUpstreamKeyModels(null);
    setUpstreamKeyModelsError(null);
    setUpstreamKeyModelsDraft('');

    void loadUpstreamKeyModels(props.settings, upstreamKeyId)
      .then((models) => {
        if (cancelled) return;
        setUpstreamKeyModels(models);
      })
      .catch((error) => {
        if (cancelled) return;
        setUpstreamKeyModels([]);
        setUpstreamKeyModelsError(error instanceof Error ? error.message : '加载密钥模型失败。');
      });

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    const item = selected();
    if (!item || !isLive()) return;

    const providerId = item.provider.id;
    let cancelled = false;
    setProviderModels(null);
    setProviderModelsError(null);

    void loadProviderModels(props.settings, providerId)
      .then((models) => {
        if (cancelled) return;
        setProviderModels(models);
        setModelAliasDraft((current) => {
          const next: Record<number, string> = {};
          for (const model of models) {
            next[model.id] = current[model.id] ?? (model.alias ?? '');
          }
          return next;
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setProviderModels([]);
        setProviderModelsError(error instanceof Error ? error.message : '加载模型失败。');
      });

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!isLive()) return;

    let cancelled = false;
    setGatewayModelPoliciesError(null);

    void loadGatewayModelPolicies(props.settings)
      .then((policies) => {
        if (cancelled) return;
        setGatewayModelPolicies(policies);
      })
      .catch((error) => {
        if (cancelled) return;
        setGatewayModelPolicies([]);
        setGatewayModelPoliciesError(error instanceof Error ? error.message : '加载全局模型策略失败。');
      });

    onCleanup(() => {
      cancelled = true;
    });
  });

  const startLogin = async (item: ProviderWorkspace) => {
    if (!ensureLive()) return;
    setBusy(`codex-oauth-start-${item.provider.id}`);
    try {
      const started = await startCodexOauth(props.settings, item.provider.id);
      setCodexOauthStart(started);
      setCodexOauthView(null);
      props.onMessage('已生成登录链接。请在浏览器完成授权。');

      try {
        const view = await getCodexOauthRequest(props.settings, started.request_id);
        setCodexOauthView(view);
      } catch {
        // Polling will handle subsequent fetches.
      }
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '启动 Codex OAuth 失败。');
    } finally {
      setBusy(null);
    }
  };

  createEffect(() => {
    const item = selected();
    const requestId = codexOauthStart()?.request_id?.trim();
    if (!item || !requestId || !isLive()) return;
    if (item.provider.provider_type !== 'openai_codex_oauth') return;

    let cancelled = false;
    let timeoutId: number | undefined;

    const poll = async () => {
      if (cancelled) return;
      try {
        const view = await getCodexOauthRequest(props.settings, requestId);
        if (cancelled) return;
        setCodexOauthView(view);

        if (view.status.state === 'pending') {
          timeoutId = window.setTimeout(poll, 2000);
          return;
        }

        if (view.status.state === 'completed') {
          await props.onRefresh(`Codex OAuth 已完成，已创建密钥 #${view.status.key_id}。`);
        } else if (view.status.state === 'failed') {
          props.onMessage(`Codex OAuth 失败：${view.status.message}`);
        }
      } catch (error) {
        if (cancelled) return;
        props.onMessage(error instanceof Error ? error.message : '轮询 Codex OAuth 状态失败。');
      }
    };

    timeoutId = window.setTimeout(poll, 2000);
    onCleanup(() => {
      cancelled = true;
      if (timeoutId) window.clearTimeout(timeoutId);
    });
  });

  const syncKeyModels = async (upstreamKeyId: number) => {
    if (!ensureLive()) return;
    setBusy(`key-models-sync-${upstreamKeyId}`);
    try {
      const models = await syncUpstreamKeyModels(props.settings, upstreamKeyId);
      setUpstreamKeyModels(models);
      setUpstreamKeyModelsError(null);
      props.onMessage(`已同步 ${models.length} 个密钥模型。`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '同步密钥模型失败。');
    } finally {
      setBusy(null);
    }
  };

  const addKeyModels = async (upstreamKeyId: number) => {
    if (!ensureLive()) return;
    const models = parseModelList(upstreamKeyModelsDraft());
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
      props.onMessage(`已写入 ${models.length} 个模型。`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '写入密钥模型失败。');
    } finally {
      setBusy(null);
    }
  };

  const toggleKeyModelEnabled = async (model: UpstreamKeyModel, enabled: boolean) => {
    if (!ensureLive()) return;

    setBusy(`key-model-${model.id}`);
    setUpstreamKeyModels((current) =>
      current ? current.map((row) => (row.id === model.id ? { ...row, enabled } : row)) : current,
    );

    try {
      await updateUpstreamKeyModel(props.settings, model.id, { enabled });
    } catch (error) {
      setUpstreamKeyModels((current) =>
        current ? current.map((row) => (row.id === model.id ? { ...row, enabled: model.enabled } : row)) : current,
      );
      props.onMessage(error instanceof Error ? error.message : '更新密钥模型状态失败。');
    } finally {
      setBusy(null);
    }
  };

  const removeKeyModel = async (model: UpstreamKeyModel) => {
    if (!ensureLive()) return;
    if (!window.confirm(`确认删除密钥模型 ${model.model_name}？`)) return;

    setBusy(`key-model-${model.id}`);
    try {
      await deleteUpstreamKeyModel(props.settings, model.id);
      setUpstreamKeyModels((current) => (current ? current.filter((row) => row.id !== model.id) : current));
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
      setModelAliasDraft((current) => {
        const next: Record<number, string> = {};
        for (const model of models) {
          next[model.id] = current[model.id] ?? (model.alias ?? '');
        }
        return next;
      });
      props.onMessage(`已同步 ${models.length} 个模型。`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '同步模型失败。');
    } finally {
      setBusy(null);
    }
  };

  const saveModelAlias = async (model: ProviderModel) => {
    const item = selected();
    if (!item || !ensureLive()) return;

    const trimmed = (modelAliasDraft()[model.id] ?? '').trim();
    const nextAlias = trimmed.length > 0 ? trimmed : null;
    const existingAlias = (model.alias ?? '').trim() || null;
    if (nextAlias === existingAlias) return;

    setBusy(`provider-model-${model.id}`);
    try {
      await updateProviderModel(props.settings, model.id, { alias: trimmed });
      setProviderModels((current) =>
        current ? current.map((row) => (row.id === model.id ? { ...row, alias: nextAlias } : row)) : current,
      );
      setModelAliasDraft((current) => ({ ...current, [model.id]: nextAlias ?? '' }));
      props.onMessage('已保存别名。');
    } catch (error) {
      setModelAliasDraft((current) => ({ ...current, [model.id]: model.alias ?? '' }));
      props.onMessage(error instanceof Error ? error.message : '保存别名失败。');
    } finally {
      setBusy(null);
    }
  };

  const toggleModelEnabled = async (model: ProviderModel, enabled: boolean) => {
    const item = selected();
    if (!item || !ensureLive()) return;

    setBusy(`provider-model-${model.id}`);
    setProviderModels((current) =>
      current ? current.map((row) => (row.id === model.id ? { ...row, enabled } : row)) : current,
    );

    try {
      await updateProviderModel(props.settings, model.id, { enabled });
    } catch (error) {
      setProviderModels((current) =>
        current ? current.map((row) => (row.id === model.id ? { ...row, enabled: model.enabled } : row)) : current,
      );
      props.onMessage(error instanceof Error ? error.message : '更新模型状态失败。');
    } finally {
      setBusy(null);
    }
  };

  const toggleGatewayModelEnabled = async (upstreamModel: string, enabled: boolean) => {
    if (!ensureLive()) return;

    setBusy(`gateway-model-${upstreamModel}`);
    try {
      await updateGatewayModelPolicy(props.settings, { model_name: upstreamModel, enabled });
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
    const item = selected();
    if (!item || !ensureLive()) return;
    if (!window.confirm(`确认删除模型 ${model.upstream_model}？`)) return;

    setBusy(`provider-model-${model.id}`);
    try {
      await deleteProviderModel(props.settings, model.id);
      setProviderModels((current) => (current ? current.filter((row) => row.id !== model.id) : current));
      setModelAliasDraft((current) => {
        const next = { ...current };
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

  return (
    <div class="flex flex-col gap-6">
      <PageHeader
        title="上游"
        description="查看连接目标、流量去向与健康状态。"
        actions={
          <Button
            type="button"
            disabled={!isLive()}
            class="rounded-none text-xs tracking-wider"
            onClick={() => {
              resetCreateForm();
              setCreateOpen(true);
            }}
          >
            <Plus class="mr-2 size-3" />
            CREATE PROVIDER
          </Button>
        }
      />

      <StatsGrid items={stats()} />

      <Show when={!isLive()}>
        <Alert class="rounded-none border-border/40 bg-muted/20">
          <AlertTitle class="font-mono text-xs uppercase tracking-widest">未连接后台</AlertTitle>
          <AlertDescription class="text-sm mt-2 opacity-80">当前不能创建或修改上游，请先连接后台。</AlertDescription>
        </Alert>
      </Show>

      <Card class="rounded-none border border-border bg-background shadow-none">
        <CardHeader class="pb-6">
          <CardTitle class="text-xl font-medium tracking-tight">上游列表</CardTitle>
          <CardDescription class="font-mono text-xs uppercase tracking-widest mt-1">查看目标与健康状态。</CardDescription>
        </CardHeader>
        <CardContent class="p-0 border-t border-border/40">
          <Show
            when={props.items.length > 0}
            fallback={
              <EmptyState
                title="NO PROVIDERS"
                description="先连接一个可用目标，再逐步补充更多目标和密钥。"
                action={
                  <Button
                    type="button"
                    disabled={!isLive()}
                    variant="ghost"
                    onClick={() => {
                      resetCreateForm();
                      setCreateOpen(true);
                    }}
                  >
                    CREATE PROVIDER
                  </Button>
                }
              />
            }
          >
            <Table>
              <TableHeader>
                <TableRow class="border-b border-border hover:bg-transparent">
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">上游</TableHead>
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">状态</TableHead>
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">目标</TableHead>
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">密钥</TableHead>
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">优先级 / 权重</TableHead>
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">最近错误</TableHead>
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <For each={props.items}>
                  {(item) => {
                    const health = healthStatus(item.provider.health?.state, item.provider.health?.available);
                    return (
                      <TableRow class="cursor-pointer border-b border-border/40 hover:bg-muted/30 transition-colors" onClick={() => setSelectedProviderId(item.provider.id)}>
                        <TableCell>
                          <div class="flex flex-col gap-1">
                            <strong class="text-sm font-medium text-foreground truncate max-w-[150px]">{item.provider.name}</strong>
                            <span class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground opacity-70 truncate max-w-[150px]">{item.provider.provider_type}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone={health.tone}>{health.label}</StatusBadge>
                        </TableCell>
                        <TableCell class="font-mono text-xs">{item.endpoints.length}</TableCell>
                        <TableCell class="font-mono text-xs">{item.keys.length}</TableCell>
                        <TableCell class="font-mono text-xs">
                          P{item.provider.priority} / W{item.provider.weight}
                        </TableCell>
                        <TableCell class="font-mono text-[0.65rem] uppercase tracking-widest opacity-80">{item.provider.health?.last_error_type ?? '—'}</TableCell>
                        <TableCell class="text-right">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            class="font-mono text-xs hover:bg-transparent hover:text-primary px-0"
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedProviderId(item.provider.id);
                            }}
                          >
                            [ DETAILS ]
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  }}
                </For>
              </TableBody>
            </Table>
          </Show>
        </CardContent>
      </Card>

      <DetailDrawer
        open={createOpen()}
        title="NEW PROVIDER"
        description="填写必要信息即可创建。"
        onClose={() => setCreateOpen(false)}
      >
        <form class="flex flex-col gap-6" onSubmit={(event) => void submitProviderCreate(event)}>
          <FieldGroup class="grid gap-6 md:grid-cols-2">
            <Field>
              <FieldLabel>名称</FieldLabel>
              <Input
                name="name"
                value={createName()}
                onInput={(event) => {
                  setCreateName(event.currentTarget.value);
                  setCreateSubmitError(null);
                }}
                placeholder="openai-prod"
                class="bg-background"
              />
            </Field>
            <Field>
              <FieldLabel>类型</FieldLabel>
              <Select
                name="provider_type"
                value={createProviderType()}
                onChange={(event) => setCreateProviderType(event.currentTarget.value)}
              >
                <For each={PROVIDER_TYPE_OPTIONS}>{(option) => <option value={option.value}>{option.label}</option>}</For>
              </Select>
              <FieldDescription class="mt-2">{providerTypeDescription(createProviderType())}</FieldDescription>
            </Field>
          </FieldGroup>
          <FieldGroup class="grid gap-6">
            <Field>
              <FieldLabel>服务地址</FieldLabel>
              <Input
                name="base_url"
                type="url"
                value={createBaseUrl()}
                onInput={(event) => {
                  setCreateBaseUrl(event.currentTarget.value);
                  setCreateSubmitError(null);
                }}
                placeholder="https://api.openai.com"
                class="bg-background"
              />
              <FieldDescription class="mt-2">用于创建首个节点，后续可继续添加。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>API 密钥</FieldLabel>
              <Input
                name="api_key"
                type="password"
                value={createApiKey()}
                onInput={(event) => {
                  setCreateApiKey(event.currentTarget.value);
                  setCreateSubmitError(null);
                }}
                placeholder={createProviderType() === 'openai_codex_oauth' ? 'Codex OAuth 将通过登录获取' : 'sk-...'}
                disabled={createProviderType() === 'openai_codex_oauth'}
                class="bg-background"
              />
              <FieldDescription class="mt-2">
                {createProviderType() === 'openai_codex_oauth'
                  ? '创建后通过登录获取。'
                  : '用于创建首个上游密钥，后续可继续添加。'}
              </FieldDescription>
            </Field>
          </FieldGroup>
          <FieldGroup class="grid gap-6 md:grid-cols-2">
            <Field>
              <FieldLabel>优先级</FieldLabel>
              <Input name="priority" type="number" value="100" class="bg-background" />
            </Field>
            <Field>
              <FieldLabel>权重</FieldLabel>
              <Input name="weight" type="number" value="1" class="bg-background" />
            </Field>
          </FieldGroup>
          <div class="grid gap-4 md:grid-cols-3">
            <label class="flex items-center gap-3 border border-border/40 bg-transparent px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors">
              <Checkbox name="enabled" checked />
              <span>创建后启用</span>
            </label>
            <label class="flex items-center gap-3 border border-border/40 bg-transparent px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors">
              <Checkbox name="supports_include_usage" checked />
              <span>补充用量</span>
            </label>
            <label class="flex items-center gap-3 border border-border/40 bg-transparent px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors">
              <Checkbox name="websocket_enabled" checked={createProviderType() === 'openai_codex_oauth'} />
              <span>WebSocket</span>
            </label>
          </div>
          <div class="border border-border/40 bg-transparent p-4 text-sm text-muted-foreground font-mono">
            {createFormHint()}
          </div>
          <Show when={createSubmitError()}>
            <Alert variant="destructive" class="rounded-none border-border/40 bg-muted/20">
              <AlertTitle class="font-mono text-xs uppercase tracking-widest">创建失败</AlertTitle>
              <AlertDescription class="mt-2 opacity-80">{createSubmitError()}</AlertDescription>
            </Alert>
          </Show>
          <div class="flex justify-end border-t border-border/40 pt-6 mt-2">
            <Button
              type="submit"
              disabled={busy() === 'create-provider' || createMissingFields().length > 0}
              class="rounded-none font-mono text-xs tracking-widest px-8"
            >
              {busy() === 'create-provider' ? 'CREATING...' : 'CREATE'}
            </Button>
          </div>
        </form>
      </DetailDrawer>

      <DetailDrawer
        open={!!selected()}
        title={selected()?.provider.name ?? '上游详情'}
        description={selected() ? '连接目标、健康状态与编辑入口。' : undefined}
        onClose={() => {
          setSelectedProviderId(null);
          setTestResult(null);
        }}
      >
        <Show when={selected()}>
          {(itemSignal) => {
            const item = itemSignal();
            const health = healthStatus(item.provider.health?.state, item.provider.health?.available);
            return (
              <div class="flex flex-col gap-8">
                <div class="grid gap-6 md:grid-cols-4 border-b border-border/40 pb-8">
                  <div class="flex flex-col gap-2 border-l border-border/40 pl-4 border-l-2 border-l-primary">
                      <div class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground opacity-70">状态</div>
                      <div class="mt-2">
                        <StatusBadge tone={health.tone}>{health.label}</StatusBadge>
                      </div>
                  </div>
                  <div class="flex flex-col gap-2 border-l border-border/40 pl-4 border-l-2 border-l-primary/20">
                      <div class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground opacity-70">目标</div>
                      <div class="mt-2 text-2xl font-medium tracking-tight text-foreground">{item.endpoints.length}</div>
                  </div>
                  <div class="flex flex-col gap-2 border-l border-border/40 pl-4 border-l-2 border-l-primary/20">
                      <div class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground opacity-70">上游密钥</div>
                      <div class="mt-2 text-2xl font-medium tracking-tight text-foreground">{item.keys.length}</div>
                  </div>
                  <div class="flex flex-col gap-2 border-l border-border/40 pl-4 border-l-2 border-l-primary/20">
                      <div class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground opacity-70">最近成功</div>
                      <div class="mt-2 font-mono text-sm tracking-tight pt-1 text-muted-foreground">
                        {item.provider.health?.last_success_at_ms ? formatDateTime(item.provider.health.last_success_at_ms) : '—'}
                      </div>
                  </div>
                </div>

                <form class="flex flex-col gap-6" onSubmit={(event) => void submitProviderUpdate(event, item)}>
                  <div class="flex items-center gap-3 border-b border-border/40 pb-4">
                    <ShieldCheck class="size-4 opacity-70" />
                    <h3 class="text-base font-medium tracking-tight text-foreground uppercase">上游信息</h3>
                  </div>
                  <FieldGroup class="grid gap-6 md:grid-cols-2 pt-4">
                    <Field>
                      <FieldLabel>名称</FieldLabel>
                      <Input name="provider_name" value={item.provider.name} class="bg-background" />
                    </Field>
                    <Field>
                      <FieldLabel>类型</FieldLabel>
                      <Select name="provider_type" value={item.provider.provider_type}>
                        <For each={PROVIDER_TYPE_OPTIONS}>{(option) => <option value={option.value}>{option.label}</option>}</For>
                        <Show when={!PROVIDER_TYPE_OPTIONS.some((option) => option.value === item.provider.provider_type)}>
                          <option value={item.provider.provider_type}>{item.provider.provider_type}</option>
                        </Show>
                      </Select>
                      <FieldDescription>{providerTypeDescription(item.provider.provider_type)}</FieldDescription>
                    </Field>
                  </FieldGroup>
                  <FieldGroup class="grid gap-6 md:grid-cols-2">
                    <Field>
                      <FieldLabel>优先级</FieldLabel>
                      <Input name="provider_priority" type="number" value={String(item.provider.priority)} class="bg-background" />
                    </Field>
                    <Field>
                      <FieldLabel>权重</FieldLabel>
                      <Input name="provider_weight" type="number" value={String(item.provider.weight)} class="bg-background" />
                    </Field>
                  </FieldGroup>
                  <div class="grid gap-4 md:grid-cols-3">
                    <label class="flex items-center gap-3 border border-border/40 bg-transparent px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors">
                      <Checkbox name="provider_enabled" checked={item.provider.enabled} />
                      <span>启用上游</span>
                    </label>
                    <label class="flex items-center gap-3 border border-border/40 bg-transparent px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors">
                      <Checkbox name="supports_include_usage" checked={item.provider.supports_include_usage} />
                      <span>补充用量信息</span>
                    </label>
                    <label class="flex items-center gap-3 border border-border/40 bg-transparent px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors">
                      <Checkbox name="provider_websocket_enabled" checked={item.provider.websocket_enabled} />
                      <span>启用 WebSocket 传输</span>
                    </label>
                  </div>
                  <div class="flex justify-end pt-4 border-t border-border/40 mt-2">
                    <Button type="submit" disabled={busy() === `provider-${item.provider.id}`}>
                      {busy() === `provider-${item.provider.id}` ? 'SAVING...' : 'SAVE PROVIDER'}
                    </Button>
                  </div>
                </form>

                <Show when={item.provider.provider_type === 'openai_codex_oauth'}>
                  <Card class="rounded-none border border-border bg-background shadow-none mt-8">
                    <CardHeader class="pb-6">
                      <CardTitle class="text-xl font-medium tracking-tight">Codex OAuth</CardTitle>
                      <CardDescription class="font-mono text-xs uppercase tracking-widest mt-1">完成登录后会自动写入一个上游密钥。</CardDescription>
                    </CardHeader>
                    <CardContent class="grid gap-6 border-t border-border/40 pt-6">
                      <div class="flex flex-wrap items-center gap-4">
                        <Button type="button" size="sm" class="rounded-none font-mono tracking-widest text-[0.65rem] px-4" onClick={() => void startLogin(item)} disabled={busy() === `codex-oauth-start-${item.provider.id}`}>
                          <ShieldCheck class="size-3 mr-2" />
                          START LOGIN
                        </Button>
                        <Show when={codexOauthView()?.status.state === 'pending'}>
                          <span class="font-mono text-xs uppercase tracking-widest text-muted-foreground opacity-70 animate-pulse">WAITING FOR AUTHORIZATION...</span>
                        </Show>
                      </div>

                      <Show
                        when={codexOauthView() || codexOauthStart()}
                        fallback={<p class="font-mono text-xs text-muted-foreground opacity-70 uppercase tracking-widest border-l-2 border-primary/20 pl-4 py-2 mt-4">Click START LOGIN to open authorization in browser.</p>}
                      >
                        <div class="grid gap-6 border border-border/40 bg-muted/5 p-6 text-sm">
                          <div class="flex flex-col gap-2">
                            <div class="flex items-center justify-between">
                              <span class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground opacity-70">登录地址</span>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                class="h-6 font-mono text-[0.65rem] tracking-widest px-2 opacity-80 hover:bg-transparent hover:text-primary"
                                onClick={() => void copyValue('登录地址', (codexOauthView()?.login_url ?? codexOauthStart()?.login_url ?? '').trim())}
                                disabled={!((codexOauthView()?.login_url ?? codexOauthStart()?.login_url ?? '').trim())}
                              >
                                [ COPY ]
                              </Button>
                            </div>
                            <div class="break-all font-mono text-[0.7rem] bg-background border border-border/40 p-3 opacity-90 mt-1">
                              <a
                                class="text-primary hover:text-primary/80 transition-colors"
                                href={(codexOauthView()?.login_url ?? codexOauthStart()?.login_url ?? '').trim()}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {(codexOauthView()?.login_url ?? codexOauthStart()?.login_url ?? '').trim()}
                              </a>
                            </div>
                          </div>

                          <div class="grid grid-cols-2 gap-6 pt-4 border-t border-border/40">
                            <div class="flex flex-col gap-2">
                              <span class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground opacity-70">状态</span>
                              <span class="font-mono text-sm tracking-tight text-foreground opacity-90">
                                {(() => {
                                  const view = codexOauthView();
                                  if (!view) return '—';
                                  if (view.status.state === 'completed') return `COMPLETED (KEY #${view.status.key_id})`;
                                  if (view.status.state === 'failed') return `FAILED: ${view.status.message}`;
                                  if (view.status.state === 'pending') return 'PENDING';
                                  return '—';
                                })()}
                              </span>
                            </div>

                            <div class="flex flex-col gap-2">
                              <span class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground opacity-70">过期时间</span>
                              <span class="font-mono text-sm tracking-tight text-foreground opacity-90">
                                {(() => {
                                  const expiresAt = codexOauthView()?.expires_at_ms ?? codexOauthStart()?.expires_at_ms;
                                  return expiresAt ? formatDateTime(expiresAt) : '—';
                                })()}
                              </span>
                            </div>
                          </div>
                        </div>
                      </Show>
                    </CardContent>
                  </Card>
                </Show>

                <section class="grid gap-6 mt-8">
                  <div class="flex items-center justify-between border-b border-border/40 pb-4">
                    <div class="flex items-center gap-3">
                      <Stethoscope class="size-4 opacity-70" />
                      <h3 class="text-base font-medium tracking-tight text-foreground uppercase">目标</h3>
                    </div>
                  </div>
                  <For each={item.endpoints}>
                    {(endpoint) => {
                      const endpointHealth = healthStatus(endpoint.health?.state, endpoint.health?.available);
                      return (
                        <form class="flex flex-col gap-6 border border-border/40 bg-muted/5 p-6" onSubmit={(event) => void submitEndpointUpdate(event, endpoint.id)}>
                          <div class="flex flex-wrap items-center justify-between gap-4 border-b border-border/40 pb-6">
                            <div class="flex items-center gap-4">
                              <strong class="text-lg font-medium text-foreground tracking-tight">{endpoint.name}</strong>
                              <StatusBadge tone={endpointHealth.tone}>{endpointHealth.label}</StatusBadge>
                            </div>
                            <div class="flex items-center gap-2">
                              <Button type="button" size="sm" variant="ghost" class="font-mono text-xs hover:bg-transparent hover:text-primary px-3" disabled={busy() === `test-${endpoint.id}`} onClick={() => void handleTestEndpoint(endpoint.id)}>
                                [ TEST CONNECTION ]
                              </Button>
                              <Button type="submit" size="sm" class="rounded-none font-mono text-[0.65rem] uppercase tracking-widest px-4 ml-2" disabled={busy() === `endpoint-${endpoint.id}`}>
                                {busy() === `endpoint-${endpoint.id}` ? 'SAVING...' : 'SAVE'}
                              </Button>
                            </div>
                          </div>
                          <FieldGroup class="grid gap-6 md:grid-cols-2 pt-2">
                            <Field>
                              <FieldLabel>名称</FieldLabel>
                              <Input name={`endpoint_name_${endpoint.id}`} value={endpoint.name} class="bg-background" />
                            </Field>
                            <Field>
                              <FieldLabel>服务地址</FieldLabel>
                              <Input name={`endpoint_base_url_${endpoint.id}`} value={endpoint.base_url} class="bg-background" />
                            </Field>
                          </FieldGroup>
                          <FieldGroup class="grid gap-6 md:grid-cols-2">
                            <Field>
                              <FieldLabel>优先级</FieldLabel>
                              <Input name={`endpoint_priority_${endpoint.id}`} type="number" value={String(endpoint.priority)} class="bg-background" />
                            </Field>
                            <Field>
                              <FieldLabel>权重</FieldLabel>
                              <Input name={`endpoint_weight_${endpoint.id}`} type="number" value={String(endpoint.weight)} class="bg-background" />
                              <FieldDescription class="mt-2 opacity-60">
                                最近延迟 {endpoint.health?.latency_ewma_ms ? formatMs(endpoint.health.latency_ewma_ms) : '—'}
                              </FieldDescription>
                            </Field>
                          </FieldGroup>
                          <label class="flex items-center gap-3 border border-border/40 bg-background px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors mt-2">
                            <Checkbox name={`endpoint_enabled_${endpoint.id}`} checked={endpoint.enabled} />
                            <span>启用目标</span>
                          </label>
                        </form>
                      );
                    }}
                  </For>

                  <form class="flex flex-col gap-6 border border-dashed border-border/60 bg-transparent p-6 mt-4" onSubmit={(event) => void submitEndpointCreate(event, item)}>
                    <h4 class="text-sm font-medium tracking-widest uppercase font-mono text-foreground mb-2">添加目标</h4>
                    <FieldGroup class="grid gap-6 md:grid-cols-2">
                      <Field>
                        <FieldLabel>名称</FieldLabel>
                        <Input name="endpoint_name" placeholder="us-east-primary" />
                      </Field>
                      <Field>
                        <FieldLabel>服务地址</FieldLabel>
                        <Input name="endpoint_base_url" placeholder="https://api.openai.com" />
                      </Field>
                    </FieldGroup>
                    <FieldGroup class="grid gap-6 md:grid-cols-2">
                      <Field>
                        <FieldLabel>优先级</FieldLabel>
                        <Input name="endpoint_priority" type="number" value="100" />
                      </Field>
                      <Field>
                        <FieldLabel>权重</FieldLabel>
                        <Input name="endpoint_weight" type="number" value="1" />
                      </Field>
                    </FieldGroup>
                    <div class="flex items-center justify-between border-t border-border/40 pt-6 mt-2">
                      <label class="flex items-center gap-3 cursor-pointer">
                        <Checkbox name="endpoint_enabled" checked />
                        <span class="font-mono text-xs uppercase tracking-widest text-muted-foreground opacity-80">创建后启用</span>
                      </label>
                      <Button type="submit" disabled={busy() === `endpoint-create-${item.provider.id}`} class="rounded-none font-mono text-[0.65rem] uppercase tracking-widest px-6">
                        {busy() === `endpoint-create-${item.provider.id}` ? 'ADDING...' : 'ADD ENDPOINT'}
                      </Button>
                    </div>
                  </form>
                </section>

                <section class="grid gap-6 mt-8">
                  <div class="flex items-center justify-between border-b border-border/40 pb-4">
                    <div class="flex items-center gap-3">
                      <AlertCircle class="size-4 opacity-70" />
                      <h3 class="text-base font-medium tracking-tight text-foreground uppercase">上游密钥</h3>
                    </div>
                  </div>
                  <For each={item.keys}>
                    {(key) => {
                      const keyHealth = healthStatus(key.health?.state, key.health?.available);
                      return (
                        <form class="flex flex-col gap-6 border border-border/40 bg-muted/5 p-6" onSubmit={(event) => void submitKeyUpdate(event, key.id)}>
                          <div class="flex flex-wrap items-center justify-between gap-4 border-b border-border/40 pb-6">
                            <div class="flex items-center gap-4">
                              <strong class="text-lg font-medium text-foreground tracking-tight">{key.name}</strong>
                              <StatusBadge tone={keyHealth.tone}>{keyHealth.label}</StatusBadge>
                            </div>
                            <Button type="submit" size="sm" class="rounded-none font-mono text-[0.65rem] uppercase tracking-widest px-4 ml-2" disabled={busy() === `key-${key.id}`}>
                              {busy() === `key-${key.id}` ? 'SAVING...' : 'SAVE'}
                            </Button>
                          </div>
                          <FieldGroup class="grid gap-6 md:grid-cols-2 pt-2">
                            <Field>
                              <FieldLabel>名称</FieldLabel>
                              <Input name={`upstream_key_name_${key.id}`} value={key.name} class="bg-background" />
                            </Field>
                            <Field>
                              <FieldLabel>替换密钥</FieldLabel>
                              <Input name={`upstream_key_secret_${key.id}`} type="password" placeholder="留空表示不修改" class="bg-background" />
                            </Field>
                          </FieldGroup>
                          <FieldGroup class="grid gap-6 md:grid-cols-2">
                            <Field>
                              <FieldLabel>优先级</FieldLabel>
                              <Input name={`upstream_key_priority_${key.id}`} type="number" value={String(key.priority)} class="bg-background" />
                            </Field>
                            <Field>
                              <FieldLabel>权重</FieldLabel>
                              <Input name={`upstream_key_weight_${key.id}`} type="number" value={String(key.weight)} class="bg-background" />
                            </Field>
                          </FieldGroup>
                          <label class="flex items-center gap-3 border border-border/40 bg-background px-4 py-4 text-sm font-mono uppercase tracking-widest text-muted-foreground opacity-80 cursor-pointer hover:bg-muted/10 transition-colors mt-2">
                            <Checkbox name={`upstream_key_enabled_${key.id}`} checked={key.enabled} />
                            <span>启用密钥</span>
                          </label>
                        </form>
                      );
                    }}
                  </For>

                  <form class="flex flex-col gap-6 border border-dashed border-border/60 bg-transparent p-6 mt-4" onSubmit={(event) => void submitKeyCreate(event, item)}>
                    <h4 class="text-sm font-medium tracking-widest uppercase font-mono text-foreground mb-2">添加上游密钥</h4>
                    <FieldGroup class="grid gap-6 md:grid-cols-2">
                      <Field>
                        <FieldLabel>名称</FieldLabel>
                        <Input name="upstream_key_name" placeholder="prod-key-a" />
                      </Field>
                      <Field>
                        <FieldLabel>密钥</FieldLabel>
                        <Input name="upstream_key_secret" type="password" placeholder="sk-..." />
                      </Field>
                    </FieldGroup>
                    <FieldGroup class="grid gap-6 md:grid-cols-2">
                      <Field>
                        <FieldLabel>优先级</FieldLabel>
                        <Input name="upstream_key_priority" type="number" value="100" />
                      </Field>
                      <Field>
                        <FieldLabel>权重</FieldLabel>
                        <Input name="upstream_key_weight" type="number" value="1" />
                      </Field>
                    </FieldGroup>
                    <div class="flex items-center justify-between border-t border-border/40 pt-6 mt-2">
                      <label class="flex items-center gap-3 cursor-pointer">
                        <Checkbox name="upstream_key_enabled" checked />
                        <span class="font-mono text-xs uppercase tracking-widest text-muted-foreground opacity-80">创建后启用</span>
                      </label>
                      <Button type="submit" disabled={busy() === `key-create-${item.provider.id}`} class="rounded-none font-mono text-[0.65rem] uppercase tracking-widest px-6">
                        {busy() === `key-create-${item.provider.id}` ? 'ADDING...' : 'ADD KEY'}
                      </Button>
                    </div>
                  </form>
                </section>

                <section class="grid gap-6 mt-8">
                  <div class="flex items-center justify-between border-b border-border/40 pb-4">
                    <div class="flex items-center gap-3">
                      <ShieldCheck class="size-4 opacity-70" />
                      <h3 class="text-base font-medium tracking-tight text-foreground uppercase">密钥模型限制</h3>
                    </div>
                  </div>

                  <Show
                    when={isLive()}
                    fallback={
                      <Card class="rounded-none border border-border bg-background shadow-none">
                        <CardContent class="p-6 font-mono text-xs uppercase tracking-widest text-muted-foreground opacity-70">
                          连接后台后可为每个上游密钥设置可用模型。
                        </CardContent>
                      </Card>
                    }
                  >
                    <Card class="rounded-none border border-border bg-background shadow-none">
                      <CardHeader class="flex flex-row items-start justify-between gap-6 pb-6">
                        <div class="grid gap-2">
                          <CardTitle class="text-xl font-medium tracking-tight">按密钥限制模型</CardTitle>
                          <CardDescription class="font-mono text-[0.65rem] uppercase tracking-widest mt-1">未设置时允许所有模型；设置后只允许列表中的模型。</CardDescription>
                        </div>
                        <div class="flex flex-wrap items-center gap-3">
                          <Select
                            value={selectedUpstreamKeyId() === null ? '' : String(selectedUpstreamKeyId())}
                            onChange={(event) => {
                              const raw = event.currentTarget.value.trim();
                              const parsed = Number.parseInt(raw, 10);
                              setSelectedUpstreamKeyId(Number.isFinite(parsed) ? parsed : null);
                            }}
                            disabled={item.keys.length === 0}
                            class="w-[240px]"
                          >
                            <option value="">选择密钥…</option>
                            <For each={item.keys}>{(key) => <option value={String(key.id)}>{key.name} (#{key.id})</option>}</For>
                          </Select>
                          <Button
                            type="button"
                            size="sm"
                            class="rounded-none text-xs tracking-wider"
                            onClick={() => {
                              const keyId = selectedUpstreamKeyId();
                              if (keyId === null) {
                                props.onMessage('请先选择一个密钥。');
                                return;
                              }
                              void syncKeyModels(keyId);
                            }}
                            disabled={selectedUpstreamKeyId() === null || busy() === `key-models-sync-${selectedUpstreamKeyId() ?? 0}`}
                          >
                            <RefreshCw class={`mr-2 size-3 ${busy() === `key-models-sync-${selectedUpstreamKeyId() ?? 0}` ? 'animate-spin' : undefined}`} />
                            SYNC
                          </Button>
                        </div>
                      </CardHeader>
                      <CardContent class="grid gap-6 border-t border-border/40 pt-6">
                        <Show when={upstreamKeyModelsError()}>
                          {(message) => (
                            <div class="border border-border/40 bg-background px-4 py-4 font-mono text-xs text-muted-foreground opacity-80">{message()}</div>
                          )}
                        </Show>

                        <Show
                          when={item.keys.length > 0}
                          fallback={
                            <div class="border border-dashed border-border/60 bg-transparent px-4 py-6 text-sm text-muted-foreground opacity-70">
                              还没有上游密钥，请先创建。
                            </div>
                          }
                        >
                          <div class="flex flex-col gap-4 border border-dashed border-border/60 bg-transparent p-6">
                            <Field>
                              <FieldLabel>添加模型（逗号或空格分隔）</FieldLabel>
                              <div class="flex items-center gap-2">
                                <Input
                                  value={upstreamKeyModelsDraft()}
                                  placeholder="gpt-4.1, o4-mini …"
                                  disabled={selectedUpstreamKeyId() === null || busy() === `key-models-add-${selectedUpstreamKeyId() ?? 0}`}
                                  onInput={(event) => setUpstreamKeyModelsDraft(event.currentTarget.value)}
                                  class="font-mono text-sm"
                                />
                                <Button
                                  type="button"
                                  size="sm"
                                  class="rounded-none font-mono text-[0.65rem] uppercase tracking-widest px-6 whitespace-nowrap"
                                  onClick={() => {
                                    const keyId = selectedUpstreamKeyId();
                                    if (keyId === null) {
                                      props.onMessage('请先选择一个密钥。');
                                      return;
                                    }
                                    void addKeyModels(keyId);
                                  }}
                                  disabled={selectedUpstreamKeyId() === null || busy() === `key-models-add-${selectedUpstreamKeyId() ?? 0}`}
                                >
                                  ADD MODELS
                                </Button>
                              </div>
                            </Field>
                          </div>

                          <div class="border border-border/40 bg-muted/5">
                          {(() => {
                            const keyId = selectedUpstreamKeyId();
                            if (keyId === null) {
                              return (
                                <div class="px-6 py-8 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground opacity-60">
                                  请选择一个密钥。
                                </div>
                              );
                            }

                            const models = upstreamKeyModels();
                            if (models === null) {
                              return (
                                <div class="px-6 py-8 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground opacity-60">
                                  LOADING...
                                </div>
                              );
                            }

                            if (models.length === 0) {
                              return (
                                <div class="px-6 py-8 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground opacity-60">
                                  当前未限制模型；同步或添加后将按列表限制。
                                </div>
                              );
                            }

                            return (
                              <Table>
                                <TableHeader>
                                  <TableRow class="border-b border-border/40 hover:bg-transparent bg-background">
                                    <TableHead class="h-10">模型</TableHead>
                                    <TableHead class="h-10">启用</TableHead>
                                    <TableHead class="h-10 text-right">操作</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  <For each={models}>
                                    {(model) => (
                                      <TableRow class={`border-b border-border/40 hover:bg-muted/30 transition-colors ${model.enabled ? '' : 'opacity-50'}`}>
                                        <TableCell class="font-mono text-sm max-w-[200px] truncate" title={model.model_name}>{model.model_name}</TableCell>
                                        <TableCell>
                                          <Checkbox
                                            checked={model.enabled}
                                            disabled={busy() === `key-model-${model.id}`}
                                            onChange={(event) =>
                                              void toggleKeyModelEnabled(model, event.currentTarget.checked)
                                            }
                                          />
                                        </TableCell>
                                        <TableCell class="text-right">
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant="ghost"
                                            class="font-mono text-[0.65rem] uppercase tracking-widest hover:bg-transparent hover:text-destructive px-0"
                                            onClick={() => void removeKeyModel(model)}
                                            disabled={busy() === `key-model-${model.id}`}
                                          >
                                            [ REMOVE ]
                                          </Button>
                                        </TableCell>
                                      </TableRow>
                                    )}
                                  </For>
                                </TableBody>
                              </Table>
                            );
                          })()}
                          </div>
                        </Show>
                      </CardContent>
                    </Card>
                  </Show>
                </section>

                <section class="grid gap-6 mt-8 pb-8">
                  <div class="flex items-center justify-between border-b border-border/40 pb-4">
                    <div class="flex items-center gap-3">
                      <RefreshCw class="size-4 opacity-70" />
                      <h3 class="text-base font-medium tracking-tight text-foreground uppercase">模型</h3>
                    </div>
                  </div>

                  <Show
                    when={isLive()}
                    fallback={
                      <Card class="rounded-none border border-border bg-background shadow-none">
                        <CardContent class="p-6 font-mono text-xs uppercase tracking-widest text-muted-foreground opacity-70">
                          连接后台后可同步模型，并管理显示名称和启用状态。
                        </CardContent>
                      </Card>
                    }
                  >
                    <Card class="rounded-none border border-border bg-background shadow-none">
                      <CardHeader class="flex flex-row items-start justify-between gap-6 pb-6">
                        <div class="grid gap-2">
                          <CardTitle class="text-xl font-medium tracking-tight">可用模型</CardTitle>
                          <CardDescription class="font-mono text-[0.65rem] uppercase tracking-widest mt-1">同步模型并管理显示名称与启用状态。</CardDescription>
                        </div>
                        <Button type="button" size="sm" class="rounded-none text-xs tracking-wider" onClick={() => void syncModels(item)} disabled={busy() === `models-sync-${item.provider.id}`}>
                          <RefreshCw class={`mr-2 size-3 ${busy() === `models-sync-${item.provider.id}` ? 'animate-spin' : ''}`} />
                          SYNC MODELS
                        </Button>
                      </CardHeader>
                      <CardContent class="grid gap-0 border-t border-border/40 pt-0 p-0">
                        <Show when={providerModelsError()}>
                          {(message) => (
                            <div class="border-b border-border/40 bg-background px-6 py-4 font-mono text-xs text-muted-foreground opacity-80">{message()}</div>
                          )}
                        </Show>
                        <Show when={gatewayModelPoliciesError()}>
                          {(message) => (
                            <div class="border-b border-border/40 bg-background px-6 py-4 font-mono text-xs text-muted-foreground opacity-80">
                              模型开关：{message()}
                            </div>
                          )}
                        </Show>

                        {(() => {
                          const models = providerModels();
                          if (models === null) {
                            return (
                              <div class="px-6 py-8 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground opacity-60">
                                LOADING...
                              </div>
                            );
                          }

                          if (models.length === 0) {
                            return (
                              <div class="px-6 py-8 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground opacity-60">
                                NO MODELS. CLICK SYNC TO FETCH.
                              </div>
                            );
                          }

                          return (
                            <Table>
                              <TableHeader>
                                <TableRow class="border-b border-border/40 hover:bg-transparent bg-muted/5">
                                  <TableHead class="h-10">上游名称</TableHead>
                                  <TableHead class="h-10 w-[240px]">显示名称</TableHead>
                                  <TableHead class="h-10 text-center w-[80px]">启用</TableHead>
                                  <TableHead class="h-10 text-center w-[80px]">全局</TableHead>
                                  <TableHead class="h-10 text-right w-[100px]">操作</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                <For each={models}>
                                  {(model) => {
                                    const globallyDisabled = () => disabledGatewayModels().has(model.upstream_model);

                                    return (
                                      <TableRow class={`border-b border-border/40 hover:bg-muted/30 transition-colors ${model.enabled && !globallyDisabled() ? '' : 'opacity-50'}`}>
                                      <TableCell class="font-mono text-sm max-w-[200px] truncate" title={model.upstream_model}>{model.upstream_model}</TableCell>
                                      <TableCell class="p-2">
                                        <div class="flex items-center">
                                          <Input
                                            value={modelAliasDraft()[model.id] ?? model.alias ?? ''}
                                            placeholder="无别名"
                                            disabled={busy() === `provider-model-${model.id}`}
                                            class="h-8 font-mono text-xs border-transparent bg-transparent hover:border-border/40 focus:border-primary px-2 transition-colors"
                                            onInput={(event) =>
                                              setModelAliasDraft((current) => ({
                                                ...current,
                                                [model.id]: (event.currentTarget as HTMLInputElement).value,
                                              }))
                                            }
                                            onBlur={() => void saveModelAlias(model)}
                                          />
                                        </div>
                                      </TableCell>
                                      <TableCell class="text-center">
                                        <Checkbox
                                          checked={model.enabled}
                                          disabled={busy() === `provider-model-${model.id}`}
                                          onChange={(event) => void toggleModelEnabled(model, event.currentTarget.checked)}
                                        />
                                      </TableCell>
                                      <TableCell class="text-center">
                                        <Checkbox
                                          checked={!globallyDisabled()}
                                          disabled={
                                            busy() === `gateway-model-${model.upstream_model}` ||
                                            gatewayModelPolicies() === null
                                          }
                                          onChange={(event) =>
                                            void toggleGatewayModelEnabled(model.upstream_model, event.currentTarget.checked)
                                          }
                                        />
                                      </TableCell>
                                      <TableCell class="text-right p-2">
                                        <Button
                                          type="button"
                                          size="icon"
                                          variant="ghost"
                                          class="size-8 hover:text-destructive opacity-70 hover:opacity-100"
                                          onClick={() => void removeModel(model)}
                                          disabled={busy() === `provider-model-${model.id}`}
                                        >
                                          <Trash2 class="size-3" />
                                        </Button>
                                      </TableCell>
                                    </TableRow>
                                    );
                                  }}
                                </For>
                              </TableBody>
                            </Table>
                          );
                        })()}
                      </CardContent>
                    </Card>
                  </Show>
                </section>

                <Show when={testResult()}>
                  {(result) => (
                    <Card class="rounded-none border border-border bg-background shadow-none mb-8">
                      <CardHeader class="pb-4">
                        <CardTitle class="text-lg font-medium tracking-tight">最近测试结果</CardTitle>
                      </CardHeader>
                      <CardContent class="grid gap-2 font-mono text-sm border-t border-border/40 pt-4">
                        <div>地址：{result().url}</div>
                        <div>状态：{result().status ?? '连接失败'}</div>
                        <div>消息：{result().message ?? '无返回内容'}</div>
                      </CardContent>
                    </Card>
                  )}
                </Show>
              </div>
            );
          }}
        </Show>
      </DetailDrawer>
    </div>
  );
}
