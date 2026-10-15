/**
 * Access gate, app accounts (tools/ai-gateway/app-accounts.mjs): which model account an Entra
 * caller may reach, decided by the app they use. Pure decisions first, then the running gate
 * against a fake gateway, to prove shadow mode never alters a request and enforce mode rewrites
 * or refuses.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decide,
  loadAppAccounts,
  planRequest,
  resolveApp,
} from '../tools/ai-gateway/app-accounts.mjs';

const BLOCK = {
  appHeader: 'x-msk-app',
  apps: {
    sdn: { role: 'msk.app.sdn', prefixes: ['yoo'] },
    mso: { role: 'msk.app.mso', prefixes: ['mso'], passthrough: ['gpt-*'], websocket: true },
  },
};
const SDN = ['msk.app.sdn'];
const MSO = ['msk.app.mso'];
const BOTH = ['msk.app.sdn', 'msk.app.mso'];
const body = (model: string) => JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] });

describe('loadAppAccounts', () => {
  test('no block is off, so deploying the code alone changes nothing', () => {
    expect(loadAppAccounts(undefined).mode).toBe('off');
    expect(planRequest(loadAppAccounts(undefined), { entra: true, roles: [], bodyText: body('claude-x') })).toEqual({
      action: 'pass',
      log: {},
    });
  });

  test('a block without a mode is shadow', () => {
    expect(loadAppAccounts(BLOCK).mode).toBe('shadow');
  });

  test('rejects a malformed block', () => {
    expect(() => loadAppAccounts({ mode: 'on', apps: BLOCK.apps })).toThrow();
    expect(() => loadAppAccounts({ apps: { sdn: { role: 'r', prefixes: [] } } })).toThrow();
    expect(() => loadAppAccounts({ apps: {} })).toThrow();
  });
});

describe('decide', () => {
  const cfg = loadAppAccounts({ ...BLOCK, mode: 'enforce' });

  test('sdn caller: plain Claude model is held to yoo', () => {
    expect(decide(cfg, { roles: SDN, model: 'claude-opus-4' })).toMatchObject({
      app: 'sdn',
      decision: 'rewrite',
      target: 'yoo/claude-opus-4',
      account: 'yoo',
    });
    expect(decide(cfg, { roles: SDN, model: 'yoo/claude-opus-4' })).toMatchObject({ decision: 'allow', account: 'yoo' });
  });

  test('mso caller: plain Claude model is held to mso; GPT is left to the gateway routing', () => {
    expect(decide(cfg, { roles: MSO, model: 'claude-sonnet-4' })).toMatchObject({
      app: 'mso',
      decision: 'rewrite',
      target: 'mso/claude-sonnet-4',
    });
    expect(decide(cfg, { roles: MSO, model: 'gpt-5' })).toMatchObject({ decision: 'allow', account: 'routed', target: 'gpt-5' });
  });

  test('sdn caller: no GPT models (no fallback to the other account)', () => {
    expect(decide(cfg, { roles: SDN, model: 'gpt-5' }).decision).toBe('refuse');
  });

  test('the other app\'s prefix is refused', () => {
    const d = decide(cfg, { roles: SDN, model: 'mso/claude-opus-4' });
    expect(d.decision).toBe('refuse');
    expect(d.reason).toContain('"mso"');
    expect(decide(cfg, { roles: MSO, model: 'yoo/claude-opus-4' }).decision).toBe('refuse');
  });

  test('a person with both roles: the app header picks the account', () => {
    expect(decide(cfg, { roles: BOTH, headerValue: 'sdn', model: 'claude-x' }).target).toBe('yoo/claude-x');
    expect(decide(cfg, { roles: BOTH, headerValue: 'MSO', model: 'claude-x' }).target).toBe('mso/claude-x');
  });

  test('a person with both roles and no header is refused with a message asking for it', () => {
    const d = decide(cfg, { roles: BOTH, model: 'claude-x' });
    expect(d.decision).toBe('refuse');
    expect(d.reason).toContain('x-msk-app');
  });

  test('no app role is refused; a header for an app the caller does not hold is refused', () => {
    expect(decide(cfg, { roles: [], model: 'claude-x' })).toMatchObject({ decision: 'refuse', app: null });
    expect(resolveApp(cfg, SDN, 'mso').error).toContain('not assigned');
    expect(resolveApp(cfg, SDN, 'other').error).toContain('unknown app');
  });
});

describe('planRequest', () => {
  test('shadow mode passes everything and logs what enforce would do', () => {
    const cfg = loadAppAccounts(BLOCK);
    const rewrite = planRequest(cfg, { entra: true, roles: SDN, bodyText: body('claude-x') });
    expect(rewrite.action).toBe('pass');
    expect(rewrite.body).toBeUndefined();
    expect(rewrite.log).toMatchObject({ app: 'sdn', appMode: 'shadow', appDecision: 'would-rewrite', appAccount: 'yoo', appModel: 'yoo/claude-x' });
    const refuse = planRequest(cfg, { entra: true, roles: [], bodyText: body('claude-x') });
    expect(refuse).toMatchObject({ action: 'pass', log: { app: 'none', appDecision: 'would-refuse' } });
  });

  test('shared-key (non-Entra) callers are unchanged in every mode and logged as legacy', () => {
    for (const mode of ['shadow', 'enforce']) {
      const cfg = loadAppAccounts({ ...BLOCK, mode });
      expect(planRequest(cfg, { entra: false, bodyText: body('mso/claude-x') })).toEqual({ action: 'pass', log: { app: 'legacy' } });
    }
  });

  test('enforce rewrites only the model and refuses with a reason', () => {
    const cfg = loadAppAccounts({ ...BLOCK, mode: 'enforce' });
    const r = planRequest(cfg, { entra: true, roles: MSO, bodyText: body('claude-x') });
    expect(r.action).toBe('rewrite');
    expect(JSON.parse(String(r.body))).toEqual(JSON.parse(body('mso/claude-x')));
    expect(planRequest(cfg, { entra: true, roles: MSO, bodyText: body('yoo/claude-x') })).toMatchObject({ action: 'refuse' });
  });

  test('enforce: websockets only for apps that allow them', () => {
    const cfg = loadAppAccounts({ ...BLOCK, mode: 'enforce' });
    expect(planRequest(cfg, { entra: true, roles: SDN, websocket: true }).action).toBe('refuse');
    expect(planRequest(cfg, { entra: true, roles: MSO, websocket: true }).action).toBe('pass');
  });
});

/* ------------------------------------------------- the running gate against a fake gateway */

