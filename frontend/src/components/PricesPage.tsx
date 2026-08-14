import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Plus, Trash2 } from "lucide-react";
import { t } from '@/lib/i18n';
import { createPrice } from '@/lib/api';
import { formatCompactInteger, formatDateTime } from '@/lib/format';
import type { ConnectionSettings, ContextPriceTier, CreatePriceInput, ModelPrice, PriceRates, ProviderWorkspace } from '@/lib/types';
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import FormHelperText from "@mui/material/FormHelperText";
import FormLabel from "@mui/material/FormLabel";
import InputBase from "@mui/material/InputBase";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TableContainer from "@mui/material/TableContainer";
import Typography from "@mui/material/Typography";
interface PricesPageProps {
  settings: ConnectionSettings;
  providers: ProviderWorkspace[];
  items: ModelPrice[];
  onRefresh: (successMessage?: string) => Promise<void>;
  onMessage: (message: string) => void;
}
interface TierDraft {
  id: number;
  threshold: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}
const EMPTY_TIER = {
  threshold: '',
  input: '',
  output: '',
  cacheRead: '',
  cacheWrite: ''
};
function readString(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim();
}
function parseRate(raw: string, label: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(t('{{key}} 需要是大于等于 0 的数字。', {
      key: label
    }));
  }
  return value;
}
function ratesFromValues(values: {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}): PriceRates {
  return {
    input: parseRate(values.input, t('输入单价')),
    output: parseRate(values.output, t('输出单价')),
    cache_read: parseRate(values.cacheRead, t('缓存读取单价')),
    cache_write: parseRate(values.cacheWrite, t('缓存写入单价'))
  };
}
function parseTiers(drafts: TierDraft[]): ContextPriceTier[] {
  const tiers = drafts.map((draft, index) => {
    const threshold = Number(draft.threshold);
    if (!Number.isSafeInteger(threshold) || threshold <= 0) {
      throw new Error(t('第 {{index}} 个层级的输入阈值必须是正整数。', {
        index: index + 1
      }));
    }
    return {
      over_total_input_tokens: threshold,
      rates: ratesFromValues(draft)
    };
  });
  tiers.sort((left, right) => left.over_total_input_tokens - right.over_total_input_tokens);
  if (tiers.some((tier, index) => index > 0 && tier.over_total_input_tokens === tiers[index - 1].over_total_input_tokens)) {
    throw new Error(t('价格层级的输入阈值不能重复。'));
  }
  return tiers;
}
function formatUnitCost(value: string | null): string {
  if (value === null) return t('无价格');
  if (value === '0' || /^0\.0+$/.test(value)) return t('免费');
  return `$${value} / MToken`;
}
function SummaryTile(props: {
  label: string;
  value: string;
  hint?: string;
}) {
  return <Box className="surface-tile">
      <Box className="surface-label">{t(props.label)}</Box>
      <Box className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{props.value}</Box>
      {props.hint ? <Box className="mt-2 text-sm leading-6 text-muted-foreground" component="p">{t(props.hint!)}</Box> : null}
    </Box>;
}
function RateFields(props: {
  prefix: string;
  values?: TierDraft;
  onInput?: (key: 'input' | 'output' | 'cacheRead' | 'cacheWrite', value: string) => void;
}) {
  const inputProps = (key: 'input' | 'output' | 'cacheRead' | 'cacheWrite') => ({
    value: props.values?.[key],
    onChange: props.onInput
      ? (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => props.onInput?.(key, event.target.value)
      : undefined
  });
  return <Box className="grid gap-4 md:grid-cols-2">
      <FormControl>
        <FormLabel>{t('输入单价 / MToken')}</FormLabel>
        <InputBase name={`${props.prefix}_input`} inputMode="decimal" placeholder={t("2.50")} {...inputProps('input')} />
      </FormControl>
      <FormControl>
        <FormLabel>{t('输出单价 / MToken')}</FormLabel>
        <InputBase name={`${props.prefix}_output`} inputMode="decimal" placeholder={t("15.00")} {...inputProps('output')} />
      </FormControl>
      <FormControl>
        <FormLabel>{t('缓存读取 / MToken')}</FormLabel>
        <InputBase name={`${props.prefix}_cache_read`} inputMode="decimal" placeholder={t("0.25")} {...inputProps('cacheRead')} />
      </FormControl>
      <FormControl>
        <FormLabel>{t('缓存写入 / MToken')}</FormLabel>
        <InputBase name={`${props.prefix}_cache_write`} inputMode="decimal" placeholder={t("3.125")} {...inputProps('cacheWrite')} />
      </FormControl>
    </Box>;
}
export function PricesPage(props: PricesPageProps) {
  const [busy, setBusy] = useState(false);
  const [tiers, setTiers] = useState<TierDraft[]>([]);
  const nextTierId = useRef(1);
  const providerNameMap = useMemo(() => new Map(props.providers.map(item => [item.provider.id, item.provider.name])), [props.providers]);
  const sortedItems = useMemo(() => [...props.items].sort((left, right) => {
    const leftScope = left.provider_id ?? -1;
    const rightScope = right.provider_id ?? -1;
    return leftScope - rightScope || left.model_name.localeCompare(right.model_name) || right.created_at_ms - left.created_at_ms;
  }), [props.items]);
  const addTier = () => {
    const id = nextTierId.current;
    nextTierId.current += 1;
    setTiers(current => [...current, {
      id,
      ...EMPTY_TIER
    }]);
  };
  const updateTier = (id: number, key: keyof Omit<TierDraft, 'id'>, value: string) => {
    setTiers(current => current.map(tier => tier.id === id ? {
      ...tier,
      [key]: value
    } : tier));
  };
  const removeTier = (id: number) => setTiers(current => current.filter(tier => tier.id !== id));
  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!props.settings.adminToken.trim()) {
      props.onMessage('请先填写管理员口令。');
      return;
    }
    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const modelName = readString(formData, 'model_name');
    if (!modelName) {
      props.onMessage('模型名称不能为空。');
      return;
    }
    let payload: CreatePriceInput;
    try {
      const providerRaw = readString(formData, 'provider_id');
      payload = {
        provider_id: providerRaw ? Number.parseInt(providerRaw, 10) : null,
        model_name: modelName,
        price_data: {
          schema_version: 2,
          unit: 'usd_per_million_tokens',
          base: ratesFromValues({
            input: readString(formData, 'base_input'),
            output: readString(formData, 'base_output'),
            cacheRead: readString(formData, 'base_cache_read'),
            cacheWrite: readString(formData, 'base_cache_write')
          }),
          tiers: parseTiers(tiers)
        }
      };
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '价格数据不合法。');
      return;
    }
    setBusy(true);
    try {
      const result = await createPrice(props.settings, payload);
      form.reset();
      setTiers([]);
      const scopeMessage = t(payload.provider_id ? '价格 {{name}} 已写入上游作用域。' : '价格 {{name}} 已写入全局作用域。', {
        name: payload.model_name
      });
      const historyMessage = result.history_recalculation_pending
        ? t('历史用量将在打开总览时继续回算。')
        : result.backfilled_requests > 0
          ? t('已按新价格回算 {{count}} 条未定价历史请求。', {
              count: formatCompactInteger(result.backfilled_requests)
            })
          : '';
      await props.onRefresh(`${scopeMessage}${historyMessage ? ` ${historyMessage}` : ''}`);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '创建价格失败。');
    } finally {
      setBusy(false);
    }
  };
  return <Box className="grid gap-6">
      <Card>
        <Box className="flex flex-col gap-3 p-6 pb-5">
          <Box className="flex items-center justify-between gap-3">
            <Box>
              <Box className="panel__eyebrow" component="p">{t('价格')}</Box>
              <Typography className="text-xl font-semibold tracking-normal text-foreground" component="div">{t('模型价格与成本换算')}</Typography>
            </Box>
            <Chip color={"success"} variant="outlined" label={t('已生效')} />
          </Box>
          <Typography className="mt-1 text-sm leading-5 text-muted-foreground" component="div">{t('按上游维护模型单价。')}</Typography>
        </Box>
        <CardContent className="flex flex-col gap-4">
          <Box className="grid gap-3 sm:grid-cols-2">
            <SummaryTile label="价格项" value={String(props.items.length)} />
            <SummaryTile label="上游专属" value={String(props.items.filter(item => item.provider_id !== null).length)} />
            <SummaryTile label="全局默认" value={String(props.items.filter(item => item.provider_id === null).length)} />
            <SummaryTile label="已覆盖上游" value={String(new Set(props.items.map(item => item.provider_id).filter(id => id !== null)).size)} hint="当前已有专属价格的上游数。" />
          </Box>

          <Divider />

          <Box className="flex flex-col gap-5" onSubmit={event => void submitCreate(event)} component="form">
            <Box className="flex flex-col gap-6">
              <FormControl>
                <FormLabel>{t('作用范围')}</FormLabel>
                <Select displayEmpty name="provider_id" defaultValue="">
                  <MenuItem value="">{t('全局默认')}</MenuItem>
                  {props.providers.map(item => <MenuItem key={item.provider.id} value={item.provider.id}>{item.provider.name}</MenuItem>)}
                </Select>
              </FormControl>
              <FormControl>
                <FormLabel>{t('模型名称')}</FormLabel>
                <InputBase name="model_name" placeholder={t("gpt-4.1-mini")} />
              </FormControl>
            </Box>

            <Box className="flex flex-col gap-4 border border-border p-4" component="fieldset">
              <Box className="px-2 text-sm font-medium text-foreground" component="legend">{t('基础价格')}</Box>
              <RateFields prefix="base" />
              <FormHelperText>{t('留空表示无价格；填写 0 表示该类 token 免费。')}</FormHelperText>
            </Box>

            <Box className="flex items-center justify-between gap-3">
              <Box>
                <Box className="text-sm font-medium text-foreground">{t('上下文价格层级')}</Box>
                <Box className="mt-1 text-sm text-muted-foreground" component="p">{t('超过阈值后，整次请求使用该层级的完整单价。')}</Box>
              </Box>
              <Button type="button" variant="outline" onClick={addTier} aria-label={t('添加价格层级')}>
                <Plus className="size-4" aria-hidden="true" />
                {t('添加层级')}
              </Button>
            </Box>

            {tiers.map((tier, index) => <Box key={tier.id} className="flex flex-col gap-4 border border-border p-4" component="fieldset">
                  <Box className="px-2 text-sm font-medium text-foreground" component="legend">
                    {t('价格层级 {{index}}', {
                index: index + 1
              })}
                  </Box>
                  <Box className="flex items-end gap-3">
                    <FormControl className="min-w-0 flex-1">
                      <FormLabel>{t('超过总输入 token')}</FormLabel>
                      <InputBase type="number" inputProps={{ min: 1, step: 1 }} inputMode="numeric" value={tier.threshold} placeholder={t("272000")} onChange={event => updateTier(tier.id, 'threshold', event.target.value)} />
                      <FormHelperText>{t('总输入包含普通输入、缓存读取和缓存写入 token。')}</FormHelperText>
                    </FormControl>
                    <Button type="button" variant="ghost" onClick={() => removeTier(tier.id)} aria-label={t('删除价格层级 {{index}}', {
                index: index + 1
              })}>
                      <Trash2 className="size-4" aria-hidden="true" />
                      {t('删除')}
                    </Button>
                  </Box>
                  <RateFields prefix={`tier_${tier.id}`} values={tier} onInput={(key, value) => updateTier(tier.id, key, value)} />
                </Box>)}

            <Button type="submit" disabled={busy}>
              {busy ? t('写入中…') : t('新增价格')}
            </Button>
          </Box>
        </CardContent>
      </Card>

      <Card>
        <Box className="flex flex-col gap-3 p-6 pb-5">
          <Box className="flex items-center justify-between gap-3">
            <Box>
              <Box className="panel__eyebrow" component="p">{t('价格结果')}</Box>
              <Typography className="text-xl font-semibold tracking-normal text-foreground" component="div">{t('当前可用价格项')}</Typography>
            </Box>
            <Chip color={"default"} variant="outlined" label={t('价格列表')} />
          </Box>
          <Typography className="mt-1 text-sm leading-5 text-muted-foreground" component="div">{t('显示当前生效的模型价格。')}</Typography>
        </Box>
        <CardContent>
          {sortedItems.length > 0 ? <TableContainer className="max-w-full">
              <Table className="table-fixed" size="small" aria-label={t('当前可用价格项')} sx={{ minWidth: 1344 }}>
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
                  </TableRow>
                </TableHead>
                <TableBody>
                  {sortedItems.map(item => [{
                threshold: null,
                rates: item.price_data.base
              }, ...item.price_data.tiers.map(tier => ({
                threshold: tier.over_total_input_tokens,
                rates: tier.rates
              }))].map(tier => <TableRow key={`${item.id}:${tier.threshold ?? 'base'}`}>
                            <TableCell className="w-56 min-w-56 max-w-56 whitespace-nowrap">
                              <Box className="block w-full truncate font-mono text-sm font-medium text-foreground" title={item.model_name} component="span">{item.model_name}</Box>
                            </TableCell>
                            <TableCell className="max-w-48 whitespace-nowrap">
                              <Chip className="max-w-full" color={item.provider_id === null ? "default" : "success"} variant="outlined" label={item.provider_id === null ? t('全局默认') : providerNameMap.get(item.provider_id) ?? t('上游 #{{id}}', {
                    id: item.provider_id
                  })} sx={{
                    '& .MuiChip-label': {
                      display: 'block',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }
                  }} />
                            </TableCell>
                            <TableCell className="whitespace-nowrap">
                              {tier.threshold === null ? t('基础') : t('超过 {{count}} 输入 token', {
                    count: formatCompactInteger(tier.threshold)
                  })}
                            </TableCell>
                            <TableCell className="whitespace-nowrap font-mono tabular-nums">{formatUnitCost(tier.rates.input)}</TableCell>
                            <TableCell className="whitespace-nowrap font-mono tabular-nums">{formatUnitCost(tier.rates.output)}</TableCell>
                            <TableCell className="whitespace-nowrap font-mono tabular-nums">{formatUnitCost(tier.rates.cache_read)}</TableCell>
                            <TableCell className="whitespace-nowrap font-mono tabular-nums">{formatUnitCost(tier.rates.cache_write)}</TableCell>
                            <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(item.updated_at_ms)}</TableCell>
                          </TableRow>))}
                </TableBody>
              </Table>
            </TableContainer> : <Box className="empty-state">{t('当前还没有价格项。')}</Box>}
        </CardContent>
      </Card>
    </Box>;
}
