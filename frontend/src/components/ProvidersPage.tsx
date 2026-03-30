import { For, Show, createMemo, createSignal } from 'solid-js';
import { AlertCircle, Plus, Save, ShieldCheck, Stethoscope } from 'lucide-solid';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DetailDrawer } from '@/components/console/DetailDrawer';
import { EmptyState } from '@/components/console/EmptyState';
import { PageHeader } from '@/components/console/PageHeader';
import { StatsGrid, type StatItem } from '@/components/console/StatsGrid';
import { StatusBadge } from '@/components/console/StatusBadge';
import {
  createEndpoint,
  createProvider,
  createProviderKey,
  testEndpointConnection,
  updateEndpoint,
  updateProvider,
  updateProviderKey,
} from '../lib/api';
import { formatDateTime, formatMs } from '../lib/format';
import type {
  ConnectionSettings,
  CreateEndpointInput,
  CreateProviderInput,
  CreateProviderKeyInput,
  ProviderWorkspace,
  UpdateEndpointInput,
  UpdateProviderInput,
  UpdateProviderKeyInput,
} from '../lib/types';

interface ProvidersPageProps {
  source: 'live' | 'preview';
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

function healthStatus(state?: string, available?: boolean) {
  if (!available || state === 'open') return { label: '异常', tone: 'error' as const };
  if (state === 'half_open') return { label: '警告', tone: 'warning' as const };
  return { label: '正常', tone: 'normal' as const };
}

export function ProvidersPage(props: ProvidersPageProps) {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [createOpen, setCreateOpen] = createSignal(false);
  const [selectedProviderId, setSelectedProviderId] = createSignal<number | null>(null);
  const [testResult, setTestResult] = createSignal<{ ok: boolean; status: number | null; url: string; message: string | null } | null>(null);

  const selected = createMemo(() => props.items.find((item) => item.provider.id === selectedProviderId()) ?? null);

  const ensureLive = () => {
    if (props.source !== 'live' || !props.settings.adminToken.trim()) {
      props.onMessage('当前是预览模式；如需编辑上游，请先连接真实后台。');
      return false;
    }
    return true;
  };

  const stats = createMemo<StatItem[]>(() => {
    const totalEndpoints = props.items.reduce((sum, item) => sum + item.endpoints.length, 0);
    const unhealthy = props.items.filter((item) => !item.provider.health?.available || item.provider.health?.state === 'open').length;
    const degraded = props.items.filter((item) => item.provider.health?.state === 'half_open').length;
    const healthy = props.items.filter((item) => item.provider.health?.state === 'closed' && item.provider.health.available).length;
    return [
      { label: '上游总数', value: String(props.items.length), hint: '已配置的连接目标' },
      { label: '健康', value: String(healthy), hint: `${degraded} 警告`, tone: healthy > 0 ? 'success' : 'default' as const },
      { label: '异常', value: String(unhealthy), hint: '优先检查这些目标', tone: unhealthy > 0 ? 'warning' : 'success' as const },
      { label: '目标数', value: String(totalEndpoints), hint: '所有 endpoint 总和' },
    ];
  });

  const submitProviderCreate = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!ensureLive()) return;

    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const payload: CreateProviderInput = {
      name: readString(formData, 'name'),
      provider_type: readString(formData, 'provider_type') || 'openai',
      enabled: readBool(formData, 'enabled'),
      priority: readInt(formData, 'priority', 100),
      weight: readInt(formData, 'weight', 1),
      supports_include_usage: readBool(formData, 'supports_include_usage'),
    };
    if (!payload.name) {
      props.onMessage('上游名称不能为空。');
      return;
    }

