import { PriceSyncPanel } from './PriceSyncPanel';
import { ModelIdentity } from './console/ModelIdentity';
import { useMemo, useRef, useState } from 'react';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@/components/console/ScrollableTable';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { FilterBar } from './console/FilterBar';
import { EmptyState } from './console/EmptyState';
import { ListPagination } from './console/ListPagination';
import { PriceEditorDrawer, formatUnitCost, reconciliationMessage } from './PriceEditor';
import { deletePrice } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { paginate, useListQuery } from '@/lib/useListQuery';
import type { ConnectionSettings, ModelPrice, ProviderWorkspace } from '@/lib/types';

interface PricesPageProps {
  settings: ConnectionSettings;
  providers: ProviderWorkspace[];
  items: ModelPrice[];
  loading?: boolean;
  error?: string | null;
  onRefresh: (message?: string) => Promise<void>;
  onMessage: (message: string) => void;
}

export function PricesPage(props: PricesPageProps) {
  const { t } = useI18n();
  const { params, filter, update, page, pageSize } = useListQuery();
  const [deleteTarget, setDeleteTarget] = useState<ModelPrice | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteCancelButtonRef = useRef<HTMLButtonElement>(null);
  const search = params.get('q') ?? '';
  const scope = params.get('scope') ?? '';
  const source = params.get('source') ?? '';
  const providerId = params.get('provider_id') ?? '';
  const providerNames = useMemo(() => new Map(props.providers.map(item => [item.provider.id, item.provider.name])), [props.providers]);
  const scopeNames = new Map(providerNames);
  for (const item of props.items) if (item.provider_id !== null && !scopeNames.has(item.provider_id)) scopeNames.set(item.provider_id, t('上游 #{{id}}', { id: item.provider_id }));
  if (providerId && !scopeNames.has(Number(providerId))) scopeNames.set(Number(providerId), t('上游 #{{id}}', { id: providerId }));
  const filtered = useMemo(() => props.items.filter(item => {
    if (source && (item.source ?? 'manual') !== source) return false;
    if (search && ![item.model_name, item.display?.display_name ?? '', ...(item.display?.aliases ?? []), providerNames.get(item.provider_id ?? -1) ?? ''].some(value => value.toLowerCase().includes(search.trim().toLowerCase()))) return false;
    if (scope === 'global') return item.provider_id === null;
    return !providerId || item.provider_id === Number(providerId);
  }).sort((a, b) => a.model_name.localeCompare(b.model_name) || (a.provider_id ?? -1) - (b.provider_id ?? -1)), [props.items, search, scope, providerId, source, providerNames]);
  const visible = paginate(filtered, page, pageSize).items;
  const confirmDelete = async () => {
    if (!deleteTarget || busy) return;
    setBusy(true);
    setDeleteError(null);
    try {
      const result = await deletePrice(props.settings, deleteTarget.id);
      await props.onRefresh(`${t('价格 {{name}} 已删除。', { name: deleteTarget.model_name })} ${reconciliationMessage(result)}`);
      setDeleteTarget(null);
    } catch (cause) { setDeleteError(cause instanceof Error ? cause.message : t('删除价格失败。')); }
    finally { setBusy(false); }
  };
  return <Box sx={{ display: 'grid', gap: 2, minWidth: 0 }}>
    <PriceSyncPanel settings={props.settings} onRefresh={props.onRefresh} />
    <FilterBar primary={<>
      <InputBase value={search} placeholder={t('搜索模型价格')} sx={{ gridColumn: { xl: 'span 2' } }} inputProps={{ 'aria-label': t('搜索模型价格') }} startAdornment={<Search size={16} />} onChange={event => filter('q', event.target.value, true)} />
      <Select sx={{ gridColumn: { xl: 'span 2' } }} displayEmpty value={scope === 'global' ? 'global' : providerId} inputProps={{ 'aria-label': t('作用范围') }} onChange={event => update({ scope: event.target.value === 'global' ? 'global' : null, provider_id: event.target.value === 'global' ? null : String(event.target.value), page: null })}>
        <MenuItem value="">{t('全部范围')}</MenuItem><MenuItem value="global">{t('全局默认')}</MenuItem>
        {Array.from(scopeNames, ([id, name]) => <MenuItem key={id} value={String(id)}>{name}</MenuItem>)}
      </Select>
      <Select displayEmpty value={source} inputProps={{ 'aria-label': t('价格来源') }} onChange={event => filter('source', event.target.value)}><MenuItem value="">{t('全部来源')}</MenuItem><MenuItem value="manual">{t('手工价格')}</MenuItem><MenuItem value="cloud">{t('云端报价')}</MenuItem></Select>
    </>} actions={<Button onClick={() => update({ price_id: 'new', price_provider: scope === 'global' ? null : providerId, price_model: null })} disabled={props.loading || !!props.error}><Plus size={16} />{t('新增价格')}</Button>} />
    <Typography variant="body2" color="text.secondary">{t('{{count}} 个价格项 · 美元 / 百万 token', { count: filtered.length })}</Typography>
    {props.error ? <Alert severity="error" action={<Button onClick={() => void props.onRefresh()}>{t('重试')}</Button>}>{props.error}</Alert> : null}
    {props.loading && props.items.length === 0 ? <CircularProgress size={24} aria-label={t('加载中')} /> : null}
    {visible.length > 0 ? <TableContainer><Table className="table-fixed" size="small" aria-label={t('当前可用价格项')} sx={{ minWidth: 1150, '& td': { overflow: 'hidden' } }}>
      <TableHead><TableRow>{['模型', '范围', '输入', '输出', '缓存读取', '缓存写入', '价格层级', '更新时间', '操作'].map(label => <TableCell key={label} className="whitespace-nowrap" sx={{ width: label === '模型' ? 210 : label === '范围' ? 150 : label === '更新时间' ? 140 : label === '操作' ? 96 : label === '价格层级' ? 100 : 115 }}>{t(label)}</TableCell>)}</TableRow></TableHead>
      <TableBody>{visible.map(item => <TableRow key={item.id} hover>
        <TableCell className="whitespace-nowrap"><ModelIdentity id={item.model_name} display={item.display} /><Typography variant="caption" color="text.secondary">{t(item.source === 'cloud' ? '云端报价' : '手工价格')}{item.source === 'cloud' && item.display?.quote_provider ? ` · ${item.display.quote_provider}` : ''}</Typography>{item.display?.adaptation && item.display.adaptation !== 'supported' ? <Typography component="div" variant="caption" color="warning.main" sx={{ whiteSpace: 'normal' }}>{t('含未适配计费维度')}</Typography> : null}{item.display?.present === false ? <Typography component="div" variant="caption" color="warning.main">{t('源中已缺失，保留最后报价')}</Typography> : null}</TableCell>
        <TableCell><Chip size="small" variant="outlined" label={item.provider_id === null ? t('全局默认') : scopeNames.get(item.provider_id)} title={item.provider_id === null ? t('全局默认') : scopeNames.get(item.provider_id)} sx={{ maxWidth: '100%' }} /></TableCell>
        {(['input', 'output', 'cache_read', 'cache_write'] as const).map(kind => <TableCell key={kind} sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{formatUnitCost(item.price_data.base[kind])}</TableCell>)}
        <TableCell sx={{ whiteSpace: 'nowrap' }}>{item.price_data.tiers.length ? t('{{count}} 个阶梯', { count: item.price_data.tiers.length }) : t('基础')}</TableCell>
        <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDateTime(item.updated_at_ms)}</TableCell>
        <TableCell><Box sx={{ display: 'flex' }}>
          <IconButton aria-label={t('编辑价格 {{name}}', { name: item.model_name })} disabled={!!props.error} onClick={() => update({ price_id: String(item.id) })}><Pencil size={16} /></IconButton>
          <IconButton color="error" aria-label={t('删除价格 {{name}}', { name: item.model_name })} disabled={busy || !!props.error} onClick={() => { setDeleteError(null); setDeleteTarget(item); }}><Trash2 size={16} /></IconButton>
        </Box></TableCell>
      </TableRow>)}</TableBody>
    </Table></TableContainer> : !props.loading && !props.error ? <EmptyState title={t('当前还没有价格项。')} description={t('尝试调整筛选条件，或新增模型价格。')} /> : null}
    <ListPagination count={filtered.length} />
    <PriceEditorDrawer {...props} />
    <Dialog open={!!deleteTarget} onClose={busy ? undefined : () => setDeleteTarget(null)} aria-labelledby="delete-price-title" slotProps={{ transition: { onEntered: () => deleteCancelButtonRef.current?.focus() } }}>
      <DialogTitle id="delete-price-title">{t('删除当前价格')}</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2 }}>
        {deleteError ? <Alert severity="error">{deleteError}</Alert> : null}
        <DialogContentText>{t('确认删除 {{name}} 的当前价格？', { name: deleteTarget?.model_name ?? '' })}</DialogContentText>
        <DialogContentText>{t('删除后新请求将不再使用这个价格。历史价格版本和已经计价的请求会保留。')}</DialogContentText>
      </DialogContent>
      <DialogActions><Button ref={deleteCancelButtonRef} autoFocus variant="outline" disabled={busy} onClick={() => setDeleteTarget(null)}>{t('取消')}</Button><Button color="error" disabled={busy} onClick={() => void confirmDelete()}>{t(busy ? '删除中…' : '确认删除')}</Button></DialogActions>
    </Dialog>
  </Box>;
}
