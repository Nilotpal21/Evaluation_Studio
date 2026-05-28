/**
 * SecurityTab Component
 *
 * Main Security tab rendering all security sections:
 * Scopes, Token, Access Summary, Emergency Revoke, Security Export, Audit Log.
 */

import { useTranslations } from 'next-intl';
import { useSecurityOverview } from '../../../hooks/useSecurityOverview';
import { useConnector } from '../../../hooks/useConnector';
import { ScopesSection } from './security/ScopesSection';
import { TokenExpirySection } from './security/TokenExpirySection';
import { AccessSummarySection } from './security/AccessSummarySection';
import { EmergencyRevokeSection } from './security/EmergencyRevokeSection';
import { SecurityExportSection } from './security/SecurityExportSection';
import { AuditLogSection } from './security/AuditLogSection';

interface SecurityTabProps {
  indexId: string;
  connectorId: string;
}

export function SecurityTab({ indexId, connectorId }: SecurityTabProps) {
  const t = useTranslations('search_ai.sharepoint.security');
  const { data: overview, isLoading, mutate } = useSecurityOverview(indexId, connectorId);
  const { connector } = useConnector(indexId, connectorId);

  const connectorName =
    ((connector?.connectionConfig as Record<string, unknown>)?.displayName as string) ??
    connector?.connectorType ??
    'Connector';

  if (isLoading) {
    return <div className="p-6 text-sm text-muted">{t('loading')}</div>;
  }

  return (
    <div className="p-6 space-y-8">
      {overview && (
        <>
          <ScopesSection scopes={overview.grantedScopes} />
          <TokenExpirySection tokenStatus={overview.tokenStatus} />
          <AccessSummarySection
            accesses={overview.accessSummary.accesses}
            doesNotAccess={overview.accessSummary.doesNotAccess}
          />
        </>
      )}

      <SecurityExportSection indexId={indexId} connectorId={connectorId} />

      <div className="border-t border-default pt-6">
        <EmergencyRevokeSection
          indexId={indexId}
          connectorId={connectorId}
          connectorName={connectorName}
          onRevoked={() => mutate()}
        />
      </div>

      <div className="border-t border-default pt-6">
        <AuditLogSection indexId={indexId} connectorId={connectorId} />
      </div>
    </div>
  );
}
