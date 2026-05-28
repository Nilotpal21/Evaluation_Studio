import type {
  BillingUsageMaterializationSessionResult,
  BillingUsagePublicationVisibilityBatch,
} from '../types/api';

export type BillingSessionResultsFilter = 'all' | 'included' | 'excluded';

export interface BillingSessionResultsFilterCounts {
  all: number;
  included: number;
  excluded: number;
}

export function canApplyBillingPublicationBatch(
  batch: BillingUsagePublicationVisibilityBatch,
): boolean {
  return batch.materializationStatus === 'completed' && batch.publicationStatus === 'pending';
}

export function canLoadBillingPublicationApplication(
  batch: BillingUsagePublicationVisibilityBatch,
): boolean {
  return batch.applicationStatus !== 'missing';
}

export function buildTenantMaterializationApplyPath(tenantId: string, batchId: string): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}/usage/materializations/${encodeURIComponent(batchId)}/apply`;
}

export function buildTenantMaterializationDetailPath(tenantId: string, batchId: string): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}/usage/materializations/${encodeURIComponent(batchId)}`;
}

export function buildTenantMaterializationApplicationPath(
  tenantId: string,
  batchId: string,
): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}/usage/materializations/${encodeURIComponent(batchId)}/application`;
}

export function buildTenantMaterializationResultsPath(
  tenantId: string,
  batchId: string,
  page?: number,
  limit?: number,
): string {
  const searchParams = new URLSearchParams();
  if (typeof page === 'number') {
    searchParams.set('page', String(page));
  }
  if (typeof limit === 'number') {
    searchParams.set('limit', String(limit));
  }
  const query = searchParams.toString();
  const path = `/api/tenants/${encodeURIComponent(tenantId)}/usage/materializations/${encodeURIComponent(batchId)}/results`;
  return query ? `${path}?${query}` : path;
}

export function getBillingSessionResultsFilterCounts(
  sessions: BillingUsageMaterializationSessionResult[],
): BillingSessionResultsFilterCounts {
  const included = sessions.filter((session) => session.included).length;
  return {
    all: sessions.length,
    included,
    excluded: sessions.length - included,
  };
}

export function filterBillingSessionResults(
  sessions: BillingUsageMaterializationSessionResult[],
  filter: BillingSessionResultsFilter,
): BillingUsageMaterializationSessionResult[] {
  switch (filter) {
    case 'included':
      return sessions.filter((session) => session.included);
    case 'excluded':
      return sessions.filter((session) => !session.included);
    default:
      return sessions;
  }
}

export function searchBillingSessionResults(
  sessions: BillingUsageMaterializationSessionResult[],
  query: string,
): BillingUsageMaterializationSessionResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return sessions;
  }

  return sessions.filter((session) => {
    const haystack = [
      session.sessionId,
      session.projectId,
      session.channel,
      session.status,
      session.disposition ?? '',
      session.sessionType ?? '',
      ...session.exclusionReasons,
    ]
      .join(' ')
      .toLowerCase();

    return haystack.includes(normalizedQuery);
  });
}
