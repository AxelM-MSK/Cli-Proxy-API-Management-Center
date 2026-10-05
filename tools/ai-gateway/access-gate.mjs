// access-gate: the gateway's front door behind cloudflared.
//
// Microsoft sign-in (Cloudflare Access) is the console login. Access forwards a
// signed JWT in `Cf-Access-Jwt-Assertion`; this gate verifies it (RS256 against
// the team's published keys, audience = the console app, allowed emails) and,
// for management and Foundry-usage calls, swaps in the real management key so
// the browser never sees or needs it.
//
//   /v1/_msk/quota                -> answered here (gateway API key or Entra token; Ledger quota)
//   /v1/_msk/usage                -> answered here (Entra token of a gateway admin; usage per person and key)
//   /_bridge/usage                -> answered here (signed-in console users; usage per person and key)
//   /v1/* with an Entra token     -> token verified, swapped for that person's own key (CONFIG.entra)
//   /v1/*                         -> 8317 untouched (per-user API keys; Access bypassed)
//   /_bridge/auth/whoami          -> answered here (signed-in email, for auto-login)
//   /_bridge/cursor/*             -> 8319 (signed-in only; bridge key auth as before)
//   /_bridge/foundry/*            -> 8320 (signed-in only; management key injected)
//   /v8|v0/management/*           -> 8317 (signed-in only; management key injected)
//   everything else               -> 8317 (signed-in only)
//
// Defense in depth: Cloudflare Access already blocks unsigned requests at the
// edge; the gate re-checks so a misconfigured Access app cannot expose the console.

import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';

const CONFIG = JSON.parse(readFileSync(process.env.GATE_CONFIG ?? '/opt/cliproxy/access-gate/config.json', 'utf8'));
const HOST = '127.0.0.1';
const PORT = CONFIG.port ?? 8316;
const TEAM = CONFIG.teamDomain; // e.g. https://msk-mso.cloudflareaccess.com
const AUD = CONFIG.aud;
const ALLOWED = new Set((CONFIG.allowedEmails ?? []).map((e) => e.toLowerCase()));
const MGMT_KEY = readFileSync(CONFIG.managementKeyFile, 'utf8').trim();
const UPSTREAM = { gateway: 8317, cursor: 8319, foundry: 8320 };

if (!TEAM || !AUD || ALLOWED.size === 0 || !MGMT_KEY) throw new Error('access-gate config incomplete');

/* --------------------------------------------------------- JWT verify */

let jwks = { at: 0, keys: new Map() };

async function signingKey(kid) {
  if (!jwks.keys.has(kid) || Date.now() - jwks.at > 60 * 60 * 1000) {
    const res = await fetch(`${TEAM}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
    const body = await res.json();
    jwks = { at: Date.now(), keys: new Map((body.keys ?? []).map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })])) };
  }
  return jwks.keys.get(kid) ?? null;
}

const b64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Returns the signed-in email, or null. */
async function accessUser(req) {
  const token = req.headers['cf-access-jwt-assertion'];
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(b64url(parts[0]).toString('utf8'));
    const claims = JSON.parse(b64url(parts[1]).toString('utf8'));
    if (header.alg !== 'RS256') return null;
    const key = await signingKey(header.kid);
    if (!key) return null;
    const ok = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, b64url(parts[2]));
    if (!ok) return null;
    const now = Math.floor(Date.now() / 1000);
    const audOk = Array.isArray(claims.aud) ? claims.aud.includes(AUD) : claims.aud === AUD;
    if (!audOk || claims.iss !== TEAM || !(claims.exp > now) || (claims.nbf && claims.nbf > now + 60)) return null;
    const email = String(claims.email ?? '').toLowerCase();
    return ALLOWED.has(email) ? email : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------- Entra sign-in for /v1 (keyless clients) */

// API clients (the msk agent) may send a Microsoft Entra access token instead of a gateway API key.
// The gate verifies it (RS256 against the tenant's keys, issuer, audience, scope, expiry, allowlist)
// and swaps in that person's own gateway API key, created on first use and named after them, so
// usage is tracked per person while nobody holds a key. Off unless CONFIG.entra is set.
const ENTRA = CONFIG.entra ?? null; // { tenantId, audience, scope, allowedUsers: ["*"|upn...], userKeysFile, gatewayConfig }
let entraJwks = { at: 0, keys: new Map() };

async function entraSigningKey(kid) {
  if (!entraJwks.keys.has(kid) || Date.now() - entraJwks.at > 60 * 60 * 1000) {
    const res = await fetch(`https://login.microsoftonline.com/${ENTRA.tenantId}/discovery/v2.0/keys`, { signal: AbortSignal.timeout(10_000) });
    const body = await res.json();
    entraJwks = { at: Date.now(), keys: new Map((body.keys ?? []).map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })])) };
  }
  return entraJwks.keys.get(kid) ?? null;
}

