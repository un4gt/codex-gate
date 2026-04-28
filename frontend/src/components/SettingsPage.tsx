import { For, Show, createSignal } from 'solid-js';
import { ChevronDown } from 'lucide-solid';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageHeader } from '@/components/console/PageHeader';
import { StatusBadge } from '@/components/console/StatusBadge';
import { t } from '@/lib/i18n';
import { createPrice } from '../lib/api';
import { formatDateTime, formatMs, formatRoutingStrategy } from '../lib/format';
import type { ConnectionSettings, CreatePriceInput, ModelPrice, ProviderWorkspace, SystemConfigResponse } from '../lib/types';

interface SettingsPageProps {
  settings: ConnectionSettings;
  systemConfig: SystemConfigResponse | null;
  prices: ModelPrice[];
  providers: ProviderWorkspace[];
  onApiBaseChange: (value: string) => void;
  onAdminTokenChange: (value: string) => void;
  onRefresh: (successMessage?: string) => Promise<void>;
  onMessage: (message: string) => void;
}

type SectionKey = 'basic' | 'routing' | 'stability' | 'retention' | 'pricing';

function readString(formData: FormData, key: string) {
  return String(formData.get(key) ?? '').trim();
}

export function SettingsPage(props: SettingsPageProps) {
  const [openSection, setOpenSection] = createSignal<SectionKey>('basic');
  const [busy, setBusy] = createSignal(false);

  const toggleSection = (key: SectionKey) => setOpenSection((current) => (current === key ? current : key));

  const submitPrice = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!props.settings.adminToken.trim()) {
      props.onMessage('请先填写管理员口令。');
      return;
    }

    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const modelName = readString(formData, 'model_name');
    if (!modelName) {
      props.onMessage('模型名称不能为空。');
      return;
    }

    const payload: CreatePriceInput = {
      provider_id: readString(formData, 'provider_id') ? Number(readString(formData, 'provider_id')) : null,
      model_name: modelName,
      price_data: {},
    };

    const input = Number(readString(formData, 'input_cost_per_token') || '0');
    const output = Number(readString(formData, 'output_cost_per_token') || '0');
    const cacheRead = Number(readString(formData, 'cache_read_input_token_cost') || '0');
    const cacheWrite = Number(readString(formData, 'cache_creation_input_token_cost') || '0');

    if (input > 0) payload.price_data.input_cost_per_token = input;
    if (output > 0) payload.price_data.output_cost_per_token = output;
    if (cacheRead > 0) payload.price_data.cache_read_input_token_cost = cacheRead;
    if (cacheWrite > 0) payload.price_data.cache_creation_input_token_cost = cacheWrite;

    if (Object.keys(payload.price_data).length === 0) {
      props.onMessage('至少填写一个价格字段。');
      return;
    }

    setBusy(true);
    try {
      await createPrice(props.settings, payload);
      await props.onRefresh(t('价格 {{name}} 已写入。', { name: payload.model_name }));
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '写入价格失败。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="flex flex-col gap-6">
      <PageHeader title="设置" description="维护连接信息与高级设置。" />

      <Card class="border-border/80 bg-card/95">
        <CardHeader>
          <div class="flex items-center justify-between gap-3">
            <div>
              <CardTitle>基础连接</CardTitle>
              <CardDescription>更新当前控制台的连接信息。</CardDescription>
            </div>
            <StatusBadge tone={props.settings.adminToken.trim() ? 'normal' : 'warning'}>
              {props.settings.adminToken.trim() ? '已连接' : '未连接'}
            </StatusBadge>
          </div>
        </CardHeader>
        <CardContent>
          <form
            class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_220px]"
            onSubmit={(event) => {
              event.preventDefault();
              void props.onRefresh('连接信息已刷新。');
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel>服务地址</FieldLabel>
                <Input value={props.settings.apiBase} onInput={(event) => props.onApiBaseChange(event.currentTarget.value)} />
              </Field>
              <Field>
                <FieldLabel>管理员口令</FieldLabel>
                <Input type="password" value={props.settings.adminToken} onInput={(event) => props.onAdminTokenChange(event.currentTarget.value)} />
                <FieldDescription>只保存在当前标签页。</FieldDescription>
              </Field>
            </FieldGroup>
            <div class="flex flex-col gap-2">
              <Button type="submit">刷新连接</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <SettingsSection
        title="基础设置"
        description="连接信息、健康检查和基础运行参数。"
        open={openSection() === 'basic'}
        onToggle={() => toggleSection('basic')}
      >
        <div class="grid gap-4 md:grid-cols-2">
          <InfoTile label="健康检查" value={`${props.systemConfig?.connection.healthz_path ?? '/healthz'} · ${props.systemConfig?.connection.readyz_path ?? '/readyz'}`} />
          <InfoTile label="监控地址" value={props.systemConfig?.connection.metrics_path ?? '/metrics'} />
          <InfoTile label="静态目录" value={props.systemConfig?.basic.static_dir ?? '—'} />
          <InfoTile label="数据库" value={props.systemConfig?.basic.db_dsn ?? '—'} />
          <InfoTile label="请求大小" value={props.systemConfig ? String(props.systemConfig.basic.max_request_bytes) : '—'} />
          <InfoTile label="用量采样" value={props.systemConfig ? `${props.systemConfig.basic.usage_capture_bytes} / ${props.systemConfig.basic.usage_capture_tail_bytes}` : '—'} />
          <InfoTile label="统计刷新" value={props.systemConfig ? `${props.systemConfig.basic.stats_flush_interval_ms}ms` : '—'} />
        </div>
      </SettingsSection>

      <SettingsSection
        title="请求路由"
        description="查看分配与缓存设置。"
        open={openSection() === 'routing'}
        onToggle={() => toggleSection('routing')}
      >
        <div class="grid gap-4 md:grid-cols-2">
          <InfoTile label="分配策略" value={formatRoutingStrategy(props.systemConfig?.routing.endpoint_selector_strategy)} />
          <InfoTile label="返回用量" value={props.systemConfig?.routing.inject_include_usage ? '开启' : '已关闭'} />
          <InfoTile label="上游缓存" value={props.systemConfig ? formatMs(props.systemConfig.routing.upstream_cache_ttl_ms) : '—'} />
          <InfoTile label="缓存宽限期" value={props.systemConfig ? formatMs(props.systemConfig.routing.upstream_cache_stale_grace_ms) : '—'} />
          <InfoTile label="密钥缓存" value={props.systemConfig ? formatMs(props.systemConfig.routing.api_key_cache_ttl_ms) : '—'} />
          <InfoTile label="缓存容量" value={props.systemConfig ? String(props.systemConfig.routing.api_key_cache_max_entries) : '—'} />
        </div>
      </SettingsSection>

      <SettingsSection
        title="稳定性与保护"
        description="风险项默认折叠。调整前先确认影响范围。"
        open={openSection() === 'stability'}
        onToggle={() => toggleSection('stability')}
        warning
      >
        <div class="grid gap-4 md:grid-cols-2">
          <InfoTile label="失败阈值" value={String(props.systemConfig?.stability.circuit_breaker_failure_threshold ?? '—')} />
          <InfoTile label="熔断时长" value={props.systemConfig ? formatMs(props.systemConfig.stability.circuit_breaker_open_ms) : '—'} />
        </div>
      </SettingsSection>

      <SettingsSection
        title="数据保留与归档"
        description="归档和清理策略集中在这里。"
        open={openSection() === 'retention'}
        onToggle={() => toggleSection('retention')}
      >
        <div class="grid gap-4 md:grid-cols-2">
          <InfoTile label="请求日志保留" value={props.systemConfig ? `${props.systemConfig.retention.request_log_retention_days} 天` : '—'} />
          <InfoTile label="统计保留" value={props.systemConfig ? `${props.systemConfig.retention.stats_daily_retention_days} 天` : '—'} />
          <InfoTile label="清理间隔" value={props.systemConfig ? formatMs(props.systemConfig.retention.cleanup_interval_ms) : '—'} />
          <InfoTile label="删除批次" value={props.systemConfig ? String(props.systemConfig.retention.delete_batch) : '—'} />
          <InfoTile label="归档" value={props.systemConfig?.retention.archive_enabled ? '开启' : '已关闭'} />
          <InfoTile label="归档目录" value={props.systemConfig?.retention.archive_dir ?? '—'} />
        </div>
      </SettingsSection>

      <SettingsSection
        title="价格与成本"
        description="低频维护项，留在设置页，不再单独占一级导航。"
        open={openSection() === 'pricing'}
        onToggle={() => toggleSection('pricing')}
      >
        <div class="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
          <Card class="border-border/70 bg-muted/20">
            <CardHeader>
              <CardTitle>新增价格</CardTitle>
            </CardHeader>
            <CardContent>
              <form class="flex flex-col gap-4" onSubmit={(event) => void submitPrice(event)}>
                <FieldGroup>
                  <Field>
                    <FieldLabel>上游</FieldLabel>
                    <select
                      name="provider_id"
                      class="flex h-10 w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground"
                    >
                      <option value="">{t('全局默认')}</option>
                      <For each={props.providers}>
                        {(item) => <option value={item.provider.id}>{item.provider.name}</option>}
                      </For>
                    </select>
                  </Field>
                  <Field>
                    <FieldLabel>模型名称</FieldLabel>
                    <Input name="model_name" placeholder="gpt-4.1-mini" />
                  </Field>
                </FieldGroup>
                <FieldGroup class="grid gap-4 md:grid-cols-2">
                  <Field>
                    <FieldLabel>输入 / token</FieldLabel>
                    <Input name="input_cost_per_token" type="number" step="0.000000001" />
                  </Field>
                  <Field>
                    <FieldLabel>输出 / token</FieldLabel>
                    <Input name="output_cost_per_token" type="number" step="0.000000001" />
                  </Field>
                  <Field>
                    <FieldLabel>缓存读取</FieldLabel>
                    <Input name="cache_read_input_token_cost" type="number" step="0.000000001" />
                  </Field>
                  <Field>
                    <FieldLabel>缓存写入</FieldLabel>
                    <Input name="cache_creation_input_token_cost" type="number" step="0.000000001" />
                  </Field>
                </FieldGroup>
                <Button type="submit" disabled={busy()}>
                  {busy() ? '写入中…' : '写入价格'}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card class="border-border/70 bg-muted/20">
            <CardHeader>
              <CardTitle>当前价格项</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>模型</TableHead>
                    <TableHead>作用域</TableHead>
                    <TableHead>更新时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <Show
                    when={props.prices.length > 0}
                    fallback={
                      <TableRow>
                        <TableCell colspan={3} class="text-center text-muted-foreground">
                          {t('暂无价格项。')}
                        </TableCell>
                      </TableRow>
                    }
                  >
                    <For each={props.prices}>
                      {(item) => (
                        <TableRow>
                          <TableCell>{item.model_name}</TableCell>
                          <TableCell>{item.provider_id ? props.providers.find((provider) => provider.provider.id === item.provider_id)?.provider.name ?? `#${item.provider_id}` : t('全局默认')}</TableCell>
                          <TableCell>{formatDateTime(item.updated_at_ms)}</TableCell>
                        </TableRow>
                      )}
                    </For>
                  </Show>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </SettingsSection>
    </div>
  );
}