    setBusy('create-provider');
    try {
      await createProvider(props.settings, payload);
      setCreateOpen(false);
      await props.onRefresh(`上游 ${payload.name} 已创建。`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '创建上游失败。');
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
      props.onMessage('目标名称和 Base URL 不能为空。');
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
      props.onMessage('Key 名称和密钥不能为空。');
      return;
    }
    setBusy(`key-create-${item.provider.id}`);
    try {
      await createProviderKey(props.settings, item.provider.id, payload);
      await props.onRefresh(`上游 Key ${payload.name} 已创建。`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '创建上游 Key 失败。');
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
      await props.onRefresh(`上游 Key ${payload.name} 已更新。`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新上游 Key 失败。');
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

  return (
    <div class="flex flex-col gap-6">
      <PageHeader
        title="上游"
        description="查看连接目标、流量去向与健康状态。"
        actions={
          <Button type="button" onClick={() => setCreateOpen(true)}>
            <Plus />
            新建上游
          </Button>
        }
      />

      <StatsGrid items={stats()} />

      <Card class="border-border/80 bg-card/95">
        <CardHeader>
          <CardTitle>上游列表</CardTitle>
          <CardDescription>查看目标与健康状态。</CardDescription>
        </CardHeader>
        <CardContent>
          <Show
            when={props.items.length > 0}
            fallback={
              <EmptyState
                title="还没有上游"
                description="先连接一个可用目标，再逐步补充更多目标和密钥。"
                action={
                  <Button type="button" onClick={() => setCreateOpen(true)}>
                    新建上游
                  </Button>
                }
              />
            }
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>上游</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>目标</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>优先级 / 权重</TableHead>
                  <TableHead>最近错误</TableHead>
                  <TableHead class="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <For each={props.items}>
                  {(item) => {
                    const health = healthStatus(item.provider.health?.state, item.provider.health?.available);
                    return (
                      <TableRow class="cursor-pointer" onClick={() => setSelectedProviderId(item.provider.id)}>
                        <TableCell>
                          <div class="flex flex-col gap-1">
                            <strong class="text-sm font-medium text-foreground">{item.provider.name}</strong>
                            <span class="text-xs text-muted-foreground">{item.provider.provider_type}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone={health.tone}>{health.label}</StatusBadge>
                        </TableCell>
                        <TableCell>{item.endpoints.length}</TableCell>
                        <TableCell>{item.keys.length}</TableCell>
                        <TableCell>
                          P{item.provider.priority} / W{item.provider.weight}
                        </TableCell>
                        <TableCell>{item.provider.health?.last_error_type ?? '—'}</TableCell>
                        <TableCell class="text-right">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedProviderId(item.provider.id);
                            }}
                          >
                            查看
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
        title="新建上游"
        description="只保留首要字段。高级策略留到设置页。"
        onClose={() => setCreateOpen(false)}
      >
        <form class="flex flex-col gap-4" onSubmit={(event) => void submitProviderCreate(event)}>
          <FieldGroup>
            <Field>
              <FieldLabel>名称</FieldLabel>
              <Input name="name" placeholder="openai-prod" />
            </Field>
            <Field>
              <FieldLabel>类型</FieldLabel>
              <Input name="provider_type" placeholder="openai" />
            </Field>
          </FieldGroup>
          <FieldGroup class="grid gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel>优先级</FieldLabel>
              <Input name="priority" type="number" value="100" />
            </Field>
            <Field>
              <FieldLabel>权重</FieldLabel>
              <Input name="weight" type="number" value="1" />
            </Field>
          </FieldGroup>
          <div class="grid gap-3 md:grid-cols-2">
            <label class="flex items-center gap-3 rounded-xl border border-border/70 bg-muted/30 px-3 py-3 text-sm">
              <Checkbox name="enabled" checked />
              <span>创建后启用</span>
            </label>
            <label class="flex items-center gap-3 rounded-xl border border-border/70 bg-muted/30 px-3 py-3 text-sm">
              <Checkbox name="supports_include_usage" checked />
              <span>支持 usage 注入</span>
            </label>
          </div>
          <Button type="submit" disabled={busy() === 'create-provider'}>
            {busy() === 'create-provider' ? '创建中…' : '创建上游'}
          </Button>
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
              <div class="flex flex-col gap-6">
                <div class="grid gap-3 md:grid-cols-4">
                  <Card class="border-border/70 bg-muted/25">
                    <CardContent class="p-4">
                      <div class="text-[0.72rem] uppercase tracking-[0.18em] text-muted-foreground">状态</div>
                      <div class="mt-2">
                        <StatusBadge tone={health.tone}>{health.label}</StatusBadge>
                      </div>
                    </CardContent>
                  </Card>
                  <Card class="border-border/70 bg-muted/25">
                    <CardContent class="p-4">
                      <div class="text-[0.72rem] uppercase tracking-[0.18em] text-muted-foreground">目标</div>
                      <div class="mt-2 text-xl font-semibold text-foreground">{item.endpoints.length}</div>
                    </CardContent>
                  </Card>
                  <Card class="border-border/70 bg-muted/25">
                    <CardContent class="p-4">
                      <div class="text-[0.72rem] uppercase tracking-[0.18em] text-muted-foreground">上游 Key</div>
                      <div class="mt-2 text-xl font-semibold text-foreground">{item.keys.length}</div>
                    </CardContent>
                  </Card>
                  <Card class="border-border/70 bg-muted/25">
                    <CardContent class="p-4">
                      <div class="text-[0.72rem] uppercase tracking-[0.18em] text-muted-foreground">最近成功</div>
                      <div class="mt-2 text-sm text-foreground">
                        {item.provider.health?.last_success_at_ms ? formatDateTime(item.provider.health.last_success_at_ms) : '—'}
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <form class="flex flex-col gap-4 rounded-2xl border border-border/70 bg-muted/25 p-4" onSubmit={(event) => void submitProviderUpdate(event, item)}>
                  <div class="flex items-center gap-2">
                    <ShieldCheck />
                    <h3 class="text-sm font-semibold text-foreground">上游信息</h3>
                  </div>
                  <FieldGroup>
                    <Field>
                      <FieldLabel>名称</FieldLabel>
                      <Input name="provider_name" value={item.provider.name} />
                    </Field>
                    <Field>
                      <FieldLabel>类型</FieldLabel>
                      <Input name="provider_type" value={item.provider.provider_type} />
                    </Field>
                  </FieldGroup>
                  <FieldGroup class="grid gap-4 md:grid-cols-2">
                    <Field>
                      <FieldLabel>优先级</FieldLabel>
                      <Input name="provider_priority" type="number" value={String(item.provider.priority)} />
                    </Field>
                    <Field>
                      <FieldLabel>权重</FieldLabel>
                      <Input name="provider_weight" type="number" value={String(item.provider.weight)} />
                    </Field>
                  </FieldGroup>
                  <div class="grid gap-3 md:grid-cols-2">
                    <label class="flex items-center gap-3 rounded-xl border border-border/70 bg-background px-3 py-3 text-sm">
                      <Checkbox name="provider_enabled" checked={item.provider.enabled} />
                      <span>启用上游</span>
                    </label>
                    <label class="flex items-center gap-3 rounded-xl border border-border/70 bg-background px-3 py-3 text-sm">
                      <Checkbox name="supports_include_usage" checked={item.provider.supports_include_usage} />
                      <span>支持 usage 注入</span>
                    </label>
                  </div>
                  <Button type="submit" disabled={busy() === `provider-${item.provider.id}`}>
                    <Save />
                    保存上游
                  </Button>
                </form>

                <section class="grid gap-4">
                  <div class="flex items-center gap-2">
                    <Stethoscope />
                    <h3 class="text-sm font-semibold text-foreground">目标</h3>
                  </div>
                  <For each={item.endpoints}>
                    {(endpoint) => {
                      const endpointHealth = healthStatus(endpoint.health?.state, endpoint.health?.available);
                      return (
                        <form class="flex flex-col gap-4 rounded-2xl border border-border/70 bg-muted/25 p-4" onSubmit={(event) => void submitEndpointUpdate(event, endpoint.id)}>
                          <div class="flex flex-wrap items-center justify-between gap-3">
                            <div class="flex items-center gap-2">
                              <strong class="text-sm text-foreground">{endpoint.name}</strong>
                              <StatusBadge tone={endpointHealth.tone}>{endpointHealth.label}</StatusBadge>
                            </div>
                            <div class="flex gap-2">
                              <Button type="button" size="sm" variant="outline" disabled={busy() === `test-${endpoint.id}`} onClick={() => void handleTestEndpoint(endpoint.id)}>
                                测试连接
                              </Button>
                              <Button type="submit" size="sm" disabled={busy() === `endpoint-${endpoint.id}`}>
                                保存
                              </Button>
                            </div>
                          </div>
                          <FieldGroup>
                            <Field>
                              <FieldLabel>名称</FieldLabel>
                              <Input name={`endpoint_name_${endpoint.id}`} value={endpoint.name} />
                            </Field>
                            <Field>
                              <FieldLabel>Base URL</FieldLabel>
                              <Input name={`endpoint_base_url_${endpoint.id}`} value={endpoint.base_url} />
                            </Field>
                          </FieldGroup>
                          <FieldGroup class="grid gap-4 md:grid-cols-2">
                            <Field>
                              <FieldLabel>优先级</FieldLabel>
                              <Input name={`endpoint_priority_${endpoint.id}`} type="number" value={String(endpoint.priority)} />
                            </Field>
                            <Field>
                              <FieldLabel>权重</FieldLabel>
                              <Input name={`endpoint_weight_${endpoint.id}`} type="number" value={String(endpoint.weight)} />
                              <FieldDescription>
                                最近延迟 {endpoint.health?.latency_ewma_ms ? formatMs(endpoint.health.latency_ewma_ms) : '—'}
                              </FieldDescription>
                            </Field>
                          </FieldGroup>
                          <label class="flex items-center gap-3 rounded-xl border border-border/70 bg-background px-3 py-3 text-sm">
                            <Checkbox name={`endpoint_enabled_${endpoint.id}`} checked={endpoint.enabled} />
                            <span>启用目标</span>
                          </label>
                        </form>
                      );
                    }}
                  </For>

                  <form class="flex flex-col gap-4 rounded-2xl border border-dashed border-border bg-muted/15 p-4" onSubmit={(event) => void submitEndpointCreate(event, item)}>
                    <h4 class="text-sm font-semibold text-foreground">添加目标</h4>
                    <FieldGroup>
                      <Field>
                        <FieldLabel>名称</FieldLabel>
                        <Input name="endpoint_name" placeholder="us-east-primary" />
                      </Field>
                      <Field>
                        <FieldLabel>Base URL</FieldLabel>
                        <Input name="endpoint_base_url" placeholder="https://api.openai.com" />
                      </Field>
                    </FieldGroup>
                    <FieldGroup class="grid gap-4 md:grid-cols-2">
                      <Field>
                        <FieldLabel>优先级</FieldLabel>
                        <Input name="endpoint_priority" type="number" value="100" />
                      </Field>
                      <Field>
                        <FieldLabel>权重</FieldLabel>
                        <Input name="endpoint_weight" type="number" value="1" />
                      </Field>
                    </FieldGroup>
                    <label class="flex items-center gap-3 rounded-xl border border-border/70 bg-background px-3 py-3 text-sm">
                      <Checkbox name="endpoint_enabled" checked />
                      <span>创建后启用</span>
                    </label>
                    <Button type="submit" disabled={busy() === `endpoint-create-${item.provider.id}`}>
                      新增目标
                    </Button>
                  </form>
                </section>

                <section class="grid gap-4">
                  <div class="flex items-center gap-2">
                    <AlertCircle />
                    <h3 class="text-sm font-semibold text-foreground">上游 Key</h3>
                  </div>
                  <For each={item.keys}>
                    {(key) => {
                      const keyHealth = healthStatus(key.health?.state, key.health?.available);
                      return (
                        <form class="flex flex-col gap-4 rounded-2xl border border-border/70 bg-muted/25 p-4" onSubmit={(event) => void submitKeyUpdate(event, key.id)}>
                          <div class="flex flex-wrap items-center justify-between gap-3">
                            <div class="flex items-center gap-2">
                              <strong class="text-sm text-foreground">{key.name}</strong>
                              <StatusBadge tone={keyHealth.tone}>{keyHealth.label}</StatusBadge>
                            </div>
                            <Button type="submit" size="sm" disabled={busy() === `key-${key.id}`}>
                              保存
                            </Button>
                          </div>
                          <FieldGroup>
                            <Field>
                              <FieldLabel>名称</FieldLabel>
                              <Input name={`upstream_key_name_${key.id}`} value={key.name} />
                            </Field>
                            <Field>
                              <FieldLabel>替换密钥</FieldLabel>
                              <Input name={`upstream_key_secret_${key.id}`} type="password" placeholder="留空表示不修改" />
                            </Field>
                          </FieldGroup>
                          <FieldGroup class="grid gap-4 md:grid-cols-2">
                            <Field>
                              <FieldLabel>优先级</FieldLabel>
                              <Input name={`upstream_key_priority_${key.id}`} type="number" value={String(key.priority)} />
                            </Field>
                            <Field>
                              <FieldLabel>权重</FieldLabel>
                              <Input name={`upstream_key_weight_${key.id}`} type="number" value={String(key.weight)} />
                            </Field>
                          </FieldGroup>
                          <label class="flex items-center gap-3 rounded-xl border border-border/70 bg-background px-3 py-3 text-sm">
                            <Checkbox name={`upstream_key_enabled_${key.id}`} checked={key.enabled} />
                            <span>启用 Key</span>
                          </label>
                        </form>
                      );
                    }}
                  </For>

                  <form class="flex flex-col gap-4 rounded-2xl border border-dashed border-border bg-muted/15 p-4" onSubmit={(event) => void submitKeyCreate(event, item)}>
                    <h4 class="text-sm font-semibold text-foreground">添加上游 Key</h4>
                    <FieldGroup>
                      <Field>
                        <FieldLabel>名称</FieldLabel>
                        <Input name="upstream_key_name" placeholder="prod-key-a" />
                      </Field>
                      <Field>
                        <FieldLabel>密钥</FieldLabel>
                        <Input name="upstream_key_secret" type="password" placeholder="sk-..." />
                      </Field>
                    </FieldGroup>
                    <FieldGroup class="grid gap-4 md:grid-cols-2">
                      <Field>
                        <FieldLabel>优先级</FieldLabel>
                        <Input name="upstream_key_priority" type="number" value="100" />
                      </Field>
                      <Field>
                        <FieldLabel>权重</FieldLabel>
                        <Input name="upstream_key_weight" type="number" value="1" />
                      </Field>
                    </FieldGroup>
                    <label class="flex items-center gap-3 rounded-xl border border-border/70 bg-background px-3 py-3 text-sm">
                      <Checkbox name="upstream_key_enabled" checked />
                      <span>创建后启用</span>
                    </label>
                    <Button type="submit" disabled={busy() === `key-create-${item.provider.id}`}>
                      新增 Key
                    </Button>
                  </form>
                </section>

                <Show when={testResult()}>
                  {(result) => (
                    <Card class="border-border/70 bg-muted/25">
                      <CardHeader>
                        <CardTitle>最近测试结果</CardTitle>
                      </CardHeader>
                      <CardContent class="grid gap-2 text-sm">
                        <div>URL：{result().url}</div>
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
