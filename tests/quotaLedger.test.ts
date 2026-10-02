/**
 * Ledger view model: meter normalization, provider totals, and email masking.
 *
 * The totals are summed remaining percent, so the cases that matter are the
 * ones that would silently skew a sum — percent-used vs remaining, an unloaded
 * credential counted as zero, and which window gets the headline.
 */

import { describe, expect, test } from 'bun:test';
import {
  buildLedgerMeters,
  buildLedgerProviderSummary,
  maskEmails,
} from '@/features/quota/ledgerModel';

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const HOUR = 3_600_000;

const claudeQuota = (fiveHourUsed: number, weeklyUsed: number, fableUsed: number) => ({
  status: 'success',
  windows: [
    { id: 'five-hour', label: '5-hour limit', usedPercent: fiveHourUsed, resetAtMs: NOW + 2 * HOUR, periodHours: 5 },
    { id: 'seven-day', label: '7-day limit', usedPercent: weeklyUsed, resetAtMs: NOW + 72 * HOUR, periodHours: 168 },
    { id: 'seven-day-fable', label: '7-day Fable 5', usedPercent: fableUsed, resetAtMs: NOW + 24 * HOUR, periodHours: 168 },
  ],
});

describe('buildLedgerMeters', () => {
  test('converts percent used into percent remaining for Claude and Codex', () => {
    const meters = buildLedgerMeters('claude', claudeQuota(5, 12, 40));
    expect(meters.map((meter) => [meter.id, meter.remaining])).toEqual([
      ['five-hour', 95],
      ['seven-day', 88],
      ['seven-day-fable', 60],
    ]);
  });

  test('reads Antigravity fractions as remaining and Meta resets as seconds', () => {
    const antigravity = buildLedgerMeters('antigravity', {
      status: 'success',
      groups: [{ buckets: [{ id: 'pro', label: 'Pro', remainingFraction: 0.42, resetAtMs: NOW }] }],
    });
    expect(antigravity[0].remaining).toBe(42);

    const meta = buildLedgerMeters('meta', {
      status: 'success',
      data: { windows: [{ id: 'weekly', usedPercent: 25, resetAt: NOW / 1000 }] },
    });
    expect(meta[0]).toMatchObject({ remaining: 75, resetAtMs: NOW, periodHours: 168 });
  });

  test('only the weekly xAI figure is a meter', () => {
    expect(
      buildLedgerMeters('xai', { status: 'success', billing: { periodType: 'monthly', usagePercent: 10 } })
    ).toEqual([]);
    expect(
      buildLedgerMeters('xai', { status: 'success', billing: { periodType: 'weekly', usagePercent: null } })[0]
        .remaining
    ).toBeNull();
  });

  test('unloaded credentials have no meters', () => {
    expect(buildLedgerMeters('claude', { status: 'error', windows: [] })).toEqual([]);
    expect(buildLedgerMeters('claude', undefined)).toEqual([]);
  });
});

describe('buildLedgerProviderSummary', () => {
  test('headlines the most depleted weekly window and sums across accounts', () => {
    const summary = buildLedgerProviderSummary(
      'claude',
      [
        { loaded: true, meters: buildLedgerMeters('claude', claudeQuota(0, 10, 50)) },
        { loaded: true, meters: buildLedgerMeters('claude', claudeQuota(0, 20, 0)) },
      ],
      NOW
    );
    // Fable: 50 + 100 = 150 of 200 (75%) beats 7-day: 90 + 80 = 170 of 200 (85%).
    expect(summary.primary).toMatchObject({
      meterId: 'seven-day-fable',
      total: 150,
      capacity: 200,
      segments: [50, 100],
      soonestResetMs: NOW + 24 * HOUR,
    });
    expect(summary.secondary).toMatchObject({ meterId: 'seven-day', total: 170 });
  });

  test('an unloaded credential counts toward the total but not the capacity', () => {
    const summary = buildLedgerProviderSummary(
      'claude',
      [
        { loaded: true, meters: buildLedgerMeters('claude', claudeQuota(0, 0, 30)) },
        { loaded: false, meters: [] },
      ],
      NOW
    );
    expect(summary.credentialCount).toBe(2);
    expect(summary.loadedCount).toBe(1);
    expect(summary.primary).toMatchObject({ total: 70, capacity: 100, segments: [70] });
  });

  test('nothing loaded yields no headline', () => {
    const summary = buildLedgerProviderSummary('codex', [{ loaded: false, meters: [] }], NOW);
    expect(summary.primary).toBeNull();
    expect(summary.secondary).toBeNull();
  });

  test('past resets are not offered as the next one', () => {
    const quota = claudeQuota(0, 0, 0);
    quota.windows[2].resetAtMs = NOW - HOUR;
    const summary = buildLedgerProviderSummary(
      'claude',
      [{ loaded: true, meters: buildLedgerMeters('claude', quota) }],
      NOW
    );
    expect(summary.primary?.meterId).toBe('seven-day');
    expect(summary.secondary?.soonestResetMs).toBeNull();
  });
});

describe('maskEmails', () => {
  test('keeps the filename prefix, first letters and TLD', () => {
    expect(maskEmails('claude-dd50080c-ada@example.com.json')).toBe(
      'claude-dd50080c-a•••@e•••.com.json'
    );
    expect(maskEmails('xai-ada@example.dev.json')).toBe('xai-a•••@e•••.dev.json');
  });

  test('stops at a plan suffix and handles multi-label domains', () => {
    expect(maskEmails('codex-baa5ac93-ada@example.com-pro.json')).toBe(
      'codex-baa5ac93-a•••@e•••.com-pro.json'
    );
    expect(maskEmails('ada@mail.example.co.uk')).toBe('a•••@m•••.uk');
  });

  test('masks an identity appended to a Devin label and leaves plain names alone', () => {
    expect(maskEmails('devin-1.json · ada.lovelace@example.org')).toBe('devin-1.json · a•••@e•••.org');
    expect(maskEmails('gemini-project-123.json')).toBe('gemini-project-123.json');
  });
});
