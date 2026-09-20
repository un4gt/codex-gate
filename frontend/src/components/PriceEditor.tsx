import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
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
import Typography from '@mui/material/Typography';
import { DetailDrawer } from './console/DetailDrawer';
import { createPrice, updatePrice } from '@/lib/api';
import { formatCompactInteger } from '@/lib/format';
import { t } from '@/lib/i18n';
import { useListQuery } from '@/lib/useListQuery';
import type { ConnectionSettings, ContextPriceTier, CreatePriceInput, ModelPrice, PriceCardV2, PriceRates, ProviderWorkspace } from '@/lib/types';

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

interface ReconciliationResult {
  backfilled_requests: number;
  history_recalculation_pending: boolean;
}

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

export function reconciliationMessage(result: ReconciliationResult): string {
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

export function formatUnitCost(value: string | null): string {
  if (value === null) return t('无价格');
  if (value === '0' || /^0\.0+$/.test(value)) return t('免费');
  return `$${value} / MToken`;
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
            inputProps={{ 'aria-label': t(field.label) }}
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
            inputProps={{ 'aria-label': t('作用范围') }}
            value={props.draft.providerId}
            onChange={event => props.onChange({ ...props.draft, providerId: String(event.target.value) })}
          >
            <MenuItem value="">{t('全局默认')}</MenuItem>
            {props.draft.providerId && !props.providers.some(item => String(item.provider.id) === props.draft.providerId) ? <MenuItem value={props.draft.providerId}>{t('上游 #{{id}}', { id: props.draft.providerId })}</MenuItem> : null}
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
            inputProps={{ 'aria-label': t('模型名称') }}
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

interface PriceEditorProps {
  settings: ConnectionSettings;
  providers: ProviderWorkspace[];
  items: ModelPrice[];
  loading?: boolean;
  error?: string | null;
  onRefresh: (message?: string) => Promise<void>;
  onMessage: (message: string) => void;
}

export function PriceEditorDrawer(props: PriceEditorProps) {
  const { params, update } = useListQuery();
  const editor = params.get('price_id');
  if (!editor) return null;
  const item = props.items.find(price => String(price.id) === editor);
  const close = () => update({ price_id: null, price_model: null, price_provider: null }, true);
  if (props.loading || props.error || (editor !== 'new' && !item)) return <DetailDrawer open title={t('编辑模型价格')} onClose={close}>
    {props.loading ? <CircularProgress size={24} /> : <Alert severity="warning">{props.error ?? t('未找到该价格，可能已更新或删除。')}</Alert>}
  </DetailDrawer>;
  return <PriceEditorForm
    key={`${editor}:${params.get('price_model')}:${params.get('price_provider')}`}
    {...props}
    item={item}
    modelName={params.get('price_model') ?? ''}
    providerId={params.get('price_provider') ?? ''}
    onClose={close}
    onEdit={id => update({ price_id: String(id), price_model: null, price_provider: null }, true)}
  />;
}

function PriceEditorForm(props: PriceEditorProps & {
  item?: ModelPrice;
  modelName: string;
  providerId: string;
  onClose: () => void;
  onEdit: (id: number) => void;
}) {
  const nextTierId = useRef(1);
  const [draft, setDraft] = useState<PriceDraft>(() => props.item
    ? draftFromPrice(props.item, () => nextTierId.current++)
    : { ...emptyPriceDraft(), modelName: props.modelName, providerId: props.providerId });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const duplicate = !props.item ? props.items.find(item => item.model_name === draft.modelName.trim()
    && String(item.provider_id ?? '') === draft.providerId) : undefined;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || duplicate) return;
    setError(null);
    const modelName = draft.modelName.trim();
    if (!modelName) { setError(t('模型名称不能为空。')); return; }
    let card: PriceCardV2;
    try { card = priceDataFromDraft(draft); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('价格数据不合法。')); return; }
    setBusy(true);
    try {
      const result = props.item
        ? await updatePrice(props.settings, props.item.id, card)
        : await createPrice(props.settings, { provider_id: draft.providerId ? Number(draft.providerId) : null, model_name: modelName, price_data: card });
      const message = `${t(props.item ? '价格 {{name}} 已更新。' : draft.providerId ? '价格 {{name}} 已写入上游作用域。' : '价格 {{name}} 已写入全局作用域。', { name: modelName })} ${reconciliationMessage(result)}`;
      if (mounted.current) props.onClose();
      await props.onRefresh(message);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t('更新价格失败。'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return <DetailDrawer open title={t(props.item ? '编辑模型价格' : '新增价格')} onClose={() => { if (!busy) props.onClose(); }}>
    <Box component="form" onSubmit={event => void submit(event)} sx={{ display: 'grid', gap: 3 }}>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {duplicate ? <Alert severity="info" action={<Button onClick={() => props.onEdit(duplicate.id)}>{t('编辑')}</Button>}>{t('该范围已有模型价格，请编辑现有价格。')}</Alert> : null}
      <PriceFields draft={draft} providers={props.providers} identityReadOnly={!!props.item} disabled={busy} onChange={setDraft} onNewTier={() => ({ id: nextTierId.current++, threshold: '', ...EMPTY_RATES })} />
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, position: 'sticky', bottom: -20, bgcolor: 'background.paper', py: 2 }}>
        <Button variant="outline" disabled={busy} onClick={props.onClose}>{t('取消')}</Button>
        <Button type="submit" disabled={busy || !!duplicate}>{busy ? <CircularProgress size={16} /> : null}{t(props.item ? '保存价格' : '新增价格')}</Button>
      </Box>
    </Box>
  </DetailDrawer>;
}

export function PriceCardDetails({ card }: { card: PriceCardV2 }) {
  const tiers = [{ threshold: 0, rates: card.base }, ...card.tiers.map(tier => ({ threshold: tier.over_total_input_tokens, rates: tier.rates }))];
  return <Box sx={{ display: 'grid', gap: 1 }}>
    <Typography variant="caption" color="text.secondary">{t('美元 / 百万 token')}</Typography>
    <TableContainer><Table size="small" aria-label={t('价格层级')} sx={{ minWidth: 580 }}>
      <TableHead><TableRow>{['价格层级', '输入', '输出', '缓存读取', '缓存写入'].map(label => <TableCell key={label} sx={{ whiteSpace: 'nowrap' }}>{t(label)}</TableCell>)}</TableRow></TableHead>
      <TableBody>{tiers.map(tier => <TableRow key={tier.threshold}>
        <TableCell>{tier.threshold ? t('超过 {{count}} 输入 token', { count: formatCompactInteger(tier.threshold) }) : t('基础')}</TableCell>
        {(['input', 'output', 'cache_read', 'cache_write'] as const).map(kind => <TableCell key={kind} sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{formatUnitCost(tier.rates[kind])}</TableCell>)}
      </TableRow>)}</TableBody>
    </Table></TableContainer>
  </Box>;
}
