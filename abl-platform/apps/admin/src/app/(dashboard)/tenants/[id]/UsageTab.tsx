'use client';

import { Fragment, useMemo, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip } from 'recharts';
import { useApi } from '../../../../hooks/use-swr-fetch';
import {
  buildTenantMaterializationApplicationPath,
  buildTenantMaterializationApplyPath,
  buildTenantMaterializationDetailPath,
  buildTenantMaterializationResultsPath,
  canApplyBillingPublicationBatch,
  canLoadBillingPublicationApplication,
  filterBillingSessionResults,
  getBillingSessionResultsFilterCounts,
  searchBillingSessionResults,
  type BillingSessionResultsFilter,
} from '../../../../lib/billing-publication';
import {
  MetricCard,
  SkeletonTable,
  EmptyState,
  ChartCard,
  ChartTooltip,
  CHART_COLORS,
  GRADIENT_DEFS,
  DateRangePicker,
  formatNumber,
} from '@agent-platform/admin-ui';
import type {
  BillingUsageMaterializationApplicationDetailResponse,
  BillingUsageMaterializationDetailResponse,
  BillingUsageMaterializationResultsResponse,
  BillingUsagePublicationVisibilityBatch,
  BillingUsagePublicationVisibilityResponse,
  TenantUsageResponse,
} from '../../../../types/api';

type BillingMaterializationApplyResponse = {
  success?: boolean;
  application?: {
    applicationId?: string;
  };
  error?: string | { message?: string };
};

type BillingMaterializationDetailState = {
  loading: boolean;
  error: string | null;
  materialization: BillingUsageMaterializationDetailResponse['materialization'] | null;
  application: BillingUsageMaterializationApplicationDetailResponse['application'] | null;
  applicationError: string | null;
};

type BillingMaterializationResultsState = {
  loading: boolean;
  error: string | null;
  results: BillingUsageMaterializationResultsResponse['results'] | null;
};

const RESULTS_PAGE_LIMIT = 5;

function formatDateTime(value: string | null): string {
  if (!value) return 'Not yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function getErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object' || !('error' in body)) {
    return fallback;
  }

  const rawError = (body as { error?: string | { message?: string } }).error;
  if (typeof rawError === 'string' && rawError.length > 0) {
    return rawError;
  }
  if (
    rawError &&
    typeof rawError === 'object' &&
    'message' in rawError &&
    typeof rawError.message === 'string' &&
    rawError.message.length > 0
  ) {
    return rawError.message;
  }
  return fallback;
}

async function parseJsonResponse<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

function publicationTone(
  status: BillingUsagePublicationVisibilityBatch['publicationStatus'],
): string {
  switch (status) {
    case 'published':
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    case 'superseded':
      return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
    case 'pending':
      return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    default:
      return 'bg-slate-500/15 text-slate-300 border-slate-500/30';
  }
}

function publicationLabel(
  status: BillingUsagePublicationVisibilityBatch['publicationStatus'],
): string {
  switch (status) {
    case 'published':
      return 'Published';
    case 'superseded':
      return 'Superseded';
    case 'pending':
      return 'Pending publication';
    default:
      return 'Not ready';
  }
}

