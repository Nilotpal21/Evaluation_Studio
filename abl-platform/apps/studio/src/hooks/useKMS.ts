/**
 * useKMS Hooks
 *
 * SWR hooks for the tenant KMS management API proxied through Studio.
 */

import useSWR from 'swr';
import { apiFetch } from '../lib/api-client';
import { useAuthStore } from '../store/auth-store';

export type KMSProviderType =
  | 'local'
  | 'aws-kms'
  | 'azure-keyvault'
  | 'azure-managed-hsm'
  | 'gcp-cloud-kms'
  | 'external';

export type KMSFailurePolicy = 'fail-closed' | 'graceful-degradation';
export type KMSComplianceLevel = 'standard' | 'pci-dss' | 'hipaa' | 'fips-140-3';
export type KMSProviderAuthMethod =
  | 'default-credentials'
  | 'service-account'
  | 'managed-identity'
  | 'api-key'
  | 'mtls'
  | 'oauth2'
  | 'hmac-sha256';

export interface KMSProviderRef {
  providerType: KMSProviderType;
  keyId: string;
  region: string | null;
  vaultUrl: string | null;
  externalEndpoint: string | null;
  authMethod: KMSProviderAuthMethod | null;
  authConfigEncrypted?: string;
}

export interface KMSProviderInput {
  providerType: KMSProviderType;
  keyId: string;
  region?: string | null;
  vaultUrl?: string | null;
  externalEndpoint?: string | null;
  authMethod?: KMSProviderAuthMethod | null;
  authConfig?: Record<string, string> | null;
}

export interface KMSReencryptionConfig {
  enabled: boolean;
  concurrency: number;
  batchSize: number;
  maxRetries: number;
}

export interface KMSEnvironmentOverride {
  environment: string;
  provider: KMSProviderRef | null;
}

export interface KMSProjectOverride {
  projectId: string;
  defaultProvider?: KMSProviderRef | null;
  environments: KMSEnvironmentOverride[];
}

export interface KMSConfigData {
  tenantId: string;
  configured: boolean;
  usingDefault?: boolean;
  configActive?: boolean;
  message?: string;
  propagationWarning?: string;
  defaultProvider?: KMSProviderRef | null;
  dekRetentionDays?: number | null;
  dekEpochIntervalHours?: number;
  dekMaxUsageCount?: number;
  kekRotationPeriodDays?: number;
  reencryption?: KMSReencryptionConfig;
  byokEnabled?: boolean;
  byopEnabled?: boolean;
  complianceLevel?: KMSComplianceLevel;
  failurePolicy?: KMSFailurePolicy;
  environments?: KMSEnvironmentOverride[];
  projects?: KMSProjectOverride[];
  createdAt?: string;
  updatedAt?: string;
}

interface KMSConfigResponse {
  success: boolean;
  data: KMSConfigData;
}

