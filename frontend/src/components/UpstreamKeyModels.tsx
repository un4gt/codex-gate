import { useEffect, useState } from 'react';
import { Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel, TextField, Typography } from '@mui/material';
import { addUpstreamKeyModels, deleteUpstreamKeyModel, loadUpstreamKeyModels, syncUpstreamKeyModels, updateUpstreamKeyModel } from '@/lib/api';
import type { ConnectionSettings, UpstreamKeyModel } from '@/lib/types';
import { t } from '@/lib/i18n';

export function UpstreamKeyModels(props: {
  settings: ConnectionSettings;
  keyId: number;
  onChanged: () => Promise<void>;
}) {
  const [models, setModels] = useState<UpstreamKeyModel[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadUpstreamKeyModels(props.settings, props.keyId).then(value => {
      if (!cancelled) setModels(value);
    }).catch(error => {
      if (!cancelled) setError(error instanceof Error ? error.message : t('加载密钥模型失败。'));
    });
    return () => { cancelled = true; };
  }, [props.settings, props.keyId]);

  const change = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      setModels(await loadUpstreamKeyModels(props.settings, props.keyId));
      await props.onChanged();
    } catch (error) {
      setError(error instanceof Error ? error.message : t('更新密钥模型状态失败。'));
    } finally {
      setBusy(false);
    }
  };
  const names = [...new Set(draft.split(/[\s,，]+/).map(name => name.trim()).filter(Boolean))];
  return <Box sx={{ display: 'grid', gap: 2, minWidth: 0 }}>
    <Alert severity="info">{t('未配置时允许所有符合上游规则的模型；配置后只允许列表中启用的模型。删除全部条目会恢复不限。')}</Alert>
    {error ? <Alert severity="error">{error}</Alert> : null}
    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
      <TextField label={t('添加模型（逗号或空格分隔）')} value={draft} onChange={event => setDraft(event.target.value)} disabled={busy} size="small" sx={{ flex: '1 1 220px' }} />
      <Button disabled={busy || names.length === 0} onClick={() => void change(async () => {
        await addUpstreamKeyModels(props.settings, props.keyId, names);
        setDraft('');
      })}>{t('添加')}</Button>
      <Button disabled={busy} onClick={() => void change(() => syncUpstreamKeyModels(props.settings, props.keyId))}>{t('同步模型')}</Button>
    </Box>
    <Typography variant="body2" color="text.secondary">{t('同步保留已有模型的启停状态，新发现的模型默认启用。限制使用路由解析后的真实模型名。')}</Typography>
    {models === null && !error ? <CircularProgress size={24} aria-label={t('加载中')} /> : null}
    {models?.length === 0 ? <Typography variant="body2">{t('未配置模型限制')}</Typography> : null}
    {models?.map(model => <Box key={model.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, borderBottom: 1, borderColor: 'divider' }}>
      <FormControlLabel sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }} label={model.model_name} control={<Checkbox checked={model.enabled} disabled={busy} onChange={(_, enabled) => void change(() => updateUpstreamKeyModel(props.settings, model.id, { enabled }))} />} />
      <Button color="error" disabled={busy} aria-label={t('删除 {{name}}', { name: model.model_name })} onClick={() => void change(() => deleteUpstreamKeyModel(props.settings, model.id))}>{t('删除')}</Button>
    </Box>)}
  </Box>;
}
