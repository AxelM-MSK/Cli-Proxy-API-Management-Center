// Cursor bridge: an OpenAI-compatible endpoint on 127.0.0.1 backed by the official
// Cursor Agent CLI (`agent`), so CLIProxyAPI can route to a Cursor subscription.
//
// Safety model (same as nyanjou/cliproxyapi-cursor-plugin for completions):
// - completions go only through the official CLI; the one exception is GET /quota,
//   which reads the CLI's saved login to make a single read-only call to Cursor's
//   own usage service (DashboardService/GetCurrentPeriodUsage); the token never
//   leaves this process except to api2.cursor.sh;
// - Cursor saves a chat transcript per CLI run; the bridge deletes its own;
// - every request runs in `--mode ask` (read-only; the CLI's sandbox exists only on
//   macOS/Linux) without --force, inside a fresh empty temp workspace that is
//   deleted afterwards;
// - the CLI is spawned directly (no shell), so prompt text is never interpreted;
// - caller tools/images are rejected rather than silently dropped;
// - loopback only, bearer key required, bounded concurrency/time/size.

import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const IS_WINDOWS = process.platform === 'win32';
const HOST = '127.0.0.1';
const PORT = CONFIG.port ?? 8319;
const API_KEY = Buffer.from(String(CONFIG.apiKey ?? ''));
const MAX_BODY = 4 * 1024 * 1024;
// The prompt travels as one argv entry: Windows caps the whole command line at
// 32,767 chars, Linux caps a single argument at 128 KiB.
const MAX_PROMPT = IS_WINDOWS ? 24_000 : 120_000;
const TIMEOUT_MS = (CONFIG.timeoutSeconds ?? 600) * 1000;
const MAX_CONCURRENT = CONFIG.maxConcurrent ?? 2;
const MODEL_TTL_MS = 10 * 60 * 1000;

if (API_KEY.length < 16) throw new Error('config.json apiKey missing or too short');

/* ---------------------------------------------------------------- CLI */

function resolveCli() {
  const root = IS_WINDOWS
    ? join(process.env.LOCALAPPDATA ?? '', 'cursor-agent', 'versions')
    : join(homedir(), '.local', 'share', 'cursor-agent', 'versions');
  const nodeName = IS_WINDOWS ? 'node.exe' : 'node';
  const versions = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => {
      const key = (v) => v.split('-')[0].split('.').map((p) => p.padStart(2, '0')).join('');
      return Number(key(b)) - Number(key(a));
    });
  for (const name of versions) {
    const node = join(root, name, nodeName);
    const index = join(root, name, 'index.js');
    if (existsSync(node) && existsSync(index)) return { node, index };
  }
  throw new Error(`Cursor Agent CLI not found under ${root}`);
}

/** Minimal environment: never forward a CURSOR_API_KEY or unrelated secrets. */
function childEnv() {
  const keep = IS_WINDOWS
    ? ['SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE',
        'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PATH', 'PATHEXT', 'COMSPEC', 'USERNAME',
        'USERDOMAIN', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']
    : ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CONFIG_HOME',
        'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'];
  keep.push('HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY');
  const env = { NO_OPEN_BROWSER: '1', CI: '1', NO_COLOR: '1' };
  for (const name of keep) if (process.env[name] !== undefined) env[name] = process.env[name];
  env.CURSOR_INVOKED_AS = 'agent';
  env.NODE_COMPILE_CACHE = IS_WINDOWS
    ? join(process.env.LOCALAPPDATA ?? '', 'cursor-compile-cache')
    : join(homedir(), '.cache', 'cursor-compile-cache');
  return env;
}

function runCli(args, { cwd, timeoutMs = 60_000, onLine } = {}) {
  const { node, index } = resolveCli();
  let child;
  const done = new Promise((resolve) => {
    child = spawn(node, [index, ...args], {
      cwd: cwd ?? tmpdir(),
      env: childEnv(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let pending = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 8 * 1024 * 1024) stdout += chunk;
      if (!onLine) return;
      pending += chunk;
      let nl;
      while ((nl = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (line) onLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (onLine && pending.trim()) onLine(pending.trim());
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err) });
    });
  });
  done.child = child;
  return done;
}

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/* ------------------------------------------------------------- models */

let modelCache = { at: 0, ids: [] };

