/**
 * Single sign-on through a gateway's access gate.
 *
 * When the console is served by a gateway behind Cloudflare Access, the gate
 * verifies the Microsoft sign-in and injects the real management key into
 * management requests itself. The console then logs in with this placeholder,
 * which never grants anything on its own: without a verified sign-in the gate
 * rejects the request before the backend sees it.
 */

export const GATEWAY_SSO_KEY = 'gateway-sso';

const WHOAMI_PATH = '/_bridge/auth/whoami';

/** Only a remote https origin can be an access-gated gateway. */
export function gatewaySsoUrl(apiBase: string): string | null {
  const base = apiBase.trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) return null;
  if (/^https:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(base)) return null;
  return `${base}${WHOAMI_PATH}`;
}

/** The signed-in email when the gateway vouches for this browser, else null. */
export async function detectGatewaySso(apiBase: string): Promise<string | null> {
  const url = gatewaySsoUrl(apiBase);
  if (!url) return null;
  try {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { gateway?: unknown; email?: unknown };
    return body.gateway === true && typeof body.email === 'string' && body.email ? body.email : null;
  } catch {
    return null;
  }
}
