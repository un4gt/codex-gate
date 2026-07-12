import { useState, type FormEvent } from 'react';
import { ChevronDown } from "lucide-react";
import { PageHeader } from '@/components/console/PageHeader';
import { StatusBadge } from '@/components/console/StatusBadge';
import { PricesPage } from '@/components/PricesPage';
import { t } from '@/lib/i18n';
import { updateRuntimeSetting } from '../lib/api';
import { formatBytes, formatCommitShort, formatMs, formatRoutingStrategy, formatVersionLabel } from '../lib/format';
import type { ConnectionSettings, ModelPrice, ProviderWorkspace, RuntimeEnvPreviewResponse, RuntimeSettingView, RuntimeSettingsResponse, SystemConfigResponse } from '../lib/types';
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
import Typography from "@mui/material/Typography";
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
  const [openSection, setOpenSection] = useState<SectionKey>('basic');
  const [busy, setBusy] = useState(false);
  const toggleSection = (key: SectionKey) => setOpenSection(current => current === key ? current : key);
  const submitRuntimeSetting = async (event: FormEvent<HTMLFormElement>, setting: RuntimeSettingView) => {
    event.preventDefault();
    if (!props.settings.adminToken.trim()) {
      props.onMessage('请先填写管理员口令。');
      return;
    }
    if (!setting.editable) {
      props.onMessage('该设置需要重启后调整。');
      return;
    }
    const formData = new FormData(event.currentTarget);
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
  return <Box className="section-stack">
      <PageHeader title="设置" description="维护连接与系统设置。" />

      <Card>
        <Box className="flex flex-col gap-3 p-6 pb-5">
          <Box className="flex items-center justify-between gap-3">
            <Box>
              <Typography className="text-xl font-semibold tracking-normal text-foreground" component="div">{t("基础连接")}</Typography>
              <Typography className="mt-1 text-sm leading-5 text-muted-foreground" component="div">{t("更新当前控制台的连接信息。")}</Typography>
            </Box>
            <StatusBadge tone={props.settings.adminToken.trim() ? 'normal' : 'warning'}>
              {props.settings.adminToken.trim() ? '已连接' : '未连接'}
            </StatusBadge>
          </Box>
        </Box>
        <CardContent>
          <Box className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_220px]" onSubmit={event => {
          event.preventDefault();
          void props.onRefresh('连接信息已刷新。');
        }} component="form">
            <Box className="flex flex-col gap-6">
              <FormControl>
                <FormLabel>{t("服务地址")}</FormLabel>
                <InputBase value={props.settings.apiBase} onChange={event => props.onApiBaseChange(event.target.value)} />
              </FormControl>
              <FormControl>
                <FormLabel>{t("管理员口令")}</FormLabel>
                <InputBase type="password" value={props.settings.adminToken} onChange={event => props.onAdminTokenChange(event.target.value)} />
                <FormHelperText>{t("只保存在当前标签页。")}</FormHelperText>
              </FormControl>
            </Box>
            <Box className="flex flex-col gap-2">
              <Button type="submit">{t("刷新连接")}</Button>
            </Box>
          </Box>
        </CardContent>
      </Card>

      <SettingsSection title="基础设置" description="查看当前服务配置。" open={openSection === 'basic'} onToggle={() => toggleSection('basic')}>
        <Box className="grid gap-4 md:grid-cols-2">
          <InfoTile label="服务版本" value={formatVersionLabel(props.systemConfig?.build?.version)} />
          <InfoTile label="构建提交" value={formatCommitShort(props.systemConfig?.build?.commit)} />
          <InfoTile label="请求大小限制" value={props.systemConfig ? formatBytes(props.systemConfig.basic.max_request_bytes) : '—'} />
          <InfoTile label="统计刷新" value={props.systemConfig ? `${props.systemConfig.basic.stats_flush_interval_ms}ms` : '—'} />
        </Box>
      </SettingsSection>

      <SettingsSection title="运行设置" description="常用设置可直接生效，资源类设置按建议调整后重启。" open={openSection === 'runtime'} onToggle={() => toggleSection('runtime')}>
        <Box className="grid gap-6">
          <Box className="grid gap-4 md:grid-cols-2">
            {(props.runtimeSettings?.settings ?? []).map(setting => <Box key={`${setting.key}:${String(setting.value)}`} className="surface-tile" onSubmit={event => void submitRuntimeSetting(event, setting)} component="form">
                  <Box className="mb-4 flex items-center justify-between gap-3">
                    <Box>
                      <Box className="text-sm font-medium text-foreground">{setting.label}</Box>
                      <Box className="mt-1 font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground">
                        {setting.requires_restart ? '重启生效' : '立即生效'}
                      </Box>
                    </Box>
                    <StatusBadge tone={setting.editable ? 'normal' : 'warning'}>{setting.editable ? '可修改' : '需重启'}</StatusBadge>
                  </Box>

                  <RuntimeSettingControl setting={setting} />

                  <Box className="mt-4 flex items-center justify-between gap-3 border-t border-border/40 pt-4">
                    <Box className="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground" component="span">
                      默认 {formatSettingValue(setting.default_value)}
                    </Box>
                    <Button type="submit" size="sm" disabled={!setting.editable || busy}>{t("保存")}</Button>
                  </Box>
                </Box>)}
          </Box>

          {props.runtimeEnvPreview ? (preview => <Box className="surface-tile">
                <Box className="mb-4 flex items-center justify-between gap-3">
                  <Box>
                    <Box className="text-sm font-medium text-foreground" component="h3">低内存建议</Box>
                    <Box className="mt-1 text-xs text-muted-foreground" component="p">适合少量用户和低请求量部署。</Box>
                  </Box>
                  <StatusBadge tone="normal">建议值</StatusBadge>
                </Box>
                <Box className="grid gap-3 md:grid-cols-2">
                  {preview.restart_settings.map(item => <InfoTile key={item.key} label={item.label} value={`${formatSettingValue(item.current)} → ${formatSettingValue(item.recommended)}`} />)}
                </Box>
              </Box>)(props.runtimeEnvPreview) : null}
        </Box>
      </SettingsSection>

      <SettingsSection title="分配设置" description="查看请求分配策略。" open={openSection === 'routing'} onToggle={() => toggleSection('routing')}>
        <Box className="grid gap-4 md:grid-cols-2">
          <InfoTile label="分配策略" value={formatRoutingStrategy(props.systemConfig?.routing.endpoint_selector_strategy)} />
          <InfoTile label="返回用量" value={props.systemConfig?.routing.inject_include_usage ? '开启' : '已关闭'} />
          <InfoTile label="上游刷新" value={props.systemConfig ? formatMs(props.systemConfig.routing.upstream_cache_ttl_ms) : '—'} />
          <InfoTile label="密钥刷新" value={props.systemConfig ? formatMs(props.systemConfig.routing.api_key_cache_ttl_ms) : '—'} />
        </Box>
      </SettingsSection>

      <SettingsSection title="稳定性与保护" description="风险项默认折叠。调整前先确认影响范围。" open={openSection === 'stability'} onToggle={() => toggleSection('stability')} warning>
        <Box className="grid gap-4 md:grid-cols-2">
          <InfoTile label="失败阈值" value={String(props.systemConfig?.stability.circuit_breaker_failure_threshold ?? '—')} />
          <InfoTile label="熔断时长" value={props.systemConfig ? formatMs(props.systemConfig.stability.circuit_breaker_open_ms) : '—'} />
        </Box>
      </SettingsSection>

      <SettingsSection title="数据保留与归档" description="归档和清理策略集中在这里。" open={openSection === 'retention'} onToggle={() => toggleSection('retention')}>
        <Box className="grid gap-4 md:grid-cols-2">
          <InfoTile label="请求日志保留" value={props.systemConfig ? `${props.systemConfig.retention.request_log_retention_days} 天` : '—'} />
          <InfoTile label="统计保留" value={props.systemConfig ? `${props.systemConfig.retention.stats_daily_retention_days} 天` : '—'} />
          <InfoTile label="清理间隔" value={props.systemConfig ? formatMs(props.systemConfig.retention.cleanup_interval_ms) : '—'} />
          <InfoTile label="删除批次" value={props.systemConfig ? String(props.systemConfig.retention.delete_batch) : '—'} />
          <InfoTile label="归档" value={props.systemConfig?.retention.archive_enabled ? '开启' : '已关闭'} />
          <InfoTile label="归档目录" value={props.systemConfig?.retention.archive_dir ?? '—'} />
        </Box>
      </SettingsSection>

      <SettingsSection title="价格与成本" description="管理模型单价与成本统计。" open={openSection === 'pricing'} onToggle={() => toggleSection('pricing')}>
        <PricesPage settings={props.settings} providers={props.providers} items={props.prices} onRefresh={props.onRefresh} onMessage={props.onMessage} />
      </SettingsSection>
    </Box>;
}
function SettingsSection(props: {
  title: string;
  description: string;
  open: boolean;
  onToggle: () => void;
  children: any;
  warning?: boolean;
}) {
  return <Card className={props.warning ? 'border-amber-500/40' : ''}>
      <Box className="flex flex-col gap-3 p-6 pb-5">
        <Button type="button" className="flex h-auto w-full cursor-pointer items-center justify-between gap-4 p-0 text-left normal-case tracking-normal hover:bg-transparent" onClick={props.onToggle} variant="ghost">
          <Box>
            <Typography className="text-xl font-semibold tracking-normal text-foreground" component="div">{t(props.title)}</Typography>
            <Typography className="mt-1 text-sm leading-5 text-muted-foreground" component="div">{t(props.description)}</Typography>
          </Box>
          <Box className="flex items-center gap-2">
            {props.warning ? <StatusBadge tone="warning">谨慎修改</StatusBadge> : null}
            <ChevronDown className={`size-6 ${props.open ? 'rotate-180 transition-transform' : 'transition-transform'}`} />
          </Box>
        </Button>
      </Box>
      {props.open ? <CardContent>{props.children}</CardContent> : null}
    </Card>;
}
function InfoTile(props: {
  label: string;
  value: string;
}) {
  return <Box className="surface-tile">
      <Box className="surface-label">{t(props.label)}</Box>
      <Box className="surface-value">{t(props.value)}</Box>
    </Box>;
}
function RuntimeSettingControl(props: {
  setting: RuntimeSettingView;
}) {
  const setting = props.setting;
  if (typeof setting.value === 'boolean') {
    return <Box className="check-row" component="label">
        <Checkbox name={`runtime_${setting.key}`} defaultChecked={setting.value} disabled={!setting.editable} />
        <Box component="span">{t(setting.value ? '开启' : '关闭')}</Box>
      </Box>;
  }
  if (setting.key === 'endpoint_selector_strategy') {
    return <Select name={`runtime_${setting.key}`} defaultValue={String(setting.value ?? 'weighted')} disabled={!setting.editable}>
        <MenuItem value="weighted">按权重</MenuItem>
        <MenuItem value="latency">低延迟</MenuItem>
      </Select>;
  }
  if (typeof setting.value === 'number') {
    return <InputBase name={`runtime_${setting.key}`} type="number" defaultValue={String(setting.value)} disabled={!setting.editable} />;
  }
  return <InputBase name={`runtime_${setting.key}`} defaultValue={String(setting.value ?? '')} disabled={!setting.editable} />;
}
function formatSettingValue(value: string | number | boolean | null) {
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (value === null) return '—';
  return String(value);
}
