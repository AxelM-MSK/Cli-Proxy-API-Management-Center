import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthStore } from '@/stores';
import { gatewayUsageUrl, parseGatewayUsage, type GatewayUsage } from './gatewayUsage';

export type GatewayUsageState =
  | { status: 'absent' }
  | { status: 'loading'; data: GatewayUsage | null }
  | { status: 'success'; data: GatewayUsage }
  | { status: 'error'; error: string; data: GatewayUsage | null };

const keepData = (prev: GatewayUsageState) => (prev.status === 'absent' ? null : prev.data);

/**
 * Loads usage per person and per key from the access gate. A 404 (or a local
 * proxy without the gate) means there is nothing to show, not an error.
 */
export function useGatewayUsage(days: number) {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const url = useMemo(() => gatewayUsageUrl(apiBase, days), [apiBase, days]);
  const [state, setState] = useState<GatewayUsageState>({ status: 'absent' });
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (connectionStatus !== 'connected' || !url) {
      setState({ status: 'absent' });
      return;
    }
    setState((prev) => ({ status: 'loading', data: keepData(prev) }));
    try {
      // The gate authorizes by the Microsoft sign-in cookie; no management key needed.
      const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
      if (requestId !== requestRef.current) return;
      if (res.status === 404) {
        setState({ status: 'absent' });
        return;
      }
      const payload: unknown = await res.json().catch(() => null);
      if (requestId !== requestRef.current) return;
      if (!res.ok) {
        const message = (payload as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
        setState((prev) => ({ status: 'error', error: message, data: keepData(prev) }));
        return;
      }
      setState({ status: 'success', data: parseGatewayUsage(payload) });
    } catch (err: unknown) {
      if (requestId !== requestRef.current) return;
      setState((prev) => ({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        data: keepData(prev),
      }));
    }
  }, [connectionStatus, url]);

  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current += 1;
    };
  }, [refresh]);

  return { state, refresh };
}
