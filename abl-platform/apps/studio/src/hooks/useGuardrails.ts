/**
 * useGuardrails Hooks
 *
 * SWR hooks for guardrail providers (tenant-scoped) and
 * guardrail policies (project-scoped).
 */

import useSWR from 'swr';
import { useAuthStore } from '../store/auth-store';
import { apiFetch } from '../lib/api-client';

// =============================================================================
// TYPES
// =============================================================================

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number; // ms
  failMode?: 'open' | 'closed';
  /** Legacy read compatibility for older Studio/runtime responses. */
  maxFailures?: number;
  resetTimeout?: number;
}

export interface RetryConfig {
  maxRetries: number;
  backoffBaseMs: number;
  /** Legacy read compatibility for older Studio responses. */
  backoff?: 'fixed' | 'exponential' | number;
}

export interface GuardrailProvider {
  _id: string;
  name: string;
  displayName?: string;
  adapterType: string; // openai_moderation | custom_llm | custom_http | custom_webhook
  endpoint?: string;
  model?: string;
  hosting?: 'cloud_api' | 'self_hosted' | 'managed_service';
  defaultCategory?: string;
  defaultThreshold?: number;
  supportedCategories?: string[];
  customMapping?: Record<string, unknown>;
  selfHostedConfig?: Record<string, unknown>;
  circuitBreaker?: CircuitBreakerConfig;
  retry?: RetryConfig;
  costPerEvalUsd?: number;
  apiKeyConfigured?: boolean;
  authProfileId?: string | null;
  isActive: boolean;
  healthStatus?: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  lastHealthCheck?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GuardrailProvidersResponse {
  success: boolean;
  data: GuardrailProvider[];
}

export interface CreateProviderInput {
  name: string;
  displayName?: string;
  adapterType: string;
  endpoint?: string;
  model?: string;
  hosting?: 'cloud_api' | 'self_hosted' | 'managed_service';
  defaultCategory?: string;
  defaultThreshold?: number;
  supportedCategories?: string[];
  customMapping?: Record<string, unknown>;
  selfHostedConfig?: Record<string, unknown>;
  circuitBreaker?: CircuitBreakerConfig;
  retry?: RetryConfig;
  costPerEvalUsd?: number;
  authProfileId?: string | null;
  isActive?: boolean;
  [key: string]: unknown;
}

export interface GuardrailStreamingSettings {
  enabled: boolean;
  defaultInterval?: 'token' | 'sentence' | 'chunk_size';
  chunkSize?: number;
  maxLatencyMs?: number;
  earlyTermination?: boolean;
}

export interface GuardrailPolicySettings {
  failMode?: 'open' | 'closed';
  timeouts?: { local: number; model: number; llm: number };
  streaming?: GuardrailStreamingSettings;
  webhookUrl?: string;
  webhookSecret?: string;
}

export interface GuardrailPolicyRule {
  guardrailName: string;
  override?: 'disable' | 'threshold' | 'action' | 'severity_actions' | 'define';
  kind?: 'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff';
  provider?: string;
  category?: string;
  check?: string;
  llmCheck?: string;
  threshold?: number;
  action?: Record<string, unknown>;
  severityActions?: Record<string, unknown>;
  description?: string;
  priority?: number;
  message?: string;
  [key: string]: unknown;
}

export interface GuardrailPolicyProviderOverride {
  providerName: string;
  endpoint?: string;
  /** Reserved for a future credential override flow. Runtime rejects this today. */
  apiKeyCredentialId?: string;
  /** Reserved for a future credential override flow. Runtime rejects this today. */
  authProfileId?: string;
  defaultCategory?: string;
  defaultThreshold?: number;
  costPerEvalUsd?: number;
  isActive?: boolean;
  circuitBreaker?: Record<string, unknown>;
  retry?: Record<string, unknown>;
}

export interface GuardrailPolicyConstitutionPrinciple {
  principle: string;
  weight: number;
  examples?: string[];
}

export interface GuardrailPolicyCaching {
  enabled?: boolean;
  exactMatch?: boolean;
  semanticMatch?: boolean;
  semanticThreshold?: number;
  defaultTtlSeconds?: number;
}

export interface GuardrailPolicyBudget {
  monthlyLimitUsd: number;
  currentSpendUsd?: number;
  overspendAction: 'downgrade' | 'disable_model_checks' | 'alert_only';
}

export interface GuardrailPolicy {
  _id: string;
  name: string;
  description?: string;
  rules: GuardrailPolicyRule[];
  isActive: boolean;
  scope: {
    type: 'tenant' | 'project' | 'agent';
    projectId?: string;
    agentDefId?: string;
  };
  status?: 'draft' | 'active' | 'archived';
  settings?: GuardrailPolicySettings;
  providerOverrides?: GuardrailPolicyProviderOverride[];
  constitution?: GuardrailPolicyConstitutionPrinciple[];
  caching?: GuardrailPolicyCaching;
  budget?: GuardrailPolicyBudget;
  createdAt: string;
  updatedAt: string;
}

export interface GuardrailPoliciesResponse {
  success: boolean;
  data: GuardrailPolicy[];
}

export interface CreatePolicyInput {
  name: string;
  description?: string;
  rules: GuardrailPolicyRule[];
  isActive?: boolean;
  scope: {
    type: 'tenant' | 'project' | 'agent';
    projectId?: string;
    agentDefId?: string;
  };
  /** Set to create a tenant-, project-, or agent-scoped policy. */
  scopeType?: 'tenant' | 'project' | 'agent';
  /** Required when scopeType is 'agent' — the agent definition to scope the policy to */
  agentDefId?: string;
  status?: 'draft' | 'active' | 'archived';
  settings?: GuardrailPolicySettings;
  providerOverrides?: GuardrailPolicyProviderOverride[];
  constitution?: GuardrailPolicyConstitutionPrinciple[];
  caching?: GuardrailPolicyCaching;
  budget?: GuardrailPolicyBudget;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const SWR_OPTIONS = {
  refreshInterval: 30_000,
  keepPreviousData: true,
};

export type GuardrailPolicyScopeView = 'project' | 'tenant';

function buildGuardrailPoliciesUrl(
  projectId: string | null,
  scope: GuardrailPolicyScopeView,
  params?: Record<string, string>,
): string | null {
  if (scope === 'project' && !projectId) {
    return null;
  }

  const searchParams = new URLSearchParams();
  if (scope === 'project' && projectId) {
    searchParams.set('projectId', projectId);
  }

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      searchParams.set(key, value);
    }
  }

