// app-accounts: which model account an Entra caller may reach, decided by the app they use.
//
// Config (access-gate config.json), all generic:
//
//   "appAccounts": {
//     "mode": "shadow",              // "shadow" (default when the block exists) | "enforce" | "off"
//     "appHeader": "x-msk-app",      // header naming the app, for callers who hold several app roles
//     "rewriteModels": ["claude-*"], // plain model ids the prefixed accounts serve (default claude-*)
//     "apps": {
//       "sdn": { "role": "msk.app.sdn", "prefixes": ["yoo"] },
//       "mso": { "role": "msk.app.mso", "prefixes": ["mso"], "passthrough": ["gpt-*", "codex-*"], "websocket": true }
//     }
//   }
//
// `passthrough`: model ids left to the gateway's own routing (e.g. GPT models on the Codex account).
// `websocket`: the app may open /v1 WebSocket sessions (the Responses API websocket), whose model
// the gate cannot see or rewrite; default false.
//
// No block means mode "off": deploying the code alone changes nothing. Pure logic only; the gate
// (access-gate.mjs) reads the body, logs the decision, and in enforce mode rewrites or refuses.

export const MODES = ['off', 'shadow', 'enforce'];

const globRe = (pattern) =>
  new RegExp(`^${String(pattern).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');

const matchesAny = (patterns, model) => patterns.some((re) => re.test(model));

/** Normalize and validate the `appAccounts` block. Throws on a malformed block. */
export function loadAppAccounts(raw) {
  if (raw == null) return { mode: 'off', header: 'x-msk-app', apps: {}, prefixes: new Set() };
  if (typeof raw !== 'object') throw new Error('appAccounts must be an object');
  const mode = raw.mode ?? 'shadow';
  if (!MODES.includes(mode)) throw new Error(`appAccounts.mode must be one of ${MODES.join(', ')}`);
  const header = String(raw.appHeader ?? 'x-msk-app').toLowerCase();
  const rewriteDefault = Array.isArray(raw.rewriteModels) ? raw.rewriteModels : ['claude-*'];
  const apps = {};
  const prefixes = new Set();
  for (const [name, a] of Object.entries(raw.apps ?? {})) {
    if (!a || typeof a.role !== 'string' || !a.role) throw new Error(`appAccounts.apps.${name}.role missing`);
    if (!Array.isArray(a.prefixes) || !a.prefixes.length || a.prefixes.some((p) => typeof p !== 'string' || !p || p.includes('/'))) {
      throw new Error(`appAccounts.apps.${name}.prefixes must be a non-empty list of account prefixes`);
    }
    apps[name.toLowerCase()] = {
      name: name.toLowerCase(),
      role: a.role,
      prefixes: a.prefixes.map((p) => p.toLowerCase()),
      rewrite: (Array.isArray(a.rewriteModels) ? a.rewriteModels : rewriteDefault).map(globRe),
      passthrough: (Array.isArray(a.passthrough) ? a.passthrough : []).map(globRe),
      websocket: a.websocket === true,
    };
    for (const p of apps[name.toLowerCase()].prefixes) prefixes.add(p);
  }
  if (mode !== 'off' && !Object.keys(apps).length) throw new Error('appAccounts.apps is empty');
  return { mode, header, apps, prefixes };
}

/**
 * Which app this request is for. `roles` = the token's `roles` claim, `headerValue` = the app header.
 * Returns { app } or { error } (the refusal message).
 */
export function resolveApp(cfg, roles, headerValue) {
  const held = Object.values(cfg.apps).filter((a) => Array.isArray(roles) && roles.includes(a.role));
  const asked = typeof headerValue === 'string' ? headerValue.trim().toLowerCase() : '';
  if (asked) {
    const app = cfg.apps[asked];
    if (!app) return { error: `unknown app "${asked}" in ${cfg.header}` };
    if (!held.includes(app)) return { error: `you are not assigned the ${app.name} app (role ${app.role})` };
    return { app };
  }
  if (held.length === 1) return { app: held[0] };
  if (!held.length) return { error: 'you hold no app role for the gateway; ask an admin to assign you an app' };
  return { error: `you hold more than one app role (${held.map((a) => a.name).join(', ')}); send the ${cfg.header} header naming the app` };
}

/**
 * The decision for one request.
 * Returns { app, decision: 'allow'|'rewrite'|'refuse', model, target, account, reason? }:
 * `target` is the model id the request should carry; `account` the prefix it is held to
 * ('routed' when the gateway's own routing picks, e.g. Codex for GPT models).
 */
export function decide(cfg, { roles, headerValue, model }) {
  const r = resolveApp(cfg, roles, headerValue);
  const base = { app: r.app?.name ?? null, model: model ?? null, target: model ?? null, account: null };
  if (r.error) return { ...base, decision: 'refuse', reason: r.error };
  const app = r.app;
  if (!model) return { ...base, decision: 'allow' };
  const slash = model.indexOf('/');
  const prefix = slash > 0 ? model.slice(0, slash).toLowerCase() : null;
  if (prefix && cfg.prefixes.has(prefix)) {
    if (app.prefixes.includes(prefix)) return { ...base, decision: 'allow', account: prefix };
    return { ...base, decision: 'refuse', reason: `model account "${prefix}" is not available in the ${app.name} app` };
  }
  if (matchesAny(app.passthrough, model)) return { ...base, decision: 'allow', account: 'routed' };
  if (!prefix && matchesAny(app.rewrite, model)) {
    const account = app.prefixes[0];
    return { ...base, decision: 'rewrite', target: `${account}/${model}`, account };
  }
  return { ...base, decision: 'refuse', reason: `model "${model}" is not available in the ${app.name} app` };
}

/** Log fields for the usage record. Shadow mode marks what enforce would have done. */
export function logFields(cfg, d) {
  if (cfg.mode === 'off') return {};
  if (!d) return { app: 'legacy' };
  const label = cfg.mode === 'shadow' && d.decision !== 'allow' ? `would-${d.decision}` : d.decision;
  return {
    app: d.app ?? 'none',
    appMode: cfg.mode,
    appDecision: label,
    appAccount: d.account,
    appModel: d.target,
    ...(d.reason ? { appReason: d.reason } : {}),
  };
}

/**
 * Enforce mode only: the body to forward for a JSON request. Always re-serialized so the gate and
 * the gateway see the same single `model` key. Returns { body } or { refuse } or { pass: true }
 * (no JSON object body; nothing to rewrite).
 */
export function enforceBody(cfg, d, raw) {
  if (d.decision === 'refuse') return { refuse: d.reason };
  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { return { pass: true }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { pass: true };
  if (d.decision === 'rewrite') parsed.model = d.target;
  return { body: Buffer.from(JSON.stringify(parsed), 'utf8') };
}

/** The model id in a request body (first 64 KB is enough), or null. */
export function bodyModel(text) {
  const s = String(text ?? '');
  try {
    const m = JSON.parse(s)?.model;
    if (typeof m === 'string') return m;
  } catch {}
  return s.match(/"model"\s*:\s*"([^"]+)"/)?.[1] ?? null;
}

/**
 * The whole per-request plan for an Entra caller's /v1 request (legacy key callers: entra=false).
 * Returns { action: 'pass'|'rewrite'|'refuse', log, body?, message? }. Only enforce mode ever
 * returns 'rewrite' or 'refuse'; shadow and off always 'pass' with the request untouched.
 * `bodyText` is the request body (a Buffer or string; may be empty).
 */
export function planRequest(cfg, { entra, roles, headerValue, bodyText, websocket = false }) {
  if (cfg.mode === 'off') return { action: 'pass', log: {} };
  if (!entra) return { action: 'pass', log: logFields(cfg, null) };
  let d;
  if (websocket) {
    const r = resolveApp(cfg, roles, headerValue);
    d = { app: r.app?.name ?? null, model: null, target: null, account: null, decision: 'allow' };
    if (r.error) Object.assign(d, { decision: 'refuse', reason: r.error });
    else if (!r.app.websocket) Object.assign(d, { decision: 'refuse', reason: `websocket sessions are not available in the ${r.app.name} app` });
  } else {
    d = decide(cfg, { roles, headerValue, model: bodyModel(bodyText) });
  }
  const log = logFields(cfg, d);
  if (cfg.mode !== 'enforce') return { action: 'pass', log };
  if (d.decision === 'refuse') return { action: 'refuse', log, message: d.reason };
  if (d.decision === 'rewrite') {
    const out = enforceBody(cfg, d, Buffer.from(bodyText ?? ''));
    if (out.body) return { action: 'rewrite', log, body: out.body };
    // A model was named but the body is not a JSON object we can rewrite: do not let it through
    // unpinned.
    return { action: 'refuse', log: { ...log, appDecision: 'refuse' }, message: 'request body must be a JSON object to apply the app account' };
  }
  return { action: 'pass', log };
}
