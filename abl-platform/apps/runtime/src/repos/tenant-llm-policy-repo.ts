/**
 * Tenant LLM Policy Repository
 *
 * CRUD operations for tenant-level LLM policies.
 * Used by: routes/tenant-llm-policy.ts, services/llm/model-resolution.ts
 */

// ─── Defaults ─────────────────────────────────────────────────────────────

const POLICY_DEFAULTS = {
  allowedProviders: [] as string[],
  credentialPolicy: 'org_first',
  monthlyTokenBudget: 0,
  dailyTokenBudget: 0,
  defaultModel: null,
  defaultFastModel: null,
  defaultVoiceModel: null,
  maxRequestsPerMinute: Number(process.env.LLM_POLICY_MAX_RPM) || 0,
  allowProjectCredentials: true,
  platformDemoEnabled: false,
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────────

function normalizeId<T extends Record<string, any>>(doc: T | null): T | null {
  if (!doc) return null;
  if (doc._id != null && doc.id == null) {
    (doc as any).id = typeof doc._id === 'object' ? doc._id.toString() : doc._id;
  }
  return doc;
}

// ─── Queries ──────────────────────────────────────────────────────────────

export async function findLLMPolicyByTenantId(tenantId: string): Promise<any | null> {
  const { TenantLLMPolicy } = await import('@agent-platform/database/models');
  return normalizeId(await TenantLLMPolicy.findOne({ tenantId }).lean());
}

export async function findLLMPolicyOrDefaults(tenantId: string): Promise<any> {
  const policy = await findLLMPolicyByTenantId(tenantId);
  if (policy) return policy;
  return { tenantId, ...POLICY_DEFAULTS };
}

export async function upsertLLMPolicy(
  tenantId: string,
  data: Record<string, unknown>,
): Promise<any> {
  const { TenantLLMPolicy } = await import('@agent-platform/database/models');
  const doc = await TenantLLMPolicy.findOneAndUpdate(
    { tenantId },
    { $set: { ...data, tenantId } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return normalizeId(doc);
}
