// Cloudflare helper for the ai.musculoskeletalmso.com gateway.
// Usage: CF_TOKEN=... node cf.mjs <inspect|create>
// Never prints the API token or the tunnel token.
import { writeFileSync } from 'node:fs';

const T = process.env.CF_TOKEN;
const ACCOUNT = 'cfc473438f2bf2ac1a1cd4ae02e1d68f';
const ZONE = 'd75edf89cfecc9803ea981a6261da53c';
const HOST = 'ai.musculoskeletalmso.com';
const TUNNEL_NAME = 'openclaw-ai-gateway';
const ALLOW = ['AxelM@musculoskeletalmso.com', 'mso@musculoskeletalmso.com', 'yoomd@sdneurosurgery.com'];
if (!T) throw new Error('CF_TOKEN missing');

async function cf(method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${T}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!json.success) {
    const err = new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json.errors ?? json).slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return json.result;
}

const tryCf = async (...args) => {
  try {
    return { ok: true, result: await cf(...args) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

async function inspect() {
  const checks = {
    verify: await tryCf('GET', `/accounts/${ACCOUNT}/tokens/verify`),
    tunnels: await tryCf('GET', `/accounts/${ACCOUNT}/cfd_tunnel?is_deleted=false`),
    idps: await tryCf('GET', `/accounts/${ACCOUNT}/access/identity_providers`),
    apps: await tryCf('GET', `/accounts/${ACCOUNT}/access/apps`),
    dns: await tryCf('GET', `/zones/${ZONE}/dns_records?name=${HOST}`),
  };
  console.log('verify:', checks.verify.ok ? checks.verify.result.status : checks.verify.error);
  console.log('tunnels:', checks.tunnels.ok ? checks.tunnels.result.map((t) => `${t.name}:${t.status}`) : checks.tunnels.error);
  console.log('idps:', checks.idps.ok ? checks.idps.result.map((i) => `${i.name}:${i.type}:${i.id}`) : checks.idps.error);
  console.log('apps:', checks.apps.ok ? checks.apps.result.map((a) => `${a.name}:${a.domain}`) : checks.apps.error);
  console.log('dns ai record:', checks.dns.ok ? checks.dns.result.map((r) => `${r.type}:${r.content}`) : checks.dns.error);
}

async function create() {
  // 1. Tunnel (remotely managed), reused if it already exists.
  let tunnel = (await cf('GET', `/accounts/${ACCOUNT}/cfd_tunnel?is_deleted=false&name=${TUNNEL_NAME}`))[0];
  if (!tunnel) tunnel = await cf('POST', `/accounts/${ACCOUNT}/cfd_tunnel`, { name: TUNNEL_NAME, config_src: 'cloudflare' });
  console.log('tunnel:', tunnel.id);

  // 2. Ingress: bridges by path, everything else to the gateway, then 404.
  await cf('PUT', `/accounts/${ACCOUNT}/cfd_tunnel/${tunnel.id}/configurations`, {
    config: {
      ingress: [
        { hostname: HOST, path: '^/_bridge/cursor/', service: 'http://127.0.0.1:8319' },
        { hostname: HOST, path: '^/_bridge/foundry/', service: 'http://127.0.0.1:8320' },
        { hostname: HOST, service: 'http://127.0.0.1:8317' },
        { service: 'http_status:404' },
      ],
    },
  });
  console.log('ingress: configured');

  // 3. Access (before DNS, so the console is never reachable unprotected): console + management behind Entra sign-in; /v1 API bypassed
  //    (protected by per-user gateway keys, since harnesses cannot do SSO).
  const idps = await cf('GET', `/accounts/${ACCOUNT}/access/identity_providers`);
  const entra = idps.find((i) => i.type === 'azureAD');
  if (!entra) throw new Error('no Entra (azureAD) identity provider in Zero Trust');
  const apps = await cf('GET', `/accounts/${ACCOUNT}/access/apps`);
  const upsertApp = async (name, domain, policy, extra = {}) => {
    const found = apps.find((a) => a.domain === domain);
    const app = {
      name,
      domain,
      type: 'self_hosted',
      session_duration: '24h',
      allowed_idps: [entra.id],
      auto_redirect_to_identity: true,
      app_launcher_visible: false,
      policies: [policy],
      ...extra,
    };
    const result = found
      ? await cf('PUT', `/accounts/${ACCOUNT}/access/apps/${found.id}`, app)
      : await cf('POST', `/accounts/${ACCOUNT}/access/apps`, app);
    console.log(`access app: ${name} (${domain})`);
    return result;
  };
  await upsertApp('AI gateway console', HOST, {
    name: 'Axel and Dr. Yoo',
    decision: 'allow',
    precedence: 1,
    include: ALLOW.map((email) => ({ email: { email } })),
  });
  await upsertApp(
    'AI gateway API (key auth)',
    `${HOST}/v1`,
    { name: 'API clients use gateway keys', decision: 'bypass', precedence: 1, include: [{ everyone: {} }] },
    { allowed_idps: [], auto_redirect_to_identity: false }
  );

  // 4. DNS: proxied CNAME to the tunnel.
  const target = `${tunnel.id}.cfargotunnel.com`;
  const existing = (await cf('GET', `/zones/${ZONE}/dns_records?name=${HOST}`))[0];
  const record = { type: 'CNAME', name: HOST, content: target, proxied: true, comment: 'CLIProxyAPI gateway on openclaw-vm (Cloudflare Tunnel)' };
  if (!existing) await cf('POST', `/zones/${ZONE}/dns_records`, record);
  else if (existing.content !== target) await cf('PUT', `/zones/${ZONE}/dns_records/${existing.id}`, record);
  console.log('dns:', `${HOST} -> ${target}`);

  // 5. Connector token for cloudflared, written to a private local file only.
  const token = await cf('GET', `/accounts/${ACCOUNT}/cfd_tunnel/${tunnel.id}/token`);
  writeFileSync(process.env.TUNNEL_TOKEN_FILE, typeof token === 'string' ? token : token.token, { mode: 0o600 });
  console.log('tunnel token: written to', process.env.TUNNEL_TOKEN_FILE);
}

const mode = process.argv[2];
if (mode === 'inspect') await inspect();
else if (mode === 'create') await create();
else throw new Error('usage: node cf.mjs <inspect|create>');
