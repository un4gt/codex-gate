import { For, Show, createSignal } from 'solid-js';
import { ChevronDown } from 'lucide-solid';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { PageHeader } from '@/components/console/PageHeader';
import { StatusBadge } from '@/components/console/StatusBadge';
import { PricesPage } from '@/components/PricesPage';
import { t } from '@/lib/i18n';
import { updateRuntimeSetting } from '../lib/api';
import { formatBytes, formatCommitShort, formatMs, formatRoutingStrategy, formatVersionLabel } from '../lib/format';
import type {
  ConnectionSettings,
  ModelPrice,
  ProviderWorkspace,
  RuntimeEnvPreviewResponse,
  RuntimeSettingView,
  RuntimeSettingsResponse,
  SystemConfigResponse,
} from '../lib/types';

interface SettingsPageProps {
  settings: ConnectionSettings;
  systemConfig: SystemConfigResponse | null;
  runtimeSettings: RuntimeSettingsResponse | null;
  runtimeEnvPreview: RuntimeEnvPreviewResponse | null;
  prices: ModelPrice[];
  providers: ProviderWorkspace[];
  onApiBaseChange: (value: string) => void;
  onAdminTokenChange: (value: string) => void;
  onRefresh: (successMessage?: string) => Promise<void>;
  onMessage: (message: string) => void;
}

type SectionKey = 'basic' | 'runtime' | 'routing' | 'stability' | 'retention' | 'pricing';

function readString(formData: FormData, key: string) {
  return String(formData.get(key) ?? '').trim();
}