export interface KMSDEKEntry {
  _id: string;
  dekId: string;
  tenantId: string;
  projectId: string;
  environment: string;
  epoch: string;
  kekKeyId: string;
  kekKeyVersion: number;
  wrappingProvider: KMSProviderRef | null;
  wrappingSourceConfigVersion: number | null;
  status: 'active' | 'decrypt_only' | 'destroyed';
  usageCount: number;
  maxUsageCount: number;
  expiresAt: string | null;
  retiredAt: string | null;
  destroyedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KMSKeysStatusFacet {
  status: KMSDEKEntry['status'];
  count: number;
}

export interface KMSKeysSummary {
  total: number;
  activeCount: number;
  decryptOnlyCount: number;
  destroyedCount: number;
  expiringSoonCount: number;
  latestCreatedAt: string | null;
}

interface KMSKeysResponse {
  success: boolean;
  data: {
    entries: KMSDEKEntry[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    summary: KMSKeysSummary;
    filters: {
      statuses: KMSKeysStatusFacet[];
      projects: string[];
      environments: string[];
    };
  };
}

function buildDerivedKMSKeysSummary(
  entries: KMSDEKEntry[],
  total: number,
  fallback?: Partial<KMSKeysSummary>,
): KMSKeysSummary {
  if (fallback) {
    return {
      total: fallback.total ?? total,
      activeCount:
        fallback.activeCount ?? entries.filter((entry) => entry.status === 'active').length,
      decryptOnlyCount:
        fallback.decryptOnlyCount ??
        entries.filter((entry) => entry.status === 'decrypt_only').length,
      destroyedCount:
        fallback.destroyedCount ?? entries.filter((entry) => entry.status === 'destroyed').length,
      expiringSoonCount: fallback.expiringSoonCount ?? 0,
      latestCreatedAt:
        fallback.latestCreatedAt ??
        entries.reduce<string | null>((latest, entry) => {
          if (!entry.createdAt) {
            return latest;
          }
          if (!latest) {
            return entry.createdAt;
          }
          return new Date(entry.createdAt).getTime() > new Date(latest).getTime()
            ? entry.createdAt
            : latest;
        }, null),
    };
  }

  return {
    total,
    activeCount: entries.filter((entry) => entry.status === 'active').length,
    decryptOnlyCount: entries.filter((entry) => entry.status === 'decrypt_only').length,
    destroyedCount: entries.filter((entry) => entry.status === 'destroyed').length,
    expiringSoonCount: 0,
    latestCreatedAt: entries.reduce<string | null>((latest, entry) => {
      if (!entry.createdAt) {
        return latest;
      }
      if (!latest) {
        return entry.createdAt;
      }
      return new Date(entry.createdAt).getTime() > new Date(latest).getTime()
        ? entry.createdAt
        : latest;
    }, null),
  };
}

function buildDerivedKMSKeysFilters(
  entries: KMSDEKEntry[],
  fallback?: KMSKeysResponse['data']['filters'],
): KMSKeysResponse['data']['filters'] {
  if (fallback) {
    return {
      statuses: fallback.statuses ?? [],
      projects: fallback.projects ?? [],
      environments: fallback.environments ?? [],
    };
  }

  const statuses = new Map<KMSDEKEntry['status'], number>();
  const projects = new Set<string>();
  const environments = new Set<string>();

  for (const entry of entries) {
    statuses.set(entry.status, (statuses.get(entry.status) ?? 0) + 1);
    if (entry.projectId) {
      projects.add(entry.projectId);
    }
    if (entry.environment) {
      environments.add(entry.environment);
    }
  }

  return {
    statuses: Array.from(statuses.entries()).map(([status, count]) => ({ status, count })),
    projects: Array.from(projects),
    environments: Array.from(environments),
  };
}

export interface KMSHealthData {
  tenantId: string;
  healthy: boolean;
  provider: KMSProviderType;
  failurePolicy?: KMSFailurePolicy;
  message?: string;
  deks?: {
    active: number;
    decryptOnly: number;
  };
  providerHealth?: {
    healthy: boolean;
    providerType: string;
    latencyMs: number;
    cryptoVerified?: boolean;
    cryptoProbeLatencyMs?: number | null;
    checkedKeyId?: string;
    healthLatencyMs?: number;
    message?: string;
  };
  migration?: {
    migrationActive: boolean;
    cryptoVerified: boolean;
    legacyLocalDekCount: number;
    implicitLocalMetadataCount: number;
    driftedDekCount: number;
    authConfigDependencyCount: number;
    localMasterKeyStillRequired: boolean;
    dekMigrationComplete: boolean;
    warnings: string[];
  };
}

interface KMSHealthResponse {
  success: boolean;
  data: KMSHealthData;
}

export interface KMSAuditEntry {
  event_id?: string;
  timestamp: string;
  operation: string;
  key_id?: string;
  key_version?: number;
  key_purpose?: string;
  provider_type?: string;
  project_id?: string;
  environment?: string;
  epoch?: string;
  actor_id?: string;
  actor_type?: string;
  actor_ip?: string;
  success?: 0 | 1 | boolean;
  error_message?: string;
  latency_ms?: number;
  metadata?: string;
}

export interface KMSAuditOperationCount {
  operation: string;
  count: number;
}

export interface KMSAuditSummary {
  total: number;
  successCount: number;
  failureCount: number;
  uniqueKeys: number;
  uniqueActors: number;
  avgLatencyMs: number | null;
  lastEventAt: string | null;
}

interface KMSAuditResponse {
  success: boolean;
  data: {
    entries: KMSAuditEntry[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    summary: KMSAuditSummary;
    operations: KMSAuditOperationCount[];
    message?: string;
  };
}

export interface KMSValidateRequest {
  endpoint: string;
  authMethod: KMSProviderAuthMethod;
  testKeyId: string;
  roundTripTest?: boolean;
  maxLatencyMs?: number;
  apiKey?: string;
  apiKeyHeader?: string;
  oauth2ClientId?: string;
  oauth2ClientSecret?: string;
  oauth2TokenUrl?: string;
  hmacSecret?: string;
  tlsCert?: string;
  tlsKey?: string;
  tlsCa?: string;
}

export interface KMSValidateResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  latencyMs?: number;
}

interface KMSValidateResponse {
  success: boolean;
  data: KMSValidateResult;
}

export interface KMSEffectiveScopeStep {
  source:
    | 'platform_default'
    | 'tenant_default'
    | 'tenant_environment'
    | 'project_default'
    | 'project_environment';
  matched: boolean;
  projectId?: string;
  environment?: string;
  provider?: KMSProviderRef | null;
}

export interface KMSEffectiveConfigData {
  tenantId: string;
  projectId: string;
  environment: string;
  configured: boolean;
  source:
    | 'platform_default'
    | 'tenant_default'
    | 'tenant_environment'
    | 'project_default'
    | 'project_environment';
  provider: KMSProviderRef | null;
  keyId: string;
  failurePolicy: KMSFailurePolicy;
  sourceConfigVersion: number;
  chain: KMSEffectiveScopeStep[];
}

interface KMSEffectiveConfigResponse {
  success: boolean;
  data: KMSEffectiveConfigData;
}

export interface KMSConfigUpdateInput {
  defaultProvider?: KMSProviderInput | null;
  environments?: Array<{
    environment: string;
    provider: KMSProviderInput;
  }>;
  dekRetentionDays?: number | null;
  dekEpochIntervalHours?: number;
  dekMaxUsageCount?: number;
  kekRotationPeriodDays?: number;
  reencryption?: Partial<KMSReencryptionConfig>;
  byokEnabled?: boolean;
  byopEnabled?: boolean;
  complianceLevel?: KMSComplianceLevel;
  failurePolicy?: KMSFailurePolicy;
}

interface KMSMutationResponse {
  success: boolean;
  data?: KMSConfigData | { message?: string; propagationWarning?: string };
  error?: string | { message?: string };
}

function buildKMSUrl(endpoint: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams({ endpoint });
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value) {
        params.set(key, value);
      }
    }
  }
  return `/api/admin/kms?${params.toString()}`;
}

