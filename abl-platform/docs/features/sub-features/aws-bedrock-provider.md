# Feature: AWS Bedrock Provider Integration

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Model Hub](../model-hub.md)
**Status**: BETA
**Feature Area(s)**: `integrations`, `enterprise`, `governance`
**Package(s)**: `packages/llm`, `apps/runtime`, `apps/studio`, `packages/i18n`
**Owner(s)**: `Platform team`
**Testing Guide**: [../../testing/sub-features/aws-bedrock-provider.md](../../testing/sub-features/aws-bedrock-provider.md)
**Last Updated**: 2026-04-28
**Jira**: ABLP-674
**Customer**: FloridaBlue (P0 blocker)

---

## 1. Introduction / Overview

### Problem Statement

The Model Hub already supports configuring AWS Bedrock connections in Studio UI and stores `authConfig` (region, accessKeyId, secretAccessKey) encrypted in the `llm_credentials` collection. However, **runtime execution silently falls back to the OpenAI-compatible default** because `packages/llm/src/provider-factory.ts` has no `case 'bedrock'` and the `@ai-sdk/amazon-bedrock` package is not installed. Any attempt to execute an agent configured with a Bedrock model produces "OpenAI API error" responses, which confuse operators and block FloridaBlue from going live.

A secondary gap: FloridaBlue's preferred authentication method is IRSA (IAM Roles for Service Accounts on EKS) — long-lived AWS credentials must not be stored in the database for HIPAA/PHI compliance. The current UI and backend have no mechanism for ambient-credential (IAM role) Bedrock connections.

### Goal Statement

Enable end-to-end AWS Bedrock inference on the ABL platform in two credential modes: (1) explicit AWS Access Key + Secret Key for cross-cloud deployments; (2) IAM role / IRSA ambient credentials for in-AWS (EKS/ECS) deployments where no keys are stored. Both modes must support streaming, tool calling, multi-region routing, and the same observability contract as other providers.

### Summary

The feature adds `@ai-sdk/amazon-bedrock@^4.0.0` to `packages/llm`, implements a `case 'bedrock'` branch in the shared `createVercelProvider()` factory, extends the provider cache key to avoid region collisions, fixes the SearchAI pipeline model resolver to pass `authConfig`, and adds a UI toggle in `AddConnectionDialog` for credential mode selection. The database schema requires no change — `authConfig: Mixed` already supports arbitrary credential fields.

---

## 2. Scope

### Goals

- Enable Bedrock Claude model execution with explicit AWS credentials (Phase 1) — works on any cloud (AWS, Azure, GCP, on-prem)
- Enable Bedrock Claude model execution with IAM role ambient credentials (Phase 2) — IRSA on EKS, Task Roles on ECS, Instance Profiles on EC2, no stored keys
- Multi-region support via per-connection `region` field
- Streaming responses and tool calling parity with other providers
- Provider-specific error messages (replace "OpenAI API error" fallback)
- Studio UI credential mode toggle for Bedrock connections
- SearchAI pipeline authConfig passthrough fix

### Non-Goals (Out of Scope)

- **Phase 3 cross-account Bedrock**: STS AssumeRole with tenant-supplied IAM Role ARN — deferred to post-MVP (ABLP-674 Phase 3)
- **"Test Connection" validation**: Calling `bedrock:ListFoundationModels` to validate credentials before saving — P1 follow-up ticket
- **Region-specific model availability**: Filtering model catalog by selected AWS region — P1 follow-up
- **CloudWatch metrics**: Bedrock-specific billing/usage metrics in AWS — P1 follow-up
- **Credential rotation workflows**: Automated notification or rotation tooling for explicit credentials — out of scope
- **Non-Claude Bedrock models**: Titan, Llama, Mistral on Bedrock — not in model registry, not addressed here

---

## 3. User Stories

1. As a **tenant admin** deploying to Azure AKS, I want to create a Bedrock connection with explicit AWS credentials so that my agents can use Claude models via AWS Bedrock without moving to AWS infrastructure.
2. As a **FloridaBlue platform operator** on EKS, I want to configure Bedrock connections that use the cluster's IAM role (IRSA) so that no long-lived AWS credentials are stored in the database, satisfying HIPAA/PHI compliance requirements.
3. As an **agent developer**, I want streaming and tool calling to work identically for Bedrock Claude models as they do for direct Anthropic API models, so that I don't need to write provider-specific agent logic.
4. As a **platform operator**, I want Bedrock error messages to identify the provider and failure reason (e.g., "AWS Bedrock: invalid credentials for region us-east-1") so that I can diagnose issues without reading server logs.
5. As a **SearchAI pipeline developer**, I want to configure a Bedrock Claude model as the pipeline classifier so that inference traffic stays within the customer's AWS account boundary.

---

## 4. Functional Requirements

