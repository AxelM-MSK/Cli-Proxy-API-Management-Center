/**
 * Ledger view model: one row of meters per credential, one summary per provider.
 *
 * Pure and React-free like the timeline model — `now` is passed in and the
 * provider states are read structurally — so the aggregation rules are pinned by
 * plain tests rather than rendered markup.
 *
 * The card grid answers "how is this credential doing?"; the ledger answers "how
 * much capacity does this provider have left across every account I hold?". That
 * second question needs the meters normalized to *remaining percent* so they can
 * be summed, which is why this does not reuse the per-provider Body components.
 */

import type { QuotaProviderType } from './providers/types';

/** One limit on one credential, normalized to percent remaining. */
export interface LedgerMeter {
  id: string;
  /** Literal label from the payload; used when `labelKey` is absent. */
  label: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  /** Remaining percent, 0..100; null when the upstream did not report usage. */
  remaining: number | null;
  resetAtMs: number | null;
  periodHours: number | null;
}

/** Aggregate of one meter id across every loaded credential of a provider. */
export interface LedgerAggregate {
  meterId: string;
  label: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  /** Sum of remaining percent over credentials that reported this meter. */
  total: number | null;
  /** 100 × credentials carrying this meter. */
  capacity: number;
  /** One entry per loaded credential, in entry order; null = no reading. */
  segments: (number | null)[];
  /** Soonest future reset among the credentials, or null. */
  soonestResetMs: number | null;
}

export interface LedgerProviderSummary {
  provider: QuotaProviderType;
  credentialCount: number;
  loadedCount: number;
  primary: LedgerAggregate | null;
  secondary: LedgerAggregate | null;
}

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const remainingFromUsed = (used: unknown): number | null => {
  const value = finiteOrNull(used);
  return value === null ? null : clampPercent(100 - value);
};