const looksLikeJwt = (auth) => /^Bearer eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(auth ?? '');

/** Returns { oid, upn, name } for a valid, allowed Entra token, or null. */
async function entraUser(auth) {
  if (!ENTRA || !looksLikeJwt(auth)) return null;
  const parts = auth.slice(7).split('.');
  try {
    const header = JSON.parse(b64url(parts[0]).toString('utf8'));
    const c = JSON.parse(b64url(parts[1]).toString('utf8'));
    if (header.alg !== 'RS256') return null;
    const key = await entraSigningKey(header.kid);
    if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, b64url(parts[2]))) return null;
    const now = Math.floor(Date.now() / 1000);
    if (c.iss !== `https://login.microsoftonline.com/${ENTRA.tenantId}/v2.0` || c.tid !== ENTRA.tenantId) return null;
    if (c.aud !== ENTRA.audience || !(c.exp > now) || (c.nbf && c.nbf > now + 60)) return null;
    if (!String(c.scp ?? '').split(' ').includes(ENTRA.scope)) return null;
    const upn = String(c.preferred_username ?? c.upn ?? '').toLowerCase();
    const allowed = ENTRA.allowedUsers ?? [];
    if (!c.oid || !upn || !(allowed.includes('*') || allowed.map((u) => u.toLowerCase()).includes(upn))) return null;
    return { oid: c.oid, upn, name: c.name ?? upn };
  } catch {
    return null;
  }
}

