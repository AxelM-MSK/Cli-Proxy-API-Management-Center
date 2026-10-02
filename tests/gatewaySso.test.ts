/**
 * Gateway single sign-on: only a remote https gateway that vouches for the
 * browser triggers the placeholder-key login.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { detectGatewaySso, gatewaySsoUrl } from '@/utils/gatewaySso';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const respond = (status: number, body: unknown) => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
};

describe('gatewaySsoUrl', () => {
  test('is only offered for remote https origins', () => {
    expect(gatewaySsoUrl('https://ai.example.com/')).toBe('https://ai.example.com/_bridge/auth/whoami');
    expect(gatewaySsoUrl('http://127.0.0.1:8317')).toBeNull();
    expect(gatewaySsoUrl('https://localhost:8317')).toBeNull();
    expect(gatewaySsoUrl('http://ai.example.com')).toBeNull();
  });
});

describe('detectGatewaySso', () => {
  test('returns the email the gateway vouches for', async () => {
    respond(200, { gateway: true, email: 'ada@example.com' });
    expect(await detectGatewaySso('https://ai.example.com')).toBe('ada@example.com');
  });

  test('ignores unsigned, non-gateway and failing responses', async () => {
    respond(401, { error: 'sign in' });
    expect(await detectGatewaySso('https://ai.example.com')).toBeNull();
    respond(200, { gateway: false, email: 'ada@example.com' });
    expect(await detectGatewaySso('https://ai.example.com')).toBeNull();
    respond(200, { gateway: true });
    expect(await detectGatewaySso('https://ai.example.com')).toBeNull();
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await detectGatewaySso('https://ai.example.com')).toBeNull();
  });

  test('never calls out for a local desktop proxy', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    expect(await detectGatewaySso('http://127.0.0.1:8317')).toBeNull();
    expect(called).toBe(false);
  });
});
