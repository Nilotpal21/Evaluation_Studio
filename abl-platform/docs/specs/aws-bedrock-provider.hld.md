# HLD: AWS Bedrock Provider Integration

**Feature Spec**: [`docs/features/sub-features/aws-bedrock-provider.md`](../features/sub-features/aws-bedrock-provider.md)
**Test Spec**: [`docs/testing/sub-features/aws-bedrock-provider.md`](../testing/sub-features/aws-bedrock-provider.md)
**Status**: APPROVED
**Author**: Prasanna Arikala
**Date**: 2026-04-28
**Jira**: ABLP-674

---

## 1. Problem Statement

The Model Hub (`docs/features/model-hub.md`) supports configuring AWS Bedrock connections in Studio UI and stores `authConfig` (region, accessKeyId, secretAccessKey) encrypted in the `llm_credentials` collection. However, **runtime execution silently falls back to the OpenAI-compatible default** because `packages/llm/src/provider-factory.ts` has no `case 'bedrock'` and `@ai-sdk/amazon-bedrock` is not installed.

Any agent session configured with a Bedrock model produces "OpenAI API error" responses. This blocks FloridaBlue — a HIPAA/PHI-sensitive customer — from going live. FloridaBlue's compliance requirements additionally mandate that no long-lived AWS credentials be stored in the database, requiring ambient-credential (IRSA) support that the current UI and backend do not provide.

**Two gaps to close:**

1. **Phase 1**: Add `case 'bedrock'` to `createVercelProvider()` with explicit AWS credential support — unblocks any cloud deployment.
2. **Phase 2**: Add IRSA ambient credential support + Studio UI toggle — meets FloridaBlue's HIPAA/PHI compliance requirement.

---

## 2. Goal

Enable end-to-end AWS Bedrock Claude model inference on the ABL platform. Phase 1 adds explicit AWS credential support (works on any cloud). Phase 2 adds IRSA ambient credential support (no stored keys, satisfies FloridaBlue HIPAA/PHI compliance). Both phases must deliver streaming responses, tool calling, multi-region routing, provider-specific error messages, and the same observability contract as existing providers — all without any schema or API changes.

### FR Traceability

| FR   | Description                                           | Design Section                                               | LLD Phase |
| ---- | ----------------------------------------------------- | ------------------------------------------------------------ | --------- |
| FR-1 | Explicit AWS credentials execution                    | §4 Data Flow (explicit), §5 Concern #1, §7 API Design        | A         |
| FR-2 | IAM role ambient credentials execution                | §4 Data Flow (ambient), §5 Concern #4, §5 Concern #6         | B         |
| FR-3 | Studio UI credential mode toggle                      | §4 Component Diagram, §5 Concern #3 (API Contract)           | E         |
| FR-4 | Streaming responses and tool calling parity           | §3 Option A Pros, §4 Sequence Diagram                        | A         |
| FR-5 | Provider-specific error messages                      | §5 Concern #5, §7 Error Responses table, Open Q#3            | A         |
| FR-6 | Provider cache key differentiation by region + mode   | §4 Component Diagram, §7 `buildProviderCacheKey()` interface | C         |
| FR-7 | SearchAI pipeline authConfig passthrough              | §4 Component Diagram, §7 API Design, §9 Dependencies         | D         |
| FR-8 | Region defaults (authConfig → AWS_REGION → us-east-1) | §4 Data Flow step 4, §7 `BedrockAuthConfig` interface        | A         |

---

## 3. Alternatives Considered

### Option A: Vercel AI SDK Native Integration (CHOSEN)

**Description**: Add `@ai-sdk/amazon-bedrock@^4.0.0` to `packages/llm`. Add `case 'bedrock'` to the existing `createVercelProvider()` factory. Both explicit and ambient credential paths handled within this single case block using the SDK's `createAmazonBedrock()` factory.

**Pros**:

- Consistent with all 15 existing providers (19 case labels) in `provider-factory.ts`
- Streaming, tool calling, and error handling provided by the SDK — zero custom HTTP code
- `credentialProvider` callback in `AmazonBedrockProviderSettings` is the designed extension point for IRSA — no hacks needed
- No additional infrastructure (no proxy, no sidecar)
- `@ai-sdk/amazon-bedrock@^4.0.0` shares `@ai-sdk/provider@3.0.8` with existing providers — no version conflict