1. **FR-1**: The system must execute Claude model inference via AWS Bedrock when a TenantModel has `provider = 'bedrock'` and the associated LLMCredential has `authType = 'aws_iam'` with `authConfig.accessKeyId` and `authConfig.secretAccessKey` populated (explicit credentials mode).
2. **FR-2**: The system must execute Claude model inference via AWS Bedrock using the platform's IAM role credential chain (IRSA → ECS Task Role → Instance Profile) when `authConfig.useAmbientCredentials = true`, with no AWS access keys stored in the database.
3. **FR-3**: The Studio `AddConnectionDialog` must present a credential mode toggle ("Explicit AWS Credentials" | "Use Platform IAM Role") when creating a Bedrock connection, hiding key input fields when IAM role mode is selected.
4. **FR-4**: Streaming responses (`streamText`) and tool calling must work for Bedrock Claude models using the same Vercel AI SDK interface as other providers (source: `packages/llm/src/provider-factory.ts`).
5. **FR-5**: Errors from Bedrock execution must surface as provider-specific messages (e.g., "AWS Bedrock: ...") and must not appear as "OpenAI API error" from the default fallback case.
6. **FR-6**: The provider instance cache in `SessionLLMClient` must distinguish Bedrock connections by `region` and `useAmbientCredentials` to prevent cross-region or cross-mode cache collisions (source: `apps/runtime/src/services/llm/session-llm-client.ts:840-843`).
7. **FR-7**: The SearchAI pipeline model resolver must pass `authConfig` as the 6th argument to `createVercelProvider()` so that Bedrock models work in pipeline classification, not only in agent session execution (source: `apps/runtime/src/services/pipeline/model-resolver.ts:142`). The 5th argument (`useResponsesApi`) must be passed as `undefined` to preserve existing auto-detection behavior for non-Bedrock models in the pipeline.
8. **FR-8**: The connection's `region` field must default to the `AWS_REGION` environment variable and then `us-east-1` if neither is provided, ensuring inference targets the correct AWS region.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                              |
| -------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Agents in any project can use Bedrock models once a tenant Bedrock connection is provisioned       |
| Agent lifecycle            | PRIMARY      | Bedrock models become first-class models in agent model selection and execution                    |
| Customer experience        | SECONDARY    | Bedrock models behave identically to other providers from the end-user chat perspective            |
| Integrations / channels    | SECONDARY    | SearchAI pipeline can use Bedrock classifiers; no channel-level changes                            |
| Observability / tracing    | SECONDARY    | Existing TraceEvent emission for LLM calls covers Bedrock; no new trace types                      |
| Governance / controls      | PRIMARY      | Tenant LLM Policy governs Bedrock models; IAM role mode removes credential-storage compliance risk |
| Enterprise / compliance    | PRIMARY      | HIPAA/PHI-sensitive customer (FloridaBlue) requires Bedrock for data residency + no stored keys    |
| Admin / operator workflows | SECONDARY    | Admin portal uses existing tenant-model management UI; no admin-specific changes                   |

### Related Feature Integration Matrix

| Related Feature                                | Relationship Type | Why It Matters                                                                                            | Key Touchpoints                                                                              | Current State                                                                |
| ---------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [Model Hub](../model-hub.md)                   | extends           | Bedrock is a new provider slot in the Model Hub credential + provider architecture                        | `createVercelProvider()`, `ModelResolutionService`, `LLMCredential` schema, `MODEL_REGISTRY` | BETA — Bedrock models in registry; `case 'bedrock'` now wired (ALPHA)        |
| [Encryption at Rest](../encryption-at-rest.md) | depends on        | `authConfig` (AWS keys) encrypted via tenant DEK before storage                                           | `packages/database/src/models/llm-credential.model.ts` encryption plugin                     | BETA — already applied to `authConfig` field                                 |
| [Tenant LLM Policy](../tenant-llm-policy.md)   | configured by     | Tenant policy governs which providers are permitted; Bedrock must be allowable                            | `ModelResolutionService` policy check                                                        | ALPHA — policy enforcement applies to all providers including Bedrock        |
| [Auth Profiles](../auth-profiles.md)           | shares data with  | Auth profiles can supply AWS IAM credentials to agent connections as an alternative to inline credentials | `AddConnectionDialog` auth profile mode                                                      | BETA — existing auth profile picker in dialog; `aws_iam` auth type supported |
| [Pipeline Engine](../pipeline-engine.md)       | depends on        | SearchAI pipeline uses `model-resolver.ts` to resolve the pipeline classifier model                       | `apps/runtime/src/services/pipeline/model-resolver.ts:142`                                   | ALPHA — authConfig passthrough implemented (commit 155dedbd7)                |

---

## 6. Design Considerations

**Studio UI toggle**: The `AddConnectionDialog` already has Bedrock-specific form fields (region, accessKeyId, secretAccessKey, sessionToken) rendered when `newCredProvider === 'bedrock'` (source: `apps/studio/src/components/admin/AddConnectionDialog.tsx:557-596`). Phase 2 adds a credential mode radio toggle above those fields. When "Use Platform IAM Role" is selected, the Access Key ID / Secret Key / Session Token inputs are hidden; only the Region input remains.

