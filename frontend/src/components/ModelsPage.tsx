import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Plus, RefreshCw, Save, Search, Trash2 } from 'lucide-react';
import { EmptyState } from '@/components/console/EmptyState';
import { FilterBar } from '@/components/console/FilterBar';
import { PageHeader } from '@/components/console/PageHeader';
import { StatusBadge } from '@/components/console/StatusBadge';
import {
  ColumnResizeHandle,
  useResizableColumns,
} from '@/components/console/ResizableTable';
import { t } from '@/lib/i18n';
import {
  createModelAlias,
  createModelAliasTarget,
  deleteModelAlias,
  deleteModelAliasTarget,
  deleteProviderModel,
  loadConsolePreferences,
  loadGatewayModelPolicies,
  loadProviderModelInventory,
  updateGatewayModelPolicy,
  updateConsolePreferences,
  updateModelAlias,
  updateModelAliasTarget,
  updateProviderModel,
} from '@/lib/api';
import type {
  ConnectionSettings,
  GatewayModelPolicy,
  ModelAlias,
  ProviderModelInventory,
  ProviderWorkspace,
} from '@/lib/types';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import InputBase from '@mui/material/InputBase';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

interface ModelsPageProps {
  settings: ConnectionSettings;
  providers: ProviderWorkspace[];
  aliases: ModelAlias[];
  onAliasesRefresh: (successMessage?: string) => Promise<void>;
  onMessage: (message: string) => void;
}

type AvailabilityFilter = '' | 'available' | 'unavailable';
type ConversionFilter = '' | 'enabled' | 'disabled' | 'eligible';

const MODEL_COLUMN_DEFINITIONS = [
  { id: 'provider', label: '上游', defaultWidth: 128, minWidth: 96, maxWidth: 360, align: 'left' },
  { id: 'model', label: '模型', defaultWidth: 200, minWidth: 140, maxWidth: 640, align: 'left' },
  { id: 'alias', label: '显示名称', defaultWidth: 190, minWidth: 140, maxWidth: 480, align: 'left' },
  { id: 'native_endpoint', label: '原生端点', defaultWidth: 180, minWidth: 140, maxWidth: 420, align: 'left' },
  { id: 'availability', label: '库存', defaultWidth: 120, minWidth: 88, maxWidth: 240, align: 'left' },
  { id: 'enabled', label: '启用', defaultWidth: 120, minWidth: 96, maxWidth: 240, align: 'center' },
  { id: 'global', label: '全局', defaultWidth: 80, minWidth: 72, maxWidth: 180, align: 'center' },
  { id: 'conversion', label: '转协议', defaultWidth: 210, minWidth: 160, maxWidth: 480, align: 'center' },
  { id: 'actions', label: '操作', defaultWidth: 96, minWidth: 72, maxWidth: 200, align: 'right' },
] as const;
const MODEL_COLUMN_DEFINITION_MAP = new Map(MODEL_COLUMN_DEFINITIONS.map(column => [column.id, column]));

function initialProviderFilter(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('provider_id') ?? '';
}

function nativeEndpointLabel(model: ProviderModelInventory): string {
  return model.native_api_formats
    .map(format => format === 'responses' ? 'v1/responses' : 'v1/chat/completions')
    .join(' + ');
}

function readString(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim();
}