**Cons**:

- Adds two new npm dependencies (`@ai-sdk/amazon-bedrock`, `@aws-sdk/credential-providers`)
- `aws4fetch` (used internally) patches `fetch()` — nock interception needed for tests

**Effort**: M (3–4 days for both phases)

---

### Option B: Bypass Vercel AI SDK — Direct AWS Bedrock HTTP Client

**Description**: Write a custom AWS SigV4-signed HTTP client that calls the Bedrock Converse API directly, returning `LanguageModel` objects that implement the Vercel AI SDK interface.

**Pros**:

- No new SDK dependency in `packages/llm`
- Full control over request signing and error handling

**Cons**:

- Enormous implementation effort: SigV4 signing, streaming eventstream binary decoding, tool calling schema translation, error normalization, credential refresh
- Zero precedent: ALL 15 existing providers (19 case labels) in `provider-factory.ts` use Vercel AI SDK factories — direct HTTP would be an architectural inconsistency in the runtime
- Ongoing maintenance burden; SDK updates for new model capabilities require manual sync
- `@ai-sdk/amazon-bedrock` already implements this correctly — reimplementing it is pure duplication

**Effort**: XL (3–4 weeks)
**Rejected**: Prohibitive effort; architectural inconsistency; no upside over Option A.

---

### Option C: LiteLLM Proxy as Bedrock Gateway

**Description**: Route Bedrock calls through the existing LiteLLM proxy integration (`case 'litellm'` in `provider-factory.ts`). Configure LiteLLM with Bedrock as a backend. Bedrock connections use `provider: 'litellm'` with Bedrock routing in the proxy config.

**Pros**:

- No new dependencies in `packages/llm`
- LiteLLM handles Bedrock's request format and auth internally

**Cons**:

- Requires a LiteLLM proxy deployment inside the customer's infrastructure — this is an operational dependency FloridaBlue would need to run and maintain
- IRSA requires LiteLLM to run inside the EKS cluster with the IAM role — now two services need IRSA, not one
- Credentials still must be passed from the platform to LiteLLM somehow — the stored-credentials problem is not eliminated
- Adds a synchronous network hop to every inference call (latency regression)
- Existing `case 'litellm'` routes all traffic through one proxy URL — per-connection region routing would require LiteLLM model routing config, adding operational complexity

**Effort**: M (implementation-wise), L–XL (operational burden on customer)
**Rejected**: Operational dependency and latency regression outweigh the marginal benefit.

---