**i18n for Bedrock fields**: All Bedrock form labels and the new credential mode toggle strings use `t()` via `packages/i18n/locales/en/studio.json` (keys: `bedrock_credential_mode`, `bedrock_explicit_creds`, `bedrock_iam_role`, `bedrock_iam_role_description`, `bedrock_aws_region_label`, `bedrock_access_key_id_label`, `bedrock_secret_access_key_label`, `bedrock_session_token_label`). The LLD initially deferred i18n (Decision D-5) but the implementation correctly used i18n keys consistent with the original feature spec plan (§10, §13).

---

## 7. Technical Considerations

**SDK version selection**: `@ai-sdk/amazon-bedrock@^4.0.0` is the correct version to pair with the project's current dependencies. The 3.x branch of `@ai-sdk/amazon-bedrock` depends on `@ai-sdk/anthropic@2.0.x`, which conflicts with the project's `@ai-sdk/anthropic@^3.0.47`. The 4.x branch shares `@ai-sdk/provider@3.0.8` with the project's existing providers (verified: `npm view @ai-sdk/amazon-bedrock@4.0.96 dependencies`).

**Ambient credential mechanism**: `@ai-sdk/amazon-bedrock` uses `aws4fetch` for request signing (not the full AWS SDK). Omitting explicit keys only falls back to `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` environment variables — it cannot resolve IRSA web identity tokens. The `credentialProvider` callback option in `AmazonBedrockProviderSettings` (type inspected via `npm view @ai-sdk/amazon-bedrock@4.0.96` — not yet installed locally; will be confirmed against installed types after `pnpm install` in LLD Phase A) is the designed extension point. `fromNodeProviderChain()` from `@aws-sdk/credential-providers` handles the full AWS credential chain including IRSA.

**`encryptedApiKey` sentinel for ambient mode**: `LLMCredential.encryptedApiKey` is `required: true` in the Mongoose schema (source: `packages/database/src/models/llm-credential.model.ts:48`). Making it nullable would cascade through the encryption plugin, model-resolution guards, and cache key logic. For ambient mode connections, the value `"__iam_role__"` is stored as a documented sentinel; the provider factory detects `useAmbientCredentials: true` and ignores the `apiKey` parameter.

**Provider cache key gap**: `session-llm-client.ts:840-843` builds `authSuffix` encoding only Azure-specific fields (`resourceName`, `apiVersion`). Two Bedrock connections with identical `modelId` but different regions produce identical cache keys, returning the wrong provider instance. The fix extends `authSuffix` to include `authConfig.region` and `authConfig.useAmbientCredentials`.

