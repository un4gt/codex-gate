import { For, Show, createMemo, createSignal } from 'solid-js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { t } from '@/lib/i18n';
import { createPrice } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { ConnectionSettings, CreatePriceInput, ModelPrice, ProviderWorkspace } from '../lib/types';

interface PricesPageProps {
  settings: ConnectionSettings;
  providers: ProviderWorkspace[];
  items: ModelPrice[];
  onRefresh: (successMessage?: string) => Promise<void>;
  onMessage: (message: string) => void;
}

function readString(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim();
}

function parseOptionalNumber(formData: FormData, key: string): number | null {
  const raw = readString(formData, key);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(t('{{key}} 需要是大于等于 0 的数字。', { key }));
  }
  return parsed;
}

function formatUnitCost(value: unknown): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '—';
  return `$${numeric.toFixed(9)}`;
}

function SummaryTile(props: { label: string; value: string; hint?: string }) {
  return (
    <div class="rounded-2xl border border-border bg-muted/50 p-4">
      <div class="text-[0.72rem] uppercase tracking-[0.22em] text-muted-foreground">{t(props.label)}</div>
      <div class="mt-2 text-2xl font-semibold tracking-tight text-foreground">{props.value}</div>
      <Show when={props.hint}>
        <p class="mt-2 text-sm leading-6 text-muted-foreground">{t(props.hint!)}</p>
      </Show>
    </div>
  );
}

