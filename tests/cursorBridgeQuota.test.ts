/**
 * Cursor bridge quota: discovery from the proxy config and payload parsing.
 *
 * Discovery is the security-relevant part: the bridge key is read from the
 * proxy config and sent with the quota request, so only a loopback provider
 * named "cursor" may be used.
 */

import { describe, expect, test } from 'bun:test';
import {
  findCursorBridge,
  parseCursorQuota,
  pickCursorHeadline,
} from '@/features/quota/cursorBridge';
import type { OpenAIProviderConfig } from '@/types';

const provider = (overrides: Partial<OpenAIProviderConfig>): OpenAIProviderConfig => ({
  name: 'cursor',
  baseUrl: 'http://127.0.0.1:8319/v1',
  apiKeyEntries: [{ apiKey: 'sk-cursor-test' }],
  ...overrides,
});

describe('findCursorBridge', () => {
  test('derives the quota URL from a loopback cursor provider', () => {
    expect(findCursorBridge([provider({})])).toEqual({
      quotaUrl: 'http://127.0.0.1:8319/quota',
      apiKey: 'sk-cursor-test',
    });
    expect(findCursorBridge([provider({ baseUrl: 'http://localhost:9000/v1/' })])?.quotaUrl).toBe(
      'http://localhost:9000/quota'
    );
  });

  test('never targets a remote, disabled, keyless or differently named provider', () => {
    expect(findCursorBridge([provider({ baseUrl: 'https://example.com/v1' })])).toBeNull();
    expect(findCursorBridge([provider({ baseUrl: 'http://127.0.0.1.evil.test/v1' })])).toBeNull();
    expect(findCursorBridge([provider({ disabled: true })])).toBeNull();
    expect(findCursorBridge([provider({ apiKeyEntries: [] })])).toBeNull();
    expect(findCursorBridge([provider({ name: 'openrouter' })])).toBeNull();
    expect(findCursorBridge(undefined)).toBeNull();
  });
});

describe('parseCursorQuota', () => {
  const payload = {
    plan: 'Ultra',
    email: 'ada@example.com',
    windows: [
      { id: 'total', label: 'Included usage', usedPercent: 41.3, resetAtMs: 1000, periodHours: 720 },
      { id: 'api', label: 'Named models (API)', usedPercent: 54.5, resetAtMs: 1000, periodHours: 720 },
      { id: 'broken', label: 'No reading', usedPercent: 'n/a' },
    ],
    spend: { totalCents: 139293, includedCents: 40000, bonusCents: 99293 },
    fetchedAtMs: 5,
  };

  test('turns percent used into remaining and keeps unreadable windows as unknown', () => {
    const quota = parseCursorQuota(payload);
    expect(quota.plan).toBe('Ultra');
    expect(quota.meters.map((meter) => [meter.id, meter.remaining])).toEqual([
      ['total', 58.7],
      ['api', 45.5],
      ['broken', null],
    ]);
    expect(quota.spend.totalCents).toBe(139293);
  });

  test('headlines the most depleted window', () => {
    expect(pickCursorHeadline(parseCursorQuota(payload).meters)?.id).toBe('api');
  });

  test('tolerates an empty or malformed payload', () => {
    expect(parseCursorQuota(null)).toMatchObject({ plan: null, meters: [] });
    expect(parseCursorQuota({ windows: 'nope' }).meters).toEqual([]);
  });
});
