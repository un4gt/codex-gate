import { useLayoutEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import TableContainer, { type TableContainerProps } from '@mui/material/TableContainer';
import { t } from '@/lib/i18n';

/** A table-local scrollbar clipped to the visible viewport and scroll ancestors. */
export default function ScrollableTable({ children, sx, ...props }: TableContainerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current, table = tableRef.current, bar = barRef.current, spacer = spacerRef.current;
    if (!root || !table || !bar || !spacer) return;
    let frame = 0;
    let source: 'table' | 'bar' | null = null;
    const ancestors: HTMLElement[] = [];
    for (let node = root.parentElement; node; node = node.parentElement) ancestors.push(node);
    const update = () => {
      frame = 0;
      if (source === 'bar') table.scrollLeft = bar.scrollLeft;
      else bar.scrollLeft = table.scrollLeft;
      source = null;
      const rect = table.getBoundingClientRect(), origin = root.getBoundingClientRect();
      let top = Math.max(rect.top, 0), bottom = Math.min(rect.bottom, window.innerHeight);
      let left = Math.max(rect.left, 0), right = Math.min(rect.right, document.documentElement.clientWidth);
      for (const ancestor of ancestors) {
        const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top + ancestor.clientTop); bottom = Math.min(bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left + ancestor.clientLeft); right = Math.min(right, bounds.left + ancestor.clientLeft + ancestor.clientWidth); }
      }
      const visible = table.scrollWidth > table.clientWidth + 1 && bottom - top > 24 && right > left && table.getClientRects().length > 0;
      bar.style.display = visible ? 'block' : 'none';
      bar.style.left = `${left - origin.left}px`;
      bar.style.top = `${bottom - origin.top - 16}px`;
      bar.style.width = `${right - left}px`;
      spacer.style.width = `${table.scrollWidth - table.clientWidth + Math.max(0, right - left)}px`;
      // A geometry change can clamp the native scroll offset.
      bar.scrollLeft = table.scrollLeft;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const tableScroll = () => { if (table.scrollLeft !== bar.scrollLeft) source = 'table'; schedule(); };
    const barScroll = () => { if (table.scrollLeft !== bar.scrollLeft) source = 'bar'; schedule(); };
    table.addEventListener('scroll', tableScroll, { passive: true });
    bar.addEventListener('scroll', barScroll, { passive: true });
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(table);
    for (const node of ancestors) observer?.observe(node);
    const observeChildren = () => { for (const child of table.children) observer?.observe(child); schedule(); };
    const mutation = new MutationObserver(observeChildren);
    mutation.observe(table, { childList: true, subtree: true, attributes: true, characterData: true });
    observeChildren(); update();
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); mutation.disconnect(); table.removeEventListener('scroll', tableScroll); bar.removeEventListener('scroll', barScroll); window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); };
  }, []);
  return <Box ref={rootRef} sx={{ position: 'relative', minWidth: 0, maxWidth: '100%' }}>
    <TableContainer {...props} ref={tableRef} sx={[{ pb: '16px', scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } }, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])]}>{children}</TableContainer>
    <Box ref={barRef} data-table-scrollbar tabIndex={0} role="region" aria-label={t('表格横向滚动')} sx={{ position: 'absolute', display: 'none', height: 16, overflowX: 'scroll', overflowY: 'hidden', zIndex: 5, bgcolor: 'background.paper', overscrollBehaviorX: 'contain', '&::-webkit-scrollbar': { height: 14 }, '&::-webkit-scrollbar-thumb': { bgcolor: 'text.disabled', borderRadius: 2 }, scrollbarColor: 'auto', pointerEvents: 'auto' }}>
      <Box ref={spacerRef} sx={{ height: 1 }} />
    </Box>
  </Box>;
}