function formatWindowLabel(value: string): string {
  const date = new Date(value);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

function formatDurationSeconds(value: number): string {
  if (value < 60) {
    return `${value}s`;
  }

  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function UsageTab({ tenantId }: { tenantId: string }) {
  const [dateRange, setDateRange] = useState<{ from: string; to: string }>(() => {
    const now = new Date();
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: now.toISOString() };
  });

  const apiUrl = useMemo(() => {
    const params = new URLSearchParams({
      windowStart: dateRange.from,
      windowEnd: dateRange.to,
      granularity: 'day',
    });
    return `/api/tenants/${tenantId}/usage?${params.toString()}`;
  }, [dateRange, tenantId]);
  const publicationStatusUrl = useMemo(
    () => `/api/tenants/${tenantId}/usage/publication-status?limit=8`,
    [tenantId],
  );

  const { data, loading, error, refetch } = useApi<TenantUsageResponse>(apiUrl);
  const {
    data: publicationStatus,
    loading: publicationLoading,
    error: publicationError,
    refetch: refetchPublicationStatus,
  } = useApi<BillingUsagePublicationVisibilityResponse>(publicationStatusUrl);
  const [applyingBatchId, setApplyingBatchId] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<{ batchId: string; message: string } | null>(null);
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);
  const [detailStateByBatchId, setDetailStateByBatchId] = useState<
    Record<string, BillingMaterializationDetailState>
  >({});
  const [resultsStateByBatchId, setResultsStateByBatchId] = useState<
    Record<string, BillingMaterializationResultsState>
  >({});
  const [resultsFilterByBatchId, setResultsFilterByBatchId] = useState<
    Record<string, BillingSessionResultsFilter>
  >({});
  const [resultsSearchByBatchId, setResultsSearchByBatchId] = useState<Record<string, string>>({});

  async function loadBatchDetails(batch: BillingUsagePublicationVisibilityBatch): Promise<void> {
    setDetailStateByBatchId((current) => ({
      ...current,
      [batch.batchId]: {
        loading: true,
        error: null,
        materialization: current[batch.batchId]?.materialization ?? null,
        application: current[batch.batchId]?.application ?? null,
        applicationError: null,
      },
    }));

    try {
      const batchResponse = await fetch(
        buildTenantMaterializationDetailPath(tenantId, batch.batchId),
      );
      const batchBody =
        await parseJsonResponse<BillingUsageMaterializationDetailResponse>(batchResponse);

      if (!batchResponse.ok || !batchBody?.materialization) {
        throw new Error(getErrorMessage(batchBody, `HTTP ${batchResponse.status}`));
      }

      let application: BillingUsageMaterializationApplicationDetailResponse['application'] | null =
        null;
      let applicationError: string | null = null;

      if (canLoadBillingPublicationApplication(batch)) {
        const applicationResponse = await fetch(
          buildTenantMaterializationApplicationPath(tenantId, batch.batchId),
        );
        const applicationBody =
          await parseJsonResponse<BillingUsageMaterializationApplicationDetailResponse>(
            applicationResponse,
          );

        if (applicationResponse.ok && applicationBody?.application) {
          application = applicationBody.application;
        } else if (applicationResponse.status !== 404) {
          applicationError = getErrorMessage(applicationBody, `HTTP ${applicationResponse.status}`);
        }
      }

      setDetailStateByBatchId((current) => ({
        ...current,
        [batch.batchId]: {
          loading: false,
          error: null,
          materialization: batchBody.materialization,
          application,
          applicationError,
        },
      }));
    } catch (error: unknown) {
      setDetailStateByBatchId((current) => ({
        ...current,
        [batch.batchId]: {
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to load billing materialization detail',
          materialization: null,
          application: null,
          applicationError: null,
        },
      }));
    }
  }

  async function handleApply(batch: BillingUsagePublicationVisibilityBatch): Promise<void> {
    setApplyingBatchId(batch.batchId);
    setApplyError(null);

    try {
      const response = await fetch(buildTenantMaterializationApplyPath(tenantId, batch.batchId), {
        method: 'POST',
      });
      const body = (await response
        .json()
        .catch(() => null)) as BillingMaterializationApplyResponse | null;

      if (!response.ok) {
        throw new Error(getErrorMessage(body, `HTTP ${response.status}`));
      }

      await Promise.all([refetch(), refetchPublicationStatus()]);
      setDetailStateByBatchId((current) => {
        if (!(batch.batchId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[batch.batchId];
        return next;
      });
      if (expandedBatchId === batch.batchId) {
        await loadBatchDetails({
          ...batch,
          applicationStatus: 'projected',
        });
      }
    } catch (error: unknown) {
      setApplyError({
        batchId: batch.batchId,
        message: error instanceof Error ? error.message : 'Failed to publish usage report rows',
      });
    } finally {
      setApplyingBatchId(null);
    }
  }

  async function loadBatchResults(batchId: string, page = 1): Promise<void> {
    setResultsStateByBatchId((current) => ({
      ...current,
      [batchId]: {
        loading: true,
        error: null,
        results: current[batchId]?.results ?? null,
      },
    }));

    try {
      const response = await fetch(
        buildTenantMaterializationResultsPath(tenantId, batchId, page, RESULTS_PAGE_LIMIT),
      );
      const body = await parseJsonResponse<BillingUsageMaterializationResultsResponse>(response);

      if (!response.ok || !body?.results) {
        throw new Error(getErrorMessage(body, `HTTP ${response.status}`));
      }

      setResultsStateByBatchId((current) => ({
        ...current,
        [batchId]: {
          loading: false,
          error: null,
          results: body.results,
        },
      }));
    } catch (error: unknown) {
      setResultsStateByBatchId((current) => ({
        ...current,
        [batchId]: {
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to load materialization session results',
          results: current[batchId]?.results ?? null,
        },
      }));
    }
  }

  async function handleToggleDetails(batch: BillingUsagePublicationVisibilityBatch): Promise<void> {
    if (expandedBatchId === batch.batchId) {
      setExpandedBatchId(null);
      return;
    }

    setExpandedBatchId(batch.batchId);
    const existing = detailStateByBatchId[batch.batchId];

    if (!existing || existing.error) {
      await Promise.all([loadBatchDetails(batch), loadBatchResults(batch.batchId)]);
      return;
    }

    const existingResults = resultsStateByBatchId[batch.batchId];
    if (!existingResults || existingResults.error) {
      await loadBatchResults(batch.batchId);
    }
  }

  if (loading && !data) {
    return <SkeletonTable rows={4} />;
  }

  if (error && !data) {
    return (
      <EmptyState
        title="Failed to load usage"
        description={error}
        action={
          <button
            onClick={refetch}
            className="px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm hover:opacity-90 transition-colors"
          >
            Retry
          </button>
        }
      />
    );
  }

  if (!data) {
    return (
      <EmptyState
        title="No usage data"
        description="Usage data is not available for this tenant."
      />
    );
  }

  const { totals, windows, projectBreakdown, channelBreakdown } = data;
  const publicationSummary = publicationStatus?.visibility.summary ?? null;
  const publicationBatches = publicationStatus?.visibility.batches ?? [];

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <DateRangePicker onChange={setDateRange} defaultRange="30d" />
      </div>

      <div
        id="publication-visibility"
        className="rounded-lg border border-border bg-background-subtle p-5 space-y-4 scroll-mt-6"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-foreground">Materialization Publication</h3>
            <p className="text-xs text-foreground-muted mt-1">
              Usage reports update only after a completed materialization batch is published into
              report rows.
            </p>
          </div>
        </div>

        {publicationError ? (
          <EmptyState title="Unable to load publication state" description={publicationError} />
        ) : publicationLoading && !publicationSummary ? (
          <div className="text-sm text-foreground-muted">Loading publication state…</div>
        ) : publicationSummary ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <MetricCard
                title="Pending Publication"
                value={formatNumber(publicationSummary.pendingPublicationCount)}
              />
              <MetricCard
                title="Published Batches"
                value={formatNumber(publicationSummary.publishedBatchCount)}
              />
              <MetricCard
                title="Last Materialized"
                value={publicationSummary.lastMaterializedAt ? 'Ready' : 'Never'}
                description={formatDateTime(publicationSummary.lastMaterializedAt)}
              />
              <MetricCard
                title="Last Published"
                value={publicationSummary.lastPublishedAt ? 'Visible' : 'Not yet'}
                description={formatDateTime(publicationSummary.lastPublishedAt)}
              />
            </div>

            {publicationBatches.length > 0 && (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-foreground-muted">
                      <th className="py-2 pr-3">Batch</th>
                      <th className="py-2 pr-3">Scope</th>
                      <th className="py-2 pr-3">Trigger</th>
                      <th className="py-2 pr-3">Units</th>
                      <th className="py-2 pr-3">Materialized</th>
                      <th className="py-2 pr-3">Report State</th>
                      <th className="py-2 pr-3">Published</th>
                      <th className="py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {publicationBatches.map((batch) => {
                      const detailState = detailStateByBatchId[batch.batchId];
                      const resultsState = resultsStateByBatchId[batch.batchId];
                      const isExpanded = expandedBatchId === batch.batchId;
                      const currentResults = resultsState?.results;
                      const currentPage = currentResults?.page.page ?? 1;
                      const totalPages = currentResults
                        ? Math.max(
                            1,
                            Math.ceil(currentResults.page.total / currentResults.page.limit),
                          )
                        : 1;
                      const currentFilter = resultsFilterByBatchId[batch.batchId] ?? 'all';
                      const currentSearchQuery = resultsSearchByBatchId[batch.batchId] ?? '';
                      const currentFilterCounts = currentResults
                        ? getBillingSessionResultsFilterCounts(currentResults.sessions)
                        : { all: 0, included: 0, excluded: 0 };
                      const filteredResults = currentResults
                        ? filterBillingSessionResults(currentResults.sessions, currentFilter)
                        : [];
                      const visibleResults = searchBillingSessionResults(
                        filteredResults,
                        currentSearchQuery,
                      );
                      const batchSummary = detailState?.materialization?.summary;
                      const batchFilterCounts = batchSummary
                        ? {
                            all: batchSummary.examinedSessionCount,
                            included: batchSummary.includedSessionCount,
                            excluded: batchSummary.excludedSessionCount,
                          }
                        : currentFilterCounts;
                      const exclusionEntries = batchSummary
                        ? Object.entries(batchSummary.exclusionCounts).sort(
                            ([leftReason], [rightReason]) => leftReason.localeCompare(rightReason),
                          )
                        : [];

                      return (
                        <Fragment key={batch.batchId}>
                          <tr className="border-b border-border/60 align-top">
                            <td className="py-3 pr-3 font-mono text-xs text-foreground">
                              {batch.batchId}
                            </td>
                            <td className="py-3 pr-3 text-foreground-muted">
                              {batch.projectId ?? 'Tenant scope'}
                            </td>
                            <td className="py-3 pr-3 text-foreground-muted capitalize">
                              {batch.triggerSource}
                            </td>
                            <td className="py-3 pr-3 text-foreground">
                              {formatNumber(batch.totalUnits)}
                            </td>
                            <td className="py-3 pr-3 text-foreground-muted">
                              {formatDateTime(batch.completedAt)}
                            </td>
                            <td className="py-3 pr-3">
                              <span
                                className={`inline-flex items-center rounded-full border px-2 py-1 text-[11px] font-medium ${publicationTone(batch.publicationStatus)}`}
                              >
                                {publicationLabel(batch.publicationStatus)}
                              </span>
                              {batch.publicationReason &&
                              batch.publicationStatus !== 'published' ? (
                                <div className="mt-1 text-xs text-foreground-muted">
                                  {batch.publicationReason}
                                </div>
                              ) : null}
                            </td>
                            <td className="py-3 pr-3 text-foreground-muted">
                              {formatDateTime(batch.publishedAt)}
                            </td>
                            <td className="py-3">
                              <div className="space-y-1">
                                <div className="flex flex-wrap gap-2">
                                  {canApplyBillingPublicationBatch(batch) ? (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        void handleApply(batch);
                                      }}
                                      disabled={applyingBatchId === batch.batchId}
                                      className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                                    >
                                      {applyingBatchId === batch.batchId
                                        ? 'Publishing…'
                                        : 'Publish now'}
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      void handleToggleDetails(batch);
                                    }}
                                    disabled={detailState?.loading === true}
                                    className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                                  >
                                    {detailState?.loading && isExpanded
                                      ? 'Loading…'
                                      : isExpanded
                                        ? 'Hide details'
                                        : 'View details'}
                                  </button>
                                </div>
                                {applyError?.batchId === batch.batchId ? (
                                  <div className="text-xs text-red-300">{applyError.message}</div>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                          {isExpanded ? (
                            <tr className="border-b border-border/60 bg-background/30">
                              <td colSpan={8} className="px-4 py-4">
                                {detailState?.error ? (
                                  <div className="space-y-3">
                                    <div className="text-sm text-red-300">{detailState.error}</div>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        void loadBatchDetails(batch);
                                      }}
                                      className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background transition-colors"
                                    >
                                      Retry details
                                    </button>
                                  </div>
                                ) : detailState?.loading || !detailState?.materialization ? (
                                  <div className="text-sm text-foreground-muted">
                                    Loading batch details…
                                  </div>
                                ) : (
                                  <div className="space-y-4">
                                    <div className="grid gap-4 lg:grid-cols-3">
                                      <div className="rounded-md border border-border bg-background p-4">
                                        <div className="text-xs uppercase tracking-wide text-foreground-muted">
                                          Batch Scope
                                        </div>
                                        <div className="mt-2 space-y-2 text-sm text-foreground">
                                          <div>
                                            <span className="text-foreground-muted">Basis:</span>{' '}
                                            {detailState.materialization.scope.basis}
                                          </div>
                                          <div>
                                            <span className="text-foreground-muted">Window:</span>{' '}
                                            {detailState.materialization.scope.periodLabel ??
                                              'Custom scope'}
                                          </div>
                                          <div>
                                            <span className="text-foreground-muted">Trigger:</span>{' '}
                                            {detailState.materialization.triggerSource}
                                          </div>
                                          <div>
                                            <span className="text-foreground-muted">
                                              Result rows:
                                            </span>{' '}
                                            {formatNumber(detailState.materialization.resultCount)}
                                          </div>
                                          <div>
                                            <span className="text-foreground-muted">
                                              Materialized:
                                            </span>{' '}
                                            {formatDateTime(
                                              detailState.materialization.completedAt,
                                            )}
                                          </div>
                                          <div>
                                            <span className="text-foreground-muted">Warnings:</span>{' '}
                                            {detailState.materialization.warnings.length > 0
                                              ? detailState.materialization.warnings.join(', ')
                                              : 'None'}
                                          </div>
                                          {detailState.materialization.failureReason ? (
                                            <div className="text-red-300">
                                              <span className="text-foreground-muted">
                                                Failure:
                                              </span>{' '}
                                              {detailState.materialization.failureReason}
                                            </div>
                                          ) : null}
                                        </div>
                                      </div>

                                      <div className="rounded-md border border-border bg-background p-4">
                                        <div className="text-xs uppercase tracking-wide text-foreground-muted">
                                          Usage Summary
                                        </div>
                                        {detailState.materialization.summary ? (
                                          <div className="mt-2 space-y-2 text-sm text-foreground">
                                            <div>
                                              <span className="text-foreground-muted">
                                                Included:
                                              </span>{' '}
                                              {formatNumber(
                                                detailState.materialization.summary
                                                  .includedSessionCount,
                                              )}
                                            </div>
                                            <div>
                                              <span className="text-foreground-muted">
                                                Excluded:
                                              </span>{' '}
                                              {formatNumber(
                                                detailState.materialization.summary
                                                  .excludedSessionCount,
                                              )}
                                            </div>
                                            <div>
                                              <span className="text-foreground-muted">
                                                Base units:
                                              </span>{' '}
                                              {formatNumber(
                                                detailState.materialization.summary.baseUnits,
                                              )}
                                            </div>
                                            <div>
                                              <span className="text-foreground-muted">
                                                LLM addon units:
                                              </span>{' '}
                                              {formatNumber(
                                                detailState.materialization.summary.llmAddonUnits,
                                              )}
                                            </div>
                                            <div>
                                              <span className="text-foreground-muted">
                                                Tool addon units:
                                              </span>{' '}
                                              {formatNumber(
                                                detailState.materialization.summary.toolAddonUnits,
                                              )}
                                            </div>
                                            <div>
                                              <span className="text-foreground-muted">
                                                Total units:
                                              </span>{' '}
                                              {formatNumber(
                                                detailState.materialization.summary.totalUnits,
                                              )}
                                            </div>
                                            <div className="text-xs text-foreground-muted">
                                              Exclusions:{' '}
                                              {Object.entries(
                                                detailState.materialization.summary.exclusionCounts,
                                              )
                                                .map(([reason, count]) => `${reason} (${count})`)
                                                .join(', ') || 'None'}
                                            </div>
                                            <div className="text-xs text-foreground-muted">
                                              Metrics sources:{' '}
                                              {Object.entries(
                                                detailState.materialization.summary
                                                  .metricsSourceCounts,
                                              )
                                                .map(([source, count]) => `${source} (${count})`)
                                                .join(', ') || 'None'}
                                            </div>
                                          </div>
                                        ) : (
                                          <div className="mt-2 text-sm text-foreground-muted">
                                            Summary is not available for this batch.
                                          </div>
                                        )}
                                      </div>

                                      <div className="rounded-md border border-border bg-background p-4">
                                        <div className="text-xs uppercase tracking-wide text-foreground-muted">
                                          Application
                                        </div>
                                        {detailState.application ? (
                                          <div className="mt-2 space-y-2 text-sm text-foreground">
                                            <div>
                                              <span className="text-foreground-muted">
                                                Application:
                                              </span>{' '}
                                              {detailState.application.applicationId}
                                            </div>
                                            <div>
                                              <span className="text-foreground-muted">Status:</span>{' '}
                                              {detailState.application.status}
                                            </div>
                                            <div>
                                              <span className="text-foreground-muted">Deal:</span>{' '}
                                              {detailState.application.dealResolution.dealId} (
                                              {detailState.application.dealResolution.matchType})
                                            </div>
                                            <div>
                                              <span className="text-foreground-muted">Period:</span>{' '}
                                              {detailState.application.accountingPeriod.periodLabel}
                                            </div>
                                            <div>
                                              <span className="text-foreground-muted">
                                                Usage reports:
                                              </span>{' '}
                                              {
                                                detailState.application.projection.usageReports
                                                  .status
                                              }
                                            </div>
                                            <div className="text-xs text-foreground-muted">
                                              {detailState.application.projection.usageReports
                                                .reason ?? 'Usage report projection completed.'}
                                            </div>
                                            <div className="text-xs text-foreground-muted">
                                              Credit ledger:{' '}
                                              {
                                                detailState.application.projection.creditLedger
                                                  .status
                                              }
                                              {detailState.application.projection.creditLedger
                                                .reason
                                                ? ` (${detailState.application.projection.creditLedger.reason})`
                                                : ''}
                                            </div>
                                            <div className="text-xs text-foreground-muted">
                                              Billing line items:{' '}
                                              {
                                                detailState.application.projection.billingLineItems
                                                  .status
                                              }
                                              {detailState.application.projection.billingLineItems
                                                .reason
                                                ? ` (${detailState.application.projection.billingLineItems.reason})`
                                                : ''}
                                            </div>
                                          </div>
                                        ) : (
                                          <div className="mt-2 space-y-2 text-sm text-foreground-muted">
                                            <div>
                                              {batch.applicationStatus === 'missing'
                                                ? 'No application has been recorded yet for this batch.'
                                                : 'Application detail is not currently available.'}
                                            </div>
                                            {batch.applicationStatus === 'missing' &&
                                            canApplyBillingPublicationBatch(batch) ? (
                                              <div>
                                                Use{' '}
                                                <span className="text-foreground">Publish now</span>{' '}
                                                to create the application and publish report rows.
                                              </div>
                                            ) : null}
                                            {detailState.applicationError ? (
                                              <div className="text-red-300">
                                                {detailState.applicationError}
                                              </div>
                                            ) : null}
                                          </div>
                                        )}
                                      </div>
                                    </div>

                                    <div className="rounded-md border border-border bg-background p-4">
                                      <div className="flex items-start justify-between gap-4">
                                        <div>
                                          <div className="text-xs uppercase tracking-wide text-foreground-muted">
                                            Session Results
                                          </div>
                                          <div className="mt-1 text-xs text-foreground-muted">
                                            Included and excluded sessions that contributed to this
                                            materialization batch.
                                          </div>
                                          <div className="mt-3 flex flex-wrap gap-2">
                                            {(
                                              [
                                                ['all', 'All', batchFilterCounts.all],
                                                [
                                                  'included',
                                                  'Included',
                                                  batchFilterCounts.included,
                                                ],
                                                [
                                                  'excluded',
                                                  'Excluded',
                                                  batchFilterCounts.excluded,
                                                ],
                                              ] as const
                                            ).map(([filter, label, count]) => (
                                              <button
                                                key={filter}
                                                type="button"
                                                onClick={() => {
                                                  setResultsFilterByBatchId((current) => ({
                                                    ...current,
                                                    [batch.batchId]: filter,
                                                  }));
                                                }}
                                                className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                                                  currentFilter === filter
                                                    ? 'border-accent bg-accent/15 text-accent'
                                                    : 'border-border text-foreground-muted hover:bg-background'
                                                }`}
                                              >
                                                {label} {formatNumber(count)}
                                              </button>
                                            ))}
                                          </div>
                                          <div className="mt-3 flex flex-wrap items-center gap-2">
                                            <input
                                              type="search"
                                              value={currentSearchQuery}
                                              onChange={(event) => {
                                                setResultsSearchByBatchId((current) => ({
                                                  ...current,
                                                  [batch.batchId]: event.target.value,
                                                }));
                                              }}
                                              placeholder="Search session, project, channel, or reason"
                                              className="min-w-[260px] flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-foreground-muted focus:border-accent"
                                            />
                                            {currentSearchQuery.length > 0 ? (
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  setResultsSearchByBatchId((current) => ({
                                                    ...current,
                                                    [batch.batchId]: '',
                                                  }));
                                                }}
                                                className="inline-flex items-center rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-background transition-colors"
                                              >
                                                Clear
                                              </button>
                                            ) : null}
                                          </div>
                                          {exclusionEntries.length > 0 ? (
                                            <div className="mt-3 flex flex-wrap gap-2">
                                              {exclusionEntries.map(([reason, count]) => (
                                                <span
                                                  key={reason}
                                                  className="inline-flex items-center rounded-full border border-border bg-background px-3 py-1 text-[11px] text-foreground-muted"
                                                >
                                                  {reason} ({formatNumber(count)})
                                                </span>
                                              ))}
                                            </div>
                                          ) : null}
                                        </div>
                                        {currentResults ? (
                                          <div className="text-xs text-foreground-muted">
                                            Page {currentPage} of {totalPages}
                                          </div>
                                        ) : null}
                                      </div>

                                      {resultsState?.error ? (
                                        <div className="mt-3 space-y-3">
                                          <div className="text-sm text-red-300">
                                            {resultsState.error}
                                          </div>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              void loadBatchResults(batch.batchId, currentPage);
                                            }}
                                            className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background transition-colors"
                                          >
                                            Retry sessions
                                          </button>
                                        </div>
                                      ) : resultsState?.loading && !currentResults ? (
                                        <div className="mt-3 text-sm text-foreground-muted">
                                          Loading session results…
                                        </div>
                                      ) : currentResults ? (
                                        <div className="mt-3 space-y-3">
                                          {visibleResults.length > 0 ? (
                                            <div className="overflow-x-auto">
                                              <table className="min-w-full text-sm">
                                                <thead>
                                                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-foreground-muted">
                                                    <th className="py-2 pr-3">Seq</th>
                                                    <th className="py-2 pr-3">Session</th>
                                                    <th className="py-2 pr-3">Outcome</th>
                                                    <th className="py-2 pr-3">Reasons</th>
                                                    <th className="py-2 pr-3">Duration</th>
                                                    <th className="py-2 pr-3">Units</th>
                                                    <th className="py-2">Metrics</th>
                                                  </tr>
                                                </thead>
                                                <tbody>
                                                  {visibleResults.map((session) => (
                                                    <tr
                                                      key={session.sessionId}
                                                      className="border-b border-border/60 align-top"
                                                    >
                                                      <td className="py-3 pr-3 text-foreground-muted">
                                                        {session.sequence + 1}
                                                      </td>
                                                      <td className="py-3 pr-3">
                                                        <div className="font-mono text-xs text-foreground">
                                                          {session.sessionId}
                                                        </div>
                                                        <div className="mt-1 text-xs text-foreground-muted">
                                                          {session.channel} • {session.projectId}
                                                        </div>
                                                      </td>
                                                      <td className="py-3 pr-3">
                                                        <span
                                                          className={`inline-flex items-center rounded-full border px-2 py-1 text-[11px] font-medium ${
                                                            session.included
                                                              ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
                                                              : 'border-amber-500/30 bg-amber-500/15 text-amber-300'
                                                          }`}
                                                        >
                                                          {session.included
                                                            ? 'Included'
                                                            : 'Excluded'}
                                                        </span>
                                                      </td>
                                                      <td className="py-3 pr-3 text-xs text-foreground-muted">
                                                        {session.exclusionReasons.length > 0
                                                          ? session.exclusionReasons.join(', ')
                                                          : 'None'}
                                                      </td>
                                                      <td className="py-3 pr-3 text-foreground-muted">
                                                        {formatDurationSeconds(
                                                          session.durationSeconds,
                                                        )}
                                                      </td>
                                                      <td className="py-3 pr-3 text-foreground">
                                                        {formatNumber(session.totalUnits)}
                                                      </td>
                                                      <td className="py-3 text-xs text-foreground-muted">
                                                        {session.metricsSource} •{' '}
                                                        {session.llmCallCount} LLM /{' '}
                                                        {session.toolCallCount} tool
                                                      </td>
                                                    </tr>
                                                  ))}
                                                </tbody>
                                              </table>
                                            </div>
                                          ) : (
                                            <div className="rounded-md border border-dashed border-border px-4 py-6 text-sm text-foreground-muted">
                                              {currentSearchQuery.length > 0
                                                ? `No ${currentFilter === 'all' ? 'sessions' : currentFilter} rows on this page match "${currentSearchQuery}".`
                                                : `No ${currentFilter === 'all' ? 'sessions' : currentFilter} rows are visible on this page.`}
                                            </div>
                                          )}

                                          <div className="flex items-center justify-between gap-3">
                                            <div className="text-xs text-foreground-muted">
                                              Showing {formatNumber(visibleResults.length)} of{' '}
                                              {formatNumber(filteredResults.length)} filtered row
                                              {filteredResults.length === 1 ? '' : 's'} on this page
                                              • {formatNumber(currentResults.page.total)} session
                                              {currentResults.page.total === 1 ? '' : 's'} in this
                                              batch
                                            </div>
                                            <div className="flex gap-2">
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  void loadBatchResults(
                                                    batch.batchId,
                                                    Math.max(1, currentPage - 1),
                                                  );
                                                }}
                                                disabled={resultsState.loading || currentPage <= 1}
                                                className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                                              >
                                                Previous
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  void loadBatchResults(
                                                    batch.batchId,
                                                    currentPage + 1,
                                                  );
                                                }}
                                                disabled={
                                                  resultsState.loading ||
                                                  !currentResults.page.hasMore
                                                }
                                                className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                                              >
                                                Next
                                              </button>
                                            </div>
                                          </div>
                                        </div>
                                      ) : (
                                        <div className="mt-3 text-sm text-foreground-muted">
                                          No session results are available for this batch yet.
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <EmptyState
            title="No materialization batches yet"
            description="No billing materialization batches have been created for this tenant."
          />
        )}
      </div>

      {totals.examinedSessionCount === 0 ? (
        <EmptyState
          title="No billing usage data"
          description="No published billing usage fell inside the selected reporting window."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <MetricCard
              title="Included Sessions"
              value={formatNumber(totals.includedSessionCount)}
            />
            <MetricCard title="Billing Units" value={formatNumber(totals.totalUnits)} />
            <MetricCard title="LLM Calls" value={formatNumber(totals.llmCallCount)} />
          </div>

          {windows.length > 0 && (
            <ChartCard title="Daily Billing Units">
              <AreaChart data={windows}>
                {GRADIENT_DEFS}
                <XAxis
                  dataKey="windowStart"
                  tick={{ fontSize: 11, fill: 'hsl(var(--foreground-muted,0 0% 63.9%))' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={formatWindowLabel}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'hsl(var(--foreground-muted,0 0% 63.9%))' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={formatNumber}
                />
                <Tooltip
                  content={<ChartTooltip formatter={(value: number) => formatNumber(value)} />}
                />
                <Area
                  type="monotone"
                  dataKey="totalUnits"
                  stroke={CHART_COLORS.accent}
                  fill="url(#gradAccent)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ChartCard>
          )}

          {projectBreakdown.length > 0 && (
            <div className="rounded-lg border border-border bg-background-subtle p-5">
              <h3 className="text-sm font-medium text-foreground-muted mb-3">Project Breakdown</h3>
              <div className="space-y-3">
                {projectBreakdown.map((item) => {
                  const maxUnits = Math.max(...projectBreakdown.map((row) => row.totalUnits), 1);
                  const pct = (item.totalUnits / maxUnits) * 100;
                  return (
                    <div key={item.projectId}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-foreground">{item.projectId}</span>
                        <span className="text-foreground-muted">
                          {formatNumber(item.totalUnits)} units
                        </span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-background-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {channelBreakdown.length > 0 && (
            <div className="rounded-lg border border-border bg-background-subtle p-5">
              <h3 className="text-sm font-medium text-foreground-muted mb-3">Channel Breakdown</h3>
              <div className="space-y-3">
                {channelBreakdown.map((item) => {
                  const maxUnits = Math.max(...channelBreakdown.map((row) => row.totalUnits), 1);
                  const pct = (item.totalUnits / maxUnits) * 100;
                  return (
                    <div key={item.channel}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-foreground">{item.channel}</span>
                        <span className="text-foreground-muted">
                          {formatNumber(item.totalUnits)} units
                        </span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-background-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-purple"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
