'use client';

/**
 * ConfigSummary
 *
 * Read-only summary of connector configuration: scope, filters, schedule, permissions.
 * Reads from the overview API's configSummary (pre-computed server-side) for accuracy,
 * with fallback to connector fields.
 */

import { useTranslations } from 'next-intl';
import { Button } from '../../ui/Button';
import type { ConnectorDetail } from '../../../hooks/useConnector';
import type { OverviewData } from '../../../hooks/useConnectorOverview';

interface ConfigSummaryProps {
  connector: ConnectorDetail;
  overview: OverviewData | null;
  onEditConfig: () => void;
  onViewFullConfig: () => void;
}

export function ConfigSummary({
  connector,
  overview,
  onEditConfig,
  onViewFullConfig,
}: ConfigSummaryProps) {
  const t = useTranslations('search_ai.sharepoint.overview');

  // Use overview configSummary (pre-computed by backend) when available
  const cs = overview?.configSummary;

  const filterConfig = connector.filterConfig as Record<string, unknown> | undefined;
  const scope = (filterConfig?.scope ?? {}) as Record<string, unknown>;
  const standard = (filterConfig?.standard ?? {}) as Record<string, unknown>;
  const connectionConfig = connector.connectionConfig as Record<string, unknown> | undefined;

  // Scope: from overview or derive from filterConfig
  const scopeText = cs?.scope
    ? String(cs.scope)
    : scope.siteMode === 'selected'
      ? `${(scope.siteIds as string[] | undefined)?.length ?? 0} selected sites`
      : 'All sites';

  // Filters: from overview or derive from filterConfig
  const filtersText = cs?.filters
    ? String(cs.filters)
    : (() => {
        const ext = standard.fileExtensions as Record<string, unknown> | null;
        if (ext?.extensions && Array.isArray(ext.extensions)) {
          return `${ext.mode ?? 'allowlist'}: ${ext.extensions.length} extensions`;
        }
        return 'Default';
      })();

  // Schedule: from overview or derive from connectionConfig
  const scheduleText = cs?.schedule
    ? String(cs.schedule)
    : String(connectionConfig?.syncSchedule ?? 'daily');

  // Permissions
  const permissionText = cs?.permissionMode
    ? String(cs.permissionMode)
    : connector.permissionConfig.mode === 'enabled'
      ? 'Enabled'
      : 'Disabled';

  const rows = [
    { label: t('config_scope'), value: scopeText },
    { label: t('config_filters'), value: filtersText },
    { label: t('config_schedule'), value: scheduleText },
    { label: t('config_permissions'), value: permissionText },
  ];

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-foreground">{t('config_summary_title')}</h3>

      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between text-sm">
            <span className="text-muted">{row.label}</span>
            <span className="text-foreground">{row.value}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button variant="ghost" size="xs" onClick={onViewFullConfig}>
          {t('view_full_config')}
        </Button>
        <Button variant="ghost" size="xs" onClick={onEditConfig}>
          {t('edit_config')}
        </Button>
      </div>
    </div>
  );
}
