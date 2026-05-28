# Tenant LLM Policy — Low-Level Design

## Implementation Structure

### Core Files

| File                                                      | Purpose                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/runtime/src/routes/tenant-llm-policy.ts`            | REST API: GET/PUT with Zod validation, RBAC, tenant verification, audit logging |
| `apps/runtime/src/repos/tenant-llm-policy-repo.ts`        | Repository: findLLMPolicyByTenantId, findLLMPolicyOrDefaults, upsertLLMPolicy   |
| `apps/runtime/src/services/llm/model-resolution.ts`       | Consumer: enforceProviderAllowlist, resolveCredential by credentialPolicy       |
| `apps/runtime/src/repos/llm-resolution-repo.ts`           | findTenantLLMPolicy (used by model resolution)                                  |
| `packages/database/src/models/tenant-llm-policy.model.ts` | Mongoose model: ITenantLLMPolicy schema, indexes, plugins                       |

### Test Files

| File                                                                            | Type | Focus                                                 |
| ------------------------------------------------------------------------------- | ---- | ----------------------------------------------------- |
| `apps/runtime/src/__tests__/model-resolution-comprehensive.test.ts`             | unit | Provider allowlist, credential policy, default models |
| `apps/runtime/src/__tests__/credential-chain-analyzer.test.ts`                  | unit | Diagnostic output with policy context                 |
| `apps/runtime/src/__tests__/tenant-models.test.ts`                              | unit | Tenant model interactions                             |
| `apps/runtime/src/__tests__/llm-services.test.ts`                               | unit | LLM service setup                                     |
| `apps/runtime/src/__tests__/auth-profile/model-resolution-auth-profile.test.ts` | unit | Auth profile + policy                                 |

## Module T-1: REST API Route

### Route Registration

```typescript
// Mount: /api/tenants/:tenantId/llm-policy
// Global middleware: authMiddleware, tenantRateLimit('request')
// OpenAPI tags: ['Tenant LLM Policy']
```

### Endpoints

| Method | Path | Permission         | Schema                                                                            |
| ------ | ---- | ------------------ | --------------------------------------------------------------------------------- |
| GET    | `/`  | `credential:read`  | Response: `{ success, policy: policyResponseSchema }`                             |
| PUT    | `/`  | `credential:write` | Body: `policyUpdateSchema`, Response: `{ success, policy: policyResponseSchema }` |

### Tenant Verification

```typescript
function getTenantId(req): string | null {
  // 1. Get tenantId from auth context
  // 2. Compare with URL param :tenantId
  // 3. Return null if mismatch (results in 403)
}
```

### Validation Schemas

**policyResponseSchema** (GET/PUT response):

- credentialPolicy: string
- allowedProviders: string[]
- allowProjectCredentials: boolean
- platformDemoEnabled: boolean
- monthlyTokenBudget: number
- dailyTokenBudget: number
- maxRequestsPerMinute: number
- defaultModel: string | null
- defaultFastModel: string | null
- defaultVoiceModel: string | null

**policyUpdateSchema** (PUT body):

- credentialPolicy: enum [org_first, user_first, org_only, user_only] (optional)
- allowedProviders: string[] (optional, validated against VALID_PROVIDERS)
- allowProjectCredentials: boolean (optional)
- monthlyTokenBudget: number >= 0 (optional)
- dailyTokenBudget: number >= 0 (optional)
- maxRequestsPerMinute: number >= 0 (optional)
- defaultModel: string | null (optional)
- defaultFastModel: string | null (optional)
- defaultVoiceModel: string | null (optional)

### Supported Providers (VALID_PROVIDERS)

openai, anthropic, azure, google, gemini, vertex, vertex_ai, google_vertex, groq, mistral, fireworks, togetherai, perplexity, deepseek, xai, bedrock, cohere, ultravox, custom

### platformDemoEnabled Protection

The PUT handler explicitly excludes `platformDemoEnabled` from the allowed update fields:

```typescript
const allowedFields = [
  'credentialPolicy',
  'allowedProviders',
  'allowProjectCredentials',
  'monthlyTokenBudget',
  'dailyTokenBudget',
  'maxRequestsPerMinute',
  'defaultModel',
  'defaultFastModel',
  'defaultVoiceModel',
];
// platformDemoEnabled intentionally excluded — superadmin only
```

## Module T-2: Repository Layer

### Key Functions

```typescript
// Defaults returned when no policy document exists
const POLICY_DEFAULTS = {
  allowedProviders: [],
  credentialPolicy: 'org_first',
  monthlyTokenBudget: 0,
  dailyTokenBudget: 0,
  defaultModel: null,
  defaultFastModel: null,
  defaultVoiceModel: null,
  maxRequestsPerMinute: 600,
  allowProjectCredentials: true,
  platformDemoEnabled: false,
};

