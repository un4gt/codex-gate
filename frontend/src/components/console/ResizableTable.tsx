import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import Box from '@mui/material/Box';

export interface ResizableColumnDefinition<Id extends string> {
  id: Id;
  defaultWidth: number;
  minWidth: number;
  maxWidth?: number;
}

export type ColumnWidthMap<Id extends string> = Record<Id, number>;

function clampWidth<Id extends string>(
  definition: ResizableColumnDefinition<Id>,
  width: number,
): number {
  const rounded = Math.round(width);
  return Math.min(definition.maxWidth ?? 640, Math.max(definition.minWidth, rounded));
}

export function sanitizeColumnWidths<Id extends string>(
  definitions: readonly ResizableColumnDefinition<Id>[],
  saved: Record<string, number> | null | undefined,
): ColumnWidthMap<Id> {
  return Object.fromEntries(definitions.map(definition => {
    const candidate = saved?.[definition.id];
    const width = typeof candidate === 'number' && Number.isFinite(candidate)
      ? clampWidth(definition, candidate)
      : definition.defaultWidth;
    return [definition.id, width];
  })) as ColumnWidthMap<Id>;
}

function serializeColumnWidths<Id extends string>(widths: ColumnWidthMap<Id>): Record<string, number> {
  return Object.fromEntries(Object.entries(widths));
}

export function useResizableColumns<Id extends string>(
  definitions: readonly ResizableColumnDefinition<Id>[],
  onCommit: (widths: Record<string, number>) => Promise<void>,
  onError: (error: unknown) => void,
) {
  const definitionMap = useMemo(
    () => new Map(definitions.map(definition => [definition.id, definition])),
    [definitions],
  );
  const [widths, setWidths] = useState<ColumnWidthMap<Id>>(
    () => sanitizeColumnWidths(definitions, undefined),
  );
  const widthsRef = useRef(widths);
  const savedWidthsRef = useRef(widths);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitVersionRef = useRef(0);

  useEffect(() => () => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
  }, []);

  const applyPersistedWidths = useCallback((saved: Record<string, number> | null | undefined) => {
    const next = sanitizeColumnWidths(definitions, saved);
    widthsRef.current = next;
    savedWidthsRef.current = next;
    setWidths(next);
  }, [definitions]);

  const scheduleCommit = useCallback((snapshot: ColumnWidthMap<Id>) => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null;
      const version = ++commitVersionRef.current;
      void onCommit(serializeColumnWidths(snapshot))
        .then(() => {
          if (version === commitVersionRef.current) savedWidthsRef.current = snapshot;
        })
        .catch(error => {
          if (version !== commitVersionRef.current) return;
          const fallback = savedWidthsRef.current;
          widthsRef.current = fallback;
          setWidths(fallback);
          onError(error);
        });
    }, 250);
  }, [onCommit, onError]);

  const resizeColumn = useCallback((id: Id, requestedWidth: number, commit: boolean) => {
    const definition = definitionMap.get(id);
    if (!definition) return;
    const width = clampWidth(definition, requestedWidth);
    if (width === widthsRef.current[id]) {
      if (commit) scheduleCommit(widthsRef.current);
      return;
    }
    const next = { ...widthsRef.current, [id]: width };
    widthsRef.current = next;
    setWidths(next);
    if (commit) scheduleCommit(next);
  }, [definitionMap, scheduleCommit]);

  const resetColumn = useCallback((id: Id) => {
    const definition = definitionMap.get(id);
    if (!definition) return;
    resizeColumn(id, definition.defaultWidth, true);
  }, [definitionMap, resizeColumn]);

  return {
    widths,
    applyPersistedWidths,
    resizeColumn,
    resetColumn,
  };
}

interface ColumnResizeHandleProps<Id extends string> {
  column: ResizableColumnDefinition<Id>;
  label: string;
  width: number;
  onResize: (id: Id, width: number, commit: boolean) => void;
  onReset: (id: Id) => void;
}

export function ColumnResizeHandle<Id extends string>(props: ColumnResizeHandleProps<Id>) {
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const requestedWidth = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    return drag ? drag.startWidth + event.clientX - drag.startX : props.width;
  };

  const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: props.width,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    props.onResize(props.column.id, requestedWidth(event), false);
  };

  const finishPointerResize = (event: PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    props.onResize(props.column.id, requestedWidth(event), true);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    props.onResize(props.column.id, props.width + direction * (event.shiftKey ? 24 : 8), true);
  };

  return <Box
    component="span"
    role="separator"
    aria-label={props.label}
    aria-orientation="vertical"
    aria-valuemin={props.column.minWidth}
    aria-valuemax={props.column.maxWidth ?? 640}
    aria-valuenow={props.width}
    tabIndex={0}
    className="absolute inset-y-0 z-10 cursor-col-resize touch-none select-none outline-none"
    sx={{
      right: -22,
      width: 44,
      '&::after': {
        bgcolor: 'divider',
        content: '""',
        insetBlock: 6,
        opacity: 0,
        position: 'absolute',
        right: 21,
        transition: 'opacity 120ms ease, background-color 120ms ease',
        width: 2,
      },
      '&:hover::after, &:focus-visible::after': {
        bgcolor: 'primary.main',
        opacity: 1,
      },
      '@media (prefers-reduced-motion: reduce)': {
        '&::after': { transition: 'none' },
      },
    }}
    onDoubleClick={event => {
      event.preventDefault();
      event.stopPropagation();
      props.onReset(props.column.id);
    }}
    onKeyDown={handleKeyDown}
    onPointerCancel={finishPointerResize}
    onPointerDown={handlePointerDown}
    onPointerMove={handlePointerMove}
    onPointerUp={finishPointerResize}
  />;
}
