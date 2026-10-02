import type { TFunction } from 'i18next';
import { normalizePlanType, PREMIUM_CODEX_PLAN_TYPES } from '@/utils/quota';

/** Display label for a Codex plan type; shared by the card body and the ledger row. */
export function getCodexPlanLabel(t: TFunction, planType?: string | null): string | null {
  const normalized = normalizePlanType(planType);
  if (!normalized) return null;
  if (normalized === 'self_serve_business_prolite') {
    return t('codex_quota.plan_business_premium');
  }
  if (normalized === 'pro') return t('codex_quota.plan_pro');
  if (PREMIUM_CODEX_PLAN_TYPES.has(normalized) && normalized !== 'pro') {
    return t('codex_quota.plan_prolite');
  }
  if (normalized === 'plus') return t('codex_quota.plan_plus');
  if (normalized === 'team') return t('codex_quota.plan_team');
  if (normalized === 'free') return t('codex_quota.plan_free');
  return planType || normalized;
}