interface PercentWindowLike {
  id?: string;
  label?: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  usedPercent?: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

/**
 * Every meter on one credential, in the order the provider reports them.
 *
 * Returns an empty list for anything not successfully loaded — an idle or failed
 * credential has no readings, and inventing zeros would drag the provider total
 * down for a reason that has nothing to do with capacity.
 */
export function buildLedgerMeters(provider: QuotaProviderType, quota: unknown): LedgerMeter[] {
  const state = quota as { status?: string } | undefined;
  if (!state || state.status !== 'success') return [];

  if (provider === 'claude' || provider === 'codex') {
    // Both store percent USED.
    return ((quota as { windows?: PercentWindowLike[] }).windows ?? []).map((window, index) => ({
      id: window.id || `window-${index}`,
      label: window.label ?? '',
      labelKey: window.labelKey,
      labelParams: window.labelParams,
      remaining: remainingFromUsed(window.usedPercent),
      resetAtMs: finiteOrNull(window.resetAtMs),
      periodHours: finiteOrNull(window.periodHours),
    }));
  }

  if (provider === 'devin') {
    const windows =
      (
        quota as {
          windows?: {
            id: string;
            remainingPercent: number | null;
            resetAtMs: number | null;
            periodHours: number;
          }[];
        }
      ).windows ?? [];
    return windows.map((window) => ({
      id: window.id,
      label: window.id,
      labelKey: `devin_quota.${window.id}`,
      remaining: finiteOrNull(window.remainingPercent),
      resetAtMs: finiteOrNull(window.resetAtMs),
      periodHours: finiteOrNull(window.periodHours),
    }));
  }

  if (provider === 'xai') {
    const billing = (
      quota as {
        billing?: {
          periodType?: string;
          usagePercent?: number | null;
          resetAtMs?: number | null;
          periodHours?: number | null;
        } | null;
      }
    ).billing;
    // Same rule as the timeline: only the weekly figure is a quota window; the
    // monthly one is a spend cap rolling over.
    if (!billing || billing.periodType !== 'weekly') return [];
    return [
      {
        id: 'weekly',
        label: 'weekly',
        labelKey: 'xai_quota.weekly_limit',
        remaining: remainingFromUsed(billing.usagePercent),
        resetAtMs: finiteOrNull(billing.resetAtMs),
        periodHours: finiteOrNull(billing.periodHours) ?? 24 * 7,
      },
    ];
  }

  if (provider === 'antigravity') {
    const buckets = (
      (
        quota as {
          groups?: {
            buckets?: {
              id?: string;
              label?: string;
              remainingFraction?: number | null;
              resetAtMs?: number | null;
              periodHours?: number | null;
            }[];
          }[];
        }
      ).groups ?? []
    ).flatMap((group) => group.buckets ?? []);
    // Antigravity reports the fraction REMAINING.
    return buckets.map((bucket, index) => {
      const fraction = finiteOrNull(bucket.remainingFraction);
      return {
        id: bucket.id || `bucket-${index}`,
        label: bucket.label ?? '',
        remaining: fraction === null ? null : clampPercent(Math.round(fraction * 100)),
        resetAtMs: finiteOrNull(bucket.resetAtMs),
        periodHours: finiteOrNull(bucket.periodHours),
      };
    });
  }

  if (provider === 'kimi') {
    const rows =
      (
        quota as {
          rows?: {
            id?: string;
            label?: string;
            labelKey?: string;
            labelParams?: Record<string, string | number>;
            used: number;
            limit: number;
            resetAtMs?: number | null;
            periodHours?: number | null;
          }[];
        }
      ).rows ?? [];
    // Kimi reports raw counts; remaining is derived.
    return rows.map((row, index) => ({
      id: row.id || `row-${index}`,
      label: row.label ?? '',
      labelKey: row.labelKey,
      labelParams: row.labelParams,
      remaining:
        row.limit > 0 ? clampPercent(Math.round(((row.limit - row.used) / row.limit) * 100)) : null,
      resetAtMs: finiteOrNull(row.resetAtMs),
      periodHours: finiteOrNull(row.periodHours),
    }));
  }

  if (provider === 'meta') {
    const windows =
      (
        quota as {
          data?: {
            windows?: {
              id: 'window' | 'weekly';
              usedPercent: number | null;
              resetAt?: number;
              durationMinutes?: number;
            }[];
          };
        }
      ).data?.windows ?? [];
    return windows.map((window) => {
      const resetAt = finiteOrNull(window.resetAt);
      const minutes =
        window.id === 'weekly' ? 7 * 24 * 60 : finiteOrNull(window.durationMinutes);
      return {
        id: window.id,
        label: window.id,
        labelKey: `meta_quota.${window.id}`,
        remaining: remainingFromUsed(window.usedPercent),
        // Meta reports Unix seconds.
        resetAtMs: resetAt === null ? null : resetAt * 1000,
        periodHours: minutes === null ? null : minutes / 60,
      };
    });
  }

  return [];
}

/**
 * Collapse one provider's credentials into the two headline aggregates.
 *
 * Candidates are the meter ids with the longest period — the weekly windows,
 * which are what actually run out; a 5-hour window refills before anyone could
 * act on its total. Among those the most depleted is primary, because the
 * binding constraint is the number worth reading first. The runner-up becomes
 * the secondary line. Falls back to shorter windows only when a provider has
 * nothing longer.
 */
export function buildLedgerProviderSummary(
  provider: QuotaProviderType,
  credentials: readonly { meters: readonly LedgerMeter[]; loaded: boolean }[],
  nowMs: number
): LedgerProviderSummary {
  const loaded = credentials.filter((credential) => credential.loaded);
  const base: LedgerProviderSummary = {
    provider,
    credentialCount: credentials.length,
    loadedCount: loaded.length,
    primary: null,
    secondary: null,
  };
  if (loaded.length === 0) return base;

  // Meter ids in first-seen order, so ties resolve the way the provider lists them.
  const order: string[] = [];
  const sample = new Map<string, LedgerMeter>();
  loaded.forEach((credential) =>
    credential.meters.forEach((meter) => {
      if (!sample.has(meter.id)) {
        sample.set(meter.id, meter);
        order.push(meter.id);
      }
    })
  );
  if (order.length === 0) return base;

  const aggregate = (meterId: string): LedgerAggregate => {
    const first = sample.get(meterId) as LedgerMeter;
    let total: number | null = null;
    let carriers = 0;
    let soonest: number | null = null;
    const segments = loaded.map((credential) => {
      const meter = credential.meters.find((candidate) => candidate.id === meterId);
      if (!meter) return null;
      carriers += 1;
      if (meter.remaining !== null) total = (total ?? 0) + meter.remaining;
      if (meter.resetAtMs !== null && meter.resetAtMs > nowMs) {
        soonest = soonest === null ? meter.resetAtMs : Math.min(soonest, meter.resetAtMs);
      }
      return meter.remaining;
    });
    return {
      meterId,
      label: first.label,
      labelKey: first.labelKey,
      labelParams: first.labelParams,
      total,
      capacity: carriers * 100,
      segments,
      soonestResetMs: soonest,
    };
  };

  const periodOf = (meterId: string) => sample.get(meterId)?.periodHours ?? 0;
  const longest = Math.max(...order.map(periodOf));
  const candidates = order.filter((meterId) => periodOf(meterId) === longest).map(aggregate);

  // Lowest fill ratio first; an unreadable aggregate sorts last.
  const ratio = (value: LedgerAggregate) =>
    value.total === null || value.capacity === 0 ? Infinity : value.total / value.capacity;
  const ranked = candidates
    .map((value, index) => ({ value, index }))
    .sort((a, b) => ratio(a.value) - ratio(b.value) || a.index - b.index)
    .map(({ value }) => value);

  return { ...base, primary: ranked[0] ?? null, secondary: ranked[1] ?? null };
}

/* ---------------------------------------------------------------- masking */

const MASK = '•••';

// Local part stops at '-' and '_' so a filename prefix such as
// `claude-dd50080c-` stays readable and only the mailbox name is hidden.
const EMAIL_PATTERN =
  /([A-Za-z0-9.%+]+)@([A-Za-z0-9-]+)((?:\.[A-Za-z]{2,})+?)(?=\.json\b|[-_\s·)]|$)/g;

/**
 * Hide the identifying parts of every email address inside a credential label.
 *
 * `claude-ada@example.dev.json` → `claude-a•••@e•••.dev.json`. The first letters
 * and the TLD survive so two accounts can still be told apart on screen without
 * the full address being readable over someone's shoulder or in a screen share.
 */
export function maskEmails(text: string): string {
  return text.replace(EMAIL_PATTERN, (_match, local: string, host: string, suffix: string) => {
    const tld = suffix.slice(suffix.lastIndexOf('.'));
    return `${local.slice(0, 1)}${MASK}@${host.slice(0, 1)}${MASK}${tld}`;
  });
}