let keyLock = Promise.resolve();
/** The person's own gateway API key; created (and added to the gateway config) on first use. */
function userKey(user) {
  const run = keyLock.then(async () => {
    let map = {};
    try { map = JSON.parse(readFileSync(ENTRA.userKeysFile, 'utf8')); } catch {}
    if (map[user.oid]?.key) return map[user.oid].key;
    const slug = user.upn.split('@')[0].replace(/[^a-z0-9]/g, '').slice(0, 24) || 'user';
    const key = `sk-msk-u-${slug}-${randomBytes(18).toString('base64url')}`;
    const cfg = readFileSync(ENTRA.gatewayConfig, 'utf8');
    const m = cfg.match(/^access:\n    api-keys:\n((?:        - "[^"\n]+"\n)+)/m);
    if (!m) throw new Error('gateway config: access.api-keys block not found');
    const end = m.index + m[0].length;
    writeFileSync(ENTRA.gatewayConfig, `${cfg.slice(0, end)}        - "${key}"\n${cfg.slice(end)}`, { mode: 0o600 });
    map[user.oid] = { upn: user.upn, name: user.name, key, created: new Date().toISOString() };
    writeFileSync(ENTRA.userKeysFile, JSON.stringify(map, null, 1), { mode: 0o600 });
    console.log(`entra: created gateway key for ${user.upn}`);
    // the gateway hot-reloads its config; wait until it accepts the new key
    for (let i = 0; i < 20; i++) {
      if ((await local('GET', '/v1/models', `Bearer ${key}`).catch(() => ({ status: 0 }))).status === 200) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return key;
  });
  keyLock = run.catch(() => {});
  return run;
}

/**
 * For /v1 requests: swap a valid Entra token for the person's key. OpenAI-style clients send it as
 * `Authorization: Bearer`, Anthropic-style clients as `x-api-key`. Returns false if a token was
 * sent but rejected; API-key clients pass through untouched.
 */
async function applyEntra(req) {
  const fromXKey = looksLikeJwt(`Bearer ${req.headers['x-api-key'] ?? ''}`);
  const auth = fromXKey ? `Bearer ${req.headers['x-api-key']}` : req.headers.authorization;
  if (!looksLikeJwt(auth)) return true;
  const user = await entraUser(auth);
  if (!user) return false;
  const key = await userKey(user);
  if (fromXKey) req.headers['x-api-key'] = key;
  else req.headers.authorization = `Bearer ${key}`;
  req.mskUser = user.upn;
  return true;
}

/* ------------------------------------------------------------ per-person usage */

// One JSONL line per /v1 request: who, model, status, tokens. Tokens are read from the response as
// it streams through (last usage numbers seen), so streaming and non-streaming both work.
const USAGE_DIR = ENTRA?.usageDir ?? '/opt/cliproxy/access-gate/usage';
const KEY_LABELS = new Map(Object.entries(CONFIG.keyLabels ?? {})); // optional: { "<api key>": "label" }

const GATEWAY_CONFIG = ENTRA?.gatewayConfig ?? CONFIG.gatewayConfig ?? '/opt/cliproxy/config.yaml';

const requestKey = (req) => String(req.headers['x-api-key'] ?? req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');

/** Non-secret id for an API key: its prefix (with the owner slug for per-person keys) and last 4. */
export function maskKey(k) {
  if (!k) return 'none';
  const prefix = k.match(/^sk-msk-u-[a-z0-9]+-/)?.[0] ?? k.slice(0, Math.min(8, Math.max(k.length - 4, 0)));
  return `${prefix}…${k.slice(-4)}`;
}

function readUserKeys() {
  try { return JSON.parse(readFileSync(ENTRA?.userKeysFile ?? '', 'utf8')); } catch { return {}; }
}

/** The gateway's client API keys (access.api-keys), or [] if the config cannot be read. */
function configuredKeys() {
  try {
    const m = readFileSync(GATEWAY_CONFIG, 'utf8').match(/^access:\n    api-keys:\n((?:        - "[^"\n]+"\n)+)/m);
    return m ? [...m[1].matchAll(/- "([^"\n]+)"/g)].map((x) => x[1]) : [];
  } catch {
    return [];
  }
}

/** Who a key belongs to: an explicit label, the person it was created for, or nobody known. */
function keyOwner(k, userKeys = readUserKeys()) {
  if (KEY_LABELS.has(k)) return KEY_LABELS.get(k);
  return Object.values(userKeys).find((v) => v.key === k)?.upn ?? null;
}

function callerLabel(req) {
  if (req.mskUser) return req.mskUser;
  const k = requestKey(req);
  if (!k) return 'anonymous';
  return keyOwner(k) ?? `key:${k.slice(0, 10)}`;
}

const lastInt = (text, names) => {
  let v;
  for (const n of names) for (const m of text.matchAll(new RegExp(`"${n}"\\s*:\\s*(\\d+)`, 'g'))) v = Math.max(v ?? 0, Number(m[1]));
  return v;
};

/** Call BEFORE piping the request upstream, so the model name in the body is seen. */
function tapRequest(req) {
  req.mskStarted = Date.now();
  req.mskHead = '';
  req.on('data', (d) => { if (req.mskHead.length < 65536) req.mskHead += d.toString('utf8', 0, Math.min(d.length, 65536)); });
}

function trackUsage(req, up, path) {
  const started = req.mskStarted ?? Date.now();
  const reqHead = () => req.mskHead ?? '';
  let tail = '';
  up.on('data', (d) => { tail = (tail + d.toString('utf8')).slice(-131072); });
  up.on('end', () => {
    const rec = {
      ts: new Date().toISOString(),
      user: callerLabel(req),
      key: maskKey(requestKey(req)),
      path,
      model: reqHead().match(/"model"\s*:\s*"([^"]+)"/)?.[1] ?? null,
      status: up.statusCode,
      inputTokens: lastInt(tail, ['input_tokens', 'prompt_tokens']) ?? null,
      outputTokens: lastInt(tail, ['output_tokens', 'completion_tokens']) ?? null,
      cachedInputTokens: lastInt(tail, ['cache_read_input_tokens', 'cached_tokens']) ?? null,
      cacheWriteTokens: lastInt(tail, ['cache_creation_input_tokens', 'cache_write_tokens']) ?? null,
      ms: Date.now() - started,
    };
    try {
      mkdirSync(USAGE_DIR, { recursive: true });
      appendFileSync(`${USAGE_DIR}/${rec.ts.slice(0, 10)}.jsonl`, `${JSON.stringify(rec)}\n`);
    } catch (e) {
      console.error(`usage log failed: ${e.message}`);
    }
  });
}

const emptyTotals = () => ({ requests: 0, errors: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, models: {}, lastUsed: null });

function addRecord(t, r) {
  t.requests++;
  if (!(r.status >= 200 && r.status < 400)) t.errors++;
  t.inputTokens += r.inputTokens ?? 0;
  t.cachedInputTokens += r.cachedInputTokens ?? 0;
  t.cacheWriteTokens += r.cacheWriteTokens ?? 0;
  t.outputTokens += r.outputTokens ?? 0;
  t.models[r.model ?? '?'] = (t.models[r.model ?? '?'] ?? 0) + 1;
  if (r.ts && (!t.lastUsed || r.ts > t.lastUsed)) t.lastUsed = r.ts;
}

/**
 * Totals per person and per API key over the last `days` days (UTC, today included). Keys are
 * reported only by their masked id; configured keys with no traffic are listed with zeros.
 * Records written before keys were logged get their key from the owner, where known.
 */
export function summarizeUsage(days, { dir = USAGE_DIR, now = Date.now(), keys = configuredKeys(), userKeys = readUserKeys() } = {}) {
  const users = {};
  const byKey = {};
  const keyEntry = (id, owner) => {
    const k = (byKey[id] ??= { owner: owner ?? null, configured: false, ...emptyTotals() });
    if (!k.owner && owner) k.owner = owner;
    return k;
  };
  const ownerToKey = new Map();
  for (const k of keys) {
    const owner = keyOwner(k, userKeys);
    keyEntry(maskKey(k), owner).configured = true;
    if (owner && !ownerToKey.has(owner)) ownerToKey.set(owner, maskKey(k));
  }
  for (const v of Object.values(userKeys)) if (v?.upn && v.key && !ownerToKey.has(v.upn)) ownerToKey.set(v.upn, maskKey(v.key));

  for (let i = 0; i < days; i++) {
    const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    let lines = [];
    try { lines = readFileSync(`${dir}/${day}.jsonl`, 'utf8').trim().split('\n'); } catch { continue; }
    for (const l of lines) {
      let r; try { r = JSON.parse(l); } catch { continue; }
      const who = r.user ?? 'anonymous';
      // 'none' = the request carried no key (same id maskKey gives an empty key).
      const id = r.key ?? ownerToKey.get(who) ?? (who.startsWith('key:') ? `${who.slice(4)}…` : who === 'anonymous' ? 'none' : 'unknown');
      const u = (users[who] ??= { ...emptyTotals(), keys: [] });
      addRecord(u, r);
      if (!u.keys.includes(id)) u.keys.push(id);
      addRecord(keyEntry(id, who.startsWith('key:') ? null : who), r);
    }
  }
  return { days, generatedAt: new Date(now).toISOString(), users, keys: byKey };
}

const parseDays = (req) => Math.min(Math.max(Number(new URL(req.url, 'http://x').searchParams.get('days')) || 7, 1), 90);

/** GET /v1/_msk/usage?days=7: totals per person and key. Admins only (CONFIG.entra.admins). */
async function usageReport(req, res) {
  const user = await entraUser(req.headers.authorization);
  if (!user || !(ENTRA.admins ?? []).map((a) => a.toLowerCase()).includes(user.upn)) return deny(res, 403, 'gateway admins only (Microsoft token)');
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(summarizeUsage(parseDays(req))));
}

/** GET /_bridge/usage?days=7: the same report for the console (Cloudflare Access sign-in). */
function consoleUsageReport(req, res) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(summarizeUsage(parseDays(req))));
}

/* ------------------------------------------------------------ routing */

/* ------------------------------------------------- Ledger quota for API-key clients */

// GET /v1/_msk/quota: subscription quota (Claude / Codex usage windows) for clients that hold a
// gateway API key but cannot pass Cloudflare Access, e.g. the msk terminal agent. Read-only;
// the management key is used here on the VM and never returned. Cached for 60 s.
const QUOTA_SOURCES = {
  claude: {
    url: 'https://api.anthropic.com/api/oauth/usage',
    header: { 'User-Agent': 'claude-cli/2.1.280 (external, cli)', Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
  },
  codex: {
    url: 'https://chatgpt.com/backend-api/wham/usage',
    header: { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'User-Agent': 'codex-tui/0.149.1 (codex-tui; 0.149.1)' },
  },
};

function local(method, path, auth, body) {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: HOST, port: UPSTREAM.gateway, method, path, headers: { authorization: auth, 'content-type': 'application/json' } }, (up) => {
      let text = '';
      up.on('data', (d) => (text += d));
      up.on('end', () => resolve({ status: up.statusCode ?? 0, text }));
    });
    r.on('error', reject);
    r.setTimeout(30_000, () => r.destroy(new Error('timeout')));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

const maskEmail = (e) => (typeof e === 'string' && e.includes('@') ? `${e.slice(0, 2)}***@${e.split('@')[1]}` : undefined);

async function buildQuota() {
  const mgmt = `Bearer ${MGMT_KEY}`;
  const files = JSON.parse((await local('GET', '/v0/management/auth-files', mgmt)).text).files ?? [];
  const accounts = [];
  for (const f of files) {
    const src = QUOTA_SOURCES[f.type];
    if (!src || f.disabled) continue;
    const header = { ...src.header };
    if (f.type === 'codex' && f.id_token?.chatgpt_account_id) header['Chatgpt-Account-Id'] = f.id_token.chatgpt_account_id;
    const entry = { provider: f.type, account: maskEmail(f.email) ?? f.label ?? f.auth_index, status: f.status };
    try {
      const r = JSON.parse((await local('POST', '/v0/management/api-call', mgmt, { authIndex: f.auth_index, method: 'GET', url: src.url, header })).text);
      const status = Number(r.status_code ?? 0);
      const body = typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
      if (status >= 200 && status < 300) {
        entry.usage =
          f.type === 'claude'
            ? Object.fromEntries(Object.entries(body ?? {}).filter(([, v]) => v && typeof v === 'object' && 'utilization' in v))
            : { plan_type: body?.plan_type, rate_limit: body?.rate_limit, credits: body?.credits };
      } else entry.error = `upstream ${status}`;
    } catch (e) {
      entry.error = String(e.message ?? e).slice(0, 200);
    }
    accounts.push(entry);
  }
  return { observedAt: new Date().toISOString(), accounts };
}

let quotaCache = { at: 0, body: null };
async function quota(req, res) {
  const auth = req.headers.authorization ?? '';
  // Valid gateway API key = the gateway itself accepts it.
  if (!/^Bearer \S{8,}$/.test(auth) || (await local('GET', '/v1/models', auth).catch(() => ({ status: 0 }))).status !== 200) {
    return deny(res, 401, 'valid gateway API key required');
  }
  if (!quotaCache.body || Date.now() - quotaCache.at > 60_000) quotaCache = { at: Date.now(), body: await buildQuota() };
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(quotaCache.body));
}

function route(path) {
  if (path === '/v1/_msk/quota') return { local: 'quota', open: true };
  if (path === '/v1/_msk/usage') return { local: 'usage', open: true };
  if (path === '/v1' || path.startsWith('/v1/')) return { port: UPSTREAM.gateway, open: true };
  if (path === '/_bridge/auth/whoami') return { local: 'whoami' };
  if (path === '/_bridge/usage') return { local: 'console-usage' };
  if (path.startsWith('/_bridge/cursor/')) return { port: UPSTREAM.cursor };
  if (path.startsWith('/_bridge/foundry/')) return { port: UPSTREAM.foundry, inject: true };
  if (/^\/v\d+\/management(\/|$)/.test(path)) return { port: UPSTREAM.gateway, inject: true };
  return { port: UPSTREAM.gateway };
}

function forwardHeaders(req, inject) {
  const headers = { ...req.headers };
  // Never trust identity headers from outside the gate.
  for (const name of Object.keys(headers)) if (name.startsWith('x-gateway-')) delete headers[name];
  if (inject) headers.authorization = `Bearer ${MGMT_KEY}`;
  return headers;
}

function deny(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: message }));
}

