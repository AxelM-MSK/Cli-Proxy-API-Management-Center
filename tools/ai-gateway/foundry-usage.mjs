// foundry-usage: read-only Foundry usage for the gateway console.
//
// GET /_bridge/foundry/usage -> month-to-date and last-24h tokens/requests per
// deployment of mskmso-foundry (Azure Monitor metrics) plus month-to-date cost
// (Cost Management), using the VM's managed identity. No prompts or content are
// ever read; only aggregate counters.
//
// Auth: the caller must present the gateway's management key (the console
// already holds it). The key is checked against the gateway itself, so this
// service stores no secret of its own. Loopback only; reached via the tunnel.

import { createServer } from 'node:http';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8320);
const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8317';
const ACCOUNT_ID =
  process.env.FOUNDRY_RESOURCE_ID ??
  '/subscriptions/15a60cd5-8766-431b-a003-49f4f1b1890f/resourceGroups/rg-mskmso-ai/providers/Microsoft.CognitiveServices/accounts/mskmso-foundry';
const CACHE_MS = 5 * 60 * 1000;
const AUTH_CACHE_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------- tokens */

let armToken = { value: null, expiresAt: 0 };

async function managementToken() {
  if (armToken.value && Date.now() < armToken.expiresAt - 60_000) return armToken.value;
  const url =
    'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=' +
    encodeURIComponent('https://management.azure.com/');
  const res = await fetch(url, { headers: { Metadata: 'true' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`managed identity token: HTTP ${res.status}`);
  const body = await res.json();
  armToken = { value: body.access_token, expiresAt: Number(body.expires_on) * 1000 };
  return armToken.value;
}

async function arm(path, init = {}) {
  const res = await fetch(`https://management.azure.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${await managementToken()}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ARM ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/* ------------------------------------------------------------ metrics */

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function metricTotals(fromMs, toMs, interval) {
  const params = new URLSearchParams({
    'api-version': '2023-10-01',
    metricnames: 'InputTokens,OutputTokens,ModelRequests',
    aggregation: 'Total',
    timespan: `${iso(fromMs)}/${iso(toMs)}`,
    interval,
    $filter: "ModelDeploymentName eq '*'",
    top: '100',
  });
  const body = await arm(`${ACCOUNT_ID}/providers/Microsoft.Insights/metrics?${params}`);
  const byDeployment = new Map();
  for (const metric of body.value ?? []) {
    const key = { InputTokens: 'inputTokens', OutputTokens: 'outputTokens', ModelRequests: 'requests' }[
      metric.name?.value
    ];
    if (!key) continue;
    for (const series of metric.timeseries ?? []) {
      const name =
        (series.metadatavalues ?? []).find((m) => m.name?.value?.toLowerCase() === 'modeldeploymentname')
          ?.value || '(none)';
      const row = byDeployment.get(name) ?? { deployment: name, inputTokens: 0, outputTokens: 0, requests: 0 };
      for (const point of series.data ?? []) row[key] += Number(point.total ?? 0);
      byDeployment.set(name, row);
    }
  }
  return [...byDeployment.values()];
}

/* --------------------------------------------------------------- cost */

async function monthToDateCost() {
  const rg = ACCOUNT_ID.split('/providers/')[0];
  // Declaring a ClientType keeps these calls out of Cost Management's shared
  // anonymous rate-limit bucket (see the 2026-08-31 weekly-report outage).
  const body = await arm(`${rg}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`, {
    method: 'POST',
    headers: { ClientType: 'mskmso-gateway-usage' },
    body: JSON.stringify({
      type: 'ActualCost',
      timeframe: 'MonthToDate',
      dataset: {
        granularity: 'None',
        aggregation: { cost: { name: 'Cost', function: 'Sum' } },
        grouping: [{ type: 'Dimension', name: 'Meter' }],
        filter: { dimensions: { name: 'ResourceId', operator: 'In', values: [ACCOUNT_ID.toLowerCase()] } },
      },
    }),
  });
  const cols = (body.properties?.columns ?? []).map((c) => c.name);
  const iCost = cols.indexOf('Cost');
  const iMeter = cols.indexOf('Meter');
  const iCurrency = cols.indexOf('Currency');
  const meters = (body.properties?.rows ?? []).map((row) => ({
    meter: row[iMeter],
    cost: Number(row[iCost] ?? 0),
  }));
  return {
    currency: iCurrency >= 0 ? body.properties.rows?.[0]?.[iCurrency] ?? 'USD' : 'USD',
    total: meters.reduce((sum, m) => sum + m.cost, 0),
    meters: meters.sort((a, b) => b.cost - a.cost).slice(0, 15),
  };
}

/* -------------------------------------------------------------- usage */

let cache = { at: 0, body: null };
// Cost moves slowly and its API throttles hard: refresh at most every 30 min and
// keep the last good figure (marked stale) when a refresh fails.
const COST_CACHE_MS = 30 * 60 * 1000;
let costCache = { at: 0, body: null };

async function cachedCost() {
  if (costCache.body && Date.now() - costCache.at < COST_CACHE_MS) return costCache.body;
  try {
    const body = await monthToDateCost();
    costCache = { at: Date.now(), body: { ...body, fetchedAtMs: Date.now() } };
    return costCache.body;
  } catch (err) {
    if (costCache.body) return { ...costCache.body, stale: true };
    return { error: String(err.message ?? err) };
  }
}

async function usage() {
  if (cache.body && Date.now() - cache.at < CACHE_MS) return cache.body;
  const now = Date.now();
  const monthStart = new Date(now);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [month, day, cost] = await Promise.all([
    metricTotals(monthStart.getTime(), now, 'P1D'),
    metricTotals(now - 24 * 3_600_000, now, 'PT1H'),
    cachedCost(),
  ]);
  const last24 = new Map(day.map((row) => [row.deployment, row]));
  const deployments = month
    .map((row) => ({
      ...row,
      last24h: last24.get(row.deployment) ?? { inputTokens: 0, outputTokens: 0, requests: 0 },
    }))
    .filter((row) => row.requests > 0 || row.inputTokens > 0)
    .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));

  const body = {
    account: ACCOUNT_ID.split('/').at(-1),
    periodStartMs: monthStart.getTime(),
    fetchedAtMs: now,
    deployments,
    cost,
  };
  cache = { at: now, body };
  return body;
}

/* --------------------------------------------------------------- http */

const authOk = new Map();

async function authorized(req) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || header.length < 20) return false;
  const seen = authOk.get(header);
  if (seen && Date.now() - seen < AUTH_CACHE_MS) return true;
  const res = await fetch(`${GATEWAY}/v8/management/config`, {
    headers: { authorization: header },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) return false;
  authOk.set(header, Date.now());
  return true;
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  const path = (req.url ?? '').split('?')[0].replace(/^\/_bridge\/foundry(?=\/)/, '');
  if (path === '/healthz') return send(res, 200, { ok: true });
  if (req.method !== 'GET' || path !== '/usage') return send(res, 404, { error: 'not found' });
  if (!(await authorized(req))) return send(res, 401, { error: 'unauthorized' });
  try {
    send(res, 200, await usage());
  } catch (err) {
    send(res, 502, { error: String(err.message ?? err) });
  }
}).listen(PORT, HOST, () => console.log(`foundry-usage listening on http://${HOST}:${PORT}`));