## 4. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  Studio UI (apps/studio)                                            │
│                                                                     │
│  AddConnectionDialog.tsx  ──── POST /api/tenant-credentials ──────→ │
│  [Phase E: IAM role toggle]        { authType: 'aws_iam',           │
│                                      authConfig: { region, ... } }  │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Runtime (apps/runtime)                                             │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  LLMCredentialService → MongoDB (llm_credentials)           │   │
│  │  encryptionPlugin encrypts authConfig before storage        │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  Agent Session execution path:                                      │
│  SessionLLMClient → ModelResolutionService.resolve()               │
│    → LLMCredential (decrypted) → { provider, authConfig }          │
│    → getOrCreateProvider(provider, apiKey, baseUrl, modelId,       │
│                           useResponsesApi, authConfig)              │
│    → buildProviderCacheKey(...)  ← [Phase C: extend authSuffix]    │
│    → [cache miss] createVercelProvider('bedrock', ...)             │
│                   ← [Phase A+B: add case 'bedrock']                │
│    → LanguageModel  ──────────────────────────────────────────→    │
│                                              aws4fetch              │
│                                                 ↓                   │
│                            AWS Bedrock Converse API                 │
│                 https://bedrock-runtime.{region}.amazonaws.com      │
│                                                                     │
│  SearchAI Pipeline execution path:                                  │
│  model-resolver.ts:resolvePipelineModel()  ← [Phase D: add authConfig]│
│    → createVercelProvider('bedrock', ..., authConfig) → Bedrock    │
└─────────────────────────────────────────────────────────────────────┘
```

### Component Diagram

```
packages/llm (LLD Phases A + B)
├── provider-factory.ts
│     └── createVercelProvider()
│           └── case 'bedrock':                         ← NEW
│                 BedrockAuthConfig interface            ← NEW
│                 explicit path: createAmazonBedrock({ region, accessKeyId, secretAccessKey })
│                 ambient path:  createAmazonBedrock({ region, credentialProvider: fromNodeProviderChain() })
│
apps/runtime (LLD Phases C + D)
├── services/llm/provider-cache.ts
│     └── buildProviderCacheKey()                       ← NEW (extracted from session-llm-client)
│           encodes: region + useAmbientCredentials in authSuffix
│
├── services/llm/session-llm-client.ts
│     └── getOrCreateProvider()
│           authSuffix: extended to include region + useAmbientCredentials  ← MODIFIED
│
├── services/llm/utils.ts                              ← NEW (extracted from model-resolution.ts)
│     └── parseJsonField()
│
├── services/pipeline/model-resolver.ts
│     └── resolveTenantModel()
│           line 142: pass authConfig as 6th arg       ← MODIFIED
│           import parseJsonField from utils.ts        ← NEW import
│
apps/studio (LLD Phase E)
├── components/admin/AddConnectionDialog.tsx
│     └── newCredBedrockMode: 'explicit' | 'iam_role'  ← NEW state
│           radio toggle + conditional rendering        ← NEW UI
│           handleCreateCredential: ambient mode path   ← MODIFIED
│
packages/i18n (LLD Phase E)
└── locales/en/studio.json                             ← NEW strings
```

### Data Flow: Explicit Credentials (Phase 1)

```
1. Tenant admin: POST /api/tenant-credentials
   { authType: 'aws_iam', apiKey: 'AKIATEST', authConfig: { region: 'us-east-1', accessKeyId: 'AKIA...', secretAccessKey: '...' } }
   → encryptionPlugin encrypts authConfig before MongoDB save

2. Agent execution: POST /api/sessions/:id/chat
   → SessionLLMClient.getOrCreateProvider(
       provider='bedrock', apiKey='AKIA...', baseUrl=undefined,
       modelId='anthropic.claude-sonnet-4-6-v1:0',
       useResponsesApi=undefined,
       authConfig={ region: 'us-east-1', accessKeyId: 'AKIA...', secretAccessKey: '...' }
     )

3. buildProviderCacheKey('bedrock', sha256(apiKey)[0:12], undefined, modelId, authConfig)
   → key: "bedrock:<hash>:<modelId>:region=us-east-1:ambient=false"
   → [cache miss]

4. createVercelProvider('bedrock', 'AKIA...', undefined, 'anthropic.claude-sonnet-4-6-v1:0', undefined,
     { region: 'us-east-1', accessKeyId: 'AKIA...', secretAccessKey: '...' })
   → region = authConfig.region || process.env.AWS_REGION || 'us-east-1'
   → validate: accessKeyId + secretAccessKey present
   → createAmazonBedrock({ region: 'us-east-1', accessKeyId: 'AKIA...', secretAccessKey: '...' })('anthropic.claude-sonnet-4-6-v1:0')
   → LanguageModel (Bedrock Converse client)

5. setCachedProvider(key, provider, tenantId)   // 30-min TTL

6. ai.streamText(model, messages, tools)
   → model.doStream()
   → aws4fetch signs request (SigV4, us-east-1)
   → POST https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-sonnet-4-6-v1:0/converse-stream
   → streaming response → SessionLLMClient → SSE to client
```

### Data Flow: Ambient Credentials (Phase 2)

```
1. Tenant admin: POST /api/tenant-credentials
   { authType: 'aws_iam', apiKey: '__iam_role__', authConfig: { region: 'us-east-1', useAmbientCredentials: true } }
   → encryptionPlugin encrypts authConfig (no AWS keys stored)

2. Agent execution same as above until step 4:

