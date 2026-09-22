import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import TextField from '@mui/material/TextField';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import TableContainer from './console/ScrollableTable';
import { ModelIdentity } from './console/ModelIdentity';
import { PriceCardDetails } from './PriceEditor';
import { applyPriceSync, loadPriceSync, loadPriceSyncJob, previewPriceSync, savePriceSyncConfig, type PriceSyncConfig, type PriceSyncJob } from '@/lib/api';
import { useRemoteResource } from '@/lib/useRemoteResource';
import { formatDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { ConnectionSettings } from '@/lib/types';

export function PriceSyncPanel({ settings, onRefresh }: { settings: ConnectionSettings; onRefresh: () => Promise<void> }) {
  const status = useRemoteResource(settings, loadPriceSync);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<PriceSyncJob | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => { const timer = window.setTimeout(() => { void status.reload(); }, status.data?.running ? 2000 : 15000); return () => clearTimeout(timer); }, [status.data, status.error, status.reload]);
  useEffect(() => {
    if (!jobId) return;
    let active = true; let timer: number;
    const poll = async () => {
      try {
        const next = await loadPriceSyncJob(settings, jobId);
        if (!active) return;
        setJob(next);
        if (next.status === 'running') timer = window.setTimeout(() => void poll(), 1500);
        else { setJobId(null); setBusy(false); void status.reload(); if (next.status === 'applied') { void onRefresh(); setOpen(false); } }
      } catch (cause) { if (active) { setError(String(cause)); setBusy(false); setJobId(null); } }
    };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [jobId, settings, status.reload, onRefresh]);
  const preview = async () => {
    setBusy(true); setError(null); setJob(null); setSelected([]); setOpen(true);
    try { const result = await previewPriceSync(settings); setJobId(result.id); }
    catch (cause) { setError(String(cause)); setBusy(false); }
  };
  const apply = async () => {
    if (!job) return;
    setBusy(true); setError(null);
    try { const next = await applyPriceSync(settings, job, selected); setJob(next); setJobId(next.id); }
    catch (cause) { setError(String(cause)); setBusy(false); }
  };
  const current = status.data;
  return <Card variant="outlined"><CardContent sx={{ display: 'grid', gap: 1.5 }}>
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}><Typography variant="subtitle1">{t('云端价格同步')}</Typography><Button disabled={busy || current?.running || !current?.config} onClick={() => void preview()}>{t('立即同步 · 先预览')}</Button></Box>
    <Typography variant="body2" color="text.secondary">{t('自动同步保留手工价与渠道专属价；价格目录不会新增可调用模型。')}</Typography>
    {status.error ? <Alert severity="error" action={<Button onClick={() => void status.reload()}>{t('重试')}</Button>}>{status.error}</Alert> : null}
    {error && !open ? <Alert severity="error">{error}</Alert> : null}
    {current?.config ? <>
      <SyncConfigForm key={JSON.stringify(current.config)} config={current.config} busy={busy || current.running} save={async config => { setError(null); await savePriceSyncConfig(settings, config); await status.reload(); }} />
      <Typography variant="body2">{t('最近成功')}: {current.last_success_ms ? formatDateTime(current.last_success_ms) : '—'} · {t('下次执行')}: {current.next_run_ms ? formatDateTime(current.next_run_ms) : '—'} · {t(current.running ? '同步中' : '空闲')}</Typography>
      {current.last_job ? <SyncCounts job={current.last_job} /> : null}
      {current.last_job?.error ? <Alert severity="warning">{current.last_job.error}</Alert> : null}
    </> : null}
    <Dialog open={open} onClose={busy ? undefined : () => setOpen(false)} fullWidth maxWidth="lg">
      <DialogTitle>{t('云端价格预览')}</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2 }}>
        {error ? <Alert severity="error">{error}</Alert> : null}
        {job?.error ? <Alert severity="warning">{job.error}</Alert> : null}
        {busy ? <Typography role="status">{t('同步中')}</Typography> : null}
        {job ? <><SyncCounts job={job} /><Typography variant="caption">{t('目录版本')}: {job.source_version}</Typography></> : null}
        {job?.status === 'preview' ? <Alert severity="info">{t('默认保留手工价格。勾选需要改用云端报价的模型；预览后价格发生变化时必须重新预览。')}</Alert> : null}
        {job?.conflicts.length ? <TableContainer sx={{ maxHeight: '55dvh' }}><Table size="small" stickyHeader sx={{ minWidth: 900 }} aria-label={t('手工价格冲突')}>
          <TableHead><TableRow>{['改用云端价', '模型', '手工价格', '云端报价'].map(label => <TableCell key={label}>{t(label)}</TableCell>)}</TableRow></TableHead>
          <TableBody>{job.conflicts.map(conflict => <TableRow key={conflict.model_name}>
            <TableCell><Checkbox checked={selected.includes(conflict.model_name)} disabled={busy} slotProps={{ input: { 'aria-label': t('改用云端价 {{name}}', { name: conflict.model_name }) } }} onChange={(_, checked) => setSelected(items => checked ? [...items, conflict.model_name] : items.filter(item => item !== conflict.model_name))} /></TableCell>
            <TableCell><ModelIdentity id={conflict.model_name} /></TableCell><TableCell><PriceCardDetails card={conflict.local_price} /></TableCell><TableCell><PriceCardDetails card={conflict.cloud_price} /></TableCell>
          </TableRow>)}</TableBody>
        </Table></TableContainer> : null}
      </DialogContent>
      <DialogActions><Button disabled={busy} onClick={() => setOpen(false)}>{t('取消')}</Button><Button disabled={busy || job?.status !== 'preview'} onClick={() => void apply()}>{t('应用预览')}</Button></DialogActions>
    </Dialog>
  </CardContent></Card>;
}
function SyncCounts({ job }: { job: PriceSyncJob }) {
  return <Typography variant="body2">{t('新增 {{added}} · 更新 {{updated}} · 未变化 {{unchanged}} · 保留手工价 {{manual_preserved}} · 失败/未适配 {{failed}}', job.counts)}</Typography>;
}
function SyncConfigForm({ config, busy, save }: { config: PriceSyncConfig; busy: boolean; save: (config: PriceSyncConfig) => Promise<void> }) {
  const [draft, setDraft] = useState(config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <Box component="form" onSubmit={event => { event.preventDefault(); setSaving(true); setError(null); void save(draft).catch(cause => setError(String(cause))).finally(() => setSaving(false)); }} sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
    <FormControlLabel label={t('自动同步')} control={<Checkbox checked={draft.enabled} disabled={busy || saving} onChange={(_, enabled) => setDraft({ ...draft, enabled })} />} />
    <TextField label={t('价格源地址')} type="url" required value={draft.source_url} disabled={busy || saving} onChange={event => setDraft({ ...draft, source_url: event.target.value })} sx={{ flex: '1 1 320px' }} />
    <TextField label={t('同步间隔（分钟）')} type="number" required value={draft.interval_minutes} disabled={busy || saving} slotProps={{ htmlInput: { min: 5, max: 10080 } }} onChange={event => setDraft({ ...draft, interval_minutes: Number(event.target.value) })} sx={{ width: 165 }} />
    <Button type="submit" disabled={busy || saving || JSON.stringify(draft) === JSON.stringify(config)}>{t('保存')}</Button>
    {error ? <Alert severity="error" sx={{ width: '100%' }}>{error}</Alert> : null}
  </Box>;
}