const server = createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const target = route(path);
  let user = null;
  if (target.local === 'usage') {
    if (!ENTRA || req.method !== 'GET') return deny(res, 404, 'not found');
    return usageReport(req, res).catch(() => deny(res, 502, 'usage unavailable'));
  }
  if (!target.open) {
    user = await accessUser(req);
    if (!user) return deny(res, 401, 'sign in through Microsoft (Cloudflare Access) required');
  } else if (!(await applyEntra(req).catch(() => false))) {
    return deny(res, 401, 'Microsoft token rejected (expired, wrong tenant/audience/scope, or user not allowed on the gateway)');
  }
  if (target.local === 'quota') {
    if (req.method !== 'GET') return deny(res, 405, 'GET only');
    return quota(req, res).catch(() => deny(res, 502, 'quota unavailable'));
  }
  if (target.local === 'console-usage') {
    if (req.method !== 'GET') return deny(res, 405, 'GET only');
    try { return consoleUsageReport(req, res); } catch { return deny(res, 502, 'usage unavailable'); }
  }
  if (target.local === 'whoami') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ gateway: true, email: user }));
  }
  if (target.open && path.startsWith('/v1/')) tapRequest(req);
  const upstream = httpRequest(
    { host: HOST, port: target.port, method: req.method, path: req.url, headers: forwardHeaders(req, target.inject) },
    (up) => {
      if (target.open && path.startsWith('/v1/')) trackUsage(req, up, path);
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.on('error', () => (res.headersSent ? res.destroy() : deny(res, 502, 'upstream unavailable')));
  req.pipe(upstream);
});

// WebSocket upgrades (e.g. the Responses API websocket) pass straight through.
server.on('upgrade', async (req, socket, head) => {
  const path = (req.url ?? '/').split('?')[0];
  const target = route(path);
  if (!target.port || (!target.open && !(await accessUser(req)))) return socket.destroy();
  if (target.open && !(await applyEntra(req).catch(() => false))) return socket.destroy();
  const upstream = connect(target.port, HOST, () => {
    const headers = forwardHeaders(req, target.inject);
    const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.requestTimeout = 0; // long streams are fine; upstreams enforce their own limits
server.listen(PORT, HOST, () => console.log(`access-gate listening on http://${HOST}:${PORT}`));