4. createVercelProvider('bedrock', '__iam_role__', undefined, 'anthropic.claude-sonnet-4-6-v1:0', undefined,
     { region: 'us-east-1', useAmbientCredentials: true })
   → region = 'us-east-1'
   → validate: useAmbientCredentials === true → ambient path
   → import { fromNodeProviderChain } from '@aws-sdk/credential-providers'  // lazy import
   → createAmazonBedrock({
       region: 'us-east-1',
       credentialProvider: () => fromNodeProviderChain({ clientConfig: { region: 'us-east-1' } })()
     })('anthropic.claude-sonnet-4-6-v1:0')
   → LanguageModel (with IRSA credential chain)

5. setCachedProvider(key, provider, tenantId)   // 30-min TTL
   // Within TTL: AWS SDK's internal credential caching handles IRSA refresh
   //             (re-reads token file before expiry, transparent to caller)

6. aws4fetch calls credentialProvider() on every request → AWS SDK returns cached/refreshed creds
   → POST https://bedrock-runtime.us-east-1.amazonaws.com/model/.../converse-stream
```

### Sequence Diagram (Credential Resolution + Provider Instantiation)

```
Client          SessionLLMClient   ModelResolutionService   MongoDB   providerCache   createVercelProvider   Bedrock API
  │                   │                     │                  │            │                  │                   │
  │──chat request────→│                     │                  │            │                  │                   │
  │                   │──resolve(ctx)───────→│                  │            │                  │                   │
  │                   │                     │──findOne(TenantModel,tenantId)→│            │                  │                   │
  │                   │                     │←──TenantModel─────────────────│            │                  │                   │
  │                   │                     │──findOne(LLMCredential)──────→│            │                  │                   │
  │                   │                     │←──[decrypted authConfig]──────│            │                  │                   │
  │                   │←{provider,apiKey,authConfig}────────────│            │                  │                   │
  │                   │──buildCacheKey(...)──────────────────────────────────│                  │                   │
  │                   │──getCachedProvider(key)─────────────────────────────→│                  │                   │
  │                   │←─undefined (miss)──────────────────────────────────│                  │                   │
  │                   │───────────────────────────────────────────────────────────────────────→│                   │
  │                   │    createVercelProvider('bedrock', apiKey, undefined, modelId, undefined, authConfig)       │
  │                   │←──LanguageModel──────────────────────────────────────────────────────│                   │
  │                   │──setCachedProvider(key, provider)────────────────────→│                  │                   │
  │                   │──ai.streamText(model,messages,tools)                                                       │
  │                   │                                                                                            │──POST converse-stream→│
  │                   │                                                                                            │←─stream chunks───────│
  │←─SSE chunks──────│                                                                                            │                   │