  const query = searchParams.toString();
  return `/api/admin/guardrail-policies${query ? `?${query}` : ''}`;
}

// =============================================================================
// PROVIDERS HOOK (tenant-scoped)
// =============================================================================

export function useGuardrailProviders() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const key = isAuthenticated ? '/api/admin/guardrail-providers' : null;

  const { data, error, isLoading, mutate } = useSWR<GuardrailProvidersResponse>(key, SWR_OPTIONS);

  const createProvider = async (input: CreateProviderInput): Promise<void> => {
    const res = await apiFetch('/api/admin/guardrail-providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const errBody =
        typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
      const errField = errBody.error;
      const msg =
        typeof errField === 'string'
          ? errField
          : errField && typeof errField === 'object' && 'message' in errField
            ? String((errField as { message: unknown }).message)
            : 'Failed to create guardrail provider';
      throw new Error(msg);
    }
    await mutate();
  };

  const updateProvider = async (
    providerId: string,
    input: Partial<CreateProviderInput>,
  ): Promise<void> => {
    const res = await apiFetch(
      `/api/admin/guardrail-providers?providerId=${encodeURIComponent(providerId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const errBody =
        typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
      const errField = errBody.error;
      const msg =
        typeof errField === 'string'
          ? errField
          : errField && typeof errField === 'object' && 'message' in errField
            ? String((errField as { message: unknown }).message)
            : 'Failed to update guardrail provider';
      throw new Error(msg);
    }
    await mutate();
  };

  const deleteProvider = async (providerId: string): Promise<void> => {
    const res = await apiFetch(
      `/api/admin/guardrail-providers?providerId=${encodeURIComponent(providerId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const errBody =
        typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
      const errField = errBody.error;
      const msg =
        typeof errField === 'string'
          ? errField
          : errField && typeof errField === 'object' && 'message' in errField
            ? String((errField as { message: unknown }).message)
            : 'Failed to delete guardrail provider';
      throw new Error(msg);
    }
    await mutate();
  };

  const testProvider = async (
    providerId: string,
  ): Promise<{ success: boolean; latencyMs?: number; error?: string }> => {
    const res = await apiFetch(
      `/api/admin/guardrail-providers?providerId=${encodeURIComponent(providerId)}&action=test`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    const body = await res.json().catch(() => ({ success: false }));
    if (!res.ok) {
      const errBody =
        typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      const errField = errBody.error;
      const msg =
        typeof errField === 'string'
          ? errField
          : errField && typeof errField === 'object' && 'message' in errField
            ? String((errField as { message: unknown }).message)
            : 'Failed to test guardrail provider';
      throw new Error(msg);
    }
    return body as { success: boolean; latencyMs?: number; error?: string };
  };

  const activateProvider = async (providerId: string, isActive: boolean): Promise<void> => {
    await updateProvider(providerId, { isActive });
  };

  return {
    providers: data?.data ?? [],
    isLoading,
    error: error ? String(error) : null,
    mutate,
    createProvider,
    updateProvider,
    deleteProvider,
    testProvider,
    activateProvider,
  };
}

// =============================================================================
// POLICIES HOOK
// =============================================================================

export function useGuardrailPolicies(
  projectId: string | null,
  options?: { scope?: GuardrailPolicyScopeView },
) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const scope = options?.scope ?? 'project';
  const key = isAuthenticated ? buildGuardrailPoliciesUrl(projectId, scope) : null;

  const { data, error, isLoading, mutate } = useSWR<GuardrailPoliciesResponse>(key, SWR_OPTIONS);

  const createPolicy = async (input: CreatePolicyInput): Promise<void> => {
    const url = buildGuardrailPoliciesUrl(projectId, scope);
    if (!url) return;
    const res = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const errBody =
        typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
      const errField = errBody.error;
      const msg =
        typeof errField === 'string'
          ? errField
          : errField && typeof errField === 'object' && 'message' in errField
            ? String((errField as { message: unknown }).message)
            : 'Failed to create guardrail policy';
      throw new Error(msg);
    }
    await mutate();
  };

  const updatePolicy = async (
    policyId: string,
    input: Partial<CreatePolicyInput>,
  ): Promise<{ autoDeactivated: boolean }> => {
    const url = buildGuardrailPoliciesUrl(projectId, scope, {
      policyId,
    });
    if (!url) return { autoDeactivated: false };
    const res = await apiFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const errBody =
        typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
      const errField = errBody.error;
      const msg =
        typeof errField === 'string'
          ? errField
          : errField && typeof errField === 'object' && 'message' in errField
            ? String((errField as { message: unknown }).message)
            : 'Failed to update guardrail policy';
      throw new Error(msg);
    }
    const body = (await res.json().catch(() => ({}))) as { autoDeactivated?: boolean };
    await mutate();
    return { autoDeactivated: body.autoDeactivated === true };
  };

  const deletePolicy = async (policyId: string): Promise<void> => {
    const url = buildGuardrailPoliciesUrl(projectId, scope, {
      policyId,
    });
    if (!url) return;
    const res = await apiFetch(url, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const errBody =
        typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
      const errField = errBody.error;
      const msg =
        typeof errField === 'string'
          ? errField
          : errField && typeof errField === 'object' && 'message' in errField
            ? String((errField as { message: unknown }).message)
            : 'Failed to delete guardrail policy';
      throw new Error(msg);
    }
    await mutate();
  };

  const activatePolicy = async (policyId: string, isActive: boolean): Promise<void> => {
    const activateUrl = buildGuardrailPoliciesUrl(projectId, scope, {
      policyId,
      action: 'activate',
    });
    if (!activateUrl) return;

    if (isActive) {
      // Activate via dedicated POST endpoint (deactivates other policies)
      const res = await apiFetch(activateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const errBody =
          typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
        const errField = errBody.error;
        const msg =
          typeof errField === 'string'
            ? errField
            : errField && typeof errField === 'object' && 'message' in errField
              ? String((errField as { message: unknown }).message)
              : 'Failed to activate guardrail policy';
        throw new Error(msg);
      }
    } else {
      // Deactivate via PUT (set status to draft)
      await updatePolicy(policyId, { status: 'draft' });
    }
    await mutate();
  };

  return {
    policies: data?.data ?? [],
    isLoading,
    error: error ? String(error) : null,
    mutate,
    createPolicy,
    updatePolicy,
    deletePolicy,
    activatePolicy,
  };
}
