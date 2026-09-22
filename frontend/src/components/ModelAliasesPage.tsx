import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import FormLabel from '@mui/material/FormLabel';
import InputBase from '@mui/material/InputBase';
import Select from '@mui/material/Select';
import Typography from '@mui/material/Typography';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@/components/console/ScrollableTable';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import { DetailDrawer } from './console/DetailDrawer';
import { ConfirmAction } from './console/ConfirmAction';
import { EmptyState } from './console/EmptyState';
import { FilterBar } from './console/FilterBar';
import { ListPagination } from './console/ListPagination';
import { createModelAlias, createModelAliasTarget, deleteModelAlias, deleteModelAliasTarget, updateModelAlias, updateModelAliasTarget } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { paginate, useListQuery } from '@/lib/useListQuery';
import type { ConnectionSettings, ModelAlias, ModelAliasTarget, ProviderWorkspace } from '@/lib/types';

interface ModelAliasesPageProps {
  settings: ConnectionSettings;
  providers: ProviderWorkspace[];
  aliases: ModelAlias[];
  loading?: boolean;
  error?: string | null;
  onRefresh: (message?: string) => Promise<void>;
}

export function ModelAliasesPage(props: ModelAliasesPageProps) {
  const { t } = useI18n();
  const { params, update, filter, page, pageSize } = useListQuery();
  const search = params.get('q') ?? '';
  const editor = params.get('alias_id');
  const selected = props.aliases.find(alias => String(alias.id) === editor);
  const providerId = params.get('provider_id');
  const filtered = props.aliases.filter(alias => alias.name.toLowerCase().includes(search.trim().toLowerCase())
    && (!providerId || alias.targets.some(target => String(target.provider_id) === providerId)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const close = () => update({ alias_id: null }, true);
  return <Box sx={{ display: 'grid', gap: 2, minWidth: 0 }}>
    <FilterBar primary={<InputBase value={search} placeholder={t('搜索路由别名')} inputProps={{ 'aria-label': t('搜索路由别名') }} onChange={event => filter('q', event.target.value, true)} sx={{ gridColumn: '1 / -1' }} startAdornment={<Search size={16} />} />} actions={<Button disabled={props.loading || !!props.error} onClick={() => update({ alias_id: 'new' })}><Plus size={16} />{t('新增路由别名')}</Button>} />
    <Typography variant="body2" color="text.secondary">{t('通过一个调用名称，按顺序或权重选择多个上游模型。显示名称在模型详情中管理。')}</Typography>
    {providerId ? <Alert severity="info" action={<Button onClick={() => filter('provider_id', '')}>{t('清除筛选')}</Button>}>{t('只显示包含所选上游的路由别名。')}</Alert> : null}
    {props.error ? <Alert severity="error" action={<Button onClick={() => void props.onRefresh()}>{t('重试')}</Button>}>{props.error}</Alert> : null}
    {props.loading && props.aliases.length === 0 ? <CircularProgress size={24} /> : null}
    {filtered.length > 0 ? <TableContainer><Table size="small" aria-label={t('路由别名')} sx={{ minWidth: 560 }}>
      <TableHead><TableRow>{['别名', '模式', '启用', '目标数量', '操作'].map(label => <TableCell key={label}>{t(label)}</TableCell>)}</TableRow></TableHead>
      <TableBody>{paginate(filtered, page, pageSize).items.map(alias => <TableRow key={alias.id} hover>
        <TableCell sx={{ fontFamily: 'monospace' }}>{alias.name}</TableCell>
        <TableCell>{t(alias.mode === 'ordered' ? '按顺序' : '按权重')}</TableCell>
        <TableCell>{t(alias.enabled ? '启用' : '停用')}</TableCell><TableCell>{alias.targets.length}</TableCell>
        <TableCell><Button disabled={!!props.error} onClick={() => update({ alias_id: String(alias.id) })}>{t('编辑')}</Button></TableCell>
      </TableRow>)}</TableBody>
    </Table></TableContainer> : !props.loading && !props.error ? <EmptyState title={t('暂无模型配置')} description={t('新增一个模型名称后，再为它添加上游目标。')} /> : null}
    <ListPagination count={filtered.length} />
    {editor ? props.loading && editor !== 'new' && !selected ? <DetailDrawer open title={t('路由别名')} onClose={close}><CircularProgress size={24} /></DetailDrawer>
      : props.error || (editor !== 'new' && !selected) ? <DetailDrawer open title={t('路由别名')} onClose={close}><Alert severity="warning">{props.error ?? t('未找到该路由别名。')}</Alert></DetailDrawer>
        : <AliasEditor key={editor} {...props} alias={selected} onClose={close} onCreated={id => update({ alias_id: String(id) }, true)} /> : null}
  </Box>;
}

function AliasEditor(props: ModelAliasesPageProps & { alias?: ModelAlias; onClose: () => void; onCreated: (id: number) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removal, setRemoval] = useState<'alias' | ModelAliasTarget | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await operation(); }
    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (active.current) setBusy(false); }
  };
  const submitAlias = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    if (!name) { setError(t('模型名称不能为空。')); return; }
    const payload = { name, enabled: form.get('enabled') === 'on', mode: String(form.get('mode')) as 'ordered' | 'weighted' };
    void run(async () => {
      if (props.alias) {
        await updateModelAlias(props.settings, props.alias.id, payload);
        await props.onRefresh(t('模型 {{name}} 已更新。', { name }));
      } else {
        const result = await createModelAlias(props.settings, payload);
        await props.onRefresh(t('模型 {{name}} 已创建。', { name }));
        if (active.current) props.onCreated(result.id);
      }
    });
  };
  const saveTarget = (event: FormEvent<HTMLFormElement>, target?: ModelAliasTarget) => {
    event.preventDefault();
    if (!props.alias) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload = {
      provider_id: Number(form.get('provider_id')),
      upstream_model: String(form.get('upstream_model') ?? '').trim(),
      enabled: form.get('enabled') === 'on',
      priority: Number(form.get('priority')),
      weight: Number(form.get('weight')),
    };
    if (!payload.upstream_model || payload.provider_id <= 0) { setError(t('请选择上游并填写模型。')); return; }
    if (![payload.priority, payload.weight].every(Number.isSafeInteger) || payload.priority < 0 || payload.weight < 1 || Math.max(payload.priority, payload.weight) > 2147483647) {
      setError(t('优先级必须是非负整数，权重必须是正整数。')); return;
    }
    const aliasId = props.alias.id;
    void run(async () => {
      if (target) await updateModelAliasTarget(props.settings, target.id, payload);
      else await createModelAliasTarget(props.settings, aliasId, payload);
      await props.onRefresh(t(target ? '模型目标已更新。' : '模型目标已添加。'));
      if (!target && active.current) formElement.reset();
    });
  };
  return <DetailDrawer open title={props.alias?.name ?? t('新增路由别名')} onClose={() => { if (!busy) props.onClose(); }}>
    <Box sx={{ display: 'grid', gap: 3 }}>
      {error ? <Alert severity="error">{error}</Alert> : null}
      <Box component="form" onSubmit={submitAlias} sx={{ display: 'grid', gap: 2 }}>
        <AliasField name="name" label={t('别名')} placeholder="gpt-5" defaultValue={props.alias?.name ?? ''} required disabled={busy} />
        <AliasField select name="mode" label={t('模式')} defaultValue={props.alias?.mode ?? 'ordered'} disabled={busy}><MenuItem value="ordered">{t('按顺序')}</MenuItem><MenuItem value="weighted">{t('按权重')}</MenuItem></AliasField>
        <FormControlLabel control={<Checkbox name="enabled" defaultChecked={props.alias?.enabled ?? true} disabled={busy} />} label={t('启用')} />
        <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
          {props.alias ? <Button color="error" disabled={busy} onClick={() => setRemoval('alias')}><Trash2 size={16} />{t('删除模型')}</Button> : null}
          <Button type="submit" disabled={busy}>{t(props.alias ? '保存' : '新增模型')}</Button>
        </Box>
      </Box>
      {props.alias ? <>
        <Typography component="h3" variant="subtitle2">{t('上游目标')}</Typography>
        {props.alias.targets.map(target => <TargetForm key={target.id} target={target} providers={props.providers} busy={busy} onSubmit={event => saveTarget(event, target)} onDelete={() => setRemoval(target)} />)}
        <TargetForm providers={props.providers} busy={busy} onSubmit={event => saveTarget(event)} />
      </> : null}
    </Box>
    <ConfirmAction open={removal !== null} error={error} title={t(removal === 'alias' ? '确认删除模型 {{name}}？' : '确认删除这个模型目标？', { name: props.alias?.name ?? '' })} busy={busy} onClose={() => setRemoval(null)} onConfirm={() => void run(async () => {
      if (!removal || !props.alias) return;
      if (removal === 'alias') await deleteModelAlias(props.settings, props.alias.id);
      else await deleteModelAliasTarget(props.settings, removal.id);
      if (active.current) { setRemoval(null); if (removal === 'alias') props.onClose(); }
      await props.onRefresh(t(removal === 'alias' ? '模型已删除。' : '模型目标已删除。'));
    })} />
  </DetailDrawer>;
}