```

---

## 5. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | `LLMCredential` and `TenantModel` are tenant-scoped (`tenantId` field, indexed). `ModelResolutionService.resolve()` includes `tenantId` in all credential lookups (source: `model-resolution.ts:1522`). `model-resolver.ts` passes `tenantId` to all `LLMCredential.findOne()` calls. Cross-tenant credential access returns 404 (not 403 — existence not leaked). Provider cache key includes hashed `apiKey` (tenant-scoped by construction). **Ambient mode constraint**: the platform IAM role is shared across all tenants on the same EKS pod — only safe on dedicated single-tenant clusters. Documented in ops guide; no platform enforcement yet (GAP-004).                                                                                                                                                                                                                                                                                                            |
| 2   | **Data Access Pattern** | No new collections. `authConfig: Schema.Types.Mixed` already exists in `llm_credentials` and is encrypted at rest by `encryptionPlugin`. `model-resolution.ts:1522` already reads `parseJsonField(connection.authConfig)` — this is the established pattern. `model-resolver.ts` must adopt the same pattern after the Phase D fix. `parseJsonField()` extracted to `apps/runtime/src/services/llm/utils.ts` (shared utility, not duplicated). Provider cache is a process-level singleton (`provider-cache.ts`) — pod-local, no Redis required.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3   | **API Contract**        | No new runtime endpoints. No new Studio API routes. Existing `POST /api/tenant-credentials` accepts `{ authType: 'aws_iam', authConfig: { region, accessKeyId?, secretAccessKey?, sessionToken?, useAmbientCredentials? } }` — already supported by the Mixed schema. Existing `POST /api/sessions/:id/chat` and `POST /api/sessions/:id/stream` route Bedrock execution transparently. `createVercelProvider()` signature is unchanged (6 params, `authConfig` is param 6 — already present).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 4   | **Security Surface**    | (a) `authConfig` encrypted at rest via tenant DEK (`encryptionPlugin`, AES-256-GCM). (b) `"__iam_role__"` sentinel is also encrypted (benign content, encrypted for consistency). (c) Credentials exist in plaintext only in memory for the duration of `createVercelProvider()`. (d) IRSA: no credentials stored in DB. CloudTrail auto-logs all `bedrock:InvokeModel` calls. (e) **Error sanitization**: Bedrock errors must not leak region, model ID, or credentials in user-visible surfaces. The runtime LLM error classifier must handle Bedrock-specific error codes (`AccessDeniedException`, `ValidationException`, `ThrottlingException`, `ResourceNotFoundException`) and map them to provider-specific but non-leaking messages. Studio's `sanitizeError()` provides the final presentation layer. (f) Minimum IAM policy documented: `bedrock:InvokeModel` + `bedrock:InvokeModelWithResponseStream` on `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | **Pre-flight** (factory-level): `createVercelProvider('bedrock', ...)` throws a descriptive `Error` with message containing field name if credential is incomplete (e.g., `accessKeyId` present but `secretAccessKey` missing). This prevents silent fallback. **API-level**: `@ai-sdk/amazon-bedrock` wraps AWS API errors as `AISDKError` subtypes with `provider: 'bedrock'`. **Classification**: The runtime LLM error classifier (`apps/runtime/src/services/llm/classify-llm-error.ts`) intercepts errors and maps them to provider-specific messages — never exposes "OpenAI API error" for Bedrock connections. This file currently has no Bedrock-specific handling and must be extended in Phase A to cover Bedrock error codes (see §7 Error Responses table). **IRSA failure**: `fromNodeProviderChain()` throws if no credential source found (e.g., running outside AWS) — this error must be caught and re-thrown as "AWS Bedrock: credential resolution failed — ensure the platform runs in AWS with an IAM role attached." |
| 6   | **Failure Modes** | **Explicit creds**: Wrong/expired keys → Bedrock 401 → provider-specific error surfaced. Credential rotation → `clearProviderCache(tenantId)` triggered on credential update → new provider instantiated within one request. **Ambient creds**: IRSA token rotation is handled transparently by `fromNodeProviderChain()` (refreshes credentials before expiry within the 30-minute provider cache TTL). Non-AWS environment with ambient mode → `fromNodeProviderChain()` throws immediately. Wrong region → Bedrock 400/404 → provider-specific error. Bedrock 5xx / network partition → `ai` package propagates as stream error → session error handling path. Provider cache concurrency: two concurrent cache misses for the same key both call `createVercelProvider()` — both get equivalent instances, last writer wins in cache. Benign (stateless objects).                                                                                                                                                                        |
| 7   | **Idempotency**   | `createVercelProvider()` is a pure function (synchronous, no side effects, no I/O). Safe to call multiple times with identical inputs — returns equivalent but not identical object instances. Provider cache write is idempotent (same key → same behavior; no destructive side effect). `LLMCredential.create()` for Bedrock credentials follows existing idempotency guarantees (MongoDB `_id` primary key).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 8   | **Observability** | **Traces**: All Bedrock LLM calls emit `TraceEvent`s via the existing `TraceStore` path — no new trace types needed. **Token usage**: Bedrock Converse API returns `{ inputTokens, outputTokens }` in the response `usage` field — maps directly to the `ai` package's `{ usage.promptTokens, usage.completionTokens }`. **Provider attribution**: Provider name `'bedrock'` appears in error trace context. **Cache key debuggability**: `buildProviderCacheKey()` as a pure exported function means the cache key is deterministic and inspectable from known inputs. **IRSA credential resolution**: No new logging needed — `fromNodeProviderChain()` logs internally via AWS SDK.                                                                                                                                                                                                                                                                                                                                                       |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | `createAmazonBedrock()` is synchronous (<1 ms). Provider cache lookup is O(1) Map access. `fromNodeProviderChain()`: async on first resolution, then cached by the AWS SDK until IRSA token expiry (typically 1 hour) — effectively zero overhead for in-flight requests. Bedrock Converse API TTFT is network-dependent (AWS datacenter routing); equivalent to Anthropic direct API for same-region calls. Provider cache max: 500 entries (default). Each Bedrock connection with a unique region+mode combination takes one cache slot. No additional latency vs other SDK providers.                                                                                                                                                                                                         |
| 10  | **Migration Path**     | **Zero data migration**. Existing Bedrock `TenantModel` records created via Studio UI already have `authConfig: { region, accessKeyId, secretAccessKey }` stored encrypted in MongoDB (the UI form writes this today). Existing connections that were silently falling through to the OpenAI default will now correctly route to Bedrock after Phase A/B is deployed. No tenant re-configuration needed for explicit-credentials connections. Ambient-mode connections require Phase E (UI toggle) and re-creating the credential with `useAmbientCredentials: true` — these are new configurations, not migrations.                                                                                                                                                                              |
| 11  | **Rollback Plan**      | Remove `case 'bedrock'` from `provider-factory.ts`. The `default` case resumes — behavior reverts to the pre-feature state (OpenAI-compatible fallback with "OpenAI API error" responses). No schema rollback needed (authConfig is Mixed, no structural change). No API rollback needed (no new endpoints). Package rollback via pnpm lockfile pin. Safe for immediate rollback post-deploy. Risk: very low (purely additive change).                                                                                                                                                                                                                                                                                                                                                            |
| 12  | **Test Strategy**      | **Unit** (`packages/llm/src/__tests__/provider-factory.test.ts`): 6 pure function tests for `case 'bedrock'` — explicit creds, ambient creds, region defaulting (env var + fallback), error paths. No mocks needed (SDK construction is synchronous). **Integration** (`apps/runtime/src/__tests__/bedrock-integration.test.ts`): 6 real-service-boundary tests — `ModelResolutionService` + MongoDB, `buildProviderCacheKey()` pure function, `resolvePipelineModel()` with seeded Bedrock TenantModel. Nock intercepts external Bedrock HTTP. **E2E** (`apps/runtime/src/__tests__/bedrock-e2e.test.ts`): 6 full-stack tests via `startRuntimeServerHarness()` + nock. **Studio Playwright** (`apps/studio/e2e/bedrock-connection-dialog.spec.ts`): 5 UI tests for FR-3 credential mode toggle. |

