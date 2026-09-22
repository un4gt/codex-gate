import { ModelIdentity } from './console/ModelIdentity';
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { RefreshCw, Search } from 'lucide-react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import FormLabel from '@mui/material/FormLabel';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputBase from '@mui/material/InputBase';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@/components/console/ScrollableTable';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { ConfirmAction } from './console/ConfirmAction';
import { DetailDrawer } from './console/DetailDrawer';
import { EmptyState } from './console/EmptyState';
import { FilterBar } from './console/FilterBar';
import { ListPagination } from './console/ListPagination';
import { ColumnResizeHandle, useResizableColumns } from './console/ResizableTable';
import { ModelAliasesPage } from './ModelAliasesPage';
import { PricesPage } from './PricesPage';
import { PriceCardDetails, PriceEditorDrawer, formatUnitCost } from './PriceEditor';
import { deleteProviderModel, loadConsolePreferences, loadGatewayModelPolicies, loadModelAliases, loadPrices, loadProviderModelInventory, updateConsolePreferences, updateGatewayModelPolicy, updateProviderModel } from '@/lib/api';
import { aggregateModels, effectivePrice, summarizeRate, type ModelSummary } from '@/lib/modelCatalog';
import { t } from '@/lib/i18n';
import { paginate, useListQuery } from '@/lib/useListQuery';
import { useRemoteResource } from '@/lib/useRemoteResource';
import type { ConnectionSettings, ConsolePreferences, GatewayModelPolicy, ModelPrice, ProviderModelInventory, ProviderWorkspace } from '@/lib/types';

interface ModelsPageProps {
  settings: ConnectionSettings;
  providers: ProviderWorkspace[];
  refreshKey?: number;
  onMessage: (message: string) => void;
}

export function ModelsPage(props: ModelsPageProps) {
  const { pathname } = useLocation();
  const { params } = useListQuery();
  const inventory = useRemoteResource(props.settings, loadProviderModelInventory, props.refreshKey);
  const policies = useRemoteResource(props.settings, loadGatewayModelPolicies, props.refreshKey);
  const preferences = useRemoteResource(props.settings, loadConsolePreferences, props.refreshKey);
  const prices = useRemoteResource(props.settings, loadPrices, props.refreshKey);
  const aliases = useRemoteResource(props.settings, loadModelAliases, props.refreshKey);
  const tab = pathname.endsWith('/prices') ? 'prices' : pathname.endsWith('/aliases') ? 'aliases' : 'inventory';
  const providerQuery = params.get('provider_id') ? `?provider_id=${encodeURIComponent(params.get('provider_id')!)}` : '';
  const refreshPrices = async (message?: string) => { await prices.reload(); if (message) props.onMessage(message); };
  const refreshAliases = async (message?: string) => { await aliases.reload(); if (message) props.onMessage(message); };
  const refresh = () => tab === 'prices' ? prices.reload() : tab === 'aliases' ? aliases.reload() : Promise.all([inventory.reload(), policies.reload(), preferences.reload(), prices.reload()]);
  const refreshing = tab === 'prices' ? prices.loading : tab === 'aliases' ? aliases.loading : inventory.loading || policies.loading || preferences.loading || prices.loading;
  if (!['/models', '/models/', '/models/aliases', '/models/prices'].includes(pathname)) return <Navigate to={`/models${providerQuery}`} replace />;
  return <Box sx={{ display: 'grid', gap: 2, minWidth: 0 }}>
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, minWidth: 0, borderBottom: 1, borderColor: 'divider' }}>
      <Tabs value={tab} variant="scrollable" scrollButtons="auto" aria-label={t('模型中心')} sx={{ minWidth: 0 }}>
        <Tab value="inventory" label={t('模型列表')} component={Link} to={`/models${providerQuery}`} />
        <Tab value="aliases" label={t('路由别名')} component={Link} to={`/models/aliases${providerQuery}`} />
        <Tab value="prices" label={t('价格管理')} component={Link} to={`/models/prices${providerQuery}`} />
      </Tabs>
      <Button variant="outline" disabled={refreshing} onClick={() => void refresh()} sx={{ flexShrink: 0 }}><RefreshCw size={16} />{t('刷新')}</Button>
    </Box>
    {tab === 'prices' ? <PricesPage settings={props.settings} providers={props.providers} items={prices.data ?? []} loading={prices.loading} error={prices.error} onRefresh={refreshPrices} onMessage={props.onMessage} />
      : tab === 'aliases' ? <ModelAliasesPage settings={props.settings} providers={props.providers} aliases={aliases.data ?? []} loading={aliases.loading} error={aliases.error} onRefresh={refreshAliases} />
        : <ModelInventory {...props} inventory={inventory} policies={policies} preferences={preferences} prices={prices} onPricesRefresh={refreshPrices} />}
  </Box>;
}

