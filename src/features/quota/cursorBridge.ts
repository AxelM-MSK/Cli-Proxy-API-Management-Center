/**
 * Cursor quota via the local Cursor bridge.
 *
 * Cursor is not a CLIProxyAPI auth file: it reaches the proxy as an
 * OpenAI-compatible provider pointing at a bridge on loopback, and that bridge
 * also serves `GET /quota`. This module finds the bridge in the proxy config and
 * normalizes its quota payload into ledger meters. Pure and React-free.
 */

import type { OpenAIProviderConfig } from '@/types';
import type { LedgerMeter } from './ledgerModel';

export interface CursorBridgeTarget {
  quotaUrl: string;
  apiKey: string;
}

export interface CursorQuota {
  plan: string | null;
  email: string | null;
  meters: LedgerMeter[];
  spend: {
    totalCents: number | null;
    includedCents: number | null;
    bonusCents: number | null;
  };
  fetchedAtMs: number | null;
}

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

/**
 * The provider named "cursor" whose base URL is on loopback. A remote base URL is
 * ignored on purpose: the bridge key would otherwise be sent off the machine.
 */
export function findCursorBridge(
  providers: readonly OpenAIProviderConfig[] | undefined
): CursorBridgeTarget | null {
  const provider = (providers ?? []).find(
    (candidate) =>
      !candidate.disabled &&
      candidate.name.trim().toLowerCase() === 'cursor' &&
      LOOPBACK.test(candidate.baseUrl ?? '')
  );
  const apiKey = provider?.apiKeyEntries.find((entry) => entry.apiKey)?.apiKey;
  if (!provider || !apiKey) return null;
  const base = provider.baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
  return { quotaUrl: `${base}/quota`, apiKey };
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

/** Bridge payload → ledger meters (percent used → percent remaining). */
export function parseCursorQuota(payload: unknown): CursorQuota {
  const body = (payload ?? {}) as Record<string, unknown>;
  const windows = Array.isArray(body.windows) ? (body.windows as Record<string, unknown>[]) : [];
  const spend = (body.spend ?? {}) as Record<string, unknown>;

  const meters: LedgerMeter[] = windows
    .map((window, index): LedgerMeter | null => {
      const used = finiteOrNull(window.usedPercent);
      return {
        id: stringOrNull(window.id) ?? `window-${index}`,
        label: stringOrNull(window.label) ?? '',
        remaining: used === null ? null : Math.min(100, Math.max(0, 100 - used)),
        resetAtMs: finiteOrNull(window.resetAtMs),
        periodHours: finiteOrNull(window.periodHours),
      };
    })
    .filter((meter): meter is LedgerMeter => meter !== null);

  return {
    plan: stringOrNull(body.plan),
    email: stringOrNull(body.email),
    meters,
    spend: {
      totalCents: finiteOrNull(spend.totalCents),
      includedCents: finiteOrNull(spend.includedCents),
      bonusCents: finiteOrNull(spend.bonusCents),
    },
    fetchedAtMs: finiteOrNull(body.fetchedAtMs),
  };
}

/** The most depleted meter headlines the summary cell. */
export function pickCursorHeadline(meters: readonly LedgerMeter[]): LedgerMeter | null {
  let best: LedgerMeter | null = null;
  for (const meter of meters) {
    if (meter.remaining === null) continue;
    if (best === null || meter.remaining < (best.remaining as number)) best = meter;
  }
  return best ?? meters[0] ?? null;
}
