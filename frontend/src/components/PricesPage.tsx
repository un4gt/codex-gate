import { For, Show, createMemo, createSignal } from 'solid-js';
import { Plus, Trash2 } from 'lucide-solid';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { t } from '@/lib/i18n';
import { createPrice } from '@/lib/api';
import { formatCompactInteger, formatDateTime } from '@/lib/format';
import type {
  ConnectionSettings,
  ContextPriceTier,
  CreatePriceInput,
  ModelPrice,
  PriceRates,
  ProviderWorkspace,
} from '@/lib/types';

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

const EMPTY_TIER = { threshold: '', input: '', output: '', cacheRead: '', cacheWrite: '' };

function readString(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim();
}

function parseRate(raw: string, label: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(t('{{key}} 需要是大于等于 0 的数字。', { key: label }));
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
    cache_write: parseRate(values.cacheWrite, t('缓存写入单价')),
  };
}

function parseTiers(drafts: TierDraft[]): ContextPriceTier[] {
  const tiers = drafts.map((draft, index) => {
    const threshold = Number(draft.threshold);
    if (!Number.isSafeInteger(threshold) || threshold <= 0) {
      throw new Error(t('第 {{index}} 个层级的输入阈值必须是正整数。', { index: index + 1 }));
    }
    return {
      over_total_input_tokens: threshold,
      rates: ratesFromValues(draft),
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

function SummaryTile(props: { label: string; value: string; hint?: string }) {
  return (
    <div class="surface-tile">
      <div class="surface-label">{t(props.label)}</div>
      <div class="mt-2 text-2xl font-semibold tracking-tight text-foreground">{props.value}</div>
      <Show when={props.hint}>
        <p class="mt-2 text-sm leading-6 text-muted-foreground">{t(props.hint!)}</p>
      </Show>
    </div>
  );
}

function RateFields(props: {
  prefix: string;
  values?: TierDraft;
  onInput?: (key: 'input' | 'output' | 'cacheRead' | 'cacheWrite', value: string) => void;
}) {
  const inputProps = (key: 'input' | 'output' | 'cacheRead' | 'cacheWrite') => ({
    value: props.values?.[key],
    onInput: props.onInput
      ? (event: InputEvent & { currentTarget: HTMLInputElement }) => props.onInput?.(key, event.currentTarget.value)
      : undefined,
  });
  return (
    <FieldGroup class="grid gap-4 md:grid-cols-2">
      <Field>
        <FieldLabel>{t('输入单价 / MToken')}</FieldLabel>
        <Input name={`${props.prefix}_input`} inputMode="decimal" placeholder="2.50" {...inputProps('input')} />
      </Field>
      <Field>
        <FieldLabel>{t('输出单价 / MToken')}</FieldLabel>
        <Input name={`${props.prefix}_output`} inputMode="decimal" placeholder="15.00" {...inputProps('output')} />
      </Field>
      <Field>
        <FieldLabel>{t('缓存读取 / MToken')}</FieldLabel>
        <Input name={`${props.prefix}_cache_read`} inputMode="decimal" placeholder="0.25" {...inputProps('cacheRead')} />
      </Field>
      <Field>
        <FieldLabel>{t('缓存写入 / MToken')}</FieldLabel>
        <Input name={`${props.prefix}_cache_write`} inputMode="decimal" placeholder="3.125" {...inputProps('cacheWrite')} />
      </Field>
    </FieldGroup>
  );
}

export function PricesPage(props: PricesPageProps) {
  const [busy, setBusy] = createSignal(false);
  const [tiers, setTiers] = createSignal<TierDraft[]>([]);
  let nextTierId = 1;

  const providerNameMap = createMemo(() => new Map(props.providers.map((item) => [item.provider.id, item.provider.name])));
  const sortedItems = createMemo(() =>
    [...props.items].sort((left, right) => {
      const leftScope = left.provider_id ?? -1;
      const rightScope = right.provider_id ?? -1;
      return leftScope - rightScope || left.model_name.localeCompare(right.model_name) || right.created_at_ms - left.created_at_ms;
    }),
  );

  const addTier = () => {
    const id = nextTierId;
    nextTierId += 1;
    setTiers((current) => [...current, { id, ...EMPTY_TIER }]);
  };
  const updateTier = (id: number, key: keyof Omit<TierDraft, 'id'>, value: string) => {
    setTiers((current) => current.map((tier) => (tier.id === id ? { ...tier, [key]: value } : tier)));
  };
  const removeTier = (id: number) => setTiers((current) => current.filter((tier) => tier.id !== id));

  const submitCreate = async (event: SubmitEvent) => {
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
            cacheWrite: readString(formData, 'base_cache_write'),
          }),
          tiers: parseTiers(tiers()),
        },
      };
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '价格数据不合法。');
      return;
    }

    setBusy(true);
    try {
      await createPrice(props.settings, payload);
      form.reset();
      setTiers([]);
      await props.onRefresh(
        t(payload.provider_id ? '价格 {{name}} 已写入上游作用域。' : '价格 {{name}} 已写入全局作用域。', {
          name: payload.model_name,
        }),
      );
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '创建价格失败。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="grid gap-6 xl:grid-cols-[minmax(360px,460px)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="panel__eyebrow">{t('价格')}</p>
              <CardTitle>{t('模型价格与成本换算')}</CardTitle>
            </div>
            <Badge variant="success">{t('已生效')}</Badge>
          </div>
          <CardDescription>{t('按上游维护模型单价。')}</CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col gap-4">
          <div class="grid gap-3 sm:grid-cols-2">
            <SummaryTile label="价格项" value={String(props.items.length)} />
            <SummaryTile label="上游专属" value={String(props.items.filter((item) => item.provider_id !== null).length)} />
            <SummaryTile label="全局默认" value={String(props.items.filter((item) => item.provider_id === null).length)} />
            <SummaryTile label="已覆盖上游" value={String(new Set(props.items.map((item) => item.provider_id).filter((id) => id !== null)).size)} hint="当前已有专属价格的上游数。" />
          </div>

          <Separator />

          <form class="flex flex-col gap-5" onSubmit={(event) => void submitCreate(event)}>
            <FieldGroup>
              <Field>
                <FieldLabel>{t('作用范围')}</FieldLabel>
                <Select name="provider_id" value="">
                  <option value="">{t('全局默认')}</option>
                  <For each={props.providers}>{(item) => <option value={item.provider.id}>{item.provider.name}</option>}</For>
                </Select>
              </Field>
              <Field>
                <FieldLabel>{t('模型名称')}</FieldLabel>
                <Input name="model_name" placeholder="gpt-4.1-mini" />
              </Field>
            </FieldGroup>

            <fieldset class="flex flex-col gap-4 border border-border p-4">
              <legend class="px-2 text-sm font-medium text-foreground">{t('基础价格')}</legend>
              <RateFields prefix="base" />
              <FieldDescription>{t('留空表示无价格；填写 0 表示该类 token 免费。')}</FieldDescription>
            </fieldset>

            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-sm font-medium text-foreground">{t('上下文价格层级')}</div>
                <p class="mt-1 text-sm text-muted-foreground">{t('超过阈值后，整次请求使用该层级的完整单价。')}</p>
              </div>
              <Button type="button" variant="outline" onClick={addTier} aria-label={t('添加价格层级')}>
                <Plus class="size-4" aria-hidden="true" />
                {t('添加层级')}
              </Button>
            </div>

            <For each={tiers()}>
              {(tier, index) => (
                <fieldset class="flex flex-col gap-4 border border-border p-4">
                  <legend class="px-2 text-sm font-medium text-foreground">
                    {t('价格层级 {{index}}', { index: index() + 1 })}
                  </legend>
                  <div class="flex items-end gap-3">
                    <Field class="min-w-0 flex-1">
                      <FieldLabel>{t('超过总输入 token')}</FieldLabel>
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        inputMode="numeric"
                        value={tier.threshold}
                        placeholder="272000"
                        onInput={(event) => updateTier(tier.id, 'threshold', event.currentTarget.value)}
                      />
                      <FieldDescription>{t('总输入包含普通输入、缓存读取和缓存写入 token。')}</FieldDescription>
                    </Field>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => removeTier(tier.id)}
                      aria-label={t('删除价格层级 {{index}}', { index: index() + 1 })}
                    >
                      <Trash2 class="size-4" aria-hidden="true" />
                      {t('删除')}
                    </Button>
                  </div>
                  <RateFields
                    prefix={`tier_${tier.id}`}
                    values={tier}
                    onInput={(key, value) => updateTier(tier.id, key, value)}
                  />
                </fieldset>
              )}
            </For>

            <Button type="submit" disabled={busy()}>
              {busy() ? t('写入中…') : t('新增价格')}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="panel__eyebrow">{t('价格结果')}</p>
              <CardTitle>{t('当前可用价格项')}</CardTitle>
            </div>
            <Badge variant="outline">{t('价格列表')}</Badge>
          </div>
          <CardDescription>{t('显示当前生效的模型价格。')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Show when={sortedItems().length > 0} fallback={<div class="empty-state">{t('当前还没有价格项。')}</div>}>
            <div class="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('模型')}</TableHead>
                    <TableHead>{t('范围')}</TableHead>
                    <TableHead>{t('价格层级')}</TableHead>
                    <TableHead>{t('输入')}</TableHead>
                    <TableHead>{t('输出')}</TableHead>
                    <TableHead>{t('缓存读取')}</TableHead>
                    <TableHead>{t('缓存写入')}</TableHead>
                    <TableHead>{t('更新时间')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <For each={sortedItems()}>
                    {(item) => (
                      <For each={[{ threshold: null, rates: item.price_data.base }, ...item.price_data.tiers.map((tier) => ({ threshold: tier.over_total_input_tokens, rates: tier.rates }))]}>
                        {(tier) => (
                          <TableRow>
                            <TableCell class="font-medium text-foreground">{item.model_name}</TableCell>
                            <TableCell>
                              <Badge variant={item.provider_id === null ? 'outline' : 'success'}>
                                {item.provider_id === null ? t('全局默认') : providerNameMap().get(item.provider_id) ?? t('上游 #{{id}}', { id: item.provider_id })}
                              </Badge>
                            </TableCell>
                            <TableCell class="whitespace-nowrap">
                              {tier.threshold === null ? t('基础') : t('超过 {{count}} 输入 token', { count: formatCompactInteger(tier.threshold) })}
                            </TableCell>
                            <TableCell>{formatUnitCost(tier.rates.input)}</TableCell>
                            <TableCell>{formatUnitCost(tier.rates.output)}</TableCell>
                            <TableCell>{formatUnitCost(tier.rates.cache_read)}</TableCell>
                            <TableCell>{formatUnitCost(tier.rates.cache_write)}</TableCell>
                            <TableCell class="whitespace-nowrap text-muted-foreground">{formatDateTime(item.updated_at_ms)}</TableCell>
                          </TableRow>
                        )}
                      </For>
                    )}
                  </For>
                </TableBody>
              </Table>
            </div>
          </Show>
        </CardContent>
      </Card>
    </div>
  );
}