const SWR_OPTIONS = {
  refreshInterval: 30_000,
  keepPreviousData: true,
};

function getErrorMessage(payload: KMSMutationResponse | undefined, fallback: string): string {
  if (!payload?.error) {
    return fallback;
  }
  return typeof payload.error === 'string' ? payload.error : payload.error.message || fallback;
}

export function useKMSConfig() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const key = isAuthenticated ? buildKMSUrl('config') : null;
  const { data, error, isLoading, mutate } = useSWR<KMSConfigResponse>(key, SWR_OPTIONS);

  return {
    config: data?.data ?? null,
    isLoading,
    error: error ? String(error) : null,
    mutate,
  };
}

export function useKMSKeys(params?: {
  status?: string;
  projectId?: string;
  environment?: string;
  limit?: number;
  offset?: number;
}) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const extra: Record<string, string> = {};
  if (params?.status) extra.status = params.status;
  if (params?.projectId) extra.projectId = params.projectId;
  if (params?.environment) extra.environment = params.environment;
  if (params?.limit) extra.limit = String(params.limit);
  if (params?.offset) extra.offset = String(params.offset);

  const key = isAuthenticated ? buildKMSUrl('keys', extra) : null;
  const { data, error, isLoading, mutate } = useSWR<KMSKeysResponse>(key, SWR_OPTIONS);
  const entries = data?.data.entries ?? [];
  const total = data?.data.total ?? 0;
  const limit = data?.data.limit ?? params?.limit ?? 25;
  const offset = data?.data.offset ?? params?.offset ?? 0;
  const summary = buildDerivedKMSKeysSummary(entries, total, data?.data.summary);
  const filters = buildDerivedKMSKeysFilters(entries, data?.data.filters);
  const hasMore = data?.data.hasMore ?? offset + entries.length < total;

  return {
    keys: entries,
    total,
    limit,
    offset,
    hasMore,
    summary,
    filters,
    isLoading,
    error: error ? String(error) : null,
    mutate,
  };
}