function readInt(formData: FormData, key: string, fallback: number): number {
  const parsed = Number.parseInt(readString(formData, key), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBool(formData: FormData, key: string): boolean {
  return formData.get(key) === 'on';
}

export function ModelsPage(props: ModelsPageProps) {
  const [models, setModels] = useState<ProviderModelInventory[]>([]);
  const [modelAliasDraft, setModelAliasDraft] = useState<Record<number, string>>({});
  const [gatewayPolicies, setGatewayPolicies] = useState<GatewayModelPolicy[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [providerId, setProviderId] = useState(initialProviderFilter);
  const [nativeFormat, setNativeFormat] = useState('');
  const [availability, setAvailability] = useState<AvailabilityFilter>('');
  const [conversion, setConversion] = useState<ConversionFilter>('');
  const commitModelColumnWidths = useCallback(async (widths: Record<string, number>) => {
    await updateConsolePreferences(props.settings, { model_column_widths: widths });
  }, [props.settings]);
  const reportColumnWidthError = useCallback((error: unknown) => {
    props.onMessage(error instanceof Error ? error.message : '保存模型列宽失败。');
  }, [props.onMessage]);
  const {
    widths: columnWidths,
    applyPersistedWidths,
    resizeColumn,
    resetColumn,
  } = useResizableColumns(
    MODEL_COLUMN_DEFINITIONS,
    commitModelColumnWidths,
    reportColumnWidthError,
  );

  const loadModels = useCallback(async () => {
    if (!props.settings.adminToken.trim()) {
      setModels([]);
      setGatewayPolicies([]);
      return;
    }
    setLoading(true);
    try {
      const [inventory, policies, preferences] = await Promise.all([
        loadProviderModelInventory(props.settings),
        loadGatewayModelPolicies(props.settings).catch(error => {
          props.onMessage(error instanceof Error ? error.message : '加载全局模型策略失败。');
          return [];
        }),
        loadConsolePreferences(props.settings).catch(error => {
          props.onMessage(error instanceof Error ? error.message : '读取模型列宽失败。');
          return null;
        }),
      ]);
      setModels(inventory);
      setGatewayPolicies(policies);
      if (preferences) applyPersistedWidths(preferences.model_column_widths);
      setModelAliasDraft(Object.fromEntries(inventory.map(model => [
        model.id,
        model.alias ?? '',
      ])));
    } catch (error) {
      setModels([]);
      setGatewayPolicies([]);
      props.onMessage(error instanceof Error ? error.message : '读取模型库存失败。');
    } finally {
      setLoading(false);
    }
  }, [applyPersistedWidths, props.onMessage, props.settings]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return models.filter(model => {
      if (query && ![model.upstream_model, model.alias ?? '', model.provider_name]
        .some(value => value.toLowerCase().includes(query))) return false;
      if (providerId && String(model.provider_id) !== providerId) return false;
      if (nativeFormat && !model.native_api_formats.includes(nativeFormat as 'chat_completions' | 'responses')) return false;
      if (availability === 'available' && !model.available) return false;
      if (availability === 'unavailable' && model.available) return false;
      if (conversion === 'enabled' && !model.responses_via_chat_enabled) return false;
      if (conversion === 'disabled' && model.responses_via_chat_enabled) return false;
      if (conversion === 'eligible' && model.provider_type !== 'openai_compatible') return false;
      return true;
    });
  }, [availability, conversion, models, nativeFormat, providerId, search]);

  const disabledGatewayModels = useMemo(() => new Set(
    (gatewayPolicies ?? []).filter(policy => !policy.enabled).map(policy => policy.model_name),
  ), [gatewayPolicies]);

  const providerNames = useMemo(() => new Map(
    props.providers.map(item => [item.provider.id, item.provider.name]),
  ), [props.providers]);

  const tableWidth = useMemo(
    () => MODEL_COLUMN_DEFINITIONS.reduce((sum, column) => sum + columnWidths[column.id], 0),
    [columnWidths],
  );

  const saveInventoryAlias = async (model: ProviderModelInventory) => {
    const trimmed = (modelAliasDraft[model.id] ?? '').trim();
    const nextAlias = trimmed || null;
    if (nextAlias === ((model.alias ?? '').trim() || null)) return;
    setBusy(`model-${model.id}`);
    try {
      await updateProviderModel(props.settings, model.id, { alias: trimmed });
      setModels(current => current.map(item => item.id === model.id ? { ...item, alias: nextAlias } : item));
      setModelAliasDraft(current => ({ ...current, [model.id]: nextAlias ?? '' }));
      props.onMessage('已保存别名。');
    } catch (error) {
      setModelAliasDraft(current => ({ ...current, [model.id]: model.alias ?? '' }));
      props.onMessage(error instanceof Error ? error.message : '保存别名失败。');
    } finally {
      setBusy(null);
    }
  };

  const toggleModelEnabled = async (model: ProviderModelInventory, enabled: boolean) => {
    setModels(current => current.map(item => item.id === model.id ? { ...item, enabled } : item));
    setBusy(`model-${model.id}`);
    try {
      await updateProviderModel(props.settings, model.id, { enabled });
      props.onMessage(enabled ? '模型已启用。' : '模型已停用。');
    } catch (error) {
      setModels(current => current.map(item => item.id === model.id ? { ...item, enabled: model.enabled } : item));
      props.onMessage(error instanceof Error ? error.message : '更新模型状态失败。');
    } finally {
      setBusy(null);
    }
  };

  const toggleConversion = async (model: ProviderModelInventory, enabled: boolean) => {
    setModels(current => current.map(item => item.id === model.id
      ? { ...item, responses_via_chat_enabled: enabled }
      : item));
    setBusy(`model-${model.id}`);
    try {
      await updateProviderModel(props.settings, model.id, {
        responses_via_chat_enabled: enabled,
      });
      props.onMessage(enabled ? '已开启 Responses 转协议。' : '已关闭 Responses 转协议。');
    } catch (error) {
      setModels(current => current.map(item => item.id === model.id
        ? { ...item, responses_via_chat_enabled: model.responses_via_chat_enabled }
        : item));
      props.onMessage(error instanceof Error ? error.message : '更新转协议状态失败。');
    } finally {
      setBusy(null);
    }
  };

  const toggleGatewayModelEnabled = async (model: ProviderModelInventory, enabled: boolean) => {
    setBusy(`gateway-model-${model.upstream_model}`);
    try {
      await updateGatewayModelPolicy(props.settings, {
        model_name: model.upstream_model,
        enabled,
      });
      setGatewayPolicies(await loadGatewayModelPolicies(props.settings));
      props.onMessage(enabled ? '已取消全局禁用。' : '已全局禁用该模型。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新全局模型策略失败。');
    } finally {
      setBusy(null);
    }
  };

  const removeModel = async (model: ProviderModelInventory) => {
    if (!window.confirm(t('确认删除模型 {{name}}？', { name: model.upstream_model }))) return;
    setBusy(`model-${model.id}`);
    try {
      await deleteProviderModel(props.settings, model.id);
      setModels(current => current.filter(item => item.id !== model.id));
      setModelAliasDraft(current => {
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

  const submitAliasCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
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
        mode: (readString(formData, 'alias_mode') || 'ordered') as 'ordered' | 'weighted',
      });
      form.reset();
      await props.onAliasesRefresh(t('模型 {{name}} 已创建。', { name }));
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '创建模型失败。');
    } finally {
      setBusy(null);
    }
  };

  const submitAliasUpdate = async (event: FormEvent<HTMLFormElement>, alias: ModelAlias) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
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
        mode: (readString(formData, `alias_mode_${alias.id}`) || alias.mode) as 'ordered' | 'weighted',
      });
      await props.onAliasesRefresh(t('模型 {{name}} 已更新。', { name }));
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新模型失败。');
    } finally {
      setBusy(null);
    }
  };

  const submitAliasTargetCreate = async (event: FormEvent<HTMLFormElement>, alias: ModelAlias) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const upstreamModel = readString(formData, `alias_target_model_${alias.id}`);
    const targetProviderId = readInt(formData, `alias_target_provider_${alias.id}`, 0);
    if (!upstreamModel || targetProviderId <= 0) {
      props.onMessage('请选择上游并填写模型。');
      return;
    }
    setBusy(`alias-target-create-${alias.id}`);
    try {
      await createModelAliasTarget(props.settings, alias.id, {
        provider_id: targetProviderId,
        upstream_model: upstreamModel,
        enabled: true,
        priority: readInt(formData, `alias_target_priority_${alias.id}`, 100),
        weight: readInt(formData, `alias_target_weight_${alias.id}`, 1),
      });
      form.reset();
      await props.onAliasesRefresh('模型目标已添加。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '添加模型目标失败。');
    } finally {
      setBusy(null);
    }
  };

  const toggleAliasTarget = async (targetId: number, enabled: boolean) => {
    setBusy(`alias-target-${targetId}`);
    try {
      await updateModelAliasTarget(props.settings, targetId, { enabled });
      await props.onAliasesRefresh(enabled ? '模型目标已启用。' : '模型目标已停用。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新模型目标失败。');
    } finally {
      setBusy(null);
    }
  };

  const removeAliasTarget = async (targetId: number) => {
    if (!window.confirm(t('确认删除这个模型目标？'))) return;
    setBusy(`alias-target-${targetId}`);
    try {
      await deleteModelAliasTarget(props.settings, targetId);
      await props.onAliasesRefresh('模型目标已删除。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '删除模型目标失败。');
    } finally {
      setBusy(null);
    }
  };

  const removeAlias = async (alias: ModelAlias) => {
    if (!window.confirm(t('确认删除模型 {{name}}？', { name: alias.name }))) return;
    setBusy(`alias-${alias.id}`);
    try {
      await deleteModelAlias(props.settings, alias.id);
      await props.onAliasesRefresh('模型已删除。');
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '删除模型失败。');
    } finally {
      setBusy(null);
    }
  };

  return <Box className="flex flex-col gap-4">
    <PageHeader
      title="模型"
      description="管理模型库存、别名目标与 Responses 兼容能力。"
      actions={<Box className="flex w-full flex-wrap justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loading || busy !== null}
          onClick={() => void loadModels()}
        >
          <RefreshCw className="mr-2 size-3" aria-hidden="true" />
          {t('刷新')}
        </Button>
      </Box>}
    />

    <FilterBar primary={<>
      <InputBase
        value={search}
        placeholder={t('搜索模型、别名或上游')}
        startAdornment={<Search className="mr-2 size-4 text-muted-foreground" aria-hidden="true" />}
        onChange={event => setSearch(event.target.value)}
      />
      <Select displayEmpty value={providerId} onChange={event => setProviderId(String(event.target.value))}>
        <MenuItem value="">{t('全部上游')}</MenuItem>
        {props.providers.map(item => <MenuItem key={item.provider.id} value={item.provider.id}>
          {item.provider.name}
        </MenuItem>)}
      </Select>
      <Select displayEmpty value={nativeFormat} onChange={event => setNativeFormat(String(event.target.value))}>
        <MenuItem value="">{t('全部原生协议')}</MenuItem>
        <MenuItem value="chat_completions">v1/chat/completions</MenuItem>
        <MenuItem value="responses">v1/responses</MenuItem>
      </Select>
      <Select displayEmpty value={availability} onChange={event => setAvailability(event.target.value as AvailabilityFilter)}>
        <MenuItem value="">{t('全部可用状态')}</MenuItem>
        <MenuItem value="available">{t('可用')}</MenuItem>
        <MenuItem value="unavailable">{t('同步中已下线')}</MenuItem>
      </Select>
      <Select displayEmpty value={conversion} onChange={event => setConversion(event.target.value as ConversionFilter)}>
        <MenuItem value="">{t('全部转换状态')}</MenuItem>
        <MenuItem value="enabled">{t('已开启转协议')}</MenuItem>
        <MenuItem value="disabled">{t('未开启转协议')}</MenuItem>
        <MenuItem value="eligible">{t('可开启转协议')}</MenuItem>
      </Select>
    </>} />

    <Card className="border border-border bg-background shadow-none">
      <Box className="flex flex-wrap items-center justify-between gap-2.5 p-4 pb-3">
        <Box>
          <Typography className="text-sm font-semibold tracking-normal" component="h2">{t('模型库存')}</Typography>
          <Typography className="mt-0.5 text-[0.8125rem] text-muted-foreground" component="p">
            {t('{{visible}} / {{total}} 个模型', { visible: filtered.length, total: models.length })}
          </Typography>
        </Box>
        <StatusBadge tone={models.some(model => !model.available) ? 'warning' : 'normal'}>
          {`${models.filter(model => model.responses_via_chat_enabled).length} ${t('项转协议')}`}
        </StatusBadge>
      </Box>
      <CardContent className="border-t border-border/40 p-0">
        {filtered.length > 0 ? <TableContainer
          className="max-w-full overflow-auto"
          data-testid="model-inventory-table-container"
          sx={{ maxHeight: { xs: '65dvh', md: 'min(70dvh, 48rem)' } }}
        >
          <Table stickyHeader aria-label={t('模型库存')} size="small" sx={{
            tableLayout: 'fixed',
            width: tableWidth,
            '& .MuiTableCell-root': { boxSizing: 'border-box' },
          }}>
            <colgroup>
              {MODEL_COLUMN_DEFINITIONS.map(column => <col
                key={column.id}
                data-column-id={column.id}
                style={{ width: columnWidths[column.id] }}
              />)}
            </colgroup>
            <TableHead sx={{ '& .MuiTableCell-head': { bgcolor: 'background.default' } }}>
              <TableRow>
                {MODEL_COLUMN_DEFINITIONS.map(column => {
                  const width = columnWidths[column.id];
                  return <TableCell
                    key={column.id}
                    align={column.align}
                    aria-label={t(column.label)}
                    data-column-id={column.id}
                    data-sticky-offset={column.id === 'model' ? columnWidths.provider : column.id === 'provider' ? 0 : undefined}
                    data-sticky-column={column.id === 'provider' || column.id === 'model' ? column.id : undefined}
                    sx={{
                      maxWidth: width,
                      minWidth: column.minWidth,
                      overflow: 'visible',
                      position: 'relative',
                      width,
                      ...(column.id === 'provider' ? {
                        position: 'sticky',
                        left: 0,
                        zIndex: 5,
                        bgcolor: 'background.default',
                        boxShadow: { xs: '4px 0 8px -7px rgb(0 0 0 / 0.65)', md: 'none' },
                      } : {}),
                      ...(column.id === 'model' ? {
                        position: 'sticky',
                        left: { xs: 'auto', md: columnWidths.provider },
                        zIndex: 4,
                        bgcolor: 'background.default',
                        boxShadow: { xs: 'none', md: '4px 0 8px -7px rgb(0 0 0 / 0.65)' },
                      } : {}),
                    }}
                  >
                    {t(column.label)}
                    <ColumnResizeHandle
                      column={column}
                      label={t('调整 {{column}} 列宽', { column: t(column.label) })}
                      width={width}
                      onResize={resizeColumn}
                      onReset={resetColumn}
                    />
                  </TableCell>;
                })}
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map(model => {
                const eligible = model.provider_type === 'openai_compatible';
                return <TableRow key={model.id} hover>
                  <TableCell data-column-id="provider" data-sticky-column="provider" data-sticky-offset={0} sx={{
                    position: 'sticky',
                    left: 0,
                    zIndex: 2,
                    width: columnWidths.provider,
                    minWidth: MODEL_COLUMN_DEFINITION_MAP.get('provider')!.minWidth,
                    maxWidth: columnWidths.provider,
                    overflow: 'hidden',
                    bgcolor: 'background.default',
                    boxShadow: { xs: '4px 0 8px -7px rgb(0 0 0 / 0.65)', md: 'none' },
                    'tr:hover &': { bgcolor: 'color-mix(in oklab, var(--muted) 50%, var(--background))' },
                  }}>
                    <Box className="truncate font-medium" title={model.provider_name}>{model.provider_name}</Box>
                    <Box className="mt-1 truncate font-mono text-[0.65rem] text-muted-foreground" title={model.provider_type}>{model.provider_type}</Box>
                  </TableCell>
                  <TableCell className="font-mono text-xs" data-column-id="model" data-sticky-column="model" data-sticky-offset={columnWidths.provider} sx={{
                    position: 'sticky',
                    left: { xs: 'auto', md: columnWidths.provider },
                    zIndex: 2,
                    width: columnWidths.model,
                    minWidth: MODEL_COLUMN_DEFINITION_MAP.get('model')!.minWidth,
                    maxWidth: columnWidths.model,
                    overflow: 'hidden',
                    bgcolor: 'background.default',
                    boxShadow: { xs: 'none', md: '4px 0 8px -7px rgb(0 0 0 / 0.65)' },
                    'tr:hover &': { bgcolor: 'color-mix(in oklab, var(--muted) 50%, var(--background))' },
                  }}><Box className="truncate" title={model.upstream_model}>{model.upstream_model}</Box></TableCell>
                  <TableCell className="p-2" data-column-id="alias" sx={{
                    maxWidth: columnWidths.alias,
                    minWidth: MODEL_COLUMN_DEFINITION_MAP.get('alias')!.minWidth,
                    overflow: 'hidden',
                    width: columnWidths.alias,
                  }}>
                    <InputBase
                      value={modelAliasDraft[model.id] ?? model.alias ?? ''}
                      placeholder={t('无别名')}
                      disabled={busy !== null}
                      inputProps={{ 'aria-label': t('编辑 {{model}} 的显示名称', { model: model.upstream_model }) }}
                      className="h-9 bg-background font-mono text-xs"
                      onChange={event => setModelAliasDraft(current => ({
                        ...current,
                        [model.id]: event.target.value,
                      }))}
                      onBlur={() => void saveInventoryAlias(model)}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs" data-column-id="native_endpoint" sx={{
                    maxWidth: columnWidths.native_endpoint,
                    minWidth: MODEL_COLUMN_DEFINITION_MAP.get('native_endpoint')!.minWidth,
                    overflow: 'hidden',
                    width: columnWidths.native_endpoint,
                  }}><Box className="truncate whitespace-nowrap" title={nativeEndpointLabel(model)}>{nativeEndpointLabel(model)}</Box></TableCell>
                  <TableCell data-column-id="availability" sx={{
                    maxWidth: columnWidths.availability,
                    minWidth: MODEL_COLUMN_DEFINITION_MAP.get('availability')!.minWidth,
                    overflow: 'hidden',
                    width: columnWidths.availability,
                  }}>
                    <StatusBadge tone={model.available ? 'normal' : 'warning'}>
                      {model.available ? t('可用') : t('已下线')}
                    </StatusBadge>
                  </TableCell>
                  <TableCell align="center" data-column-id="enabled" sx={{
                    maxWidth: columnWidths.enabled,
                    minWidth: MODEL_COLUMN_DEFINITION_MAP.get('enabled')!.minWidth,
                    overflow: 'hidden',
                    width: columnWidths.enabled,
                  }}>
                    <FormControlLabel
                      className="m-0 min-w-0 whitespace-nowrap"
                      control={<Checkbox
                        checked={model.enabled}
                        disabled={busy !== null}
                        onChange={event => void toggleModelEnabled(model, event.target.checked)}
                      />}
                      label={t(model.enabled ? '启用' : '停用')}
                    />
                  </TableCell>
                  <TableCell align="center" data-column-id="global" sx={{
                    maxWidth: columnWidths.global,
                    minWidth: MODEL_COLUMN_DEFINITION_MAP.get('global')!.minWidth,
                    overflow: 'hidden',
                    width: columnWidths.global,
                  }}>
                    <Checkbox
                      checked={!disabledGatewayModels.has(model.upstream_model)}
                      disabled={gatewayPolicies === null || busy !== null}
                      aria-label={t('切换 {{model}} 的全局状态', { model: model.upstream_model })}
                      onChange={event => void toggleGatewayModelEnabled(model, event.target.checked)}
                    />
                  </TableCell>
                  <TableCell align="center" data-column-id="conversion" sx={{
                    maxWidth: columnWidths.conversion,
                    minWidth: MODEL_COLUMN_DEFINITION_MAP.get('conversion')!.minWidth,
                    overflow: 'hidden',
                    width: columnWidths.conversion,
                  }}>
                    <FormControlLabel
                      className="m-0 min-w-0 whitespace-nowrap"
                      control={<Checkbox
                        checked={model.responses_via_chat_enabled}
                        disabled={!eligible || !model.available || busy !== null}
                        aria-label={eligible
                          ? t('切换 {{model}} 的 Responses 转协议', { model: model.upstream_model })
                          : t('{{model}} 使用原生协议', { model: model.upstream_model })}
                        onChange={event => void toggleConversion(model, event.target.checked)}
                      />}
                      label={eligible
                        ? 'Chat -> Responses'
                        : model.native_api_formats.includes('responses') ? t('原生 Responses') : t('不支持')}
                    />
                  </TableCell>
                  <TableCell align="right" data-column-id="actions" sx={{
                    maxWidth: columnWidths.actions,
                    minWidth: MODEL_COLUMN_DEFINITION_MAP.get('actions')!.minWidth,
                    overflow: 'hidden',
                    width: columnWidths.actions,
                  }}>
                    <Tooltip title={t('删除模型')}>
                      <span>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={t('删除模型')}
                          disabled={busy !== null}
                          onClick={() => void removeModel(model)}
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                        </Button>
                      </span>
                    </Tooltip>
                  </TableCell>
                </TableRow>;
              })}
            </TableBody>
          </Table>
        </TableContainer> : <EmptyState
          title={loading ? t('正在读取模型') : t('未找到模型')}
          description={loading ? t('请稍候。') : t('尝试放宽筛选条件，或前往上游页同步模型。')}
          action={loading ? undefined : <Button component="a" href="/upstreams" variant="outline">{t('前往上游')}</Button>}
        />}
      </CardContent>
    </Card>

    <Card className="min-w-0 border border-border bg-background shadow-none">
      <Box className="p-4 pb-3">
        <Typography className="text-sm font-semibold tracking-normal" component="h2">{t('模型别名')}</Typography>
        <Typography className="mt-0.5 text-[0.8125rem] text-muted-foreground" component="p">{t('按优先级汇总多个上游模型目标。')}</Typography>
      </Box>
      <CardContent className="grid min-w-0 gap-4 border-t border-border/40 pt-4">
        <Box
          className="grid gap-3 lg:grid-cols-[minmax(180px,1fr)_160px_140px_140px] lg:items-end"
          component="form"
          onSubmit={event => void submitAliasCreate(event)}
        >
          <FormControl>
            <FormLabel>{t('别名')}</FormLabel>
            <InputBase name="alias_name" placeholder={t('gpt-5')} className="bg-background" />
          </FormControl>
          <FormControl>
            <FormLabel>{t('模式')}</FormLabel>
            <Select name="alias_mode" defaultValue="ordered">
              <MenuItem value="ordered">{t('按顺序')}</MenuItem>
              <MenuItem value="weighted">{t('按权重')}</MenuItem>
            </Select>
          </FormControl>
          <FormControlLabel className="m-0 min-h-10 border border-border/40 px-2" control={<Checkbox name="alias_enabled" defaultChecked />} label={t('启用')} />
          <Button type="submit" disabled={busy !== null}>
            <Plus className="mr-2 size-4" aria-hidden="true" />
            {t(busy === 'alias-create' ? '创建中…' : '新增模型')}
          </Button>
        </Box>

        {props.aliases.length > 0 ? <Box className="grid min-w-0 gap-5">
          {props.aliases.map(alias => <Box key={alias.id} className="min-w-0 border border-border/40 bg-muted/5 p-4 sm:p-5">
            <Box
              className="grid gap-4 lg:grid-cols-[minmax(180px,1fr)_160px_140px_96px] lg:items-end"
              component="form"
              onSubmit={event => void submitAliasUpdate(event, alias)}
            >
              <FormControl>
                <FormLabel>{t('别名')}</FormLabel>
                <InputBase name={`alias_name_${alias.id}`} defaultValue={alias.name} className="bg-background" />
              </FormControl>
              <FormControl>
                <FormLabel>{t('模式')}</FormLabel>
                <Select name={`alias_mode_${alias.id}`} defaultValue={alias.mode}>
                  <MenuItem value="ordered">{t('按顺序')}</MenuItem>
                  <MenuItem value="weighted">{t('按权重')}</MenuItem>
                </Select>
              </FormControl>
              <FormControlLabel className="m-0 min-h-10 border border-border/40 px-2" control={<Checkbox name={`alias_enabled_${alias.id}`} defaultChecked={alias.enabled} />} label={t('启用')} />
              <Box className="flex justify-end gap-1">
                <Tooltip title={t('保存')}>
                  <span>
                    <Button type="submit" size="icon" variant="outline" aria-label={t('保存')} disabled={busy !== null}>
                      <Save className="size-4" aria-hidden="true" />
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip title={t('删除模型')}>
                  <span>
                    <Button type="button" size="icon" variant="ghost" aria-label={t('删除模型')} disabled={busy !== null} onClick={() => void removeAlias(alias)}>
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </span>
                </Tooltip>
              </Box>
            </Box>

            <TableContainer className="mt-5 w-full min-w-0 max-w-full overflow-x-auto border border-border/30">
              <Table size="small" sx={{ minWidth: 720 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>{t('上游')}</TableCell>
                    <TableCell>{t('模型')}</TableCell>
                    <TableCell>{t('优先级')}</TableCell>
                    <TableCell>{t('权重')}</TableCell>
                    <TableCell align="center">{t('启用')}</TableCell>
                    <TableCell align="right">{t('操作')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {alias.targets.length > 0 ? alias.targets.map(target => <TableRow key={target.id}>
                    <TableCell>{providerNames.get(target.provider_id) ?? `#${target.provider_id}`}</TableCell>
                    <TableCell className="font-mono text-xs">{target.upstream_model}</TableCell>
                    <TableCell className="font-mono text-xs">{target.priority}</TableCell>
                    <TableCell className="font-mono text-xs">{target.weight}</TableCell>
                    <TableCell align="center">
                      <Checkbox
                        checked={target.enabled}
                        disabled={busy !== null}
                        aria-label={t('切换 {{model}} 目标状态', { model: target.upstream_model })}
                        onChange={event => void toggleAliasTarget(target.id, event.target.checked)}
                      />
                    </TableCell>
                    <TableCell align="right">
                      <Tooltip title={t('删除目标')}>
                        <span>
                          <Button type="button" size="icon" variant="ghost" aria-label={t('删除目标')} disabled={busy !== null} onClick={() => void removeAliasTarget(target.id)}>
                            <Trash2 className="size-4" aria-hidden="true" />
                          </Button>
                        </span>
                      </Tooltip>
                    </TableCell>
                  </TableRow>) : <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">{t('暂无目标。')}</TableCell>
                  </TableRow>}
                </TableBody>
              </Table>
            </TableContainer>

            <Box
              className="mt-4 grid gap-4 lg:grid-cols-[180px_minmax(180px,1fr)_120px_120px_130px] lg:items-end"
              component="form"
              onSubmit={event => void submitAliasTargetCreate(event, alias)}
            >
              <FormControl>
                <FormLabel>{t('上游')}</FormLabel>
                <Select displayEmpty name={`alias_target_provider_${alias.id}`} defaultValue="">
                  <MenuItem value="">{t('选择上游')}</MenuItem>
                  {props.providers.map(item => <MenuItem key={item.provider.id} value={item.provider.id}>{item.provider.name}</MenuItem>)}
                </Select>
              </FormControl>
              <FormControl>
                <FormLabel>{t('模型')}</FormLabel>
                <InputBase name={`alias_target_model_${alias.id}`} placeholder={t('上游模型名称')} className="bg-background" />
              </FormControl>
              <FormControl>
                <FormLabel>{t('优先级')}</FormLabel>
                <InputBase name={`alias_target_priority_${alias.id}`} type="number" defaultValue="100" className="bg-background" />
              </FormControl>
              <FormControl>
                <FormLabel>{t('权重')}</FormLabel>
                <InputBase name={`alias_target_weight_${alias.id}`} type="number" defaultValue="1" className="bg-background" />
              </FormControl>
              <Button type="submit" disabled={busy !== null}>{t('添加目标')}</Button>
            </Box>
          </Box>)}
        </Box> : <EmptyState title={t('暂无模型配置')} description={t('新增一个模型名称后，再为它添加上游目标。')} />}
      </CardContent>
    </Card>
  </Box>;
}