type Resource<T> = ReturnType<typeof useRemoteResource<T>>;
interface InventoryProps extends ModelsPageProps {
  inventory: Resource<ProviderModelInventory[]>;
  policies: Resource<GatewayModelPolicy[]>;
  preferences: Resource<ConsolePreferences>;
  prices: Resource<ModelPrice[]>;
  onPricesRefresh: (message?: string) => Promise<void>;
}

const MODEL_COLUMNS = [
  { id: 'model', label: '模型', defaultWidth: 240, minWidth: 160, maxWidth: 640 },
  { id: 'provider_count', label: '上游数量', defaultWidth: 104, minWidth: 88, maxWidth: 240 },
  { id: 'native_endpoint', label: '原生端点', defaultWidth: 160, minWidth: 128, maxWidth: 420 },
  { id: 'availability', label: '库存', defaultWidth: 96, minWidth: 88, maxWidth: 240 },
  { id: 'enabled', label: '上游启用', defaultWidth: 128, minWidth: 112, maxWidth: 240 },
  { id: 'input_price', label: '输入', defaultWidth: 152, minWidth: 112, maxWidth: 360 },
  { id: 'output_price', label: '输出', defaultWidth: 152, minWidth: 112, maxWidth: 360 },
  { id: 'global', label: '全局', defaultWidth: 88, minWidth: 72, maxWidth: 180 },
  { id: 'actions', label: '操作', defaultWidth: 96, minWidth: 80, maxWidth: 200 },
] as const;

