/**
 * Foundry usage sidecar: URL selection and payload parsing, plus the Cursor
 * bridge's switch to the gateway route when the console is remote.
 */

import { describe, expect, test } from 'bun:test';
import {
  compactNumber,
  foundryUsageUrl,
  parseFoundryUsage,
} from '@/features/quota/foundryUsage';
import { findCursorBridge } from '@/features/quota/cursorBridge';
import type { OpenAIProviderConfig } from '@/types';

describe('foundryUsageUrl', () => {
  test('only a remote https gateway serves the sidecar', () => {
    expect(foundryUsageUrl('https://ai.example.com/')).toBe(
      'https://ai.example.com/_bridge/foundry/usage'
    );
    expect(foundryUsageUrl('http://127.0.0.1:8317')).toBeNull();
    expect(foundryUsageUrl('https://localhost:8317')).toBeNull();
    expect(foundryUsageUrl('http://ai.example.com')).toBeNull();
    expect(foundryUsageUrl(undefined)).toBeNull();
  });
});

describe('parseFoundryUsage', () => {
  const payload = {
    account: 'mskmso-foundry',
    periodStartMs: 1,
    deployments: [
      { deployment: 'small', inputTokens: 10, outputTokens: 5, requests: 2, last24h: { requests: 1, inputTokens: 3, outputTokens: 1 } },
      { deployment: 'big', inputTokens: 1000, outputTokens: 50, requests: 9, last24h: {} },
    ],
    cost: { total: 17.59, currency: 'USD', meters: [] },
  };

  test('sorts by tokens and totals across deployments', () => {
    const usage = parseFoundryUsage(payload);
    expect(usage.deployments.map((d) => d.deployment)).toEqual(['big', 'small']);
    expect(usage.deployments[1]).toMatchObject({ last24hRequests: 1, last24hTokens: 4 });
    expect(usage.totals).toEqual({ inputTokens: 1010, outputTokens: 55, requests: 11 });
    expect(usage.cost).toEqual({ total: 17.59, currency: 'USD', stale: false });
  });

  test('surfaces a cost error instead of a zero cost', () => {
    const usage = parseFoundryUsage({ ...payload, cost: { error: 'ARM 429' } });
    expect(usage.cost).toBeNull();
    expect(usage.costError).toBe('ARM 429');
  });

  test('tolerates malformed payloads', () => {
    expect(parseFoundryUsage(null)).toMatchObject({ deployments: [], cost: null });
  });
});

describe('compactNumber', () => {
  test('formats token counts', () => {
    expect(compactNumber(11_602_296)).toBe('11.6M');
    expect(compactNumber(823_632)).toBe('824K');
    expect(compactNumber(1_500)).toBe('1.5K');
    expect(compactNumber(42)).toBe('42');
  });
});

describe('findCursorBridge behind a gateway', () => {
  const providers: OpenAIProviderConfig[] = [
    { name: 'cursor', baseUrl: 'http://127.0.0.1:8319/v1', apiKeyEntries: [{ apiKey: 'k' }] },
  ];

  test('routes through the gateway when the console is remote', () => {
    expect(findCursorBridge(providers, 'https://ai.example.com')?.quotaUrl).toBe(
      'https://ai.example.com/_bridge/cursor/quota'
    );
  });

  test('talks to the bridge directly when the console is local', () => {
    expect(findCursorBridge(providers, 'http://127.0.0.1:8317')?.quotaUrl).toBe(
      'http://127.0.0.1:8319/quota'
    );
  });
});
