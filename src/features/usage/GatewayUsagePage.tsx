import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconRefreshCw } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { formatDateTimeValue } from '@/utils/format';
import { compactNumber } from '@/features/quota/foundryUsage';
import {
  GATEWAY_USAGE_DAY_OPTIONS,
  type GatewayUsage,
  type UsageTotals,
} from './gatewayUsage';
import { useGatewayUsage } from './useGatewayUsage';
import styles from './GatewayUsagePage.module.scss';

const DEFAULT_DAYS = 7;

function ModelsCell({ totals }: { totals: UsageTotals }) {
  const top = totals.models.slice(0, 3);
  const rest = totals.models.length - top.length;
  return (
    <span className={styles.models}>
      {top.map((m) => `${m.model} ×${m.requests}`).join(', ')}
      {rest > 0 ? ` +${rest}` : ''}
    </span>
  );
}

function TotalsCells({ totals }: { totals: UsageTotals }) {
  const { t, i18n } = useTranslation();
  return (
    <>
      <td className={styles.numeric}>
        {compactNumber(totals.requests)}
        {totals.errors > 0 && (
          <span className={styles.errors}>
            {' '}
            {t('gateway_usage.errors', { count: totals.errors })}
          </span>
        )}
      </td>
      <td className={styles.numeric}>{compactNumber(totals.inputTokens)}</td>
      <td className={styles.numeric}>{compactNumber(totals.cachedInputTokens)}</td>
      <td className={styles.numeric}>{compactNumber(totals.cacheWriteTokens)}</td>
      <td className={styles.numeric}>{compactNumber(totals.outputTokens)}</td>
      <td className={`${styles.numeric} ${styles.strong}`}>{compactNumber(totals.totalTokens)}</td>
      <td><ModelsCell totals={totals} /></td>
      <td className={styles.muted}>
        {totals.lastUsedMs === null
          ? t('gateway_usage.never')
          : formatDateTimeValue(totals.lastUsedMs, i18n.language)}
      </td>
    </>
  );
}

function TotalsHeads() {
  const { t } = useTranslation();
  return (
    <>
      <th className={styles.numeric}>{t('gateway_usage.col_requests')}</th>
      <th className={styles.numeric}>{t('gateway_usage.col_input')}</th>
      <th className={styles.numeric}>{t('gateway_usage.col_cached')}</th>
      <th className={styles.numeric}>{t('gateway_usage.col_cache_write')}</th>
      <th className={styles.numeric}>{t('gateway_usage.col_output')}</th>
      <th className={styles.numeric}>{t('gateway_usage.col_total')}</th>
      <th>{t('gateway_usage.col_models')}</th>
      <th>{t('gateway_usage.col_last_used')}</th>
    </>
  );
}

function UsageTable({
  children,
}: {
  children: ReactNode;
}) {
  return <div className={styles.tableWrap}><table className={styles.table}>{children}</table></div>;
}

function UsageTables({ data }: { data: GatewayUsage }) {
  const { t } = useTranslation();
  return (
    <>
      <section className={styles.section} aria-labelledby="gateway-usage-users">
        <h2 id="gateway-usage-users" className={styles.sectionTitle}>
          {t('gateway_usage.by_user')}<span className={styles.count}>{data.users.length}</span>
        </h2>
        {data.users.length === 0 ? <EmptyState title={t('gateway_usage.empty')} /> : (
          <UsageTable>
            <thead><tr><th>{t('gateway_usage.col_user')}</th><th>{t('gateway_usage.col_keys')}</th><TotalsHeads /></tr></thead>
            <tbody>{data.users.map((row) => (
              <tr key={row.user}>
                <td className={styles.strong}>{row.user}</td>
                <td className={styles.mono}>{row.keys.join(', ')}</td>
                <TotalsCells totals={row} />
              </tr>
            ))}</tbody>
          </UsageTable>
        )}
      </section>

      <section className={styles.section} aria-labelledby="gateway-usage-keys">
        <h2 id="gateway-usage-keys" className={styles.sectionTitle}>
          {t('gateway_usage.by_key')}<span className={styles.count}>{data.keys.length}</span>
        </h2>
        {data.keys.length === 0 ? <EmptyState title={t('gateway_usage.empty')} /> : (
          <UsageTable>
            <thead><tr><th>{t('gateway_usage.col_key')}</th><th>{t('gateway_usage.col_owner')}</th><TotalsHeads /></tr></thead>
            <tbody>{data.keys.map((row) => (
              <tr key={row.key}>
                <td className={styles.mono}>
                  {row.key}
                  {!row.configured && <span className={styles.tag}>{t('gateway_usage.key_removed')}</span>}
                </td>
                <td>{row.owner ?? t('gateway_usage.owner_unknown')}</td>
                <TotalsCells totals={row} />
              </tr>
            ))}</tbody>
          </UsageTable>
        )}
      </section>
    </>
  );
}

export function GatewayUsagePage() {
  const { t, i18n } = useTranslation();
  const [days, setDays] = useState(DEFAULT_DAYS);
  const { state, refresh } = useGatewayUsage(days);
  useHeaderRefresh(refresh);

  const data = state.status === 'absent' ? null : state.data;
  const loading = state.status === 'loading';
  const dayOptions = useMemo(
    () => GATEWAY_USAGE_DAY_OPTIONS.map((d) => ({
      value: String(d), label: t('gateway_usage.days_option', { count: d }),
    })),
    [t]
  );

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div><h1 className={styles.pageTitle}>{t('gateway_usage.title')}</h1><p className={styles.subtitle}>{t('gateway_usage.subtitle')}</p></div>
        <div className={styles.controls}>
          <Select value={String(days)} options={dayOptions} onChange={(value) => setDays(Number(value))} ariaLabel={t('gateway_usage.days_label')} size="sm" />
          <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading}>
            <IconRefreshCw size={14} className={loading ? styles.spinning : undefined} />{t('gateway_usage.refresh')}
          </Button>
        </div>
      </div>
      {state.status === 'absent' && <EmptyState title={t('gateway_usage.absent_title')} description={t('gateway_usage.absent_desc')} />}
      {state.status === 'error' && <div className={styles.error} role="alert">{t('gateway_usage.load_failed', { error: state.error })}</div>}
      {data && <>
        <div className={styles.summary}>
          <div className={styles.stat}><span className={styles.statLabel}>{t('gateway_usage.col_requests')}</span><span className={styles.statValue}>{compactNumber(data.totals.requests)}</span></div>
          <div className={styles.stat}><span className={styles.statLabel}>{t('gateway_usage.col_total')}</span><span className={styles.statValue}>{compactNumber(data.totals.totalTokens)}</span></div>
          <div className={styles.stat}><span className={styles.statLabel}>{t('gateway_usage.people')}</span><span className={styles.statValue}>{data.users.length}</span></div>
          <div className={styles.stat}><span className={styles.statLabel}>{t('gateway_usage.active_keys')}</span><span className={styles.statValue}>{data.keys.filter((k) => k.requests > 0).length} / {data.keys.length}</span></div>
        </div>
        <UsageTables data={data} />
        {data.generatedAtMs !== null && <p className={styles.muted}>{t('gateway_usage.generated_at', { time: formatDateTimeValue(data.generatedAtMs, i18n.language) })}</p>}
      </>}
    </div>
  );
}
