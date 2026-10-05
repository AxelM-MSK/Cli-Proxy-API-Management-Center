/**
 * Gateway usage page: URL selection and parsing of the access gate's
 * per-person / per-key report.
 */

import { describe, expect, test } from 'bun:test';
import { gatewayUsageUrl, parseGatewayUsage } from '@/features/usage/gatewayUsage';

describe('gatewayUsageUrl', () => {
  test('only a remote https gateway serves the report', () => {
    expect(gatewayUsageUrl('https://ai.example.com/', 7)).toBe(
      'https://ai.example.com/_bridge/usage?days=7'
    );
    expect(gatewayUsageUrl('http://127.0.0.1:8317', 7)).toBeNull();
    expect(gatewayUsageUrl('https://localhost:8317', 7)).toBeNull();
    expect(gatewayUsageUrl('http://ai.example.com', 7)).toBeNull();
    expect(gatewayUsageUrl(undefined, 7)).toBeNull();
  });
});

describe('parseGatewayUsage', () => {
  const payload = {
    days: 7,
    generatedAt: '2026-10-05T12:00:00.000Z',
    users: {
      'a@example.com': {
        requests: 3,
        errors: 1,
        inputTokens: 100,
        cachedInputTokens: 50,
        cacheWriteTokens: 10,
        outputTokens: 40,
        models: { small: 1, big: 2 },
        lastUsed: '2026-10-05T11:00:00.000Z',
        keys: ['sk-msk-u-a-…aaaa'],
      },
      bot: {
        requests: 1,
        inputTokens: 5000,
        outputTokens: 1,
        models: { big: 1 },
        lastUsed: '2026-10-04T11:00:00.000Z',
        keys: ['sk-bot12…bbbb', 42],
      },
    },
    keys: {
      'sk-msk-u-a-…aaaa': {
        owner: 'a@example.com',
        configured: true,
        requests: 3,
        inputTokens: 100,
        cachedInputTokens: 50,
        cacheWriteTokens: 10,
        outputTokens: 40,
        models: { small: 1, big: 2 },
        lastUsed: '2026-10-05T11:00:00.000Z',
      },
      'sk-bot12…bbbb': { owner: 'bot', configured: false, requests: 1, inputTokens: 5000, outputTokens: 1, models: { big: 1 } },
      'sk-idle0…cccc': { owner: null, configured: true, requests: 0, models: {}, lastUsed: null },
    },
  };

  test('sorts people and keys by tokens, models by use', () => {
    const usage = parseGatewayUsage(payload);
    expect(usage.users.map((u) => u.user)).toEqual(['bot', 'a@example.com']);
    expect(usage.users[1].models).toEqual([
      { model: 'big', requests: 2 },
      { model: 'small', requests: 1 },
    ]);
    expect(usage.users[1].totalTokens).toBe(200);
    expect(usage.users[0].keys).toEqual(['sk-bot12…bbbb']);
    expect(usage.keys.map((k) => k.key)).toEqual([
      'sk-bot12…bbbb',
      'sk-msk-u-a-…aaaa',
      'sk-idle0…cccc',
    ]);
  });

  test('keeps key ownership, removed keys and idle keys', () => {
    const usage = parseGatewayUsage(payload);
    const [bot, person, idle] = usage.keys;
    expect(bot).toMatchObject({ owner: 'bot', configured: false });
    expect(person).toMatchObject({ owner: 'a@example.com', configured: true, errors: 0 });
    expect(idle).toMatchObject({ owner: null, configured: true, requests: 0, lastUsedMs: null });
  });

  test('totals come from the person rows', () => {
    const usage = parseGatewayUsage(payload);
    expect(usage.totals).toMatchObject({ requests: 4, errors: 1, totalTokens: 5201 });
    expect(usage.totals.lastUsedMs).toBe(Date.parse('2026-10-05T11:00:00.000Z'));
    expect(usage.generatedAtMs).toBe(Date.parse('2026-10-05T12:00:00.000Z'));
  });

  test('tolerates an empty or malformed payload', () => {
    expect(parseGatewayUsage(null)).toMatchObject({ users: [], keys: [], days: 0 });
    expect(parseGatewayUsage({ users: [], keys: 'x' })).toMatchObject({ users: [], keys: [] });
  });
});