**SearchAI pipeline gap**: `model-resolver.ts:142` calls `createVercelProvider(provider, apiKey, baseUrl ?? undefined, modelId)` — both `useResponsesApi` (5th arg) and `authConfig` (6th arg) are omitted. The fix requires: (1) extracting `credential.authConfig` after decryption (the encryption plugin's post-find hook decrypts it on the returned Mongoose document), (2) parsing it via `parseJsonField()` or equivalent, (3) passing `undefined` as `useResponsesApi` to preserve existing behavior, and (4) passing the parsed `authConfig` as the 6th argument. This is approximately 3-5 lines plus a possible import of `parseJsonField`. The `WorkerLLMClient` in `packages/llm/src/worker-llm-client.ts` already passes `authConfig` through its constructor, so SearchAI workers (not the pipeline classifier) are already wired.

**Phase 3 deferred**: Cross-account Bedrock via STS AssumeRole with tenant-supplied IAM Role ARN is P2 complexity (20+ hours) and is deferred. The code design for Phase 1+2 should not block Phase 3 — the `BedrockAuthConfig` interface will include an optional `roleArn` field placeholder marked as reserved.

---

## 8. How to Consume

### Studio UI

**Path**: Studio → Admin → Models → select a Bedrock TenantModel → "Add Connection"

The `AddConnectionDialog` (`apps/studio/src/components/admin/AddConnectionDialog.tsx`) renders provider-specific credential fields when `newCredProvider === 'bedrock'`:

**Phase 1 (explicit credentials) — existing UI, already works for storage:**

- AWS Region (text input, default `us-east-1`)
- Access Key ID (text input)
- Secret Access Key (password input)
- Session Token (password input, optional — for STS temporary credentials)

**Phase 2 (IAM role toggle) — new UI:**

- Credential mode toggle: "Explicit AWS Credentials" | "Use Platform IAM Role"
- When "Use Platform IAM Role" selected: only Region input shown; key fields hidden
- Help text: "Running on EKS? Use Platform IAM Role for credential-free access. Ensure the platform's IAM role has `bedrock:InvokeModel` permissions."

### Surface Semantics Matrix

| Asset / Entity Type   | Source of Truth              | Design-Time Surface                    | Editable or Read-Only?                                 | Consumer Reference                                          | Runtime Materialization                                                             | Notes                                                                                                   |
| --------------------- | ---------------------------- | -------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Bedrock LLMCredential | `llm_credentials` collection | Studio Admin → Models → Add Connection | Editable at creation; keys not re-displayed after save | `LLMCredential._id` referenced from `TenantModelConnection` | Decrypted `authConfig` passed to `createVercelProvider()` at inference time         | Ambient mode: sentinel `"__iam_role__"` in `encryptedApiKey`; actual credentials come from pod IAM role |
| Bedrock TenantModel   | `tenant_models` collection   | Studio Admin → Models → provision      | Editable                                               | `modelId` (e.g., `anthropic.claude-sonnet-4-6-v1:0`)        | Resolved via `ModelResolutionService` to `{ provider: 'bedrock', authConfig, ... }` | Models must already exist in `MODEL_REGISTRY` (`packages/compiler/src/platform/llm/model-registry.ts`)  |

### Design-Time vs Runtime Behavior

**Design-time**: Tenant admin creates a Bedrock `LLMCredential` (explicit or ambient mode) in Studio. Credential `authConfig` is encrypted before storage. Admin creates a `TenantModelConnection` linking the credential to a `TenantModel`.

**Runtime**: `ModelResolutionService.resolve()` decrypts the credential, extracts `authConfig`, and passes it to `createVercelProvider('bedrock', apiKey, baseUrl, modelId, undefined, authConfig)`. For explicit mode, the factory uses `createAmazonBedrock({ region, accessKeyId, secretAccessKey, sessionToken })`. For ambient mode, the factory calls `createAmazonBedrock({ region, credentialProvider: fromNodeProviderChain(...) })`.

### API (Runtime)

No new runtime API endpoints. Bedrock inference flows through the existing session execution path:

| Method | Path                              | Purpose                                                      |
| ------ | --------------------------------- | ------------------------------------------------------------ |
| POST   | `/api/sessions/:sessionId/chat`   | Existing session chat endpoint — Bedrock models execute here |
| POST   | `/api/sessions/:sessionId/stream` | Existing streaming endpoint — Bedrock streaming responses    |

### API (Studio)

No new Studio API routes. Bedrock credentials are created via the existing tenant-credentials endpoint:

| Method | Path                                      | Purpose                                                                                        |
| ------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| POST   | `/api/tenant-credentials`                 | Create Bedrock LLMCredential (existing route, new `authType: 'aws_iam'` + `authConfig` fields) |
| POST   | `/api/tenant-models/:modelId/connections` | Wire credential to TenantModel (existing route, unchanged)                                     |

### Admin Portal

No Admin Portal changes. Existing tenant-model management surfaces apply to Bedrock models.

### Channel / SDK / Voice / A2A / MCP Integration

Bedrock Claude models are provider-agnostic once the factory case is wired — they work across all channels and integration surfaces that route through `SessionLLMClient`. No channel-specific changes are required.

---

## 9. Data Model

### Collections / Tables

No new collections. No schema changes to existing collections.

```text
Collection: llm_credentials (EXISTING — no changes)
Relevant fields for Bedrock:
  - authType: 'aws_iam'                          (existing enum value)
  - encryptedApiKey: '__iam_role__'              (sentinel for ambient mode; real key for explicit)
  - authConfig: {                                (Mixed field, already encrypted by encryptionPlugin)
      region: string,                            (e.g., 'us-east-1')
      accessKeyId?: string,                      (explicit mode only)
      secretAccessKey?: string,                  (explicit mode only)
      sessionToken?: string,                     (explicit mode, STS only)
      useAmbientCredentials?: boolean,            (Phase 2: true = IAM role mode)
    }
```

The `encryptionPlugin` at `packages/database/src/models/llm-credential.model.ts:65-70` already encrypts `authConfig` as a whole field. No additional encryption configuration needed.

### Key Relationships

`TenantModelConnection` → `LLMCredential` (via `credentialId`) — the connection record links a provisioned Bedrock model to its credential. `ModelResolutionService` follows this join at inference time (source: `apps/runtime/src/services/llm/model-resolution.ts:1522`).

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                   | Purpose                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `packages/llm/src/provider-factory.ts`                 | Add `case 'bedrock'` with `BedrockAuthConfig` interface; both explicit and ambient credential paths   |
| `packages/llm/package.json`                            | Add `@ai-sdk/amazon-bedrock@^4.0.0` (Phase 1) and `@aws-sdk/credential-providers` (Phase 2)           |
| `apps/runtime/src/services/llm/session-llm-client.ts`  | Extend `authSuffix` in provider cache key (~line 840) to include `region` and `useAmbientCredentials` |
| `apps/runtime/src/services/pipeline/model-resolver.ts` | Pass `authConfig` as 6th argument to `createVercelProvider()` at line 142                             |
| `apps/runtime/src/services/llm/utils.ts`               | Shared `parseJsonField()` utility extracted from model-resolution.ts                                  |
| `docs/guides/llm-providers/aws-bedrock.md`             | Ops guide: IRSA setup, explicit credentials, IAM policy, troubleshooting                              |

### Routes / Handlers

| File | Purpose                                                                  |
| ---- | ------------------------------------------------------------------------ |
| N/A  | No new routes; existing credential and model-connection routes unchanged |

### UI Components

| File                                                       | Purpose                                                                     |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| `apps/studio/src/components/admin/AddConnectionDialog.tsx` | Credential mode toggle (RadioGroup), IAM role + explicit paths, i18n labels |
| `apps/studio/src/components/admin/ModelsPage.tsx`          | Credentials tab: IAM role toggle added (parity with AddConnectionDialog)    |
| `packages/i18n/locales/en/studio.json`                     | Add English i18n keys for new IAM role toggle and help text                 |

### Jobs / Workers / Background Processes

| File | Purpose                |
| ---- | ---------------------- |
| N/A  | No new background jobs |

### Tests

| File                                                     | Type            | Coverage Focus                                                                                                                       |
| -------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/llm/src/__tests__/provider-factory.test.ts`    | unit            | `case 'bedrock'` in `createVercelProvider`: explicit creds, ambient creds, region default, error on incomplete creds                 |
| `apps/runtime/src/__tests__/bedrock-integration.test.ts` | integration     | Model resolution with Bedrock TenantModel; cache key differentiation by region + credential mode; pipeline authConfig passthrough    |
| `apps/runtime/src/__tests__/bedrock-e2e.test.ts`         | integration+e2e | Bedrock provisioning roundtrip, cross-tenant isolation, authConfig connection test                                                   |
| `apps/runtime/src/__tests__/classify-llm-error.test.ts`  | unit            | Bedrock error classifier patterns (ThrottlingException, ValidationException, ResourceNotFoundException, ServiceUnavailableException) |

---

## 11. Configuration

### Environment Variables

| Variable                      | Default                | Description                                                                                            |
| ----------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `AWS_REGION`                  | `us-east-1`            | Fallback region for Bedrock when `authConfig.region` is not specified                                  |
| `AWS_ACCESS_KEY_ID`           | (none)                 | Ambient credential fallback (env var chain); only used if no `credentialProvider` and no explicit keys |
| `AWS_SECRET_ACCESS_KEY`       | (none)                 | Ambient credential fallback (env var chain)                                                            |
| `AWS_WEB_IDENTITY_TOKEN_FILE` | (auto-injected by EKS) | IRSA token file path; consumed by `fromNodeProviderChain()` automatically                              |
| `AWS_ROLE_ARN`                | (auto-injected by EKS) | IAM role ARN for IRSA; consumed by `fromNodeProviderChain()` automatically                             |

### Runtime Configuration

No feature flags or tenant-level toggles. IAM role mode is per-connection (stored in `authConfig.useAmbientCredentials`).

### DSL / Agent IR / Schema

No DSL or IR changes. Bedrock model IDs (e.g., `anthropic.claude-sonnet-4-6-v1:0`) are already in `MODEL_REGISTRY` in `packages/compiler/src/platform/llm/model-registry.ts`. The `BedrockAuthConfig` interface defined in `packages/llm/src/provider-factory.ts` is internal to the provider factory and is not part of the public IR.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern                  | Requirement / Expectation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation         | `LLMCredential` and `TenantModel` records are tenant-scoped (`tenantId` field, indexed). Every credential lookup in `ModelResolutionService` includes `tenantId` (source: `model-resolution.ts:1522`). Cross-tenant credential access returns 404.                                                                                                                                                                                                                                                                                                                                                 |
| Project isolation        | `TenantModel` and `LLMCredential` are **tenant-scoped, not project-scoped** — they have no `projectId` field (source: `packages/database/src/models/tenant-model.model.ts`; `model-resolver.ts:79-83` filters by `{ _id, tenantId, isActive }` only). Project-level access control is enforced via RBAC at the route/middleware layer (`requireProjectPermission`) — project membership governs which projects' agents may use which TenantModels. This is consistent with the existing Model Hub architecture.                                                                                    |
| User isolation           | `LLMCredential` supports both `credentialScope='tenant'` (org-wide) and `credentialScope='user'` (personal). For this feature, Bedrock credentials created via the Studio `AddConnectionDialog` are **tenant-scoped** (`credentialScope='tenant'`). User-scoped (`credentialScope='user'`) Bedrock credentials are out of scope for ABLP-674 — the dialog always creates tenant-scoped credentials. If user-scoped Bedrock credentials are needed in the future, the same `authConfig` handling applies; no additional factory changes are required.                                               |
| Ambient credential scope | When `useAmbientCredentials = true`, **the platform's own IAM role is used for all ambient-mode connections on the same pod**. All tenants with ambient-mode Bedrock connections on a shared EKS cluster use the same IAM role. This is acceptable only for dedicated single-tenant EKS deployments (e.g., FloridaBlue's dedicated cluster). For shared multi-tenant SaaS, ambient mode must be restricted to tenants on dedicated infrastructure — this constraint must be documented in the ops guide and enforced by deployment policy (no platform-level enforcement exists yet; see GAP-004). |

### Security & Compliance

- `authConfig` (including AWS keys) is encrypted at rest via the tenant-scoped DEK using the existing `encryptionPlugin` (source: `packages/database/src/models/llm-credential.model.ts:65-70`). No unencrypted credentials at rest.
- After decryption, credentials exist in plaintext in memory only for the duration of the `createVercelProvider()` call. Provider cache TTL (30 minutes, configurable via `LLM_PROVIDER_CACHE_TTL_SECONDS`) limits the window of decrypted credential exposure.
- For ambient mode, no AWS credentials are stored in the database at all — the sentinel `"__iam_role__"` in `encryptedApiKey` is encrypted but contains no secrets.
- Recommended IAM policy for Bedrock-only access (minimum privilege):
  ```json
  {
    "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
    "Resource": "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
    "Effect": "Allow"
  }
  ```
- Error messages surfaced to users must not leak region, model ID, or credential hints. Two layers participate: (a) runtime LLM error classification (the `classify-llm-error` path in the runtime executor) is the primary defense for FR-5 and must handle Bedrock-specific error codes; (b) Studio client-side error display uses `sanitizeError` (source: `apps/studio/src/lib/sanitize-error.ts`) as the final presentation layer.
- CloudTrail automatically logs all `bedrock:InvokeModel` calls with IAM role attribution (AWS-side; no platform changes needed).

### Performance & Scalability

- `createAmazonBedrock()` is synchronous and lightweight. Provider instances are cached in `providerCache` in `session-llm-client.ts`.
- For ambient credential mode, `fromNodeProviderChain()` is called once per provider instance creation; credentials are resolved asynchronously and then cached for the provider instance lifetime. The AWS SDK handles IRSA credential refresh internally (via `fromNodeProviderChain()`); the 30-minute provider cache TTL does not determine IRSA refresh frequency.
- The `credentialProvider` callback returns a `PromiseLike<credentials>` — the `@ai-sdk/amazon-bedrock` SDK handles the async resolution at call time.
- No additional latency overhead for explicit credential mode vs. current API key providers.

### Reliability & Failure Modes

- **Missing credentials (explicit mode)**: Provider factory throws a descriptive error at `createVercelProvider()` time; surfaced to user as provider-specific error. No silent fallback to OpenAI-compatible default.
- **IRSA resolution failure (ambient mode)**: `fromNodeProviderChain()` throws if no credential source is found; e.g., when running outside AWS. Error is surfaced as "AWS Bedrock: credential resolution failed — ensure the platform runs in AWS with an IAM role attached."
- **Wrong region**: AWS Bedrock returns a 4xx/5xx error; surfaces as Bedrock-specific error message.
- **Model not available in region**: Bedrock returns `ValidationException`; provider passes it through as a provider error.
- **Credential rotation (explicit mode)**: Provider cache TTL (30 minutes, configurable via `LLM_PROVIDER_CACHE_TTL_SECONDS`) means rotated keys take effect within one TTL window of being updated in the credential store.

### Observability

- All Bedrock LLM calls emit `TraceEvent`s via the existing `TraceStore` path — no new trace types needed.
- Token usage from Bedrock responses maps to the existing `usage: { inputTokens, outputTokens }` struct in the Vercel AI SDK response.
- Bedrock errors should appear in existing LLM error traces with the provider name (`bedrock`) set in the error context.
- No new dashboards or alerts required for ALPHA/BETA. P1 follow-up: CloudWatch metrics for Bedrock API call counts and latency.

### Data Lifecycle

No new data. `LLMCredential` records follow the existing data lifecycle (tenant DEK rotation cascades, right-to-erasure cascades, etc.). No TTL changes.

---

## 13. Delivery Plan / Work Breakdown

1. **Phase A — Core provider factory (Phase 1, P0)**
   1.1 Add `@ai-sdk/amazon-bedrock@^4.0.0` to `packages/llm/package.json`
   1.2 Define `BedrockAuthConfig` interface in `provider-factory.ts`
   1.3 Add `case 'bedrock'` to `createVercelProvider()` — explicit credentials path
   1.4 Run `pnpm build --filter=@agent-platform/llm` and verify no type errors
   1.5 Write unit tests in `packages/llm/src/__tests__/provider-factory.test.ts`

2. **Phase B — Ambient credentials backend (Phase 2, P0)**
   2.1 Add `@aws-sdk/credential-providers` to `packages/llm/package.json`
   2.2 Implement ambient credentials path in `case 'bedrock'` via `credentialProvider: fromNodeProviderChain()`
   2.3 Run `pnpm build --filter=@agent-platform/llm` and add unit test for ambient path

3. **Phase C — Provider cache key fix**
   3.1 Extend `authSuffix` in `session-llm-client.ts` (~line 840) to include `authConfig.region` and `authConfig.useAmbientCredentials`
   3.2 Run `pnpm build --filter=@agent-platform/runtime`

4. **Phase D — SearchAI pipeline fix**
   4.1 Verify `credential.authConfig` is available after decryption in `model-resolver.ts` execution context (~line 102-145)
   4.2 Extract and parse `credential.authConfig` using `parseJsonField()` (same pattern as `model-resolution.ts:1522`)
   4.3 Pass `undefined` as 5th argument and parsed `authConfig` as 6th argument to `createVercelProvider()` at line 142
   4.4 Run `pnpm build --filter=@agent-platform/runtime`

5. **Phase E — Studio UI toggle (Phase 2, P0)**
   5.1 Add `newCredBedrockMode: 'explicit' | 'iam_role'` state and reset
   5.2 Add credential mode radio toggle in Bedrock form section of `AddConnectionDialog`
   5.3 Conditionally hide key fields when `iam_role` mode selected
   5.4 Update `handleCreateCredential` for IAM role mode (sentinel `apiKey`, `useAmbientCredentials` flag)
   5.5 Add English i18n strings to `packages/i18n/locales/en/studio.json`

6. **Phase F — Documentation**
   6.1 Create `docs/guides/llm-providers/aws-bedrock.md` with IRSA setup, explicit credential setup, IAM policy template, supported models, troubleshooting

---

## 14. Success Metrics

| Metric                                                  | Baseline                        | Target                                                                   | How Measured                                                                                    |
| ------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Bedrock inference success rate                          | 0% (fallback to OpenAI default) | 100% for correctly configured connections                                | Runtime trace events — Bedrock model calls complete without error                               |
| "OpenAI API error" occurrences for Bedrock TenantModels | > 0 (current state)             | 0 after implementation                                                   | Error traces filtered by provider = 'bedrock'                                                   |
| FloridaBlue staging validation                          | Blocked                         | IRSA ambient connection executes agent session with no credentials in DB | Manual E2E on FloridaBlue staging EKS                                                           |
| Unit test coverage                                      | 0 tests for `case 'bedrock'`    | 5 passing unit tests                                                     | `pnpm test --filter=@agent-platform/llm` — **6 passing**; plus 24 error-classifier tests (BETA) |

---

## 15. Open Questions

1. **Bedrock model IDs in registry**: The registry contains `anthropic.claude-opus-4-6-v1:0`, `anthropic.claude-sonnet-4-6-v1:0`, and `anthropic.claude-sonnet-4-20250514-v1:0`. FloridaBlue has not confirmed which specific model IDs and regions they require. This does not block implementation but should be confirmed before staging validation.
2. **Shared-tenant ambient credential risk**: When `useAmbientCredentials = true`, all tenants on the same EKS cluster use the platform's IAM role. This is acceptable for FloridaBlue's dedicated cluster but is a shared-resource risk in multi-tenant SaaS. The platform does not currently enforce that ambient-credential Bedrock connections are restricted to single-tenant deployments. This should be documented as a deployment constraint.
3. **Phase 3 scope (future)**: Cross-account Bedrock via IAM Role ARN + STS AssumeRole (for multi-tenant SaaS where each tenant brings their own AWS account) is explicitly deferred. The `BedrockAuthConfig` interface reserves a `roleArn?: string` field for Phase 3 but the STS AssumeRole logic is not implemented.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                      | Severity | Status                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------- |
| GAP-001 | `model-resolver.ts:142` does not pass `authConfig` to `createVercelProvider()` — Bedrock models silently fail in SearchAI pipeline classification                | High     | FIXED — Phase D (authConfig passthrough implemented)            |
| GAP-002 | Provider cache key does not encode `authConfig.region` — two Bedrock connections in different regions produce identical cache keys and return the wrong provider | High     | FIXED — Phase C (`buildProviderCacheKey()` includes authSuffix) |
| GAP-003 | No "Test Connection" validation for Bedrock credentials — users cannot verify credentials before saving (calls `bedrock:ListFoundationModels`)                   | Medium   | Open — P1 follow-up ticket                                      |
| GAP-004 | Ambient credential mode exposes platform IAM role to all tenants on the same EKS cluster — no enforcement mechanism restricts this to single-tenant deployments  | Medium   | Open — documented constraint; enforcement deferred to Phase 3   |
| GAP-005 | Region-specific model availability not enforced — UI allows selecting a Bedrock model regardless of whether it is available in the configured region             | Low      | Open — P1 follow-up                                             |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                                                           | Coverage Type | Status     | Test File / Note                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | `createVercelProvider('bedrock', ...)` with valid explicit credentials returns non-null LanguageModel                              | unit          | PASSING    | `packages/llm/src/__tests__/provider-factory.test.ts`                                                                |
| 2   | `createVercelProvider('bedrock', ...)` with `useAmbientCredentials: true` returns non-null LanguageModel                           | unit          | PASSING    | `packages/llm/src/__tests__/provider-factory.test.ts`                                                                |
| 3   | `createVercelProvider('bedrock', ...)` defaults region to `us-east-1` when no region in authConfig                                 | unit          | PASSING    | `packages/llm/src/__tests__/provider-factory.test.ts`                                                                |
| 4   | `createVercelProvider('bedrock', ...)` throws descriptive error when `accessKeyId` present but `secretAccessKey` absent            | unit          | PASSING    | `packages/llm/src/__tests__/provider-factory.test.ts`                                                                |
| 5   | `createVercelProvider('bedrock', ...)` throws descriptive error when no keys and `useAmbientCredentials` is absent/false           | unit          | PASSING    | `packages/llm/src/__tests__/provider-factory.test.ts`                                                                |
| 5a  | `createVercelProvider('bedrock', ...)` uses `AWS_REGION` env var when `authConfig.region` absent but `AWS_REGION` set              | unit          | PASSING    | `packages/llm/src/__tests__/provider-factory.test.ts`                                                                |
| 6   | ModelResolutionService resolves Bedrock TenantModel with explicit credentials — authConfig contains AWS fields                     | integration   | DEFERRED   | `apps/runtime/src/__tests__/bedrock-integration.test.ts` (it.todo — requires MongoMemoryServer + encryption harness) |
| 7   | Provider cache key differs for same modelId in different regions                                                                   | integration   | PASSING    | `apps/runtime/src/__tests__/bedrock-integration.test.ts`                                                             |
| 8   | Provider cache key differs for explicit-creds vs ambient-creds in the same region                                                  | integration   | PASSING    | `apps/runtime/src/__tests__/bedrock-integration.test.ts`                                                             |
| 9   | `model-resolver.ts` passes `authConfig` through to `createVercelProvider()`                                                        | integration   | PASSING    | `apps/runtime/src/__tests__/bedrock-integration.test.ts`                                                             |
| 10  | Bedrock execution error surfaces as provider-specific message, not "OpenAI API error"                                              | integration   | PASSING    | `apps/runtime/src/__tests__/bedrock-integration.test.ts`                                                             |
| 11  | Runtime: Create Bedrock explicit-credentials connection → agent executes via /api/v1/chat/agent → Bedrock HTTP intercepted by nock | e2e (auto)    | PASSING    | `apps/runtime/src/__tests__/bedrock-e2e.test.ts` (E2E-1 — `scope.isDone() === true` confirms Bedrock was called)     |
| 12  | Studio UI: Create Bedrock IAM-role connection → `useAmbientCredentials: true` in DB, no keys stored                                | e2e (manual)  | NOT TESTED | EKS staging with IRSA                                                                                                |
| 13  | Wrong credentials → error surfaces as provider-specific message, no "OpenAI API error" in response                                 | e2e (auto)    | PASSING    | `apps/runtime/src/__tests__/bedrock-e2e.test.ts` (E2E-3 — nock returns 401, asserts no "openai api error" in body)   |
| 14  | Incomplete explicit credentials → Studio validation error, connection not created                                                  | e2e (manual)  | NOT TESTED | Manual UI test                                                                                                       |
| 15  | SearchAI pipeline with Bedrock classifier model → resolves and executes correctly                                                  | e2e (manual)  | NOT TESTED | SearchAI pipeline config with Bedrock model                                                                          |
| 16  | Bedrock Claude model with tool definitions executes tool call and returns structured result                                        | e2e (manual)  | NOT TESTED | Agent with tool + Bedrock model; validates FR-4 tool calling                                                         |

### Testing Notes

**Current coverage (BETA)**: 6 unit tests passing (`provider-factory.test.ts`), 8 integration tests (7 passing + 1 `it.todo` for INT-1), 5/5 E2E tests passing (`bedrock-e2e.test.ts` — E2E-1 full chat roundtrip via `/api/v1/chat/agent` + nock, E2E-3 error path, plus provisioning/isolation/connection tests), 24 error-classifier unit tests including 2 regression guards for non-Bedrock 404 mis-classification (`classify-llm-error.test.ts`). Playwright PLY-1 through PLY-5 are `test.fixme` stubs pending live Studio infrastructure. `ModelsPage.tsx` has IAM role toggle at parity with `AddConnectionDialog.tsx`.

Unit tests for `provider-factory.ts` are black-box tests against the pure factory function — no mocking of the `@ai-sdk/amazon-bedrock` SDK. E2E tests use `startRuntimeServerHarness()` (real Express + MongoMemoryServer) and nock for external Bedrock HTTP interception. `scope.isDone() === true` in E2E-1 confirms Bedrock is actually called, not an OpenAI fallback. Integration tests do not mock `ModelResolutionService` or `SessionLLMClient`.

**Still deferred**: FR-4b streaming (requires eventstream binary mock helper), INT-1 ModelResolutionService with real Bedrock credential (requires full encryption harness), PLY-1 through PLY-5 (test.fixme stubs).

> Full testing details: [../../testing/sub-features/aws-bedrock-provider.md](../../testing/sub-features/aws-bedrock-provider.md)

---

## 18. References

- **Requirements document**: Jira ABLP-674 description (sourced from internal design review `bedrock-integration-review.md`)
- **Jira**: [ABLP-674](https://koreteam.atlassian.net/browse/ABLP-674)
- **Related Jira**: [KE-68383](https://koreteam.atlassian.net/browse/KE-68383) (Yogendra's IAM auth comment)
- **Parent feature spec**: [docs/features/model-hub.md](../model-hub.md)
- **Provider factory**: `packages/llm/src/provider-factory.ts`
- **Model registry**: `packages/compiler/src/platform/llm/model-registry.ts`
- **Model resolution**: `apps/runtime/src/services/llm/model-resolution.ts`
- **Vercel AI SDK Bedrock docs**: https://ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock
- **AWS IRSA docs**: https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html
- **HLD**: `docs/specs/aws-bedrock-provider.hld.md`
- **LLD**: `docs/plans/2026-04-28-aws-bedrock-provider-impl-plan.md`