function TargetForm(props: { target?: ModelAliasTarget; providers: ProviderWorkspace[]; busy: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onDelete?: () => void }) {
  const { t } = useI18n();
  const target = props.target;
  return <Box component="form" onSubmit={props.onSubmit} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2, display: 'grid', gap: 2 }}>
    <Typography variant="subtitle2">{target?.upstream_model ?? t('添加目标')}</Typography>
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
      <AliasField select name="provider_id" label={t('上游')} defaultValue={target?.provider_id ?? ''} required disabled={props.busy}>
        {target && !props.providers.some(item => item.provider.id === target.provider_id) ? <MenuItem value={target.provider_id}>{t('上游 #{{id}}', { id: target.provider_id })}</MenuItem> : null}
        {props.providers.map(item => <MenuItem key={item.provider.id} value={item.provider.id}>{item.provider.name}</MenuItem>)}
      </AliasField>
      <AliasField name="upstream_model" label={t('上游模型名称')} defaultValue={target?.upstream_model ?? ''} required disabled={props.busy} />
      <AliasField name="priority" label={t('优先级')} type="number" defaultValue={target?.priority ?? 100} min={0} max={2147483647} required disabled={props.busy} />
      <AliasField name="weight" label={t('权重')} type="number" defaultValue={target?.weight ?? 1} min={1} max={2147483647} required disabled={props.busy} />
    </Box>
    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
      <FormControlLabel control={<Checkbox name="enabled" defaultChecked={target?.enabled ?? true} disabled={props.busy} />} label={t('启用')} />
      <Button type="submit" disabled={props.busy}>{t(target ? '保存' : '添加目标')}</Button>
      {props.onDelete ? <Button color="error" disabled={props.busy} onClick={props.onDelete}>{t('删除目标')}</Button> : null}
    </Box>
  </Box>;
}

function AliasField(props: {
  name: string;
  label: string;
  defaultValue: string | number;
  disabled: boolean;
  required?: boolean;
  placeholder?: string;
  select?: boolean;
  children?: ReactNode;
  type?: 'number';
  min?: number;
  max?: number;
}) {
  const { t } = useI18n();
  const id = useId();
  return <FormControl required={props.required} disabled={props.disabled} fullWidth>
    <FormLabel id={`${id}-label`} htmlFor={id}>{props.label}</FormLabel>
    {props.select ? <Select id={id} labelId={`${id}-label`} name={props.name} defaultValue={props.defaultValue} required={props.required} displayEmpty>
      {props.defaultValue === '' ? <MenuItem value="" disabled>{t('选择上游')}</MenuItem> : null}
      {props.children}
    </Select> : <InputBase id={id} name={props.name} defaultValue={props.defaultValue} placeholder={props.placeholder} required={props.required} type={props.type} inputProps={{ min: props.min, max: props.max, step: props.type === 'number' ? 1 : undefined }} />}
  </FormControl>;
}
