import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import { Check, Copy, Cpu } from 'lucide-react';
import { t } from '@/lib/i18n';
import type { ModelDisplay } from '@/lib/types';

const brands: Record<string, string> = { openai: 'openai', anthropic: 'anthropic', google: 'google', 'google-deepmind': 'google', deepseek: 'deepseek', alibaba: 'qwen', qwen: 'qwen', meta: 'meta', 'meta-llama': 'meta', mistral: 'mistral', mistralai: 'mistral', moonshot: 'moonshot', moonshotai: 'moonshot', 'moonshot-ai': 'moonshot', xai: 'xai', 'x-ai': 'xai', minimax: 'minimax' };
export function modelBrand(id: string, brand?: string): string | null {
  if (brand) return brands[brand.toLowerCase()] ?? null;
  const name = id.toLowerCase().split('/').pop() ?? '';
  if (/^(gpt-|chatgpt-|o[134](?:-|$))/.test(name)) return 'openai';
  if (name.startsWith('claude')) return 'anthropic';
  if (name.startsWith('gemini') || name.startsWith('gemma')) return 'google';
  if (name.startsWith('deepseek')) return 'deepseek';
  if (name.startsWith('qwen')) return 'qwen';
  if (name.startsWith('llama')) return 'meta';
  if (/^(mistral|mixtral|codestral)/.test(name)) return 'mistral';
  if (/^(kimi|moonshot)/.test(name)) return 'moonshot';
  if (name.startsWith('grok')) return 'xai';
  if (name.startsWith('minimax')) return 'minimax';
  return null;
}
export function ModelIdentity({ id, display, onOpen }: { id: string; display?: ModelDisplay | null; onOpen?: () => void }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const name = display?.display_name || id;
  const brand = modelBrand(id, display?.brand);
  const copy = async () => { try { await navigator.clipboard.writeText(id); setCopied(true); setError(false); } catch { setError(true); } };
  const label = <Box sx={{ minWidth: 0, textAlign: 'left' }}><Typography component="span" className="block truncate" variant="body2" sx={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: name === id ? 'monospace' : undefined }} title={name}>{name}</Typography>{name !== id ? <Typography component="span" variant="caption" color="text.secondary" sx={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' }} title={id}>{id}</Typography> : null}</Box>;
  return <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
    {brand ? <Box component="span" role="img" aria-label={display?.brand || brand} sx={{ display: 'block', width: 24, height: 24, flexShrink: 0, bgcolor: 'text.primary', mask: `url(/brands/${brand}.svg) center / contain no-repeat` }} /> : <Cpu size={24} aria-label={t('通用模型')} style={{ flexShrink: 0 }} />}
    {onOpen ? <Button variant="text" onClick={onOpen} title={id} sx={{ minWidth: 0, minHeight: 32, height: 'auto', flex: 1, justifyContent: 'flex-start', px: 0, textTransform: 'none' }}>{label}</Button> : <Box sx={{ minWidth: 0, flex: 1 }}>{label}</Box>}
    <Tooltip title={t(error ? '复制失败，请手动复制 ID' : copied ? '已复制' : '复制模型 ID')}><IconButton size="small" aria-label={t('复制模型 ID {{id}}', { id })} onClick={() => void copy()} onBlur={() => setCopied(false)}>{copied ? <Check size={15} /> : <Copy size={15} />}</IconButton></Tooltip>
  </Box>;
}