async function listModels() {
  if (Date.now() - modelCache.at < MODEL_TTL_MS && modelCache.ids.length) return modelCache.ids;
  const { code, stdout, stderr } = await runCli(['models'], { timeoutMs: 60_000 });
  if (code !== 0) throw new Error(stripAnsi(stderr || stdout).trim() || `agent models exited ${code}`);
  // Lines look like "<id> - <display name>"; keep the id column.
  const ids = stripAnsi(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^([a-z0-9][a-z0-9._:\-[\]=,]*)\s+(-|â€“)\s+/i)?.[1])
    .filter(Boolean);
  if (ids.length) modelCache = { at: Date.now(), ids };
  return ids;
}

/* ------------------------------------------------------------- prompt */

class BadRequest extends Error {}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') return part.text ?? '';
      throw new BadRequest(`unsupported content part "${part?.type}": only text is supported`);
    })
    .join('');
}

/** OpenAI messages -> one bounded text prompt for Cursor ask mode. */
function buildPrompt(body) {
  if (Array.isArray(body.tools) && body.tools.length) throw new BadRequest('tools are not supported by the Cursor bridge');
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages?.length) throw new BadRequest('messages is required');

  const system = messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => textOf(m.content));
  const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (messages.some((m) => m.role === 'tool' || m.tool_calls)) throw new BadRequest('tool messages are not supported');

  let prompt;
  if (turns.length === 1 && system.length === 0) {
    prompt = textOf(turns[0].content);
  } else {
    const parts = [];
    if (system.length) parts.push(`<instructions>\n${system.join('\n\n')}\n</instructions>`);
    const history = turns.slice(0, -1);
    if (history.length) {
      parts.push('<conversation>');
      for (const turn of history) parts.push(`${turn.role === 'user' ? 'User' : 'Assistant'}: ${textOf(turn.content)}`);
      parts.push('</conversation>');
    }
    parts.push(textOf(turns.at(-1)?.content ?? ''));
    prompt = parts.join('\n\n');
  }
  if (!prompt.trim()) throw new BadRequest('empty prompt');
  if (prompt.length > MAX_PROMPT) throw new BadRequest(`prompt too long (${prompt.length} > ${MAX_PROMPT} chars)`);
  return prompt;
}

/* ---------------------------------------------------------- execution */

let active = 0;

/**
 * Run one completion. `onDelta(text)` receives streamed text; resolves with the
 * final text and usage. Event shapes are read defensively: the CLI emits
 * `assistant` events carrying text deltas and a terminal `result` event.
 */
async function complete(model, prompt, onDelta, signal) {
  const workspace = mkdtempSync(join(tmpdir(), 'cursor-bridge-'));
  let streamed = '';
  let finalText = null;
  let usage = null;
  let errorText = null;
  try {
    const args = ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--mode', 'ask',
      '--trust', '--workspace', workspace];
    if (model && model !== 'auto') args.push('--model', model);
    args.push(prompt);

    const run = runCli(args, {
      cwd: workspace,
      timeoutMs: TIMEOUT_MS,
      onLine: (line) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === 'assistant') {
          const text = (event.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
          if (!text) return;
          // Partial events carry deltas; a non-partial repeat of the whole text is skipped.
          if (streamed && text === streamed) return;
          streamed += text;
          onDelta?.(text);
        } else if (event.type === 'result') {
          if (typeof event.result === 'string') finalText = event.result;
          if (event.is_error) errorText = finalText || 'Cursor reported an error';
          usage = event.usage ?? null;
        }
      },
    });
    const abort = () => run.child?.kill();
    signal?.addEventListener('abort', abort, { once: true });
    const { code, stderr } = await run;
    signal?.removeEventListener('abort', abort);
    if (signal?.aborted) throw new Error('client disconnected');
    if (errorText) throw new Error(errorText);
    if (code !== 0 && finalText === null) throw new Error(stripAnsi(stderr).trim() || `agent exited ${code}`);
    return { text: finalText ?? streamed, usage };
  } finally {
    removeLater(workspace);
    forgetChats((cwd) => cwd === workspace);
  }
}

/* ------------------------------------------------------- chat hygiene */

const CURSOR_HOME = join(homedir(), '.cursor');
const BRIDGE_WORKSPACE = /[\\/](cursor-bridge|cb-test)-[^\\/]+$/;

