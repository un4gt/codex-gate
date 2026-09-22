import { ChevronLeft, ChevronRight } from 'lucide-react';
import Box from '@mui/material/Box';
import FormControl from '@mui/material/FormControl';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Typography from '@mui/material/Typography';
import { useI18n } from '@/lib/i18n';
import { useListQuery } from '@/lib/useListQuery';

export function ListPagination({ count }: { count: number }) {
  const { t } = useI18n();
  const { page, pageSize, update } = useListQuery();
  const currentPage = Math.min(page, Math.max(1, Math.ceil(count / pageSize)));
  const start = count ? (currentPage - 1) * pageSize + 1 : 0;
  const end = Math.min(currentPage * pageSize, count);
  return <Box component="nav" aria-label={t('列表分页')} sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, py: 0.5 }}>
    <Typography variant="caption" color="text.secondary" sx={{ mr: 'auto', fontVariantNumeric: 'tabular-nums' }} aria-live="polite">{t('显示 {{start}}–{{end}}，共 {{count}} 条', { start, end, count })}</Typography>
    <Typography variant="caption" color="text.secondary">{t('每页')}</Typography>
    <FormControl sx={{ width: 76 }}>
      <Select value={pageSize} size="small" inputProps={{ 'aria-label': t('每页') }} onChange={event => update({ page_size: String(event.target.value), page: null })}>
        {[25, 50, 100].map(size => <MenuItem key={size} value={size}>{size}</MenuItem>)}
      </Select>
    </FormControl>
    <IconButton aria-label={t('上一页')} disabled={currentPage === 1} onClick={() => update({ page: String(currentPage - 1) })} sx={{ width: 44, height: 44 }}><ChevronLeft size={18} /></IconButton>
    <IconButton aria-label={t('下一页')} disabled={end >= count} onClick={() => update({ page: String(currentPage + 1) })} sx={{ width: 44, height: 44 }}><ChevronRight size={18} /></IconButton>
  </Box>;
}