---

## 6. Data Model

### New Collections / Tables

None. No new collections or tables.

### Modified Collections / Tables

None. No schema changes.

```
Collection: llm_credentials (EXISTING — no schema changes)
Relevant fields for Bedrock:
  authType: 'aws_iam'                          // existing enum value
  encryptedApiKey: '__iam_role__'              // sentinel for ambient mode
                 | 'AKIATEST...'              // explicit mode: real Access Key ID
  authConfig: {                               // Schema.Types.Mixed, encrypted by encryptionPlugin
    region: string,                           // e.g., 'us-east-1' (required)
    accessKeyId?: string,                     // explicit mode only
    secretAccessKey?: string,                 // explicit mode only
    sessionToken?: string,                    // explicit mode, STS temporary creds only
    useAmbientCredentials?: boolean,           // Phase 2: true = IAM role mode
    roleArn?: string,                         // Phase 3 placeholder (reserved, not implemented)
  }

Note: encryptionPlugin encrypts authConfig as a whole field (AES-256-GCM, tenant DEK).
The post-find hook decrypts it on document retrieval. No .lean() on this collection.
```

### Key Relationships

`TenantModelConnection.credentialId` → `LLMCredential._id`

`ModelResolutionService` joins `TenantModel` → `TenantModelConnection` → `LLMCredential` at inference time. Decrypted `authConfig` flows from `LLMCredential` through `ModelResolutionService.resolve()` → `SessionLLMClient.getOrCreateProvider()` → `createVercelProvider('bedrock', ...)`.

---

## 7. API Design

### New Endpoints

None. Bedrock execution uses existing session endpoints.

### Modified Endpoints (Extended Behavior Only)

