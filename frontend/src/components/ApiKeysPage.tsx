import { For, Show, createMemo, createSignal } from 'solid-js';
import { Copy, Plus, Power, Trash2 } from 'lucide-solid';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DetailDrawer } from '@/components/console/DetailDrawer';
import { EmptyState } from '@/components/console/EmptyState';
import { PageHeader } from '@/components/console/PageHeader';
import { StatsGrid } from '@/components/console/StatsGrid';
import { StatusBadge } from '@/components/console/StatusBadge';
import { createApiKey, deleteApiKey, updateApiKey } from '../lib/api';
import { formatCompactInteger, formatCost, formatDateTime, formatDateTimeLocalInput, parseDateTimeLocalInput } from '../lib/format';
import type { ApiKeyWorkspace, ConnectionSettings, CreateApiKeyInput, CreatedApiKey, UpdateApiKeyInput } from '../lib/types';

interface ApiKeysPageProps {
  settings: ConnectionSettings;
  items: ApiKeyWorkspace[];
  onRefresh: (successMessage?: string) => Promise<void>;
  onMessage: (message: string) => void;
}

function readString(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim();
}

function readBool(formData: FormData, key: string): boolean {
  return formData.get(key) === 'on';
}

function isExpiringSoon(expiresAtMs: number | null) {
  return typeof expiresAtMs === 'number' && expiresAtMs - Date.now() < 7 * 24 * 60 * 60 * 1000;
}

function keyStatus(item: ApiKeyWorkspace) {
  if (!item.apiKey.enabled) return { label: '停用', tone: 'disabled' as const };
  if (isExpiringSoon(item.apiKey.expires_at_ms)) return { label: '即将过期', tone: 'warning' as const };
  return { label: '启用', tone: 'normal' as const };
}

