/**
 * Gateway usage per person and per API key, served by the access gate at
 * `/_bridge/usage?days=N` (same origin as the console, Microsoft sign-in).
 * The gate logs every `/v1` request; keys are only ever reported masked.
 * Pure and React-free.
 */

export const GATEWAY_USAGE_PATH = '/_bridge/usage';
export const GATEWAY_USAGE_DAY_OPTIONS = [1, 7, 30, 90] as const;

export interface UsageTotals {
  requests: number;
  errors: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Requests per model, most used first. */
  models: { model: string; requests: number }[];
  lastUsedMs: number | null;
}

export interface UserUsage extends UsageTotals {
  user: string;
  keys: string[];
}

export interface KeyUsage extends UsageTotals {
  /** Masked key id, e.g. `sk-msk-u-axelm-…a1b2`. */
  key: string;
  owner: string | null;
  /** Still listed in the gateway's access.api-keys. */
  configured: boolean;
}

export interface GatewayUsage {
  days: number;
  generatedAtMs: number | null;
  users: UserUsage[];
  keys: KeyUsage[];
  totals: UsageTotals;
}

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const timeMs = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Only a remote https gateway has the access gate; the desktop proxy does not. */
export function gatewayUsageUrl(apiBase: string | undefined, days: number): string | null {
  const base = (apiBase ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) return null;
  if (/^https:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(base)) return null;
  return `${base}${GATEWAY_USAGE_PATH}?days=${days}`;
}

function parseTotals(value: unknown): UsageTotals {
  const row = record(value);
  const inputTokens = num(row.inputTokens);
  const cachedInputTokens = num(row.cachedInputTokens);
  const cacheWriteTokens = num(row.cacheWriteTokens);
  const outputTokens = num(row.outputTokens);
  const models = Object.entries(record(row.models))
    .map(([model, requests]) => ({ model, requests: num(requests) }))
    .sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));
  return {
    requests: num(row.requests),
    errors: num(row.errors),
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    totalTokens: inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens,
    models,
    lastUsedMs: timeMs(row.lastUsed),
  };
}

const byActivity = (a: UsageTotals, b: UsageTotals) =>
  b.totalTokens - a.totalTokens || b.requests - a.requests;

export function sumTotals(rows: UsageTotals[]): UsageTotals {
  const models = new Map<string, number>();
  let lastUsedMs: number | null = null;
  const sum = rows.reduce(
    (acc, row) => {
      row.models.forEach((m) => models.set(m.model, (models.get(m.model) ?? 0) + m.requests));
      if (row.lastUsedMs !== null && (lastUsedMs === null || row.lastUsedMs > lastUsedMs)) {
        lastUsedMs = row.lastUsedMs;
      }
      acc.requests += row.requests;
      acc.errors += row.errors;
      acc.inputTokens += row.inputTokens;
      acc.cachedInputTokens += row.cachedInputTokens;
      acc.cacheWriteTokens += row.cacheWriteTokens;
      acc.outputTokens += row.outputTokens;
      acc.totalTokens += row.totalTokens;
      return acc;
    },
    {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }
  );
  return {
    ...sum,
    models: [...models.entries()]
      .map(([model, requests]) => ({ model, requests }))
      .sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model)),
    lastUsedMs,
  };
}

export function parseGatewayUsage(payload: unknown): GatewayUsage {
  const body = record(payload);

  const users = Object.entries(record(body.users))
    .map(([user, value]): UserUsage => {
      const keys = record(value).keys;
      return {
        user,
        keys: Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [],
        ...parseTotals(value),
      };
    })
    .sort(byActivity);

  const keys = Object.entries(record(body.keys))
    .map(([key, value]): KeyUsage => {
      const row = record(value);
      return {
        key,
        owner: typeof row.owner === 'string' && row.owner ? row.owner : null,
        configured: row.configured === true,
        ...parseTotals(value),
      };
    })
    .sort(
      (a, b) =>
        byActivity(a, b) ||
        Number(b.configured) - Number(a.configured) ||
        a.key.localeCompare(b.key)
    );

  return {
    days: num(body.days),
    generatedAtMs: timeMs(body.generatedAt),
    users,
    keys,
    // Every request is counted once per person, so the person rows give the grand total.
    totals: sumTotals(users),
  };
}
