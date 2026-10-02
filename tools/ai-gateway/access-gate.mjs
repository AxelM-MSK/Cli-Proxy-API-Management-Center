// access-gate: the gateway's front door behind cloudflared.
//
// Microsoft sign-in (Cloudflare Access) is the console login. Access forwards a
// signed JWT in `Cf-Access-Jwt-Assertion`; this gate verifies it (RS256 against
// the team's published keys, audience = the console app, allowed emails) and,
// for management and Foundry-usage calls, swaps in the real management key so
// the browser never sees or needs it.
//
//   /v1/_msk/quota                -> answered here (gateway API key; read-only Ledger quota)
//   /v1/*                         -> 8317 untouched (per-user API keys; Access bypassed)
//   /_bridge/auth/whoami          -> answered here (signed-in email, for auto-login)
//   /_bridge/cursor/*             -> 8319 (signed-in only; bridge key auth as before)
//   /_bridge/foundry/*            -> 8320 (signed-in only; management key injected)
//   /v8|v0/management/*           -> 8317 (signed-in only; management key injected)
//   everything else               -> 8317 (signed-in only)
//
// Defense in depth: Cloudflare Access already blocks unsigned requests at the
// edge; the gate re-checks so a misconfigured Access app cannot expose the console.

import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  if (path === '/v1' || path.startsWith('/v1/')) return { port: UPSTREAM.gateway, open: true };
  if (path === '/_bridge/auth/whoami') return { local: 'whoami' };
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
  if (!target.open) {
    user = await accessUser(req);
    if (!user) return deny(res, 401, 'sign in through Microsoft (Cloudflare Access) required');
  }
  if (target.local === 'quota') {
    if (req.method !== 'GET') return deny(res, 405, 'GET only');
    return quota(req, res).catch(() => deny(res, 502, 'quota unavailable'));
  }
  if (target.local === 'whoami') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ gateway: true, email: user }));
  }
  const upstream = httpRequest(
    { host: HOST, port: target.port, method: req.method, path: req.url, headers: forwardHeaders(req, target.inject) },
    (up) => {
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