function ModelInventory(props: InventoryProps) {
  const { params, filter, update, page, pageSize } = useListQuery();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProviderModelInventory | null>(null);
  const search = params.get('q') ?? '';
  const providerId = params.get('provider_id') ?? '';
  const protocol = ['chat_completions', 'responses'].includes(params.get('protocol') ?? '') ? params.get('protocol')! : '';
  const availability = ['available', 'unavailable'].includes(params.get('availability') ?? '') ? params.get('availability')! : '';
  const conversion = ['enabled', 'disabled', 'eligible'].includes(params.get('conversion') ?? '') ? params.get('conversion')! : '';
  const models = props.inventory.data ?? [];
  const priceItems = props.prices.data ?? [];
  const pricesKnown = props.prices.data !== null && !props.prices.error;
  const policiesKnown = props.policies.data !== null && !props.policies.error;
  const commitWidths = useCallback(async (widths: Record<string, number>) => {
    if (!props.preferences.data || props.preferences.error) return;
    await updateConsolePreferences(props.settings, { model_column_widths: { ...props.preferences.data.model_column_widths, ...widths } });
  }, [props.preferences.data, props.preferences.error, props.settings]);
  const reportWidthError = useCallback((cause: unknown) => props.onMessage(cause instanceof Error ? cause.message : t('保存模型列宽失败。')), [props.onMessage]);
  const { widths, applyPersistedWidths, resizeColumn, resetColumn } = useResizableColumns(MODEL_COLUMNS, commitWidths, reportWidthError);
  useEffect(() => { if (props.preferences.data) applyPersistedWidths(props.preferences.data.model_column_widths); }, [props.preferences.data, applyPersistedWidths]);
  const filtered = useMemo(() => aggregateModels((props.inventory.data ?? []).filter(model => {
    const query = search.trim().toLowerCase();
    if (query && ![model.upstream_model, model.display?.display_name ?? '', ...(model.display?.aliases ?? []), model.alias ?? '', model.provider_name].some(value => value.toLowerCase().includes(query))) return false;
    if (providerId && String(model.provider_id) !== providerId) return false;
    if (protocol && !model.native_api_formats.includes(protocol as 'chat_completions' | 'responses')) return false;
    if (availability && model.available !== (availability === 'available')) return false;
    if (conversion === 'eligible' && model.provider_type !== 'openai_compatible') return false;
    if (conversion === 'enabled' && !model.responses_via_chat_enabled) return false;
    if (conversion === 'disabled' && model.responses_via_chat_enabled) return false;
    return true;
  })), [props.inventory.data, search, providerId, protocol, availability, conversion]);
  const selected = filtered.find(model => model.name === params.get('model'));
  const disabled = new Set((props.policies.data ?? []).filter(policy => !policy.enabled).map(policy => policy.model_name));
  const providerNames = new Map(props.providers.map(item => [String(item.provider.id), item.provider.name]));
  for (const model of models) providerNames.set(String(model.provider_id), model.provider_name);
  if (providerId && !providerNames.has(providerId)) providerNames.set(providerId, t('上游 #{{id}}', { id: providerId }));
  const run = async (operation: () => Promise<unknown>, reload: () => Promise<void>, message: string) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await operation(); await reload(); props.onMessage(t(message)); return true; }
    catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); setError(message); props.onMessage(message); return false; }
    finally { setBusy(false); }
  };
  const toggleGlobal = (model: string, enabled: boolean) => void run(() => updateGatewayModelPolicy(props.settings, { model_name: model, enabled }), props.policies.reload, enabled ? '已取消全局禁用。' : '已全局禁用该模型。');
  const toggleProvider = (model: ProviderModelInventory, enabled: boolean) => void run(() => updateProviderModel(props.settings, model.id, { enabled }), props.inventory.reload, enabled ? '已在此上游启用模型。' : '已在此上游停用模型。');
  const setPrice = (model: ProviderModelInventory, item: ModelPrice | null) => update({ price_id: item ? String(item.id) : 'new', price_model: model.upstream_model, price_provider: String(model.provider_id) });
  return <Box sx={{ display: 'grid', gap: 2, minWidth: 0 }}>
    <FilterBar primary={<>
      <InputBase value={search} placeholder={t('搜索模型、别名或上游')} inputProps={{ 'aria-label': t('搜索模型、别名或上游') }} startAdornment={<Search size={16} />} onChange={event => filter('q', event.target.value, true)} />
      <Select displayEmpty value={providerId} inputProps={{ 'aria-label': t('上游') }} onChange={event => filter('provider_id', String(event.target.value))}><MenuItem value="">{t('全部上游')}</MenuItem>{Array.from(providerNames, ([id, name]) => <MenuItem key={id} value={id}>{name}</MenuItem>)}</Select>
      <Select displayEmpty value={protocol} inputProps={{ 'aria-label': t('原生端点') }} onChange={event => filter('protocol', String(event.target.value))}><MenuItem value="">{t('全部原生协议')}</MenuItem><MenuItem value="chat_completions">Chat Completions</MenuItem><MenuItem value="responses">Responses</MenuItem></Select>
      <Select displayEmpty value={availability} inputProps={{ 'aria-label': t('库存') }} onChange={event => filter('availability', String(event.target.value))}><MenuItem value="">{t('全部可用状态')}</MenuItem><MenuItem value="available">{t('可用')}</MenuItem><MenuItem value="unavailable">{t('同步中已下线')}</MenuItem></Select>
      <Select displayEmpty value={conversion} inputProps={{ 'aria-label': t('转协议') }} onChange={event => filter('conversion', String(event.target.value))}><MenuItem value="">{t('全部转换状态')}</MenuItem><MenuItem value="enabled">{t('已开启转协议')}</MenuItem><MenuItem value="disabled">{t('未开启转协议')}</MenuItem><MenuItem value="eligible">{t('可开启转协议')}</MenuItem></Select>
    </>} />
    {error ? <Alert severity="error" onClose={() => setError(null)}>{error}</Alert> : null}
    {([['库存', props.inventory], ['全局', props.policies], ['价格', props.prices], ['列宽', props.preferences]] as const).map(([label, resource]) => resource.error ? <Alert key={label} severity="error" action={<Button onClick={() => void resource.reload()}>{t('重试')}</Button>}>{t(label)}: {resource.error}</Alert> : null)}
    <Typography variant="body2" color="text.secondary">{t('{{count}} 个模型 · 基础价格 / 百万 token', { count: filtered.length })}</Typography>
    {providerId ? <Typography variant="body2" color="text.secondary">{t('启用开关仅影响 {{provider}}，全局状态可在模型详情中管理。', { provider: providerNames.get(providerId) ?? providerId })}</Typography> : null}
    {props.inventory.loading && props.inventory.data === null ? <CircularProgress size={24} aria-label={t('正在读取模型')} /> : null}
    {filtered.length ? <TableContainer data-testid="model-inventory-table-container" sx={{ maxHeight: '70dvh' }}>
      <Table stickyHeader size="small" aria-label={t('模型库存')} sx={{ tableLayout: 'fixed', width: MODEL_COLUMNS.reduce((sum, column) => sum + widths[column.id], 0) }}>
        <colgroup>{MODEL_COLUMNS.map(column => <col key={column.id} data-column-id={column.id} style={{ width: widths[column.id] }} />)}</colgroup>
        <TableHead><TableRow>{MODEL_COLUMNS.map(column => <TableCell key={column.id} data-column-id={column.id} data-sticky-column={column.id === 'model' ? 'model' : undefined} data-sticky-offset={column.id === 'model' ? 0 : undefined} sx={{ whiteSpace: 'nowrap', position: 'sticky', left: column.id === 'model' ? 0 : undefined, zIndex: column.id === 'model' ? 4 : 3, bgcolor: 'background.paper', pr: 3 }}>
          {t(column.label)}
          {props.preferences.data && !props.preferences.error ? <ColumnResizeHandle column={column} label={t('调整 {{column}} 列宽', { column: t(column.label) })} width={widths[column.id]} onResize={resizeColumn} onReset={resetColumn} /> : null}
        </TableCell>)}</TableRow></TableHead>
        <TableBody>{paginate(filtered, page, pageSize).items.map(model => {
          const providerModel = providerId ? model.inventories.find(item => String(item.provider_id) === providerId) : null;
          return <TableRow key={model.name} hover>
          <TableCell data-sticky-column="model" sx={{ position: 'sticky', left: 0, zIndex: 2, bgcolor: 'background.paper' }}><ModelIdentity id={model.name} display={model.inventories[0]?.display} onOpen={() => update({ model: model.name })} /></TableCell>
          <TableCell>{model.inventories.length}</TableCell>
          <TableCell sx={{ overflow: 'hidden' }}><Typography variant="caption" component="div">{Array.from(new Set(model.inventories.flatMap(item => item.native_api_formats))).map(format => format === 'responses' ? 'Responses' : 'Chat Completions').join(' · ')}</Typography></TableCell>
          <TableCell>{model.inventories.filter(item => item.available).length} / {model.inventories.length}</TableCell>
          <TableCell>{providerModel ? <Checkbox checked={providerModel.enabled} disabled={busy} slotProps={{ input: { 'aria-label': t('切换 {{provider}} 的 {{model}} 启用状态', { provider: providerModel.provider_name, model: providerModel.upstream_model }) } }} onChange={(_, enabled) => toggleProvider(providerModel, enabled)} /> : <>{model.inventories.filter(item => item.enabled).length} / {model.inventories.length}</>}</TableCell>
          {(['input', 'output'] as const).map(kind => <TableCell key={kind}><RateSummary model={model} prices={pricesKnown ? priceItems : null} kind={kind} /></TableCell>)}
          <TableCell>{providerId ? <Typography variant="body2" color={policiesKnown && disabled.has(model.name) ? 'warning.main' : 'text.secondary'}>{policiesKnown ? t(disabled.has(model.name) ? '已禁用' : '已启用') : '—'}</Typography> : <Tooltip title={t('作用于所有上游的同名真实模型。')}><Box component="span"><Checkbox checked={policiesKnown && !disabled.has(model.name)} indeterminate={!policiesKnown} disabled={busy || !policiesKnown} slotProps={{ input: { 'aria-label': t('切换 {{model}} 的全局状态', { model: model.name }) } }} onChange={(_, enabled) => toggleGlobal(model.name, enabled)} /></Box></Tooltip>}</TableCell>
          <TableCell><Button onClick={() => update({ model: model.name })}>{t('详情')}</Button></TableCell>
        </TableRow>;
        })}</TableBody>
      </Table>
    </TableContainer> : !props.inventory.loading && !props.inventory.error ? <EmptyState title={t('未找到模型')} description={t('尝试放宽筛选条件，或前往上游页同步模型。')} action={<Button component={Link} to="/upstreams" variant="outline">{t('前往上游')}</Button>} /> : null}
    <ListPagination count={filtered.length} />
    <DetailDrawer open={params.has('model') && !params.has('price_id')} title={selected?.name ?? t('模型详情')} description={t('按上游管理模型与生效价格。')} onClose={() => update({ model: null }, true)}>
      {error ? <Alert severity="error" onClose={() => setError(null)}>{error}</Alert> : null}
      {props.policies.error ? <Alert severity="error" action={<Button onClick={() => void props.policies.reload()}>{t('重试')}</Button>}>{props.policies.error}</Alert> : null}
      {props.inventory.loading && !selected ? <CircularProgress size={24} /> : !selected ? <Alert severity="warning">{props.inventory.error ?? t('当前筛选下未找到该模型，可能已删除。')}</Alert> : <Box sx={{ display: 'grid', gap: 2 }}>
        <ModelIdentity id={selected.name} display={selected.inventories[0]?.display} />
        <Alert severity={policiesKnown && disabled.has(selected.name) ? 'warning' : 'info'}><Typography variant="body2">{t(policiesKnown && disabled.has(selected.name) ? '该模型已全局禁用，所有上游均无法使用。' : '作用于所有上游的同名真实模型。')}</Typography><FormControlLabel control={<Checkbox checked={policiesKnown && !disabled.has(selected.name)} indeterminate={!policiesKnown} disabled={busy || !policiesKnown} onChange={(_, enabled) => toggleGlobal(selected.name, enabled)} />} label={t('全局启用')} /></Alert>
        {selected.inventories.map(model => {
          const price = pricesKnown ? effectivePrice(priceItems, model.provider_id, model.upstream_model) : null;
          const specific = price?.provider_id === model.provider_id ? price : null;
          return <Card key={model.id} variant="outlined"><CardContent sx={{ display: 'grid', gap: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}><Typography component="h3" variant="subtitle1">{model.provider_name}</Typography><Button component={Link} to={`/upstreams?provider_id=${model.provider_id}`}>{t('上游详情')}</Button></Box>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}><Chip size="small" label={t(model.available ? '可用' : '已下线')} />{model.native_api_formats.map(format => <Chip size="small" variant="outlined" key={format} label={format === 'responses' ? 'Responses' : 'Chat Completions'} />)}</Box>
            <ModelNameForm key={`${model.id}:${model.alias ?? ''}`} model={model} busy={busy} onSave={alias => void run(() => updateProviderModel(props.settings, model.id, { alias }), props.inventory.reload, '已保存别名。')} />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <FormControlLabel control={<Checkbox checked={model.enabled} disabled={busy} slotProps={{ input: { 'aria-label': t('切换 {{provider}} 的 {{model}} 启用状态', { provider: model.provider_name, model: model.upstream_model }) } }} onChange={(_, enabled) => toggleProvider(model, enabled)} />} label={t('在此上游启用')} />
              <FormControlLabel control={<Checkbox checked={model.responses_via_chat_enabled} disabled={busy || model.provider_type !== 'openai_compatible' || !model.available} slotProps={{ input: { 'aria-label': t('切换 {{model}} 的 Responses 转协议', { model: model.upstream_model }) } }} onChange={(_, enabled) => void run(() => updateProviderModel(props.settings, model.id, { responses_via_chat_enabled: enabled }), props.inventory.reload, enabled ? '已开启 Responses 转协议。' : '已关闭 Responses 转协议。')} />} label={model.provider_type === 'openai_compatible' ? 'Chat → Responses' : t(model.native_api_formats.includes('responses') ? '原生 Responses' : '不支持')} />
              <Button color="error" disabled={busy} onClick={() => setDeleteTarget(model)}>{t('删除模型')}</Button>
            </Box>
            {!pricesKnown ? <Alert severity="info" action={props.prices.error ? <Button onClick={() => void props.prices.reload()}>{t('重试')}</Button> : undefined}>{t(props.prices.error ? '价格暂不可用，请重试。' : '加载中')}</Alert> : <>
              <Typography variant="subtitle2">{t(price ? price.provider_id === null ? '全局默认' : '上游专属' : '未定价')}</Typography>
              {price ? <PriceCardDetails card={price.price_data} /> : null}
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                <Button variant="outline" onClick={() => setPrice(model, specific)}>{t(specific ? '编辑专属价格' : '设置专属价格')}</Button>
                {price?.provider_id === null ? <Button onClick={() => update({ price_id: String(price.id) })}>{t('编辑全局价格')}</Button> : null}
              </Box>
            </>}
          </CardContent></Card>;
        })}
      </Box>}
    </DetailDrawer>
    <PriceEditorDrawer settings={props.settings} providers={props.providers} items={priceItems} loading={props.prices.data === null && props.prices.loading} error={props.prices.error} onRefresh={props.onPricesRefresh} onMessage={props.onMessage} />
    <ConfirmAction open={!!deleteTarget} error={error} title={t('确认删除模型 {{name}}？', { name: deleteTarget?.upstream_model ?? '' })} description={deleteTarget?.provider_name} busy={busy} onClose={() => setDeleteTarget(null)} onConfirm={() => {
      if (deleteTarget) void run(() => deleteProviderModel(props.settings, deleteTarget.id), props.inventory.reload, '已删除模型。').then(ok => { if (ok) setDeleteTarget(null); });
    }} />
  </Box>;
}

