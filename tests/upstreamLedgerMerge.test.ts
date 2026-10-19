import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../src/features/quota/components/QuotaCard.tsx', import.meta.url),
  'utf8'
);

describe('upstream quota card integration', () => {
  test('combines retained Claude usage with the Ledger masked label override', () => {
    expect(source).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
    expect(source).toContain("entry.type === 'claude' && hasClaudeUsageData(quota as ClaudeQuotaState | undefined)");
    expect(source).toContain('const displayName = props.displayName ?? getQuotaDisplayName(file);');
    expect(source).toContain('{retainedClaudeUsage && quota && <adapter.Body');
    expect(source).toContain('loading && !retainedClaudeUsage');
  });
});
