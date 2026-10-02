/**
 * Azure AI Foundry usage, served by the gateway's foundry-usage sidecar at
 * `/_bridge/foundry/usage` (same origin as the console, management key as
 * bearer). Usage only: Foundry has no subscription quota to meter, so this is
 * tokens, requests and month-to-date cost. Pure and React-free.
 */

export const FOUNDRY_USAGE_PATH = '/_bridge/foundry/usage';

export interface FoundryDeploymentUsage {
  deployment: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  last24hRequests: number;
  last24hTokens: number;
}

export interface FoundryUsage {
  account: string;
  periodStartMs: number | null;
  deployments: FoundryDeploymentUsage[];
  cost: { total: number; currency: string; stale: boolean } | null;
  costError: string | null;
  totals: { inputTokens: number; outputTokens: number; requests: number };
}

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** Only a remote https gateway has the sidecar; the desktop proxy does not. */
export function foundryUsageUrl(apiBase: string | undefined): string | null {
  const base = (apiBase ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) return null;
  if (/^https:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(base)) return null;
  return `${base}${FOUNDRY_USAGE_PATH}`;
}

export function parseFoundryUsage(payload: unknown): FoundryUsage {
  const body = (payload ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(body.deployments) ? (body.deployments as Record<string, unknown>[]) : [];
  const deployments = rows
    .map((row): FoundryDeploymentUsage => {
      const last24 = (row.last24h ?? {}) as Record<string, unknown>;
      return {
        deployment: typeof row.deployment === 'string' ? row.deployment : '(unknown)',
        inputTokens: num(row.inputTokens),
        outputTokens: num(row.outputTokens),
        requests: num(row.requests),
        last24hRequests: num(last24.requests),
        last24hTokens: num(last24.inputTokens) + num(last24.outputTokens),
      };
    })
    .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));

  const cost = (body.cost ?? {}) as Record<string, unknown>;
  const hasCost = typeof cost.total === 'number' && Number.isFinite(cost.total);

  return {
    account: typeof body.account === 'string' ? body.account : 'Foundry',
    periodStartMs: typeof body.periodStartMs === 'number' ? body.periodStartMs : null,
    deployments,
    cost: hasCost
      ? {
          total: cost.total as number,
          currency: typeof cost.currency === 'string' ? cost.currency : 'USD',
          stale: cost.stale === true,
        }
      : null,
    costError: !hasCost && typeof cost.error === 'string' ? cost.error : null,
    totals: deployments.reduce(
      (sum, row) => ({
        inputTokens: sum.inputTokens + row.inputTokens,
        outputTokens: sum.outputTokens + row.outputTokens,
        requests: sum.requests + row.requests,
      }),
      { inputTokens: 0, outputTokens: 0, requests: 0 }
    ),
  };
}

/** 11602296 → "11.6M", 823632 → "824K". */
export function compactNumber(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}K`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(Math.round(value));
}
