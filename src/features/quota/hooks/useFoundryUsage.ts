import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthStore } from '@/stores';
import { foundryUsageUrl, parseFoundryUsage, type FoundryUsage } from '../foundryUsage';

export type FoundryUsageState =
  | { status: 'absent' }
  | { status: 'loading'; data: FoundryUsage | null }
  | { status: 'success'; data: FoundryUsage }
  | { status: 'error'; error: string; data: FoundryUsage | null };

/**
 * Loads Foundry usage from the gateway sidecar. A 404 means this proxy has no
 * sidecar (e.g. the desktop setup), so the section stays hidden rather than
 * showing an error.
 */
export function useFoundryUsage(enabled: boolean) {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const url = useMemo(() => foundryUsageUrl(apiBase), [apiBase]);
  const [state, setState] = useState<FoundryUsageState>({ status: 'absent' });
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!enabled || connectionStatus !== 'connected' || !url || !managementKey) {
      setState({ status: 'absent' });
      return;
    }
    setState((prev) => ({ status: 'loading', data: prev.status === 'absent' ? null : prev.data }));
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${managementKey}` },
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (requestId !== requestRef.current) return;
      if (res.status === 404) {
        setState({ status: 'absent' });
        return;
      }
      const payload: unknown = await res.json().catch(() => null);
      if (requestId !== requestRef.current) return;
      if (!res.ok) {
        const message = (payload as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
        setState((prev) => ({
          status: 'error',
          error: message,
          data: prev.status === 'absent' ? null : prev.data,
        }));
        return;
      }
      setState({ status: 'success', data: parseFoundryUsage(payload) });
    } catch (err: unknown) {
      if (requestId !== requestRef.current) return;
      setState((prev) => ({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        data: prev.status === 'absent' ? null : prev.data,
      }));
    }
  }, [connectionStatus, enabled, managementKey, url]);

  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current += 1;
    };
  }, [refresh]);

  return { state, refresh };
}