export function ApiKeysPage(props: ApiKeysPageProps) {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [created, setCreated] = createSignal<CreatedApiKey | null>(null);
  const [createOpen, setCreateOpen] = createSignal(false);
  const [selectedId, setSelectedId] = createSignal<number | null>(null);

  const selected = createMemo(() => props.items.find((item) => item.apiKey.id === selectedId()) ?? null);

  const ensureLive = () => {
    if (!props.settings.adminToken.trim()) {
      props.onMessage('请先填写管理员口令。');
      return false;
    }
    return true;
  };

  const submitCreate = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!ensureLive()) return;

    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const payload: CreateApiKeyInput = {
      name: readString(formData, 'name'),
      enabled: readBool(formData, 'enabled'),
      log_enabled: readBool(formData, 'log_enabled'),
      expires_at_ms: parseDateTimeLocalInput(readString(formData, 'expires_at')),
    };

    if (!payload.name) {
      props.onMessage('密钥名称不能为空。');
      return;
    }

    setBusy('create');
    try {
      const result = await createApiKey(props.settings, payload);
      setCreated(result);
      setCreateOpen(false);
      await props.onRefresh(`密钥 ${payload.name} 已创建。`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '创建密钥失败。');
    } finally {
      setBusy(null);
    }
  };

  const submitUpdate = async (event: SubmitEvent) => {
    event.preventDefault();
    const current = selected();
    if (!current || !ensureLive()) return;

    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const payload: UpdateApiKeyInput = {
      name: readString(formData, 'name'),
      enabled: readBool(formData, 'enabled'),
      log_enabled: readBool(formData, 'log_enabled'),
      expires_at_ms: parseDateTimeLocalInput(readString(formData, 'expires_at')),
    };

    if (!payload.name) {
      props.onMessage('密钥名称不能为空。');
      return;
    }

    setBusy(`update-${current.apiKey.id}`);
    try {
      await updateApiKey(props.settings, current.apiKey.id, payload);
      await props.onRefresh(`密钥 ${payload.name} 已更新。`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新密钥失败。');
    } finally {
      setBusy(null);
    }
  };

  const toggleEnabled = async (item: ApiKeyWorkspace, enabled: boolean) => {
    if (!ensureLive()) return;
    setBusy(`toggle-${item.apiKey.id}`);
    try {
      await updateApiKey(props.settings, item.apiKey.id, { enabled });
      await props.onRefresh(`密钥 ${item.apiKey.name} 已${enabled ? '启用' : '停用'}。`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新状态失败。');
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (item: ApiKeyWorkspace) => {
    if (!ensureLive()) return;
    const confirmed = window.confirm(`删除密钥“${item.apiKey.name}”？该操作不可撤销。`);
    if (!confirmed) return;

    setBusy(`delete-${item.apiKey.id}`);
    try {
      await deleteApiKey(props.settings, item.apiKey.id);
      setSelectedId((current) => (current === item.apiKey.id ? null : current));
      await props.onRefresh(`密钥 ${item.apiKey.name} 已删除。`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '删除密钥失败。');
    } finally {
      setBusy(null);
    }
  };

  const stats = createMemo(() => [
    { label: '密钥总数', value: formatCompactInteger(props.items.length), hint: '当前已创建的访问密钥' },
    {
      label: '启用中',
      value: formatCompactInteger(props.items.filter((item) => item.apiKey.enabled).length),
      hint: '可立即发起请求',
    },
    {
      label: '即将过期',
      value: formatCompactInteger(props.items.filter((item) => isExpiringSoon(item.apiKey.expires_at_ms)).length),
      hint: '7 天内到期',
    },
    {
      label: '累计成本',
      value: formatCost(props.items.reduce((sum, item) => sum + item.totals.cost, 0)),
      hint: '按所有密钥汇总',
    },
  ]);

  return (
    <div class="flex flex-col gap-6">
      <PageHeader
        title="密钥"
        description="创建和管理访问密钥。"
        actions={
          <Button type="button" onClick={() => setCreateOpen(true)}>
            <Plus />
            创建密钥
          </Button>
        }
      />

      <StatsGrid items={stats()} />

      <Card class="border-border/80 bg-card/95">
        <CardHeader>
          <CardTitle>密钥列表</CardTitle>
          <CardDescription>优先展示正在使用的密钥。</CardDescription>
        </CardHeader>
        <CardContent>
          <Show
            when={props.items.length > 0}
            fallback={
              <EmptyState
                title="还没有密钥"
                description="先创建第一条访问密钥，再提供给接入方使用。"
                action={
                  <Button type="button" onClick={() => setCreateOpen(true)}>
                    创建密钥
                  </Button>
                }
              />
            }
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>密钥</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>最近模型</TableHead>
                  <TableHead>请求量</TableHead>
                  <TableHead>用量</TableHead>
                  <TableHead>成本</TableHead>
                  <TableHead>到期</TableHead>
                  <TableHead class="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <For each={props.items}>
                  {(item) => {
                    const status = keyStatus(item);
                    return (
                      <TableRow class="cursor-pointer" onClick={() => setSelectedId(item.apiKey.id)}>
                        <TableCell>
                          <div class="flex flex-col gap-1">
                            <strong class="text-sm font-medium text-foreground">{item.apiKey.name}</strong>
                            <span class="text-xs text-muted-foreground">#{item.apiKey.id}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                        </TableCell>
                        <TableCell>{item.recentModels.length > 0 ? item.recentModels.join(', ') : '—'}</TableCell>
                        <TableCell>{formatCompactInteger(item.totals.requests)}</TableCell>
                        <TableCell>{formatCompactInteger(item.totals.tokens)}</TableCell>
                        <TableCell>{formatCost(item.totals.cost)}</TableCell>
                        <TableCell>{item.apiKey.expires_at_ms ? formatDateTime(item.apiKey.expires_at_ms) : '不过期'}</TableCell>
                        <TableCell class="text-right">
                          <div class="flex justify-end gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={(event) => {
                                event.stopPropagation();
                                setSelectedId(item.apiKey.id);
                              }}
                            >
                              查看
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={busy() === `toggle-${item.apiKey.id}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                void toggleEnabled(item, !item.apiKey.enabled);
                              }}
                            >
                              <Power />
                            </Button>
                          </div>
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

      <DetailDrawer open={createOpen()} title="创建密钥" description="填写必要信息后立即生成。" onClose={() => setCreateOpen(false)}>
        <form class="flex flex-col gap-4" onSubmit={(event) => void submitCreate(event)}>
          <FieldGroup>
            <Field>
              <FieldLabel>名称</FieldLabel>
              <Input name="name" placeholder="team-default" />
            </Field>
            <Field>
              <FieldLabel>到期时间</FieldLabel>
              <Input name="expires_at" type="datetime-local" />
              <FieldDescription>留空表示不过期。</FieldDescription>
            </Field>
          </FieldGroup>
          <div class="grid gap-3 md:grid-cols-2">
            <label class="flex items-center gap-3 rounded-xl border border-border/70 bg-muted/30 px-3 py-3 text-sm">
              <Checkbox name="enabled" checked />
              <span>创建后立即启用</span>
            </label>
            <label class="flex items-center gap-3 rounded-xl border border-border/70 bg-muted/30 px-3 py-3 text-sm">
              <Checkbox name="log_enabled" checked />
              <span>记录请求元数据</span>
            </label>
          </div>
          <Button type="submit" disabled={busy() === 'create'}>
            {busy() === 'create' ? '创建中…' : '创建密钥'}
          </Button>
          <Show when={created()}>
            {(createdKey) => (
              <Card class="border-emerald-200 bg-emerald-50">
                <CardContent class="flex flex-col gap-2 p-4">
                  <div class="text-sm font-medium text-emerald-900">明文密钥只展示一次</div>
                  <code class="break-all text-sm text-emerald-900">{createdKey().api_key}</code>
                  <div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void navigator.clipboard.writeText(createdKey().api_key).then(() => props.onMessage('新密钥已复制。'))}
                    >
                      <Copy />
                      复制
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </Show>
        </form>
      </DetailDrawer>

      <DetailDrawer
        open={!!selected()}
        title={selected()?.apiKey.name ?? '密钥详情'}
        description={selected() ? `查看并维护 #${selected()!.apiKey.id}` : undefined}
        onClose={() => setSelectedId(null)}
      >
        <Show when={selected()}>
          {(item) => {
            const data = item();
            const status = keyStatus(data);
            return (
              <div class="flex flex-col gap-6">
                <div class="grid gap-3 md:grid-cols-3">
                  <Card class="border-border/70 bg-muted/25">
                    <CardContent class="p-4">
                      <div class="text-[0.72rem] uppercase tracking-[0.18em] text-muted-foreground">状态</div>
                      <div class="mt-2">
                        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                      </div>
                    </CardContent>
                  </Card>
                  <Card class="border-border/70 bg-muted/25">
                    <CardContent class="p-4">
                      <div class="text-[0.72rem] uppercase tracking-[0.18em] text-muted-foreground">请求量</div>
                      <div class="mt-2 text-xl font-semibold text-foreground">{formatCompactInteger(data.totals.requests)}</div>
                    </CardContent>
                  </Card>
                  <Card class="border-border/70 bg-muted/25">
                    <CardContent class="p-4">
                      <div class="text-[0.72rem] uppercase tracking-[0.18em] text-muted-foreground">成本</div>
                      <div class="mt-2 text-xl font-semibold text-foreground">{formatCost(data.totals.cost)}</div>
                    </CardContent>
                  </Card>
                </div>

                <form class="flex flex-col gap-4" onSubmit={(event) => void submitUpdate(event)}>
                  <FieldGroup>
                    <Field>
                      <FieldLabel>名称</FieldLabel>
                      <Input name="name" value={data.apiKey.name} />
                    </Field>
                    <Field>
                      <FieldLabel>到期时间</FieldLabel>
                      <Input name="expires_at" type="datetime-local" value={formatDateTimeLocalInput(data.apiKey.expires_at_ms)} />
                    </Field>
                  </FieldGroup>

                  <div class="grid gap-3 md:grid-cols-2">
                    <label class="flex items-center gap-3 rounded-xl border border-border/70 bg-muted/30 px-3 py-3 text-sm">
                      <Checkbox name="enabled" checked={data.apiKey.enabled} />
                      <span>启用密钥</span>
                    </label>
                    <label class="flex items-center gap-3 rounded-xl border border-border/70 bg-muted/30 px-3 py-3 text-sm">
                      <Checkbox name="log_enabled" checked={data.apiKey.log_enabled} />
                      <span>记录请求元数据</span>
                    </label>
                  </div>

                  <Card class="border-border/70 bg-muted/25">
                    <CardContent class="grid gap-2 p-4">
                      <div class="text-sm text-muted-foreground">最近使用模型</div>
                      <div class="text-sm text-foreground">{data.recentModels.length > 0 ? data.recentModels.join(', ') : '暂无记录'}</div>
                    </CardContent>
                  </Card>

                  <div class="flex flex-wrap gap-2">
                    <Button type="submit" disabled={busy() === `update-${data.apiKey.id}`}>
                      {busy() === `update-${data.apiKey.id}` ? '保存中…' : '保存更改'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy() === `toggle-${data.apiKey.id}`}
                      onClick={() => void toggleEnabled(data, !data.apiKey.enabled)}
                    >
                      <Power />
                      {data.apiKey.enabled ? '停用' : '启用'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy() === `delete-${data.apiKey.id}`}
                      onClick={() => void handleDelete(data)}
                    >
                      <Trash2 />
                      删除
                    </Button>
                  </div>
                </form>
              </div>
            );
          }}
        </Show>
      </DetailDrawer>
    </div>
  );
}