export function SettingsPage(props: SettingsPageProps) {
  const [openSection, setOpenSection] = createSignal<SectionKey>('basic');
  const [busy, setBusy] = createSignal(false);

  const toggleSection = (key: SectionKey) => setOpenSection((current) => (current === key ? current : key));

  const submitRuntimeSetting = async (event: SubmitEvent, setting: RuntimeSettingView) => {
    event.preventDefault();
    if (!props.settings.adminToken.trim()) {
      props.onMessage('请先填写管理员口令。');
      return;
    }
    if (!setting.editable) {
      props.onMessage('该设置需要重启后调整。');
      return;
    }

    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const raw = readString(formData, `runtime_${setting.key}`);
    let value: string | number | boolean | null = raw;
    if (typeof setting.value === 'boolean') {
      value = formData.get(`runtime_${setting.key}`) === 'on';
    } else if (typeof setting.value === 'number') {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        props.onMessage('请输入有效数字。');
        return;
      }
      value = parsed;
    }

    setBusy(true);
    try {
      await updateRuntimeSetting(props.settings, setting.key, value);
      await props.onRefresh(`${setting.label} 已更新。`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新设置失败。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="section-stack">
      <PageHeader title="设置" description="维护连接与系统设置。" />

      <Card>
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
        description="查看当前服务配置。"
        open={openSection() === 'basic'}
        onToggle={() => toggleSection('basic')}
      >
        <div class="grid gap-4 md:grid-cols-2">
          <InfoTile label="服务版本" value={formatVersionLabel(props.systemConfig?.build?.version)} />
          <InfoTile label="构建提交" value={formatCommitShort(props.systemConfig?.build?.commit)} />
          <InfoTile label="请求大小限制" value={props.systemConfig ? formatBytes(props.systemConfig.basic.max_request_bytes) : '—'} />
          <InfoTile label="统计刷新" value={props.systemConfig ? `${props.systemConfig.basic.stats_flush_interval_ms}ms` : '—'} />
        </div>
      </SettingsSection>

      <SettingsSection
        title="运行设置"
        description="常用设置可直接生效，资源类设置按建议调整后重启。"
        open={openSection() === 'runtime'}
        onToggle={() => toggleSection('runtime')}
      >
        <div class="grid gap-6">
          <div class="grid gap-4 md:grid-cols-2">
            <For each={props.runtimeSettings?.settings ?? []} fallback={<div class="surface-tile md:col-span-2"><div class="surface-label">{t('运行设置')}</div><div class="surface-value">{t('暂未读取到运行设置，请刷新连接。')}</div></div>}>
              {(setting) => (
                <form class="surface-tile" onSubmit={(event) => void submitRuntimeSetting(event, setting)}>
                  <div class="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <div class="text-sm font-medium text-foreground">{setting.label}</div>
                      <div class="mt-1 font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground">
                        {setting.requires_restart ? '重启生效' : '立即生效'}
                      </div>
                    </div>
                    <StatusBadge tone={setting.editable ? 'normal' : 'warning'}>{setting.editable ? '可修改' : '需重启'}</StatusBadge>
                  </div>

                  <RuntimeSettingControl setting={setting} />

                  <div class="mt-4 flex items-center justify-between gap-3 border-t border-border/40 pt-4">
                    <span class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground">
                      默认 {formatSettingValue(setting.default_value)}
                    </span>
                    <Button type="submit" size="sm" disabled={!setting.editable || busy()}>
                      保存
                    </Button>
                  </div>
                </form>
              )}
            </For>
          </div>

          <Show when={props.runtimeEnvPreview}>
            {(preview) => (
              <div class="surface-tile">
                <div class="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h3 class="text-sm font-medium text-foreground">低内存建议</h3>
                    <p class="mt-1 text-xs text-muted-foreground">适合少量用户和低请求量部署。</p>
                  </div>
                  <StatusBadge tone="normal">建议值</StatusBadge>
                </div>
                <div class="grid gap-3 md:grid-cols-2">
                  <For each={preview().restart_settings}>
                    {(item) => (
                      <InfoTile
                        label={item.label}
                        value={`${formatSettingValue(item.current)} → ${formatSettingValue(item.recommended)}`}
                      />
                    )}
                  </For>
                </div>
              </div>
            )}
          </Show>
        </div>
      </SettingsSection>

      <SettingsSection
        title="分配设置"
        description="查看请求分配策略。"
        open={openSection() === 'routing'}
        onToggle={() => toggleSection('routing')}
      >
        <div class="grid gap-4 md:grid-cols-2">
          <InfoTile label="分配策略" value={formatRoutingStrategy(props.systemConfig?.routing.endpoint_selector_strategy)} />
          <InfoTile label="返回用量" value={props.systemConfig?.routing.inject_include_usage ? '开启' : '已关闭'} />
          <InfoTile label="上游刷新" value={props.systemConfig ? formatMs(props.systemConfig.routing.upstream_cache_ttl_ms) : '—'} />
          <InfoTile label="密钥刷新" value={props.systemConfig ? formatMs(props.systemConfig.routing.api_key_cache_ttl_ms) : '—'} />
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
        description="管理模型单价与成本统计。"
        open={openSection() === 'pricing'}
        onToggle={() => toggleSection('pricing')}
      >
        <PricesPage
          settings={props.settings}
          providers={props.providers}
          items={props.prices}
          onRefresh={props.onRefresh}
          onMessage={props.onMessage}
        />
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
    <Card class={props.warning ? 'border-amber-500/40' : ''}>
      <CardHeader>
        <button type="button" class="flex w-full cursor-pointer items-center justify-between gap-4 text-left" onClick={props.onToggle}>
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
    <div class="surface-tile">
      <div class="surface-label">{t(props.label)}</div>
      <div class="surface-value">{t(props.value)}</div>
    </div>
  );
}

function RuntimeSettingControl(props: { setting: RuntimeSettingView }) {
  const setting = props.setting;
  if (typeof setting.value === 'boolean') {
    return (
      <label class="check-row">
        <Checkbox name={`runtime_${setting.key}`} checked={setting.value} disabled={!setting.editable} />
        <span>{setting.value ? '开启' : '关闭'}</span>
      </label>
    );
  }

  if (setting.key === 'endpoint_selector_strategy') {
    return (
      <Select name={`runtime_${setting.key}`} value={String(setting.value ?? 'weighted')} disabled={!setting.editable}>
        <option value="weighted">按权重</option>
        <option value="latency">低延迟</option>
      </Select>
    );
  }

  if (typeof setting.value === 'number') {
    return (
      <Input
        name={`runtime_${setting.key}`}
        type="number"
        value={String(setting.value)}
        disabled={!setting.editable}
      />
    );
  }

  return (
    <Input
      name={`runtime_${setting.key}`}
      value={String(setting.value ?? '')}
      disabled={!setting.editable}
    />
  );
}

function formatSettingValue(value: string | number | boolean | null) {
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (value === null) return '—';
  return String(value);
}
