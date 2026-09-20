import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionSettings } from './types';

export function useRemoteResource<T>(
  settings: ConnectionSettings,
  loader: (settings: ConnectionSettings) => Promise<T>,
  refreshKey = 0,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const version = useRef(0);
  const active = useRef(false);
  const connection = useRef(settings);
  connection.current = settings;
  const reload = useCallback(async () => {
    if (!active.current || connection.current !== settings) return;
    const requestVersion = ++version.current;
    setLoading(true);
    setError(null);
    try {
      const result = await loader(settings);
      if (requestVersion === version.current) setData(result);
    } catch (cause) {
      if (requestVersion === version.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestVersion === version.current) setLoading(false);
    }
  }, [loader, settings]);
  useEffect(() => {
    active.current = true;
    void reload();
    return () => { active.current = false; version.current += 1; };
  }, [reload, refreshKey]);
  return { data, error, loading, reload };
}
