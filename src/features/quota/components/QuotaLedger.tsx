/**
 * Ledger view: a provider totals strip above credential rows grouped by provider.
 *
 * Same data and actions as the card grid — refresh, reset, Claude reset grants —
 * laid out so a page of twenty accounts reads as a table rather than a mosaic.
 * Aggregation lives in ledgerModel.ts; this file only renders it.
 */

import { useMemo, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import type {
  AntigravityQuotaState,
  AuthFileItem,
  ClaudeQuotaState,
  CodexQuotaState,
  DevinQuotaState,
  MetaQuotaState,
  ResolvedTheme,
  XaiQuotaState,
} from '@/types';
import { buildResetDisplay, parseIsoToMs, resolveQuotaErrorMessage, resolveResetMs } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { QUOTA_TAB_ORDER } from '../constants';
import {
  buildLedgerMeters,
  buildLedgerProviderSummary,
  type LedgerAggregate,
  type LedgerMeter,
  type LedgerProviderSummary,
} from '../ledgerModel';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import { getCodexPlanLabel } from '../providers/codex/planLabel';
import { QUOTA_PROGRESS_HIGH_THRESHOLD, QUOTA_PROGRESS_MEDIUM_THRESHOLD } from './QuotaMeter';
import styles from './QuotaLedger.module.scss';

/** Meters shown per row; the rest stay on the card view. */
const ROW_METER_LIMIT = 3;

const levelClass = (remaining: number | null): string =>
  remaining === null
    ? styles.levelUnknown
    : remaining >= QUOTA_PROGRESS_HIGH_THRESHOLD
      ? styles.levelHigh
      : remaining >= QUOTA_PROGRESS_MEDIUM_THRESHOLD
        ? styles.levelMedium
        : styles.levelLow;

const formatPercent = (value: number | null) => (value === null ? '--' : `${Math.round(value)}%`);

const meterLabel = (
  t: TFunction,
  meter: Pick<LedgerMeter, 'label' | 'labelKey' | 'labelParams'>
): string => (meter.labelKey ? t(meter.labelKey, meter.labelParams) : meter.label);

/** Plan line under the credential name, per provider; null when nothing is known. */
function resolvePlan(
  t: TFunction,
  provider: QuotaProviderType,
  quota: QuotaCardState | undefined
): string | null {
  if (!quota || quota.status !== 'success') return null;
  switch (provider) {
    case 'claude': {
      const planType = (quota as ClaudeQuotaState).planType;
      return planType ? t(`claude_quota.${planType}`) : null;
    }
    case 'codex':
      return getCodexPlanLabel(t, (quota as CodexQuotaState).planType);
    case 'xai': {
      const billing = (quota as XaiQuotaState).billing;
      if (!billing) return null;
      return billing.planLabel ?? (billing.planType === 'paid' ? t('xai_quota.plan_paid') : null);
    }
    case 'antigravity': {
      const subscription = (quota as AntigravityQuotaState).subscription;
      return subscription?.tierName ?? subscription?.plan ?? null;
    }
    case 'devin':
      return (quota as DevinQuotaState).plan ?? null;
    case 'meta':
      return (quota as MetaQuotaState).data?.planName ?? null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------- reset text */

function ResetLine({ atMs, now }: { atMs: number | null; now: number }) {
  const { t, i18n } = useTranslation();
  const display = atMs !== null && atMs > now
    ? buildResetDisplay(null, atMs, now, i18n.resolvedLanguage)
    : null;
  if (!display) return <span className={styles.resetMuted}>{t('quota_management.ledger_no_reset')}</span>;
  return (
    <span className={styles.reset}>
      {display.relative && <strong className={styles.resetRelative}>{display.relative}</strong>}
      {display.relative && <span aria-hidden="true"> · </span>}
      <span>{display.absolute}</span>
    </span>
  );
}

/* ---------------------------------------------------------- summary strip */

function SegmentBar({ segments }: { segments: (number | null)[] }) {
  return (
    <div className={styles.segments} aria-hidden="true">
      {segments.map((value, index) => (
        <span key={index} className={styles.segment}>
          <span
            className={`${styles.segmentFill} ${levelClass(value)}`}
            style={{ width: `${value ?? 0}%` } as CSSProperties}
          />
        </span>
      ))}
    </div>
  );
}

function SummaryCell(props: {
  summary: LedgerProviderSummary;
  resolvedTheme: ResolvedTheme;
  now: number;
  onSelect: (provider: QuotaProviderType) => void;
}) {
  const { summary, resolvedTheme, now, onSelect } = props;
  const { t } = useTranslation();
  const typeLabel = getTypeLabel(t, summary.provider);
  const iconSrc = getAuthFileIcon(summary.provider, resolvedTheme);
  const primary: LedgerAggregate | null = summary.primary;
  const secondary: LedgerAggregate | null = summary.secondary;

  return (
    <button
      type="button"
      className={styles.summaryCell}
      onClick={() => onSelect(summary.provider)}
      title={t('quota_management.ledger_select_provider', { provider: typeLabel })}
    >
      <span className={styles.summaryHead}>
        <span
          className={styles.icon}
          style={
            isThemeSurfaceIconProvider(summary.provider)
              ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
              : undefined
          }
        >
          {iconSrc ? (
            <img src={iconSrc} alt="" />
          ) : (
            <span className={styles.iconFallback}>{typeLabel.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <span className={styles.summaryName}>{typeLabel}</span>
        <span className={styles.summaryCount}>
          {t('quota_management.ledger_credentials', { count: summary.credentialCount })}
        </span>
      </span>

      {primary ? (
        <>
          <span className={styles.summaryLabel}>{meterLabel(t, primary)}</span>
          <span className={styles.summaryFigure}>
            <span className={styles.summaryTotal}>{formatPercent(primary.total)}</span>
            <span className={styles.summaryCapacity}>
              {t('quota_management.ledger_of_capacity', { capacity: primary.capacity })}
            </span>
          </span>
          <SegmentBar segments={primary.segments} />
          <ResetLine atMs={primary.soonestResetMs} now={now} />
          {secondary && (
            <span className={styles.summaryFooter}>
              <span>{meterLabel(t, secondary)}</span>
              <strong>{formatPercent(secondary.total)}</strong>
            </span>
          )}
        </>
      ) : (
        <>
          <span className={styles.summaryLabel}>
            {summary.loadedCount === 0 ? t('quota_management.ledger_not_loaded') : ' '}
          </span>
          <span className={styles.summaryFigure}>
            <span className={styles.summaryTotal}>--</span>
          </span>
          <SegmentBar segments={Array.from({ length: Math.max(1, summary.credentialCount) }, () => null)} />
        </>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------- rows */

function MeterCell({ meter, now }: { meter: LedgerMeter; now: number }) {
  const { t } = useTranslation();
  return (
    <div className={styles.meter}>
      <div className={styles.meterHead}>
        <span className={styles.meterLabel}>{meterLabel(t, meter)}</span>
        <span className={styles.meterPercent}>{formatPercent(meter.remaining)}</span>
      </div>
      <div className={styles.track}>
        <div
          className={`${styles.trackFill} ${levelClass(meter.remaining)}`}
          style={{ width: `${meter.remaining ?? 0}%` }}
        />
      </div>
      <ResetLine atMs={meter.resetAtMs} now={now} />
    </div>
  );
}

function CodexResetsCell({ quota, now }: { quota: CodexQuotaState; now: number }) {
  const { t, i18n } = useTranslation();
  const available = (quota.rateLimitResetCredits ?? [])
    .filter((credit) => credit.status === 'available')
    .map((credit) => parseIsoToMs(credit.expiresAt))
    .filter((ms): ms is number => ms !== null && ms > now)
    .sort((a, b) => a - b);
  const count = quota.rateLimitResetCreditsAvailableCount ?? available.length;
  const next = available[0] ?? null;
  const display = next === null ? null : buildResetDisplay(null, next, now, i18n.resolvedLanguage);

  return (
    <div className={styles.meter}>
      <span className={styles.meterLabel}>{t('quota_management.ledger_manual_resets')}</span>
      <span className={styles.resetsCount}>
        {t('quota_management.ledger_resets_available', { count })}
      </span>
      {display && (
        <span className={styles.reset}>
          {t('quota_management.ledger_reset_index', { index: 1 })}
          <span aria-hidden="true"> · </span>
          {display.relative && <strong className={styles.resetRelative}>{display.relative}</strong>}
          <span aria-hidden="true"> · </span>
          {display.absolute}
        </span>
      )}
    </div>
  );
}

interface LedgerRowProps {
  entry: QuotaFileEntry;
  quota?: QuotaCardState;
  displayName: string;
  primaryMeterId: string | null;
  canRefresh: boolean;
  resetting: boolean;
  now: number;
  onRefresh: () => void;
  onReset: () => void;
}

function LedgerRow(props: LedgerRowProps) {
  const { entry, quota, displayName, primaryMeterId, canRefresh, resetting, now, onRefresh, onReset } =
    props;
  const { t, i18n } = useTranslation();
  const adapter = QUOTA_ADAPTERS[entry.type];
  const file: AuthFileItem = entry.file;
  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';

  const claudeReset = useClaudeResetGrants(
    file,
    entry.type === 'claude' && status !== 'idle',
    !canRefresh || loading || resetting,
    quota,
    onRefresh
  );

  const meters = useMemo(() => {
    const all = buildLedgerMeters(entry.type, quota);
    // Lead with the meter the provider summary headlines, so columns line up.
    const primaryIndex = all.findIndex((meter) => meter.id === primaryMeterId);
    if (primaryIndex > 0) all.unshift(...all.splice(primaryIndex, 1));
    return all.slice(0, ROW_METER_LIMIT);
  }, [entry.type, quota, primaryMeterId]);

  const plan = resolvePlan(t, entry.type, quota);
  const codexRenewal =
    entry.type === 'codex' && status === 'success'
      ? resolveResetMs([(quota as CodexQuotaState).subscriptionActiveUntil ?? null])
      : null;
  const renewalDisplay =
    codexRenewal === null ? null : buildResetDisplay(null, codexRenewal, now, i18n.resolvedLanguage);
  const showCodexResets =
    entry.type === 'codex' &&
    status === 'success' &&
    ((quota as CodexQuotaState).rateLimitResetCreditsAvailableCount ?? null) !== null;
  const showReset =
    status === 'success' &&
    Boolean(adapter.resetQuota) &&
    quota !== undefined &&
    Boolean(adapter.canResetQuota?.(quota));
  const errorMessage = resolveQuotaErrorMessage(
    t,
    quota?.errorStatus,
    quota?.error || t('common.unknown_error')
  );

  return (
    <div className={styles.row} aria-busy={loading || undefined}>
      <div className={styles.identity}>
        <span className={styles.fileName} title={displayName}>
          {displayName}
        </span>
        {(plan || renewalDisplay || entry.type === 'claude') && (
          <span className={styles.plan}>
            {plan && <strong>{plan}</strong>}
            {renewalDisplay && (
              <span>
                {' · '}
                {t('quota_management.ledger_renews', { date: renewalDisplay.absolute })}
                {renewalDisplay.relative && ` · ${renewalDisplay.relative}`}
              </span>
            )}
            {entry.type === 'claude' && status === 'success' && claudeReset.count !== null && (
              <span>
                {plan ? ' · ' : ''}
                {t('claude_reset.remaining')} {claudeReset.count}
              </span>
            )}
          </span>
        )}
      </div>

      <div className={styles.meters}>
        {status === 'idle' ? (
          <button type="button" className={styles.idle} onClick={onRefresh} disabled={!canRefresh}>
            <IconRefreshCw size={13} aria-hidden="true" />
            {t(`${adapter.i18nPrefix}.idle`)}
          </button>
        ) : loading ? (
          <div className={styles.skeleton}>
            <span className={styles.srOnly}>{t(`${adapter.i18nPrefix}.loading`)}</span>
            {[0, 1, 2].map((index) => (
              <span key={index} className={styles.skeletonBar} aria-hidden="true" />
            ))}
          </div>
        ) : status === 'error' ? (
          <div className={styles.error} role="alert">
            {t(`${adapter.i18nPrefix}.load_failed`, { message: errorMessage })}
          </div>
        ) : meters.length === 0 && !showCodexResets ? (
          <div className={styles.resetMuted}>{t('quota_management.ledger_not_loaded')}</div>
        ) : (
          <>
            {meters.map((meter) => (
              <MeterCell key={meter.id} meter={meter} now={now} />
            ))}
            {showCodexResets && <CodexResetsCell quota={quota as CodexQuotaState} now={now} />}
          </>
        )}
        {claudeReset.message && (
          <div role="status" className={styles.error}>
            {t(`claude_reset.${claudeReset.message}`)}
          </div>
        )}
      </div>

      <div className={styles.actions}>
        {entry.type === 'claude' && status !== 'idle' && (
          <button
            type="button"
            className={styles.action}
            disabled={claudeReset.blocked}
            onClick={claudeReset.confirm}
          >
            <IconRefreshCw size={12} className={claudeReset.busy ? styles.spinning : undefined} />
            {t(`claude_reset.${claudeReset.buttonLabel}`)}
          </button>
        )}
        {showReset && (
          <button
            type="button"
            className={styles.action}
            onClick={onReset}
            disabled={!canRefresh || loading || resetting}
          >
            <IconRefreshCw size={12} className={resetting ? styles.spinning : undefined} />
            {t('codex_quota.reset_button')}
          </button>
        )}
        {status !== 'idle' && (
          <button
            type="button"
            className={styles.action}
            onClick={onRefresh}
            disabled={isQuotaRefreshDisabled(canRefresh, loading, resetting || claudeReset.busy)}
            title={t('auth_files.quota_refresh_hint')}
          >
            <IconRefreshCw size={12} className={loading ? styles.spinning : undefined} />
            {t('auth_files.quota_refresh_single')}
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- page */

export interface QuotaLedgerProps {
  /** Rows on the current page, already filtered and sorted. */
  entries: QuotaFileEntry[];
  /** Every credential in the active tab, for the provider totals. */
  summaryEntries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  displayNameFor: (file: AuthFileItem) => string;
  resolvedTheme: ResolvedTheme;
  canUseActions: boolean;
  resettingQuotaName: string | null;
  onRefresh: (entry: QuotaFileEntry) => void;
  onReset: (entry: QuotaFileEntry) => void;
  onSelectProvider: (provider: QuotaProviderType) => void;
}

export function QuotaLedger(props: QuotaLedgerProps) {
  const {
    entries,
    summaryEntries,
    quotaFor,
    displayNameFor,
    resolvedTheme,
    canUseActions,
    resettingQuotaName,
    onRefresh,
    onReset,
    onSelectProvider,
  } = props;
  const { t } = useTranslation();
  const now = useNow();

  const summaries = useMemo(
    () =>
      QUOTA_TAB_ORDER.map((provider) => {
        const credentials = summaryEntries
          .filter((entry) => entry.type === provider)
          .map((entry) => {
            const quota = quotaFor(entry);
            return {
              loaded: quota?.status === 'success',
              meters: buildLedgerMeters(provider, quota),
            };
          });
        return credentials.length === 0
          ? null
          : buildLedgerProviderSummary(provider, credentials, now);
      }).filter((summary): summary is LedgerProviderSummary => summary !== null),
    [summaryEntries, quotaFor, now]
  );

  const groups = useMemo(
    () =>
      QUOTA_TAB_ORDER.map((provider) => ({
        provider,
        rows: entries.filter((entry) => entry.type === provider),
      })).filter((group) => group.rows.length > 0),
    [entries]
  );

  const primaryByProvider = useMemo(
    () => new Map(summaries.map((summary) => [summary.provider, summary.primary?.meterId ?? null])),
    [summaries]
  );

  return (
    <div className={styles.ledger}>
      {summaries.length > 0 && (
        <section className={styles.summary} aria-label={t('quota_management.ledger_summary_label')}>
          {summaries.map((summary) => (
            <SummaryCell
              key={summary.provider}
              summary={summary}
              resolvedTheme={resolvedTheme}
              now={now}
              onSelect={onSelectProvider}
            />
          ))}
        </section>
      )}

      {groups.map((group) => (
        <section key={group.provider} className={styles.group}>
          <h2 className={styles.groupTitle}>
            {getTypeLabel(t, group.provider)}
            <span className={styles.groupCount}>{group.rows.length}</span>
          </h2>
          <div className={styles.rows}>
            {group.rows.map((entry) => {
              const key = getQuotaCacheKey(entry.file);
              return (
                <LedgerRow
                  key={`${entry.type}:${key}`}
                  entry={entry}
                  quota={quotaFor(entry)}
                  displayName={displayNameFor(entry.file)}
                  primaryMeterId={primaryByProvider.get(group.provider) ?? null}
                  canRefresh={canUseActions && !entry.file.disabled}
                  resetting={resettingQuotaName === key}
                  now={now}
                  onRefresh={() => onRefresh(entry)}
                  onReset={() => onReset(entry)}
                />
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
