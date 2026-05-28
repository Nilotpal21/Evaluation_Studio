/**
 * useBilling Hooks
 *
 * SWR hooks for the workspace billing API endpoints.
 * All data fetched via the Studio proxy at /api/admin/billing.
 */

import useSWR from 'swr';
import { BILLING_READ_PERMISSION } from '@agent-platform/shared/rbac';
import { useAuthStore } from '../store/auth-store';
import { useHasPermission } from './usePermissions';
import { apiFetch } from '../lib/api-client';

// =============================================================================
// TYPES
// =============================================================================

export interface BillingDeal {
  _id: string;
  organizationId: string;
  name: string;
  status: string;
  scope: string;
  phases: Array<{
    name: string;
    startDate: string;
    endDate: string;
  }>;
  overagePolicy: string;
  creditAllotment: {
    totalCredits: number;
    sharedPoolCredits: number;
    featureCredits: Record<string, number>;
    rolloverPolicy: string;
  };
  features: string[];
  renewalDate?: string;
  contractEndDate?: string;
  createdAt: string;
}

export interface CreditBalance {
  allocated: number;
  consumed: number;
  remaining: number;
  featureBreakdown: Record<string, { allocated: number; consumed: number }>;
}

export interface TenantFeatures {
  tenantId: string;
  planTier: string;
  features: Record<string, boolean>;
}

interface DealsResponse {
  success: boolean;
  deals: BillingDeal[];
}

interface CreditsResponse {
  success: boolean;
  credits: CreditBalance;
}

interface FeaturesResponse {
  success: boolean;
  tenantId: string;
  planTier: string;
  features: Record<string, boolean>;
}

export type BillingUsageReportGranularity = 'hour' | 'day' | 'week' | 'month';

export interface BillingUsageReportMetrics {
  examinedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  durationSeconds: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolMessageCount: number;
  interactiveTurnCount: number;
  engagedSeconds: number;
  llmCallCount: number;
  toolCallCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
}

export interface BillingUsageReportWindow extends BillingUsageReportMetrics {
  windowStart: string;
  windowEnd: string;
}

export interface BillingUsageProjectBreakdown extends BillingUsageReportMetrics {
  projectId: string;
}

export interface BillingUsageChannelBreakdown extends BillingUsageReportMetrics {
  channel: string;
}

export interface PublishedBillingUsageReport {
  tenantId: string;
  projectId: string | null;
  granularity: BillingUsageReportGranularity;
  range: {
    windowStart: string;
    windowEnd: string;
    timeZone: 'UTC';
  };
  totals: BillingUsageReportMetrics;
  windows: BillingUsageReportWindow[];
  projectBreakdown: BillingUsageProjectBreakdown[];
  channelBreakdown: BillingUsageChannelBreakdown[];
}

export interface TenantBillingUsageReport extends PublishedBillingUsageReport {}

interface PublishedBillingUsageReportResponse extends PublishedBillingUsageReport {
  success: boolean;
}

// =============================================================================
// HELPERS
// =============================================================================

function buildBillingUrl(endpoint: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams({ endpoint });
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v) params.set(k, v);
    }
  }
  return `/api/admin/billing?${params.toString()}`;
}

function buildProjectBillingUrl(projectId: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v) params.set(k, v);
    }
  }
  const queryString = params.toString();
  return `/api/projects/${encodeURIComponent(projectId)}/billing/usage${queryString ? `?${queryString}` : ''}`;
}

const SWR_OPTIONS = {
  refreshInterval: 60_000,
  keepPreviousData: true,
};

function usePublishedBillingUsageReport(key: string | null) {
  const { data, error, isLoading, mutate } = useSWR<PublishedBillingUsageReportResponse>(
    key,
    SWR_OPTIONS,
  );

  return {
    report: data
      ? {
          tenantId: data.tenantId,
          projectId: data.projectId,
          granularity: data.granularity,
          range: data.range,
          totals: data.totals,
          windows: data.windows,
          projectBreakdown: data.projectBreakdown,
          channelBreakdown: data.channelBreakdown,
        }
      : null,
    isLoading,
    error: error ? String(error) : null,
    refresh: mutate,
  };
}

// =============================================================================
// HOOKS
// =============================================================================

export function useBillingDeals() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const canRead = useHasPermission(BILLING_READ_PERMISSION);
  const key = isAuthenticated && canRead ? buildBillingUrl('deals') : null;

  const { data, error, isLoading, mutate } = useSWR<DealsResponse>(key, SWR_OPTIONS);

  return {
    deals: data?.deals ?? [],
    isLoading,
    error: error ? String(error) : null,
    mutate,
  };
}

export function useBillingCredits() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const canRead = useHasPermission(BILLING_READ_PERMISSION);
  const key = isAuthenticated && canRead ? buildBillingUrl('credits') : null;

  const { data, error, isLoading, mutate } = useSWR<CreditsResponse>(key, SWR_OPTIONS);

  return {
    credits: data?.credits ?? null,
    isLoading,
    error: error ? String(error) : null,
    mutate,
  };
}

export function useTenantFeatures() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const tenantId = useAuthStore((s) => s.tenantId);
  const canRead = useHasPermission(BILLING_READ_PERMISSION);
  const key = isAuthenticated && tenantId && canRead ? buildBillingUrl('features') : null;

  const { data, error, isLoading, mutate } = useSWR<FeaturesResponse>(key, SWR_OPTIONS);

  return {
    features: data?.features ?? {},
    planTier: data?.planTier ?? null,
    isLoading,
    error: error ? String(error) : null,
    mutate,
  };
}

export function useBillingUsageReport(input: {
  windowStart: string;
  windowEnd: string;
  granularity?: BillingUsageReportGranularity;
  projectId?: string | null;
}) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const tenantId = useAuthStore((s) => s.tenantId);
  const canRead = useHasPermission(BILLING_READ_PERMISSION);
  const key =
    isAuthenticated && tenantId && canRead
      ? buildBillingUrl('usage', {
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          granularity: input.granularity ?? 'day',
          ...(input.projectId ? { projectId: input.projectId } : {}),
        })
      : null;

  return usePublishedBillingUsageReport(key);
}

export function useProjectBillingUsageReport(input: {
  projectId: string | null;
  windowStart: string;
  windowEnd: string;
  granularity?: BillingUsageReportGranularity;
}) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const key =
    isAuthenticated && input.projectId
      ? buildProjectBillingUrl(input.projectId, {
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          granularity: input.granularity ?? 'day',
        })
      : null;

  return usePublishedBillingUsageReport(key);
}

// =============================================================================
// MUTATION HELPERS
// =============================================================================

export async function requestUpgrade(targetPlan: string): Promise<{
  success: boolean;
  message?: string;
  redirectUrl?: string | null;
}> {
  const res = await apiFetch('/api/admin/billing?endpoint=upgrade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetPlan }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || 'Failed to request upgrade');
  }
  return res.json();
}

export async function requestTopup(params?: { amount?: number; feature?: string }): Promise<{
  success: boolean;
  message?: string;
  checkoutSessionId?: string | null;
}> {
  const res = await apiFetch('/api/admin/billing?endpoint=credits/topup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || 'Failed to request top-up');
  }
  return res.json();
}
