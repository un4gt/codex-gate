import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { createPrice, deletePrice, updatePrice } from '@/lib/api';
import { formatCompactInteger, formatDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import type {
  ConnectionSettings,
  ContextPriceTier,
  CreatePriceInput,
  ModelPrice,
  PriceCardV2,
  PriceRates,
  ProviderWorkspace,
} from '@/lib/types';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import FormLabel from '@mui/material/FormLabel';
import IconButton from '@mui/material/IconButton';
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

interface PricesPageProps {
  settings: ConnectionSettings;
  providers: ProviderWorkspace[];
  items: ModelPrice[];
  onRefresh: (successMessage?: string) => Promise<void>;
  onMessage: (message: string) => void;
}

interface RateDraft {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

interface TierDraft extends RateDraft {
  id: number;
  threshold: string;
}

interface PriceDraft {
  providerId: string;
  modelName: string;
  base: RateDraft;
  tiers: TierDraft[];
}

interface EditState {
  item: ModelPrice;
  draft: PriceDraft;
}

interface ReconciliationResult {
  backfilled_requests: number;
  history_recalculation_pending: boolean;
}

type BusyAction = 'create' | 'edit' | 'delete' | null;

const EMPTY_RATES: RateDraft = {
  input: '',
  output: '',
  cacheRead: '',
  cacheWrite: '',
};

function emptyPriceDraft(): PriceDraft {
  return {
    providerId: '',
    modelName: '',
    base: { ...EMPTY_RATES },
    tiers: [],
  };
}

function rateDraftFromRates(rates: PriceRates): RateDraft {
  return {
    input: rates.input ?? '',
    output: rates.output ?? '',
    cacheRead: rates.cache_read ?? '',
    cacheWrite: rates.cache_write ?? '',
  };
}

function draftFromPrice(item: ModelPrice, nextTierId: () => number): PriceDraft {
  return {
    providerId: item.provider_id === null ? '' : String(item.provider_id),
    modelName: item.model_name,
    base: rateDraftFromRates(item.price_data.base),
    tiers: item.price_data.tiers.map(tier => ({
      id: nextTierId(),
      threshold: String(tier.over_total_input_tokens),
      ...rateDraftFromRates(tier.rates),
    })),
  };
}

function parseRate(raw: string, label: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error(t('{{key}} 不能为空；免费请填写 0。', { key: label }));
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(t('{{key}} 需要是大于等于 0 的数字。', { key: label }));
  }
  return value;
}

function ratesFromDraft(values: RateDraft): PriceRates {
  return {
    input: parseRate(values.input, t('输入单价')),
    output: parseRate(values.output, t('输出单价')),
    cache_read: parseRate(values.cacheRead, t('缓存读取单价')),
    cache_write: parseRate(values.cacheWrite, t('缓存写入单价')),
  };
}

function parseTiers(drafts: TierDraft[]): ContextPriceTier[] {
  const tiers = drafts.map((draft, index) => {
    const threshold = Number(draft.threshold);
    if (!Number.isSafeInteger(threshold) || threshold <= 0) {
      throw new Error(t('第 {{index}} 个层级的输入阈值必须是正整数。', {
        index: index + 1,
      }));
    }
    return {
      over_total_input_tokens: threshold,
      rates: ratesFromDraft(draft),
    };
  });
  tiers.sort((left, right) => left.over_total_input_tokens - right.over_total_input_tokens);
  if (tiers.some((tier, index) => index > 0
    && tier.over_total_input_tokens === tiers[index - 1].over_total_input_tokens)) {
    throw new Error(t('价格层级的输入阈值不能重复。'));
  }
  return tiers;
}

function priceDataFromDraft(draft: PriceDraft): PriceCardV2 {
  return {
    schema_version: 2,
    unit: 'usd_per_million_tokens',
    base: ratesFromDraft(draft.base),
    tiers: parseTiers(draft.tiers),
  };
}

function reconciliationMessage(result: ReconciliationResult): string {
  if (result.history_recalculation_pending) {
    return t('历史用量将在打开总览时继续回算。');
  }
  if (result.backfilled_requests > 0) {
    return t('已按当前价格重新计价 {{count}} 条历史请求。', {
      count: formatCompactInteger(result.backfilled_requests),
    });
  }
  return t('未找到需要重新计价的历史请求。');
}

function formatUnitCost(value: string | null): string {
  if (value === null) return t('无价格');
  if (value === '0' || /^0\.0+$/.test(value)) return t('免费');
  return `$${value} / MToken`;
}

function SummaryTile(props: { label: string; value: string; hint?: string }) {
  return <Box className="surface-tile">
      <Box className="surface-label">{t(props.label)}</Box>
      <Box className="mt-1.5 text-lg font-semibold tracking-tight text-foreground">{props.value}</Box>
      {props.hint ? <Box className="mt-2 text-sm leading-6 text-muted-foreground" component="p">{t(props.hint)}</Box> : null}
    </Box>;
}

function RateFields(props: {
  values: RateDraft;
  disabled?: boolean;
  onChange: (key: keyof RateDraft, value: string) => void;
}) {
  const fields: Array<{ key: keyof RateDraft; label: string; placeholder: string }> = [
    { key: 'input', label: '输入单价 / MToken', placeholder: '2.50' },
    { key: 'output', label: '输出单价 / MToken', placeholder: '15.00' },
    { key: 'cacheRead', label: '缓存读取 / MToken', placeholder: '0.25' },
    { key: 'cacheWrite', label: '缓存写入 / MToken', placeholder: '3.125' },
  ];
  return <Box className="grid gap-4 md:grid-cols-2">
      {fields.map(field => <FormControl key={field.key} required>
          <FormLabel>{t(field.label)}</FormLabel>
          <InputBase
            required
            disabled={props.disabled}
            inputMode="decimal"
            value={props.values[field.key]}
            placeholder={t(field.placeholder)}
            onChange={event => props.onChange(field.key, event.target.value)}
          />
        </FormControl>)}
    </Box>;
}

function PriceFields(props: {
  draft: PriceDraft;
  providers: ProviderWorkspace[];
  identityReadOnly?: boolean;
  disabled?: boolean;
  onChange: (draft: PriceDraft) => void;
  onNewTier: () => TierDraft;
}) {
  const updateBase = (key: keyof RateDraft, value: string) => {
    props.onChange({ ...props.draft, base: { ...props.draft.base, [key]: value } });
  };
  const updateTier = (id: number, key: keyof Omit<TierDraft, 'id'>, value: string) => {
    props.onChange({
      ...props.draft,
      tiers: props.draft.tiers.map(tier => tier.id === id ? { ...tier, [key]: value } : tier),
    });
  };
  const removeTier = (id: number) => {
    props.onChange({ ...props.draft, tiers: props.draft.tiers.filter(tier => tier.id !== id) });
  };
  return <Box className="grid gap-4">
      <Box className="grid gap-4 md:grid-cols-2">
        <FormControl>
          <FormLabel>{t('作用范围')}</FormLabel>
          <Select
            displayEmpty
            disabled={props.disabled || props.identityReadOnly}
            value={props.draft.providerId}
            onChange={event => props.onChange({ ...props.draft, providerId: String(event.target.value) })}
          >
            <MenuItem value="">{t('全局默认')}</MenuItem>
            {props.providers.map(item => <MenuItem key={item.provider.id} value={String(item.provider.id)}>{item.provider.name}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl required>
          <FormLabel>{t('模型名称')}</FormLabel>
          <InputBase
            required
            readOnly={props.identityReadOnly}
            disabled={props.disabled}
            value={props.draft.modelName}
            placeholder={t('gpt-4.1-mini')}
            onChange={event => props.onChange({ ...props.draft, modelName: event.target.value })}
          />
        </FormControl>
      </Box>

      {props.identityReadOnly ? <FormHelperText>{t('范围和模型保持不变；保存后会创建新的价格版本。')}</FormHelperText> : null}

      <Box className="flex flex-col gap-4 border border-border p-4" component="fieldset">
        <Box className="px-2 text-sm font-medium text-foreground" component="legend">{t('基础价格')}</Box>
        <RateFields values={props.draft.base} disabled={props.disabled} onChange={updateBase} />
        <FormHelperText>{t('四类单价都必须填写；免费项请填写 0。')}</FormHelperText>
      </Box>

      <Box className="flex flex-wrap items-center justify-between gap-3">
        <Box>
          <Box className="text-sm font-medium text-foreground">{t('上下文价格层级')}</Box>
          <Box className="mt-1 text-sm text-muted-foreground" component="p">{t('超过阈值后，整次请求使用该层级的完整单价。')}</Box>
        </Box>
        <Button
          type="button"
          variant="outline"
          disabled={props.disabled}
          onClick={() => props.onChange({ ...props.draft, tiers: [...props.draft.tiers, props.onNewTier()] })}
        >
          <Plus className="size-4" aria-hidden="true" />
          {t('添加层级')}
        </Button>
      </Box>

      {props.draft.tiers.map((tier, index) => <Box key={tier.id} className="flex flex-col gap-4 border border-border p-4" component="fieldset">
          <Box className="px-2 text-sm font-medium text-foreground" component="legend">
            {t('价格层级 {{index}}', { index: index + 1 })}
          </Box>
          <Box className="flex flex-wrap items-end gap-3">
            <FormControl className="min-w-52 flex-1" required>
              <FormLabel>{t('超过总输入 token')}</FormLabel>
              <InputBase
                required
                type="number"
                inputProps={{ min: 1, step: 1 }}
                inputMode="numeric"
                disabled={props.disabled}
                value={tier.threshold}
                placeholder={t('272000')}
                onChange={event => updateTier(tier.id, 'threshold', event.target.value)}
              />
              <FormHelperText>{t('总输入包含普通输入、缓存读取和缓存写入 token。')}</FormHelperText>
            </FormControl>
            <Button
              type="button"
              variant="ghost"
              disabled={props.disabled}
              onClick={() => removeTier(tier.id)}
              aria-label={t('删除价格层级 {{index}}', { index: index + 1 })}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              {t('删除')}
            </Button>
          </Box>
          <RateFields
            values={tier}
            disabled={props.disabled}
            onChange={(key, value) => updateTier(tier.id, key, value)}
          />
        </Box>)}
    </Box>;
}

export function PricesPage(props: PricesPageProps) {
  const [busy, setBusy] = useState<BusyAction>(null);
  const [createDraft, setCreateDraft] = useState<PriceDraft>(() => emptyPriceDraft());
  const [editState, setEditState] = useState<EditState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelPrice | null>(null);
  const nextTierId = useRef(1);
  const deleteCancelButtonRef = useRef<HTMLButtonElement>(null);
  const providerNameMap = useMemo(
    () => new Map(props.providers.map(item => [item.provider.id, item.provider.name])),
    [props.providers],
  );
  const sortedItems = useMemo(() => [...props.items].sort((left, right) => {
    const leftScope = left.provider_id ?? -1;
    const rightScope = right.provider_id ?? -1;
    return leftScope - rightScope
      || left.model_name.localeCompare(right.model_name)
      || right.created_at_ms - left.created_at_ms;
  }), [props.items]);

  const newTier = (): TierDraft => {
    const id = nextTierId.current;
    nextTierId.current += 1;
    return { id, threshold: '', ...EMPTY_RATES };
  };

  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!props.settings.adminToken.trim()) {
      props.onMessage('请先填写管理员口令。');
      return;
    }
    const modelName = createDraft.modelName.trim();
    if (!modelName) {
      props.onMessage('模型名称不能为空。');
      return;
    }
    let payload: CreatePriceInput;
    try {
      payload = {
        provider_id: createDraft.providerId ? Number.parseInt(createDraft.providerId, 10) : null,
        model_name: modelName,
        price_data: priceDataFromDraft(createDraft),
      };
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '价格数据不合法。');
      return;
    }

    setBusy('create');
    try {
      const result = await createPrice(props.settings, payload);
      setCreateDraft(emptyPriceDraft());
      const scopeMessage = t(payload.provider_id === null
        ? '价格 {{name}} 已写入全局作用域。'
        : '价格 {{name}} 已写入上游作用域。', { name: payload.model_name });
      await props.onRefresh(`${scopeMessage} ${reconciliationMessage(result)}`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '创建价格失败。');
    } finally {
      setBusy(null);
    }
  };

  const submitEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editState) return;
    let priceData: PriceCardV2;
    try {
      priceData = priceDataFromDraft(editState.draft);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '价格数据不合法。');
      return;
    }

    setBusy('edit');
    try {
      const result = await updatePrice(props.settings, editState.item.id, priceData);
      const modelName = editState.item.model_name;
      setEditState(null);
      await props.onRefresh(`${t('价格 {{name}} 已更新。', { name: modelName })} ${reconciliationMessage(result)}`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '更新价格失败。');
    } finally {
      setBusy(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusy('delete');
    try {
      const result = await deletePrice(props.settings, deleteTarget.id);
      const modelName = deleteTarget.model_name;
      setDeleteTarget(null);
      await props.onRefresh(`${t('价格 {{name}} 已删除。', { name: modelName })} ${reconciliationMessage(result)}`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '删除价格失败。');
    } finally {
      setBusy(null);
    }
  };

  const openEdit = (item: ModelPrice) => {
    setEditState({ item, draft: draftFromPrice(item, () => newTier().id) });
  };

  return <Box className="grid gap-4">
      <Card>
        <Box className="flex flex-col gap-2 p-4 pb-3">
          <Box className="flex items-center justify-between gap-2.5">
            <Box>
              <Box className="panel__eyebrow" component="p">{t('价格')}</Box>
              <Typography className="text-sm font-semibold tracking-normal text-foreground" component="div">{t('模型价格与成本换算')}</Typography>
            </Box>
            <Chip color="success" variant="outlined" label={t('已生效')} />
          </Box>
          <Typography className="mt-0.5 text-[0.8125rem] leading-5 text-muted-foreground" component="div">{t('按上游维护模型单价。')}</Typography>
        </Box>
        <CardContent className="flex flex-col gap-3">
          <Box className="grid gap-2.5 sm:grid-cols-2">
            <SummaryTile label="价格项" value={String(props.items.length)} />
            <SummaryTile label="上游专属" value={String(props.items.filter(item => item.provider_id !== null).length)} />
            <SummaryTile label="全局默认" value={String(props.items.filter(item => item.provider_id === null).length)} />
            <SummaryTile
              label="已覆盖上游"
              value={String(new Set(props.items.map(item => item.provider_id).filter(id => id !== null)).size)}
              hint="当前已有专属价格的上游数。"
            />
          </Box>

          <Divider />

          <Box className="grid gap-4" component="form" onSubmit={event => void submitCreate(event)}>
            <PriceFields
              draft={createDraft}
              providers={props.providers}
              disabled={busy !== null}
              onChange={setCreateDraft}
              onNewTier={newTier}
            />
            <Box className="flex justify-end border-t border-border/40 pt-3">
              <Button type="submit" disabled={busy !== null}>
                {busy === 'create' ? <CircularProgress size={16} /> : <Plus className="size-4" aria-hidden="true" />}
                {busy === 'create' ? t('写入中…') : t('新增价格')}
              </Button>
            </Box>
          </Box>
        </CardContent>
      </Card>

      <Card>
        <Box className="flex flex-col gap-2 p-4 pb-3">
          <Box className="flex items-center justify-between gap-3">
            <Box>
              <Box className="panel__eyebrow" component="p">{t('价格结果')}</Box>
              <Typography className="text-sm font-semibold tracking-normal text-foreground" component="div">{t('当前可用价格项')}</Typography>
            </Box>
            <Chip color="default" variant="outlined" label={t('价格列表')} />
          </Box>
          <Typography className="mt-1 text-sm leading-5 text-muted-foreground" component="div">{t('显示当前生效的模型价格。')}</Typography>
        </Box>
        <CardContent>
          {sortedItems.length > 0 ? <TableContainer className="max-w-full">
              <Table className="table-fixed" size="small" aria-label={t('当前可用价格项')} sx={{ minWidth: 1432 }}>
                <TableHead>
                  <TableRow>
                    <TableCell className="w-56 min-w-56 whitespace-nowrap">{t('模型')}</TableCell>
                    <TableCell className="w-36 min-w-36 whitespace-nowrap">{t('范围')}</TableCell>
                    <TableCell className="w-44 min-w-44 whitespace-nowrap">{t('价格层级')}</TableCell>
                    <TableCell className="w-40 min-w-40 whitespace-nowrap">{t('输入')}</TableCell>
                    <TableCell className="w-40 min-w-40 whitespace-nowrap">{t('输出')}</TableCell>
                    <TableCell className="w-40 min-w-40 whitespace-nowrap">{t('缓存读取')}</TableCell>
                    <TableCell className="w-40 min-w-40 whitespace-nowrap">{t('缓存写入')}</TableCell>
                    <TableCell className="w-40 min-w-40 whitespace-nowrap">{t('更新时间')}</TableCell>
                    <TableCell className="w-24 min-w-24 whitespace-nowrap text-right">{t('操作')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {sortedItems.flatMap(item => {
                    const tiers = [{ threshold: null, rates: item.price_data.base }, ...item.price_data.tiers.map(tier => ({
                      threshold: tier.over_total_input_tokens,
                      rates: tier.rates,
                    }))];
                    return tiers.map((tier, index) => <TableRow key={`${item.id}:${tier.threshold ?? 'base'}`}>
                        {index === 0 ? <TableCell rowSpan={tiers.length} className="w-56 min-w-56 max-w-56 whitespace-nowrap align-top">
                            <Box className="block w-full truncate font-mono text-sm font-medium text-foreground" title={item.model_name} component="span">{item.model_name}</Box>
                          </TableCell> : null}
                        {index === 0 ? <TableCell rowSpan={tiers.length} className="max-w-48 whitespace-nowrap align-top">
                            <Chip
                              className="max-w-full"
                              color={item.provider_id === null ? 'default' : 'success'}
                              variant="outlined"
                              label={item.provider_id === null ? t('全局默认') : providerNameMap.get(item.provider_id) ?? t('上游 #{{id}}', { id: item.provider_id })}
                              sx={{ '& .MuiChip-label': { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' } }}
                            />
                          </TableCell> : null}
                        <TableCell className="whitespace-nowrap">
                          {tier.threshold === null ? t('基础') : t('超过 {{count}} 输入 token', { count: formatCompactInteger(tier.threshold) })}
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono tabular-nums">{formatUnitCost(tier.rates.input)}</TableCell>
                        <TableCell className="whitespace-nowrap font-mono tabular-nums">{formatUnitCost(tier.rates.output)}</TableCell>
                        <TableCell className="whitespace-nowrap font-mono tabular-nums">{formatUnitCost(tier.rates.cache_read)}</TableCell>
                        <TableCell className="whitespace-nowrap font-mono tabular-nums">{formatUnitCost(tier.rates.cache_write)}</TableCell>
                        {index === 0 ? <TableCell rowSpan={tiers.length} className="whitespace-nowrap align-top text-muted-foreground">{formatDateTime(item.updated_at_ms)}</TableCell> : null}
                        {index === 0 ? <TableCell rowSpan={tiers.length} className="align-top">
                            <Box className="flex justify-end gap-2">
                              <Tooltip title={t('编辑价格 {{name}}', { name: item.model_name })}>
                                <IconButton
                                  type="button"
                                  disabled={busy !== null}
                                  aria-label={t('编辑价格 {{name}}', { name: item.model_name })}
                                  onClick={() => openEdit(item)}
                                  sx={{ width: 44, height: 44 }}
                                >
                                  <Pencil className="size-4" aria-hidden="true" />
                                </IconButton>
                              </Tooltip>
                              <Tooltip title={t('删除价格 {{name}}', { name: item.model_name })}>
                                <IconButton
                                  type="button"
                                  color="error"
                                  disabled={busy !== null}
                                  aria-label={t('删除价格 {{name}}', { name: item.model_name })}
                                  onClick={() => setDeleteTarget(item)}
                                  sx={{ width: 44, height: 44 }}
                                >
                                  <Trash2 className="size-4" aria-hidden="true" />
                                </IconButton>
                              </Tooltip>
                            </Box>
                          </TableCell> : null}
                      </TableRow>);
                  })}
                </TableBody>
              </Table>
            </TableContainer> : <Box className="empty-state">{t('当前还没有价格项。')}</Box>}
        </CardContent>
      </Card>

      <Dialog
        open={editState !== null}
        onClose={busy === 'edit' ? undefined : () => setEditState(null)}
        fullWidth
        maxWidth="md"
        aria-labelledby="edit-price-title"
      >
        {editState ? <Box component="form" onSubmit={event => void submitEdit(event)}>
            <DialogTitle id="edit-price-title">{t('编辑模型价格')}</DialogTitle>
            <DialogContent className="grid gap-4 pt-2">
              <PriceFields
                draft={editState.draft}
                providers={props.providers}
                identityReadOnly
                disabled={busy === 'edit'}
                onChange={draft => setEditState(current => current ? { ...current, draft } : null)}
                onNewTier={newTier}
              />
            </DialogContent>
            <DialogActions>
              <Button type="button" variant="ghost" disabled={busy === 'edit'} onClick={() => setEditState(null)}>{t('取消')}</Button>
              <Button type="submit" disabled={busy === 'edit'}>
                {busy === 'edit' ? <CircularProgress size={16} /> : <Pencil className="size-4" aria-hidden="true" />}
                {busy === 'edit' ? t('保存中…') : t('保存价格')}
              </Button>
            </DialogActions>
          </Box> : null}
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={busy === 'delete' ? undefined : () => setDeleteTarget(null)}
        aria-labelledby="delete-price-title"
        slotProps={{
          transition: {
            onEntered: () => deleteCancelButtonRef.current?.focus(),
          },
        }}
      >
        <DialogTitle id="delete-price-title">{t('删除当前价格')}</DialogTitle>
        <DialogContent className="grid gap-3">
          <DialogContentText>
            {deleteTarget ? t('确认删除 {{name}} 的当前价格？', { name: deleteTarget.model_name }) : ''}
          </DialogContentText>
          <DialogContentText>
            {t('删除后新请求将不再使用这个价格。历史价格版本和已经计价的请求会保留。')}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            ref={deleteCancelButtonRef}
            autoFocus
            type="button"
            variant="outline"
            disabled={busy === 'delete'}
            onClick={() => setDeleteTarget(null)}
          >
            {t('取消')}
          </Button>
          <Button type="button" color="error" disabled={busy === 'delete'} onClick={() => void confirmDelete()}>
            {busy === 'delete' ? <CircularProgress size={16} /> : <Trash2 className="size-4" aria-hidden="true" />}
            {busy === 'delete' ? t('删除中…') : t('确认删除')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>;
}