/**
 * Delete the transcripts the CLI saves under ~/.cursor/chats (and the matching
 * ~/.cursor/projects folder) for bridge workspaces. Matching is by the `cwd`
 * recorded in each chat's meta.json, so the user's own Cursor chats, which
 * never run in a bridge temp folder, are left alone.
 */
function forgetChats(matches) {
  const chatsRoot = join(CURSOR_HOME, 'chats');
  let groups = [];
  try {
    groups = readdirSync(chatsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return;
  }
  for (const group of groups) {
    const groupDir = join(chatsRoot, group.name);
    let sessions = [];
    try {
      sessions = readdirSync(groupDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    let removed = 0;
    for (const session of sessions) {
      const sessionDir = join(groupDir, session.name);
      let cwd = null;
      try {
        cwd = JSON.parse(readFileSync(join(sessionDir, 'meta.json'), 'utf8')).cwd ?? null;
      } catch {
        continue;
      }
      if (typeof cwd !== 'string' || !BRIDGE_WORKSPACE.test(cwd) || !matches(cwd)) continue;
      removeLater(sessionDir);
      removed += 1;
      const projectSuffix = `-${basename(cwd)}`;
      try {
        for (const project of readdirSync(join(CURSOR_HOME, 'projects'))) {
          if (project.endsWith(projectSuffix)) removeLater(join(CURSOR_HOME, 'projects', project));
        }
      } catch {
        // no projects folder
      }
    }
    if (removed === sessions.length) removeLater(groupDir);
  }
}

/* -------------------------------------------------------------- quota */

const QUOTA_TTL_MS = 60 * 1000;
let quotaCache = { at: 0, body: null };

function readAccessToken() {
  const candidates = IS_WINDOWS
    ? [join(process.env.APPDATA ?? '', 'Cursor', 'auth.json')]
    : [
        join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'cursor', 'auth.json'),
        join(homedir(), '.cursor', 'auth.json'),
      ];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) throw new Error('Cursor CLI is not signed in');
  const token = JSON.parse(readFileSync(file, 'utf8')).accessToken;
  if (typeof token !== 'string' || !token) throw new Error('Cursor CLI is not signed in');
  return token;
}

async function callDashboard(method) {
  const res = await fetch(`https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${readAccessToken()}`,
      'content-type': 'application/json',
      'connect-protocol-version': '1',
    },
    body: '{}',
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Cursor usage service returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

const num = (value) => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** Normalized quota: percent-used windows that all reset at the billing cycle end. */
async function fetchQuota() {
  if (quotaCache.body && Date.now() - quotaCache.at < QUOTA_TTL_MS) return quotaCache.body;

  let usage;
  try {
    usage = await callDashboard('GetCurrentPeriodUsage');
  } catch (err) {
    // An expired access token: let the CLI refresh its own login, then retry once.
    if (err.status !== 401) throw err;
    await runCli(['status'], { timeoutMs: 30_000 });
    usage = await callDashboard('GetCurrentPeriodUsage');
  }

  const startMs = num(usage.billingCycleStart);
  const endMs = num(usage.billingCycleEnd);
  const periodHours = startMs !== null && endMs !== null ? (endMs - startMs) / 3_600_000 : null;
  const plan = usage.planUsage ?? {};
  const window = (id, label, usedPercent) =>
    num(usedPercent) === null ? null : { id, label, usedPercent: num(usedPercent), resetAtMs: endMs, periodHours };

  let account = {};
  try {
    const about = await runCli(['about', '--format', 'json'], { timeoutMs: 30_000 });
    account = JSON.parse(stripAnsi(about.stdout));
  } catch {
    // plan name is optional
  }

  const body = {
    provider: 'cursor',
    plan: account.subscriptionTier ?? null,
    email: account.userEmail ?? null,
    billingCycleStartMs: startMs,
    billingCycleEndMs: endMs,
    windows: [
      window('total', 'Included usage', plan.totalPercentUsed),
      window('auto', 'Auto + Composer', plan.autoPercentUsed),
      window('api', 'Named models (API)', plan.apiPercentUsed),
    ].filter(Boolean),
    spend: {
      totalCents: num(plan.totalSpend),
      includedCents: num(plan.includedSpend),
      bonusCents: num(plan.bonusSpend),
      limitCents: num(plan.limit),
    },
    fetchedAtMs: Date.now(),
  };
  quotaCache = { at: Date.now(), body };
  return body;
}

/**
 * Windows keeps the folder locked while the CLI's child processes wind down, so
 * cleanup must never fail the request: retry in the background instead.
 */
function removeLater(dir, attempt = 0) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    if (attempt < 10) setTimeout(() => removeLater(dir, attempt + 1), 3000).unref();
  }
}