| Method | Path                              | Change                                                         | Notes                                                                                                         |
| ------ | --------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/tenant-credentials`         | Accepts `authType: 'aws_iam'` with extended `authConfig` shape | Schema already supports `Mixed` authConfig — no route code change needed. Studio form sends the correct body. |
| POST   | `/api/sessions/:sessionId/chat`   | Routes to Bedrock when `provider = 'bedrock'`                  | Factory case wired; no route code change.                                                                     |
| POST   | `/api/sessions/:sessionId/stream` | Routes to Bedrock streaming                                    | Factory case wired; no route code change.                                                                     |

### New Interfaces (in source code, not HTTP APIs)

```typescript
// packages/llm/src/provider-factory.ts (Phase A)
interface BedrockAuthConfig {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  useAmbientCredentials?: boolean;
  roleArn?: string; // Phase 3 placeholder — reserved, not implemented
}
```

```typescript
// apps/runtime/src/services/llm/provider-cache.ts (Phase C)
// Extracted pure function for testability
export function buildProviderCacheKey(
  providerType: string,
  apiKeyHash: string,
  effectiveUrl: string | undefined,
  modelId: string,
  authConfig?: Record<string, unknown>,
): string;
```

```typescript
// apps/runtime/src/services/llm/utils.ts (Phase D prerequisite)
// Extracted from model-resolution.ts for shared use
export function parseJsonField(val: unknown): unknown;
```

### Error Responses

Bedrock-specific error codes that the LLM error classifier must handle:

| AWS Error Code                | HTTP Status | User-Visible Message                                                             |
| ----------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `AccessDeniedException`       | 403         | "AWS Bedrock: authentication failed — check credentials or IAM role permissions" |
| `ValidationException`         | 400         | "AWS Bedrock: invalid request — check model ID and region configuration"         |
| `ThrottlingException`         | 429         | "AWS Bedrock: rate limit exceeded — retry after a moment"                        |
| `ResourceNotFoundException`   | 404         | "AWS Bedrock: model not available in the configured region"                      |
| `ServiceUnavailableException` | 503         | "AWS Bedrock: service temporarily unavailable"                                   |

All error messages must be produced by the runtime error classifier, not by the raw AWS error. Error messages must not contain tenant IDs, model IDs, credential hints, or region values.

---

## 8. Cross-Cutting Concerns

| Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Audit Logging** | `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` are auto-logged by AWS CloudTrail (AWS-side; no platform changes). Runtime audit log entries for LLM execution already capture `provider`, `modelId`, `tenantId`, `sessionId` — Bedrock calls inherit this.                                                                                           |
| **Rate Limiting** | Bedrock's own `ThrottlingException` is the primary rate signal. The existing runtime rate limiter governs API request ingress (tenant-level); no Bedrock-specific limits needed at the platform layer.                                                                                                                                                                  |
| **Caching**       | Provider instances: 30-minute TTL (configurable via `LLM_PROVIDER_CACHE_TTL_SECONDS`). For FloridaBlue's HIPAA deployment, consider setting `LLM_PROVIDER_CACHE_TTL_SECONDS=300` (5 min) to reduce the window of encrypted-credential materialization in memory. Bedrock supports no semantic response caching at the platform level (responses are not deterministic). |
| **Encryption**    | `authConfig` at rest: AES-256-GCM via `encryptionPlugin` with tenant DEK. `encryptedApiKey` (`"__iam_role__"` or real Access Key ID): encrypted by same plugin. In transit: TLS 1.2+ to AWS Bedrock Converse API (enforced by AWS). Credentials in memory: only for duration of `createVercelProvider()` call and the provider instance lifetime (30-min cache TTL).    |

---

## 9. Dependencies

### Upstream (this feature depends on)

| Dependency                               | Type      | Risk | Notes                                                                                                                                      |
| ---------------------------------------- | --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `@ai-sdk/amazon-bedrock@^4.0.0`          | npm (new) | LOW  | 4.x shares `@ai-sdk/provider@3.0.8` with project's existing providers. Verified via `npm view @ai-sdk/amazon-bedrock@4.0.96 dependencies`. |
| `@aws-sdk/credential-providers@^3.998.0` | npm (new) | LOW  | Matches highest existing `@aws-sdk/*` pin (`@aws-sdk/client-lambda@^3.998.0` in `apps/runtime`). Smithy core deduplication guaranteed.     |
| `@agent-platform/database` (existing)    | internal  | NONE | `LLMCredential.authConfig` Mixed field already encrypted. No schema changes.                                                               |
| `ModelResolutionService` (existing)      | internal  | NONE | Already passes `authConfig` via `parseJsonField(connection.authConfig)` at line 1522.                                                      |
| `provider-cache.ts` (existing)           | internal  | LOW  | Needs `buildProviderCacheKey()` extraction (purely additive).                                                                              |
| `model-resolution.ts:parseJsonField()`   | internal  | LOW  | Function extracted to shared utils.ts — no behavior change.                                                                                |

### Downstream (depends on this feature)

| Consumer                                      | Impact                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| All agent sessions using Bedrock TenantModels | Silent failure → correct execution. No regression for non-Bedrock providers. |
| SearchAI pipeline classifier (Bedrock models) | Will work after Phase D fix. Previously: silent wrong-provider fallback.     |
| FloridaBlue staging validation                | Unblocked after Phase B (ambient creds).                                     |

---

## 10. Open Questions & Decisions Needed

1. **Provider cache TTL for FloridaBlue**: The default provider cache TTL is 30 minutes (`LLM_PROVIDER_CACHE_TTL_SECONDS=1800`). For FloridaBlue's HIPAA/PHI deployment, a lower TTL reduces the in-memory window of decrypted credential materialization. Should we document a recommended value (e.g., 5 minutes) in the ops guide, or add a `LLM_PROVIDER_CACHE_TTL_SECONDS` entry to FloridaBlue's Helm values? **Owner**: Platform / FloridaBlue ops. **Blocker**: No — default 30 min is safe for IRSA since AWS SDK handles credential refresh internally.

2. **`fromNodeProviderChain()` credential caching behavior**: **RESOLVED.** Verified during implementation: the AWS SDK (`@aws-sdk/credential-providers`) caches resolved credentials internally and refreshes them before expiry. The 30-minute provider cache TTL (`LLM_PROVIDER_CACHE_TTL_SECONDS=1800`) does not determine IRSA refresh frequency — the SDK manages credential rotation transparently via `fromNodeProviderChain()`. Confirmed against the installed `@aws-sdk/credential-providers@3.x` types.

3. **Bedrock error classifier coverage**: The classifier file `apps/runtime/src/services/llm/classify-llm-error.ts` currently has no Bedrock-specific handling. The LLD must add error pattern matching for `AccessDeniedException`, `ValidationException`, `ThrottlingException`, `ResourceNotFoundException`, and `ServiceUnavailableException` as a Phase A subtask (not a Phase F doc task).

4. **`provisionTenantModel` helper extension scope**: The test spec identifies that `provisionTenantModel()` in `helpers/channel-e2e-bootstrap.ts` and the underlying provisioning route schema must be extended to accept `authConfig` (test prerequisite P-3). This is a non-trivial test infrastructure change. The LLD must decide: (a) extend the existing provisioning route to accept `authConfig` in the connection body (minimal scope, Bedrock-only), or (b) make `authConfig` a general-purpose field in the provisioning route (broader scope, future providers benefit).

---

## 11. References

- **Feature spec**: `docs/features/sub-features/aws-bedrock-provider.md`
- **Test spec**: `docs/testing/sub-features/aws-bedrock-provider.md`
- **Parent HLD**: `docs/specs/model-hub.hld.md`
- **Provider factory**: `packages/llm/src/provider-factory.ts`
- **Provider cache**: `apps/runtime/src/services/llm/provider-cache.ts`
- **Session LLM client**: `apps/runtime/src/services/llm/session-llm-client.ts`
- **Model resolution**: `apps/runtime/src/services/llm/model-resolution.ts`
- **Pipeline model resolver**: `apps/runtime/src/services/pipeline/model-resolver.ts`
- **Credential schema**: `packages/database/src/models/llm-credential.model.ts`
- **Studio dialog**: `apps/studio/src/components/admin/AddConnectionDialog.tsx`
- **Vercel AI SDK Bedrock docs**: https://ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock
- **AWS Bedrock Converse API**: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
- **IRSA docs**: https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html
- **LLD**: `docs/plans/2026-04-28-aws-bedrock-provider-impl-plan.md`
