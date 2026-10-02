import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthStore, useConfigStore } from '@/stores';
import { findCursorBridge, parseCursorQuota, type CursorQuota } from '../cursorBridge';

export type CursorBridgeQuotaState =
  | { status: 'absent' }
  | { status: 'loading'; data: CursorQuota | null }
  | { status: 'success'; data: CursorQuota }
  | { status: 'error'; error: string; data: CursorQuota | null };

/**
 * Loads Cursor quota from the local bridge once the proxy config is known.
 *
 * The bridge is discovered from the proxy's own config (an OpenAI-compatible
 * provider named "cursor" on loopback), so nothing extra is stored in the
 * browser. Stale responses from a previous connection or an older request are
 * dropped by request id.
 */
export function useCursorBridgeQuota(enabled: boolean) {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const config = useConfigStore((state) => state.config);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const target = useMemo(
    () => findCursorBridge(config?.openaiCompatibility, apiBase),
    [apiBase, config]
  );
  const [state, setState] = useState<CursorBridgeQuotaState>({ status: 'absent' });
  const requestRef = useRef(0);

  useEffect(() => {
    if (enabled && connectionStatus === 'connected' && !config) void fetchConfig();
  }, [config, connectionStatus, enabled, fetchConfig]);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!enabled || connectionStatus !== 'connected' || !target) {
      setState({ status: 'absent' });
      return;
    }
    setState((prev) => ({
      status: 'loading',
      data: prev.status === 'absent' ? null : prev.data,
    }));
    try {
      const res = await fetch(target.quotaUrl, {
        headers: { authorization: `Bearer ${target.apiKey}` },
        cache: 'no-store',
      });
      const payload: unknown = await res.json().catch(() => null);
      if (requestId !== requestRef.current) return;
      if (!res.ok) {
        const message =
          (payload as { error?: { message?: string } } | null)?.error?.message ??
          `HTTP ${res.status}`;
        setState((prev) => ({
          status: 'error',
          error: message,
          data: prev.status === 'absent' ? null : prev.data,
        }));
        return;
      }
      setState({ status: 'success', data: parseCursorQuota(payload) });
    } catch (err: unknown) {
      if (requestId !== requestRef.current) return;
      setState((prev) => ({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        data: prev.status === 'absent' ? null : prev.data,
      }));
    }
  }, [connectionStatus, enabled, target]);

  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current += 1;
    };
  }, [refresh]);

  return { state, refresh };
}