/* --------------------------------------------------------------- http */

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const errorBody = (message, type = 'invalid_request_error') => ({ error: { message, type } });

function authorized(req) {
  const header = req.headers.authorization ?? '';
  const token = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  return token.length === API_KEY.length && timingSafeEqual(token, API_KEY);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new BadRequest('request body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const usageOf = (usage) =>
  usage
    ? {
        prompt_tokens: usage.inputTokens ?? usage.input_tokens ?? 0,
        completion_tokens: usage.outputTokens ?? usage.output_tokens ?? 0,
        total_tokens:
          (usage.inputTokens ?? usage.input_tokens ?? 0) + (usage.outputTokens ?? usage.output_tokens ?? 0),
      }
    : undefined;

async function handleChat(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return send(res, 400, errorBody(err instanceof BadRequest ? err.message : 'invalid JSON'));
  }
  let prompt;
  try {
    prompt = buildPrompt(body);
  } catch (err) {
    return send(res, 400, errorBody(err.message));
  }
  if (active >= MAX_CONCURRENT) return send(res, 429, errorBody('Cursor bridge is busy', 'rate_limit_error'));

  const model = typeof body.model === 'string' ? body.model : 'auto';
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  active += 1;
  try {
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const chunk = (delta, finish = null, extra = {}) =>
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
      chunk({ role: 'assistant', content: '' });
      try {
        const result = await complete(model, prompt, (text) => chunk({ content: text }), controller.signal);
        chunk({}, 'stop', body.stream_options?.include_usage ? { usage: usageOf(result.usage) } : {});
      } catch (err) {
        res.write(`data: ${JSON.stringify(errorBody(String(err.message ?? err), 'api_error'))}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    } else {
      const result = await complete(model, prompt, null, controller.signal);
      send(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
        usage: usageOf(result.usage),
      });
    }
  } catch (err) {
    if (!res.headersSent) send(res, 502, errorBody(String(err.message ?? err), 'api_error'));
  } finally {
    active -= 1;
  }
}

/** Only the proxy's own console may read /quota from a browser. */
const CORS_ORIGINS = new Set(
  CONFIG.corsOrigins ?? ['http://127.0.0.1:8317', 'http://localhost:8317']
);

const server = createServer(async (req, res) => {
  // Behind the gateway's tunnel the console reaches the bridge same-origin as
  // /_bridge/cursor/*; strip that prefix so both forms route identically.
  const path = (req.url ?? '').split('?')[0].replace(/^\/_bridge\/cursor(?=\/)/, '');
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.has(origin) && path === '/quota') {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET',
        'access-control-allow-headers': 'authorization',
        'access-control-max-age': '600',
      });
      return res.end();
    }
  }
  if (path === '/healthz') return send(res, 200, { ok: true });
  if (!authorized(req)) return send(res, 401, errorBody('unauthorized', 'authentication_error'));
  try {
    if (req.method === 'GET' && path === '/quota') {
      try {
        return send(res, 200, await fetchQuota());
      } catch (err) {
        return send(res, 502, errorBody(String(err.message ?? err), 'api_error'));
      }
    }
    if (req.method === 'GET' && path === '/v1/models') {
      const ids = await listModels();
      return send(res, 200, {
        object: 'list',
        data: ids.map((mid) => ({ id: mid, object: 'model', created: 0, owned_by: 'cursor' })),
      });
    }
    if (req.method === 'POST' && path === '/v1/chat/completions') return await handleChat(req, res);
    send(res, 404, errorBody('not found'));
  } catch (err) {
    if (!res.headersSent) send(res, 502, errorBody(String(err.message ?? err), 'api_error'));
  }
});

// Sweep transcripts left by earlier runs (including ones from before cleanup existed).
forgetChats(() => true);

server.listen(PORT, HOST, () => console.log(`cursor-bridge listening on http://${HOST}:${PORT}`));