type Seen = { path: string; headers: IncomingMessage['headers']; body: string };

const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const TENANT = '00000000-0000-0000-0000-000000000000';
const AUDIENCE = 'api://gateway-test';

function token(key: KeyObject, roles: string[], upn = 'user@example.com') {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const claims = b64u({
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    tid: TENANT,
    aud: AUDIENCE,
    scp: 'gateway.use',
    oid: `oid-${upn}`,
    preferred_username: upn,
    name: upn,
    roles,
    exp: now + 600,
  });
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), key).toString('base64url');
  return `${head}.${claims}.${sig}`;
}

const listen = (s: Server) =>
  new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));

async function startGate(mode: 'shadow' | 'enforce') {
  const dir = mkdtempSync(join(tmpdir(), `gate-${mode}-`));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const seen: Seen[] = [];
  const upstream = createServer((req, res) => {
    let text = '';
    req.on('data', (d) => (text += d));
    req.on('end', () => {
      const path = req.url ?? '/';
      if (path.startsWith('/v0/management/api-keys')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ 'api-keys': ['sk-existing-key-0000'] }));
      }
      if (path === '/v1/models') return res.writeHead(200).end('{}');
      seen.push({ path, headers: req.headers, body: text });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 2 } }));
    });
  });
  const jwks = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig' }] }));
  });
  const upPort = await listen(upstream);
  const jwksPort = await listen(jwks);
  const probe = createServer();
  const gatePort = await listen(probe);
  await new Promise((r) => probe.close(r));
  writeFileSync(join(dir, 'mgmt.key'), 'test-management-key');
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      port: gatePort,
      upstreamPorts: { gateway: upPort },
      teamDomain: 'https://team.example.com',
      aud: 'console-aud',
      allowedEmails: ['user@example.com'],
      managementKeyFile: join(dir, 'mgmt.key'),
      quotaStateFile: join(dir, 'quota.json'),
      entra: {
        tenantId: TENANT,
        audience: AUDIENCE,
        scope: 'gateway.use',
        allowedUsers: ['*'],
        userKeysFile: join(dir, 'user-keys.json'),
        usageDir: join(dir, 'usage'),
        jwksUri: `http://127.0.0.1:${jwksPort}/keys`,
      },
      appAccounts: { ...BLOCK, mode },
    })
  );
  const child: ChildProcess = spawn('node', [join(import.meta.dir, '../tools/ai-gateway/access-gate.mjs')], {
    env: { ...process.env, GATE_CONFIG: join(dir, 'config.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('gate did not start')), 10_000);
    child.stdout?.on('data', (d) => String(d).includes('listening') && (clearTimeout(t), resolve()));
    child.on('exit', (c) => reject(new Error(`gate exited ${c}`)));
  });
  const call = async (bodyText: string, opts: { roles?: string[]; app?: string; key?: string } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    headers.authorization = `Bearer ${opts.key ?? token(privateKey, opts.roles ?? [])}`;
    if (opts.app) headers['x-msk-app'] = opts.app;
    const r = await fetch(`http://127.0.0.1:${gatePort}/v1/messages`, { method: 'POST', headers, body: bodyText });
    return { status: r.status, json: await r.json() };
  };
  const usage = async () => {
    await new Promise((r) => setTimeout(r, 100));
    const d = join(dir, 'usage');
    return readdirSync(d).flatMap((f) => readFileSync(join(d, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
  };
  const stop = () => {
    child.kill();
    upstream.close();
    jwks.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { call, seen, usage, stop };
}

describe('access gate, shadow mode', () => {
  let gate: Awaited<ReturnType<typeof startGate>>;
  beforeAll(async () => {
    gate = await startGate('shadow');
  });
  afterAll(() => gate?.stop());

  test('never alters the request, and logs the decision', async () => {
    const cases = [
      { roles: SDN, model: 'claude-x' },
      { roles: MSO, model: 'yoo/claude-x' },
      { roles: BOTH, model: 'claude-x' },
      { roles: [], model: 'claude-x' },
    ];
    for (const c of cases) {
      const sent = body(c.model);
      const r = await gate.call(sent, { roles: c.roles });
      expect(r.status).toBe(200);
      expect(gate.seen.at(-1)?.body).toBe(sent);
    }
    const log = await gate.usage();
    expect(log.map((l) => [l.model, l.app, l.appDecision, l.appAccount])).toEqual([
      ['claude-x', 'sdn', 'would-rewrite', 'yoo'],
      ['yoo/claude-x', 'mso', 'would-refuse', null],
      ['claude-x', 'none', 'would-refuse', null],
      ['claude-x', 'none', 'would-refuse', null],
    ]);
    expect(log[2].appReason).toContain('x-msk-app');
    expect(log.every((l) => l.user === 'user@example.com' && l.inputTokens === 3)).toBe(true);
  });

  test('shared-key callers pass untouched and are logged as legacy', async () => {
    const sent = body('mso/claude-x');
    const r = await gate.call(sent, { key: 'sk-shared-bot-key-1234' });
    expect(r.status).toBe(200);
    expect(gate.seen.at(-1)?.body).toBe(sent);
    expect((await gate.usage()).at(-1)).toMatchObject({ app: 'legacy', model: 'mso/claude-x' });
  });
});

describe('access gate, enforce mode', () => {
  let gate: Awaited<ReturnType<typeof startGate>>;
  beforeAll(async () => {
    gate = await startGate('enforce');
  });
  afterAll(() => gate?.stop());

  test('sdn caller is rewritten to yoo, mso caller to mso', async () => {
    expect((await gate.call(body('claude-x'), { roles: SDN })).status).toBe(200);
    expect(JSON.parse(gate.seen.at(-1)!.body).model).toBe('yoo/claude-x');
    expect(gate.seen.at(-1)!.headers['content-length']).toBe(String(Buffer.byteLength(gate.seen.at(-1)!.body)));
    expect((await gate.call(body('claude-x'), { roles: MSO })).status).toBe(200);
    expect(JSON.parse(gate.seen.at(-1)!.body).model).toBe('mso/claude-x');
  });

  test('dual-role caller: header picks; no header is refused asking for it', async () => {
    expect((await gate.call(body('claude-x'), { roles: BOTH, app: 'sdn' })).status).toBe(200);
    expect(JSON.parse(gate.seen.at(-1)!.body).model).toBe('yoo/claude-x');
    const before = gate.seen.length;
    const r = await gate.call(body('claude-x'), { roles: BOTH });
    expect(r.status).toBe(403);
    expect(r.json.error).toContain('x-msk-app');
    expect(gate.seen.length).toBe(before);
  });

  test('other app prefix and no role are refused with 403 JSON', async () => {
    const before = gate.seen.length;
    const other = await gate.call(body('mso/claude-x'), { roles: SDN });
    expect(other.status).toBe(403);
    expect(other.json.error).toContain('not available in the sdn app');
    expect((await gate.call(body('claude-x'), { roles: [] })).status).toBe(403);
    expect(gate.seen.length).toBe(before);
    expect((await gate.usage()).filter((l) => l.status === 403).map((l) => l.appDecision)).toEqual([
      'refuse',
      'refuse',
      'refuse',
    ]);
  });

  test('shared-key callers are unchanged', async () => {
    const sent = body('yoo/claude-x');
    expect((await gate.call(sent, { key: 'sk-shared-bot-key-1234' })).status).toBe(200);
    expect(gate.seen.at(-1)?.body).toBe(sent);
  });
});