export function useKMSHealth() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const key = isAuthenticated ? buildKMSUrl('health') : null;
  const { data, error, isLoading, mutate } = useSWR<KMSHealthResponse>(key, SWR_OPTIONS);

  return {
    health: data?.data ?? null,
    isLoading,
    error: error ? String(error) : null,
    mutate,
  };
}

export function useKMSEffectiveConfig(params?: { projectId?: string; environment?: string }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const extra: Record<string, string> = {};
  if (params?.projectId) extra.projectId = params.projectId;
  if (params?.environment) extra.environment = params.environment;

  const key = isAuthenticated ? buildKMSUrl('config/resolve', extra) : null;
  const { data, error, isLoading, mutate } = useSWR<KMSEffectiveConfigResponse>(key, SWR_OPTIONS);

  return {
    effectiveConfig: data?.data ?? null,
    isLoading,
    error: error ? String(error) : null,
    mutate,
  };
}

export function useKMSAudit(params?: {
  operation?: string;
  success?: boolean;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const extra: Record<string, string> = {};
  if (params?.operation) extra.operation = params.operation;
  if (params?.success !== undefined) extra.success = params.success ? 'success' : 'failure';
  if (params?.startDate) extra.startDate = params.startDate;
  if (params?.endDate) extra.endDate = params.endDate;
  if (params?.limit) extra.limit = String(params.limit);
  if (params?.offset) extra.offset = String(params.offset);

  const key = isAuthenticated ? buildKMSUrl('audit', extra) : null;
  const { data, error, isLoading, mutate } = useSWR<KMSAuditResponse>(key, SWR_OPTIONS);

  return {
    entries: data?.data.entries ?? [],
    total: data?.data.total ?? 0,
    limit: data?.data.limit ?? 0,
    offset: data?.data.offset ?? 0,
    hasMore: data?.data.hasMore ?? false,
    summary: data?.data.summary ?? {
      total: 0,
      successCount: 0,
      failureCount: 0,
      uniqueKeys: 0,
      uniqueActors: 0,
      avgLatencyMs: null,
      lastEventAt: null,
    },
    operations: data?.data.operations ?? [],
    message: data?.data.message ?? null,
    isLoading,
    error: error ? String(error) : null,
    mutate,
  };
}

export async function updateKMSConfig(
  config: KMSConfigUpdateInput,
): Promise<KMSConfigData | undefined> {
  const response = await apiFetch('/api/admin/kms?endpoint=config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const payload = (await response.json().catch(() => undefined)) as KMSMutationResponse | undefined;

  if (!response.ok || !payload?.success) {
    throw new Error(getErrorMessage(payload, 'Failed to update KMS config'));
  }

  return payload.data as KMSConfigData | undefined;
}

export async function rotateKMSKeys(params?: {
  reason?: 'manual-rotation' | 'kek-age-exceeded' | 'key-compromise';
  projectId?: string;
  environment?: string;
}): Promise<{ message?: string } | undefined> {
  const response = await apiFetch('/api/admin/kms?endpoint=keys/rotate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params ?? {}),
  });
  const payload = (await response.json().catch(() => undefined)) as KMSMutationResponse | undefined;

  if (!response.ok || !payload?.success) {
    throw new Error(getErrorMessage(payload, 'Failed to rotate keys'));
  }

  return payload.data as { message?: string } | undefined;
}

export async function validateExternalKMS(request: KMSValidateRequest): Promise<KMSValidateResult> {
  const response = await apiFetch('/api/admin/kms?endpoint=validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const payload = (await response.json().catch(() => undefined)) as
    | KMSValidateResponse
    | KMSMutationResponse
    | undefined;

  if (!response.ok || !payload?.success) {
    throw new Error(
      getErrorMessage(payload as KMSMutationResponse | undefined, 'Validation failed'),
    );
  }

  return (payload as KMSValidateResponse).data;
}

export interface KMSScopedOverrideInput {
  provider: KMSProviderInput;
}

export interface KMSProjectConfigInput {
  defaultProvider?: KMSProviderInput | null;
  environments?: Array<{
    environment: string;
    provider: KMSProviderInput;
  }>;
}

async function kmsMutation<T = KMSConfigData | { message?: string; propagationWarning?: string }>(
  endpoint: string,
  method: 'PUT' | 'POST' | 'DELETE',
  body?: unknown,
): Promise<T | undefined> {
  const response = await apiFetch(`/api/admin/kms?endpoint=${encodeURIComponent(endpoint)}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => undefined)) as KMSMutationResponse | undefined;

  if (!response.ok || !payload?.success) {
    throw new Error(getErrorMessage(payload, `Failed to ${method.toLowerCase()} ${endpoint}`));
  }

  return payload.data as T | undefined;
}

export async function updateTenantEnvironmentKMSConfig(
  environment: string,
  input: KMSScopedOverrideInput,
): Promise<KMSConfigData | undefined> {
  return kmsMutation<KMSConfigData>(`config/environments/${environment}`, 'PUT', input);
}

export async function deleteTenantEnvironmentKMSConfig(
  environment: string,
): Promise<KMSConfigData | undefined> {
  return kmsMutation<KMSConfigData>(`config/environments/${environment}`, 'DELETE');
}

export async function updateProjectKMSConfig(
  projectId: string,
  input: KMSProjectConfigInput,
): Promise<KMSConfigData | undefined> {
  return kmsMutation<KMSConfigData>(`config/projects/${projectId}`, 'PUT', input);
}

export async function deleteProjectKMSConfig(
  projectId: string,
): Promise<KMSConfigData | undefined> {
  return kmsMutation<KMSConfigData>(`config/projects/${projectId}`, 'DELETE');
}

export async function updateProjectEnvironmentKMSConfig(
  projectId: string,
  environment: string,
  input: KMSScopedOverrideInput,
): Promise<KMSConfigData | undefined> {
  return kmsMutation<KMSConfigData>(
    `config/projects/${projectId}/environments/${environment}`,
    'PUT',
    input,
  );
}

export async function deleteProjectEnvironmentKMSConfig(
  projectId: string,
  environment: string,
): Promise<KMSConfigData | undefined> {
  return kmsMutation<KMSConfigData>(
    `config/projects/${projectId}/environments/${environment}`,
    'DELETE',
  );
}