function SettingsSection(props: {
  title: string;
  description: string;
  open: boolean;
  onToggle: () => void;
  children: any;
  warning?: boolean;
}) {
  return (
    <Card class={`border-border/80 bg-card/95 ${props.warning ? 'border-amber-200' : ''}`}>
      <CardHeader>
        <button type="button" class="flex w-full items-center justify-between gap-4 text-left" onClick={props.onToggle}>
          <div>
            <CardTitle>{props.title}</CardTitle>
            <CardDescription>{props.description}</CardDescription>
          </div>
          <div class="flex items-center gap-2">
            <Show when={props.warning}>
              <StatusBadge tone="warning">谨慎修改</StatusBadge>
            </Show>
            <ChevronDown class={props.open ? 'rotate-180 transition-transform' : 'transition-transform'} />
          </div>
        </button>
      </CardHeader>
      <Show when={props.open}>
        <CardContent>{props.children}</CardContent>
      </Show>
    </Card>
  );
}

function InfoTile(props: { label: string; value: string }) {
  return (
    <div class="rounded-xl border border-border/70 bg-muted/25 p-4">
      <div class="text-[0.72rem] uppercase tracking-[0.18em] text-muted-foreground">{t(props.label)}</div>
      <div class="mt-2 break-all text-sm text-foreground">{t(props.value)}</div>
    </div>
  );
}