export function PricesPage(props: PricesPageProps) {
  const [busy, setBusy] = createSignal(false);

  const providerNameMap = createMemo(() => new Map(props.providers.map((item) => [item.provider.id, item.provider.name])));
  const sortedItems = createMemo(() =>
    [...props.items].sort((left, right) => {
      const leftScope = left.provider_id ?? -1;
      const rightScope = right.provider_id ?? -1;
      return leftScope - rightScope || left.model_name.localeCompare(right.model_name) || right.created_at_ms - left.created_at_ms;
    }),
  );

  const ensureLive = () => {
    if (!props.settings.adminToken.trim()) {
      props.onMessage('请先填写管理员口令。');
      return false;
    }
    return true;
  };

  const submitCreate = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!ensureLive()) return;

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
      const price_data: Record<string, number> = {};
      const inputCost = parseOptionalNumber(formData, 'input_cost_per_token');
      const outputCost = parseOptionalNumber(formData, 'output_cost_per_token');
      const cacheReadCost = parseOptionalNumber(formData, 'cache_read_input_token_cost');
      const cacheWriteCost = parseOptionalNumber(formData, 'cache_creation_input_token_cost');
      const cacheWriteAboveOneHourCost = parseOptionalNumber(formData, 'cache_creation_input_token_cost_above_1hr');

      if (inputCost !== null) price_data.input_cost_per_token = inputCost;
      if (outputCost !== null) price_data.output_cost_per_token = outputCost;
      if (cacheReadCost !== null) price_data.cache_read_input_token_cost = cacheReadCost;
      if (cacheWriteCost !== null) price_data.cache_creation_input_token_cost = cacheWriteCost;
      if (cacheWriteAboveOneHourCost !== null) {
        price_data.cache_creation_input_token_cost_above_1hr = cacheWriteAboveOneHourCost;
      }

      if (Object.keys(price_data).length === 0) {
        props.onMessage('至少填写一个价格字段。');
        return;
      }

      payload = {
        provider_id: providerRaw ? Number.parseInt(providerRaw, 10) : null,
        model_name: modelName,
        price_data,
      };
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '价格数据不合法。');
      return;
    }

    setBusy(true);
    try {
      await createPrice(props.settings, payload);
      form.reset();
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
    <div class="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="panel__eyebrow">{t('价格')}</p>
              <CardTitle>模型价格与成本换算</CardTitle>
            </div>
            <Badge variant="success">已生效</Badge>
          </div>
          <CardDescription>优先使用上游专属价格，缺失时回退到全局默认价格。</CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col gap-4">
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <SummaryTile label="价格项" value={String(props.items.length)} />
            <SummaryTile label="上游专属" value={String(props.items.filter((item) => item.provider_id !== null).length)} />
            <SummaryTile label="全局默认" value={String(props.items.filter((item) => item.provider_id === null).length)} />
            <SummaryTile label="已覆盖上游" value={String(new Set(props.items.map((item) => item.provider_id).filter((id) => id !== null)).size)} hint="当前已有专属价格的上游数。" />
          </div>

          <Separator />

          <form class="flex flex-col gap-4" onSubmit={(event) => void submitCreate(event)}>
            <FieldGroup>
              <Field>
                <FieldLabel>作用范围</FieldLabel>
                <Select name="provider_id" value="">
                  <option value="">{t('全局默认')}</option>
                  <For each={props.providers}>{(item) => <option value={item.provider.id}>{item.provider.name}</option>}</For>
                </Select>
              </Field>
              <Field>
                <FieldLabel>模型名称</FieldLabel>
                <Input name="model_name" placeholder="gpt-4.1-mini" />
              </Field>
            </FieldGroup>
            <FieldGroup class="grid gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel>输入单价 / token</FieldLabel>
                <Input name="input_cost_per_token" type="number" min="0" step="0.000000001" placeholder="0.000001200" />
              </Field>
              <Field>
                <FieldLabel>输出单价 / token</FieldLabel>
                <Input name="output_cost_per_token" type="number" min="0" step="0.000000001" placeholder="0.000004800" />
              </Field>
              <Field>
                <FieldLabel>缓存读取 / token</FieldLabel>
                <Input name="cache_read_input_token_cost" type="number" min="0" step="0.000000001" placeholder="0.000000200" />
              </Field>
              <Field>
                <FieldLabel>缓存写入 / token</FieldLabel>
                <Input name="cache_creation_input_token_cost" type="number" min="0" step="0.000000001" placeholder="0.000000900" />
              </Field>
            </FieldGroup>
            <Field>
              <FieldLabel>缓存写入 &gt; 1h</FieldLabel>
              <Input name="cache_creation_input_token_cost_above_1hr" type="number" min="0" step="0.000000001" placeholder="0.000000400" />
              <FieldDescription>用于长时间缓存场景。</FieldDescription>
            </Field>
            <Button type="submit" disabled={busy()}>
              {busy() ? '写入中…' : '新增价格'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="panel__eyebrow">{t('价格结果')}</p>
              <CardTitle>当前可用价格项</CardTitle>
            </div>
            <Badge variant="outline">上游优先，全局兜底</Badge>
          </div>
          <CardDescription>同一上游和模型只展示最新版本，全局默认价格用于兜底。</CardDescription>
        </CardHeader>
        <CardContent>
          <Show when={sortedItems().length > 0} fallback={<div class="empty-state">{t('当前还没有价格项。')}</div>}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>模型</TableHead>
                  <TableHead>范围</TableHead>
                  <TableHead>输入</TableHead>
                  <TableHead>输出</TableHead>
                  <TableHead>缓存读取</TableHead>
                  <TableHead>缓存写入</TableHead>
                  <TableHead>更新时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <For each={sortedItems()}>
                  {(item) => (
                    <TableRow>
                      <TableCell class="font-medium text-foreground">{item.model_name}</TableCell>
                      <TableCell>
                        <Badge variant={item.provider_id === null ? 'outline' : 'success'}>
                          {item.provider_id === null ? t('全局默认') : providerNameMap().get(item.provider_id) ?? t('上游 #{{id}}', { id: item.provider_id })}
                        </Badge>
                      </TableCell>
                      <TableCell>{formatUnitCost(item.price_data.input_cost_per_token)}</TableCell>
                      <TableCell>{formatUnitCost(item.price_data.output_cost_per_token)}</TableCell>
                      <TableCell>{formatUnitCost(item.price_data.cache_read_input_token_cost)}</TableCell>
                      <TableCell>{formatUnitCost(item.price_data.cache_creation_input_token_cost)}</TableCell>
                      <TableCell class="text-muted-foreground">{formatDateTime(item.updated_at_ms)}</TableCell>
                    </TableRow>
                  )}
                </For>
              </TableBody>
            </Table>
          </Show>
        </CardContent>
      </Card>
    </div>
  );
}