// Direct MongoDB lookup
async function findLLMPolicyByTenantId(tenantId: string): Promise<doc | null>;

// Lookup with fallback to defaults
async function findLLMPolicyOrDefaults(tenantId: string): Promise<doc>;

// Upsert: create if missing, update if exists
async function upsertLLMPolicy(tenantId: string, data: Record<string, unknown>): Promise<doc>;
```

### Upsert Implementation

Uses `findOneAndUpdate` with `{ upsert: true, setDefaultsOnInsert: true }` to atomically create or update. The `$set` operator applies only the provided fields, preserving existing values for omitted fields.

## Module T-3: Model Resolution Integration

### Provider Allowlist Enforcement

```typescript
private enforceProviderAllowlist(
  tenantPolicy: TenantLLMPolicyRow,
  provider: string,
  modelId: string,
): void {
  const allowed = parseJsonField(tenantPolicy.allowedProviders) || [];
  if (!Array.isArray(allowed) || allowed.length === 0) return; // empty = all allowed
  if (!allowed.includes(provider)) {
    throw new AppError(
      `Provider '${provider}' (model: ${modelId}) is not allowed for this tenant.`,
      { ...ErrorCodes.FORBIDDEN },
    );
  }
}
```

### Credential Policy Resolution

The `resolveCredential` method uses the policy's `credentialPolicy` to determine the lookup order:

| Policy       | First Try         | Fallback          |
| ------------ | ----------------- | ----------------- |
| `org_first`  | Tenant credential | User credential   |
| `user_first` | User credential   | Tenant credential |
| `org_only`   | Tenant credential | None              |
| `user_only`  | User credential   | None              |

After both attempts, a last-resort fallback checks for TenantModel connections with the matching provider.

## Module T-4: Mongoose Model

### Schema Definition

```typescript
const TenantLLMPolicySchema = new Schema<ITenantLLMPolicy>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    allowedProviders: { type: [String], default: [] },
    credentialPolicy: { type: String, required: true },
    monthlyTokenBudget: { type: Number, required: true },
    dailyTokenBudget: { type: Number, required: true },
    defaultModel: { type: String, default: null },
    defaultFastModel: { type: String, default: null },
    defaultVoiceModel: { type: String, default: null },
    maxRequestsPerMinute: { type: Number, required: true },
    allowProjectCredentials: { type: Boolean, required: true },
    platformDemoEnabled: { type: Boolean, required: true },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'tenant_llm_policies' },
);

// Plugins
TenantLLMPolicySchema.plugin(tenantIsolationPlugin);

// Indexes
TenantLLMPolicySchema.index({ tenantId: 1 }, { unique: true });
```

## Known Gaps

| ID      | Description                                                   | Severity |
| ------- | ------------------------------------------------------------- | -------- |
| GAP-001 | No dedicated test for tenant-llm-policy REST route            | High     |
| GAP-002 | No real-time token budget enforcement                         | High     |
| GAP-003 | No RBAC test for credential:read/write on this route          | High     |
| GAP-004 | No cross-tenant access test                                   | High     |
| GAP-005 | No Studio UI for policy management                            | Medium   |
| GAP-006 | No caching of policy (DB query per fetch)                     | Low      |
| GAP-007 | platformDemoEnabled only settable via direct DB or superadmin | Low      |

## Dependencies

- `@agent-platform/database/models` — TenantLLMPolicy Mongoose model
- `@agent-platform/shared-auth` — requirePermission RBAC middleware
- `@agent-platform/openapi/express` — OpenAPI router
- `@agent-platform/shared-observability` — getCurrentRequestId
- ModelResolutionService — primary consumer of policy at runtime

## Exit Criteria

- Policy stored and retrieved correctly per tenant
- Provider allowlist enforced (FORBIDDEN for unapproved providers)
- Credential policy resolution order correct for all four modes
- platformDemoEnabled not writable from tenant API
- Audit log emitted for all policy mutations
- Tenant verification prevents cross-tenant access