function ModelNameForm({ model, busy, onSave }: { model: ProviderModelInventory; busy: boolean; onSave: (name: string) => void }) {
  const fieldId = useId();
  const save = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); onSave(String(new FormData(event.currentTarget).get('alias') ?? '').trim()); };
  return <Box component="form" onSubmit={save} sx={{ display: 'flex', alignItems: 'flex-end', gap: 1 }}>
    <FormControl fullWidth><FormLabel htmlFor={fieldId}>{t('显示名称')}</FormLabel><InputBase id={fieldId} name="alias" defaultValue={model.alias ?? ''} placeholder={t('无别名')} disabled={busy} /></FormControl>
    <Button type="submit" disabled={busy}>{t('保存')}</Button>
  </Box>;
}

function RateSummary({ model, prices, kind }: { model: ModelSummary; prices: ModelPrice[] | null; kind: 'input' | 'output' }) {
  if (!prices) return <Typography variant="caption" color="text.secondary">—</Typography>;
  const rate = summarizeRate(model.inventories, prices, kind);
  const tiered = model.inventories.some(item => (effectivePrice(prices, item.provider_id, item.upstream_model)?.price_data.tiers.length ?? 0) > 0);
  return <Box sx={{ fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>
    <Typography variant="body2">{rate.missing === 'all' ? t('未定价') : rate.multiple ? t('多价格') : formatUnitCost(rate.value)}</Typography>
    {rate.missing === 'some' ? <Typography variant="caption" color="warning.main">{t('部分未定价')}</Typography> : null}
    {tiered ? <Typography variant="caption" color="text.secondary" component="div">{t('含阶梯价格')}</Typography> : null}
  </Box>;
}
