# LLD: Document Extraction Integrations (Docling + Azure Document Intelligence)

**Feature Spec**: [`docs/features/document-extraction-integrations.md`](../features/document-extraction-integrations.md) (committed `57354b3f2`)
**HLD**: [`docs/specs/document-extraction-integrations.hld.md`](../specs/document-extraction-integrations.hld.md) (committed `e44e28285`)
**Test Spec**: [`docs/testing/document-extraction-integrations.md`](../testing/document-extraction-integrations.md) (committed `ed6080f58`)
**Oracle Log**: [`docs/sdlc-logs/document-extraction-integrations/lld.log.md`](../sdlc-logs/document-extraction-integrations/lld.log.md)
**Status**: DRAFT
**Date**: 2026-05-15
**Jira**: ABLP-1073
**Target branch**: `feature/wf/ocrnode`
**Audit minimum**: 5 sequential (lld-reviewer × 4, phase-auditor × 1) + 3 parallel (platform, industry, OSS)

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                                                                                                                                                                                                                                                                                     | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Alternatives Rejected                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | Phase 1 ships the worker branch **and** the workflow-engine `callbackRequest` suspension block together (not just the worker).                                                                                                                                                                                                                               | Feature spec §13 Phase 1 title explicitly includes "workflow `async_webhook` step." Without the handler change, Phase 1 has no end-to-end testable round-trip.                                                                                                                                                                                                                                                                                                                                                                                                                     | Land the handler in Phase 2 (rejected — breaks Phase 1 acceptance).                                                                                                                                            |
| D-2  | Phase 1 commits split into **2 commits**: (1.A) `apps/search-ai` + `packages/search-ai-sdk` + `packages/shared-encryption`; (1.B) `apps/workflow-engine` + `packages/shared`.                                                                                                                                                                                | CLAUDE.md commit discipline: max 3 packages per commit (`commit-scope-guard.sh`). The handler change adds a 4th package, breaching the cap if combined.                                                                                                                                                                                                                                                                                                                                                                                                                            | Single Phase 1 commit (rejected — exceeds 3-package cap).                                                                                                                                                      |
| D-3  | `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED` gates **three layers**: (a) connector registration in `loader.ts`, (b) the 5 new routes (return `FEATURE_DISABLED`), (c) Worker B subscription not started.                                                                                                                                                   | FR-22 mandates feature-flag isolation. Gating Worker B too means no Redis subscription appears in monitoring when the flag is off, avoiding operational confusion. Worker A (ingestion) is unaffected.                                                                                                                                                                                                                                                                                                                                                                             | Gate only the routes (rejected — leaves the Worker B subscription dangling on enabled pods).                                                                                                                   |
| D-4  | Connector action `run()` receives a new optional **`callbackContext`** on `ActionContext` (Option 1 from HLD §3.2.1).                                                                                                                                                                                                                                        | `ActionContext` already exposes `tenantId` / `projectId` / `executionId` / `store` (`packages/connectors/src/types.ts:142–170`). Adding `callbackContext?: { callbackUrlBuilder, encryptSecret, restateCtx? }` is additive; third-party AP pieces ignore it.                                                                                                                                                                                                                                                                                                                       | Helper module + DI at `loadConnectors(deps)` (rejected — cross-cutting change to every connector load).                                                                                                        |
| D-5  | The Docling connector returns a **sentinel object** `{ __asyncParking: true, callbackId, callbackTimeoutMs, encryptedCallbackSecret }`; `executeConnectorAction()` recognizes it and converts to `StepDispatchResult.callbackRequest`.                                                                                                                       | HLD §3.3 step 3.h. Avoids polluting the executor's error-span path with a control-flow exception. The sentinel key is reserved and discriminated-union-typed.                                                                                                                                                                                                                                                                                                                                                                                                                      | Throw a typed exception (rejected — special-cases non-error control flow inside `ConnectorToolExecutor.execute`).                                                                                              |
| D-6  | The HMAC callback secret is generated **inside the connector's `run()`**, which is invoked inside `restateCtx.run('step:...')` at `workflow-handler.ts:3985`. On normal replay, Restate returns the journaled `AsyncParkingSentinel` from the journal — `run()` does NOT re-execute, the secret is NOT regenerated, and the BullMQ enqueue does NOT re-fire. | **(Round 7 corrected — was misleading)** The narrow re-execute window is only the crash-before-journal-write case: if the pod crashes between starting `ctx.run` and Restate persisting the journal entry, the lambda re-runs from scratch on recovery, generates a fresh secret, and re-enqueues. BullMQ `attempts: 1` plus the callback route's `step.status !== 'waiting_callback'` → 409 (`workflow-callbacks.ts:83–85`) make the stale job harmless — its callback POST is rejected and the new enqueue's callback resolves normally. Document this narrow window explicitly. | Generate inside the handler (rejected — plaintext can't reach the BullMQ payload constructed in `run()` without ugly wiring).                                                                                  |
| D-7  | The worker's outbound POST to Docling does **NOT** use `safeFetch`. The streaming helper uses Node's native `http.request` with multipart streaming. Only the **inbound** user-URL fetch uses `safeFetch`.                                                                                                                                                   | `safe-fetch.ts:403` throws `TypeError('safeFetch does not support streaming request bodies')`. `DOCLING_SERVICE_URL` is an internal loopback or in-cluster URL; SSRF is not a concern on the outbound leg.                                                                                                                                                                                                                                                                                                                                                                         | Use `safeFetch` for the Docling POST (rejected — would break with TypeError at runtime).                                                                                                                       |
| D-8  | The Azure DI piece's outbound `:analyze` POST and HEAD probe **DO** use `safeFetch` (DNS-pinned).                                                                                                                                                                                                                                                            | The Azure endpoint hostname is **tenant-supplied** via the AuthProfile `connectionConfig.endpoint`, so SSRF and DNS-rebinding protections must apply. Body is JSON (small), so `safeFetch`'s buffered-body limitation is fine.                                                                                                                                                                                                                                                                                                                                                     | Raw `fetch` (rejected — leaves DNS-rebinding window open against a tenant-controlled endpoint).                                                                                                                |
| D-9  | Pre-Phase 3, **wire `kvStore` from a Redis-backed adapter** through `ConnectorDepsFactory` → `ConnectorToolExecutor` (currently defaults to `NOOP_STORE`). **NOT Restate state** — Restate's `WorkflowContext` exposes only `sleep`/`run`/`promise` (verified at `workflow-handler.ts:239–244`) and provides no TTL-bearing KV.                              | `apps/workflow-engine/src/index.ts:954` passes only 3 ctor args; `connector-tool-executor.ts:34–38` defaults `kvStore` to a no-op. Without a real backing, FR-16 (Azure DI replay safety via `ctx.store`) silently no-ops: every replay would re-POST `:analyze` and incur a duplicate invoice. Redis is already the platform's shared cache (`RateLimiterRedis`, BullMQ) and natively supports TTL via `SET key value EX seconds`.                                                                                                                                                | Restate state (rejected — no TTL, scoped to workflow lifetime; Round 3 verified `RestateWorkflowCtx` has no `objectStore`). MongoDB-backed KV (rejected — extra latency, no native TTL without TTL index lag). |
| D-9b | Thread `workflowExecutionId` + `stepId` onto `ExecutorContext` and `ActionContext` (NEW optional fields). Wire from `workflow-handler.ts` → `ConnectorDepsFactory` → per-step `ConnectorToolExecutor` invocation.                                                                                                                                            | Current `ActionContext.executionId` at `connector-tool-executor.ts:62` is `crypto.randomUUID()` — a **fresh random value per call**, NOT the workflow's execution ID. The Azure DI piece needs the workflow `executionId` + `stepId` to compose the `ctx.store` key `azuredi:${executionId}:${stepId}` so the value survives Restate replay. Without this, the store key differs every replay; Azure DI re-POSTs `:analyze`; FR-16 fails silently.                                                                                                                                 | Use `crypto.randomUUID()` as the key (rejected — defeats replay safety). Generate the key inside `callbackContext` (rejected — only Docling uses `callbackContext`; Azure DI is an AP piece).                  |
| D-17 | The 5 new project-scoped routes mount on the **authenticated `projectRouter`**, NOT after the unauthenticated `callbackRouter` at `apps/workflow-engine/src/index.ts:1225`. Route paths are relative to the `projectRouter` mount point.                                                                                                                     | Line 1225 is in the unauthenticated section (the callback router intentionally bypasses session auth because HMAC is its auth mechanism). The integration toggle/usage routes need `tenantContext` populated by `createUnifiedAuthMiddleware`; mounting before that middleware would leave `req.user` / `req.tenant` undefined and `requireTenantProject` would 400 every call. Existing project-scoped routes (`connections.ts` mount around line 1342) are the right anchor.                                                                                                     | Mount under unauthenticated section (rejected — breaks centralized-auth invariant; routes need session principal).                                                                                             |
| D-18 | `FEATURE_DISABLED` returns **HTTP 404**, not 403, to avoid leaking feature existence.                                                                                                                                                                                                                                                                        | CLAUDE.md "cross-scope access returns 404, never 403" principle generalizes: don't surface gated-feature presence to unauthorized requests. 404 with `{ success: false, error: { code: 'FEATURE_DISABLED', message: 'Feature not available' } }` is consistent with platform information-hiding.                                                                                                                                                                                                                                                                                   | 403 (rejected — leaks existence); 501 (rejected — implies "not implemented" rather than "gated"; would conflict with the Phase 6 GA path when status flips without route shape change).                        |
| D-19 | **GAP-011 (feature spec) — RBAC for the 5 new routes — explicitly deferred to v2.** v1 ships with `requireTenantProject()`-only scoping (tenant + project isolation; principal = authenticated user in the resolved tenant/project).                                                                                                                         | HLD §6.1 documents this deferral; no workflow-engine-compatible `requireProjectPermission` middleware exists today. Introducing one as a side-effect of this feature would be precedent-setting cross-cutting work. The 5 routes accept any authenticated principal within the project — adequate for v1 (admins are the only audience for toggle/usage routes per HLD §2). Test spec scenarios that test role-based denial (AUTHZ-1/AUTHZ-2 if any) must adapt to assert tenant-project isolation only for v1.                                                                    | Implement RBAC in this feature (rejected — out of scope, cross-cutting).                                                                                                                                       |
| D-20 | **Feature spec Open Question #7 — audit-event scope** — adopted recommendation: audit-all extraction attempts, including pre-call rejections (`SSRF_BLOCKED`, `RATE_LIMITED`, `QUOTA_EXCEEDED`).                                                                                                                                                             | Security-event traceability; closes the gap where a malicious tenant could probe SSRF blocklists or rate-limiter thresholds without trace. Audit-event volume impact is minimal (rejections are a small fraction of successful extractions).                                                                                                                                                                                                                                                                                                                                       | Audit only successful + Docling-reachable failures (rejected — leaves SSRF/rate-limit probing untraced).                                                                                                       |
| D-21 | **GAP-014 (NEW)** — Azure DI cost counter resets when an admin deletes and recreates the `ConnectorConnection` mid-month. Acceptance: low severity (admin permission required), v1 acceptable. Phase 4 Task 4.9 updates the feature spec gaps table during `/post-impl-sync`.                                                                                | HLD §9 #9 flagged this. Mitigating it in v1 would require a new collection keyed by `{tenantId, projectId, connectorName, yearMonth}` — out of scope for this feature. Admin trail is captured in audit logs.                                                                                                                                                                                                                                                                                                                                                                      | Add the collection now (rejected — scope creep).                                                                                                                                                               |
| D-22 | **HLD OQ-2 (DNS-pinning verification) — RESOLVED** by D-7, D-8, and Task 3.5 step 8 justification. Exit-criterion check: Phase 2 and Phase 3 audits include "every user-controlled URL is fetched via `safeFetch`, not raw `fetch`."                                                                                                                         | The static SSRF check (`assertUrlSafeForSSRF`) is necessary but does NOT close the DNS-rebinding TOCTOU window; only `safeFetch`'s DNS pinning does. Round 3 confirmed `safeFetch` cannot stream request bodies — Task 1.6 uses `safeFetch` for the inbound URL fetch (which DOES need DNS pinning) and raw `http.request` for the outbound POST to the internal Docling URL (which doesn't). Task 3.5 step 8 uses raw `fetch` only on the Azure-provided `operationLocation`.                                                                                                     | Use raw `fetch` for user-supplied URLs (rejected — DNS-rebinding vulnerability).                                                                                                                               |
| D-23 | **Test-spec adaptation for v1 RBAC deferral (D-19)** — AUTHZ-1 / AUTHZ-2 / FORM-ERR-1 scenarios that assert 403 for non-admin roles are **adapted to assert tenant-project-isolation only** for v1 (any authenticated project member can toggle / PATCH caps). The original 403-on-role assertions are deferred to v2 when RBAC lands.                       | Test spec was written expecting RBAC; LLD D-19 defers it. To avoid a perma-failing test, the test files implementing AUTHZ-1/AUTHZ-2 assert v1 behavior with a `// TODO(v2-RBAC):` comment marking the deferred 403 assertion.                                                                                                                                                                                                                                                                                                                                                     | Keep the 403 assertions and let tests fail (rejected — perma-red CI). Skip the tests entirely (rejected — loses tenant-isolation coverage).                                                                    |
| D-10 | `ExtractionEnvelopeSchema` (Zod) is exported from `@agent-platform/connectors` (sub-path `/extraction-envelope`). The extended BullMQ payload type lives in `@agent-platform/search-ai-sdk/types`.                                                                                                                                                           | The envelope schema has three consumers all within or downstream of `packages/connectors`. The job-data type is consumed by both the producer (Docling connector in `packages/connectors`) and the consumer (`apps/search-ai` worker); placing it in the SDK avoids a cross-app import.                                                                                                                                                                                                                                                                                            | Inline in `apps/search-ai` (rejected — producer in `packages/connectors` would create a cross-app dep, breaking monorepo layering).                                                                            |
| D-11 | `ConnectorConnection` Mongoose schema is **extended** with the four cost-cap fields (`usageCount`, `usagePeriodStart`, `usageSoftCap`, `usageHardCap`) as optional typed fields.                                                                                                                                                                             | **(Round 6 corrected)** `updateOne`/`findOneAndUpdate` with `$inc`/`$set` bypasses Mongoose strict-mode validation and goes straight to MongoDB — so the operations would work without schema declaration. The real motivation is **TypeScript type safety on `IConnectorConnection`** (the routes + counter helper read these fields back as typed) and IDE autocomplete. Without typed declarations, `connection.usageCount` would always be `any`/`undefined`.                                                                                                                  | Skip schema declaration (rejected — loses type safety, ergonomics).                                                                                                                                            |
| D-12 | Per-tenant `RateLimiterRedis` for Docling is constructed **once per workflow-engine process** (long-lived singleton) and reused, mirroring `mcp-auth-resolver.ts:248–276`.                                                                                                                                                                                   | `RateLimiterRedis` builds its own internal Lua-script cache; recreating per request thrashes Redis.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Recreate per step (rejected — unnecessary load).                                                                                                                                                               |
| D-13 | **Per-tenant Azure DI circuit breaker uses `@agent-platform/circuit-breaker`** (Redis-backed, Lua-script atomic, **already in the monorepo at `packages/circuit-breaker/`** and consumed by `agent-transfer`, `pipeline-engine`, `project-io`). Use `CircuitBreakerRegistry` with the existing Redis connection.                                             | Round 6 platform audit caught the reinvention. The package exposes `RedisCircuitBreaker.execute(key, fn)` with built-in success/failure tracking. Multi-pod state coordination comes for free, retiring GAP-013 entirely. ~100 LOC of bespoke code disappears.                                                                                                                                                                                                                                                                                                                     | In-process `Map<tenantId, BreakerState>` (rejected — duplicates existing platform infrastructure).                                                                                                             |
| D-14 | Test-first for Phase 1 callback round-trip; test-after for Phase 3 Azure DI normalizers; envelope schema unit tests come **before** either provider's normalizer.                                                                                                                                                                                            | Callback / replay correctness is the dominant invariant; normalizers are pure-function mappings and can follow implementation.                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Test-after everywhere (rejected — late discovery of HMAC signing mismatch is a high-cost rework).                                                                                                              |
| D-15 | Phase 4 ships a deliberate **rollback drill E2E test** (`document-extraction-rollback.spec.ts`).                                                                                                                                                                                                                                                             | HLD §4.3 #11 documents the rollback behavior; documentation does not prove it. Drill asserts flag-off → new runs fail `FEATURE_DISABLED`, in-flight extractions complete, Worker B drains, Worker A (ingestion) is unaffected.                                                                                                                                                                                                                                                                                                                                                     | Manual checklist drill (rejected — regression risk on every future change to the suspension or flag paths).                                                                                                    |
| D-16 | The fixture Docling server (`apps/search-ai/src/__tests__/fixtures/docling-fixture.ts`) is a shared piece of test infrastructure between the worker integration tests and Studio E2E tests.                                                                                                                                                                  | Test spec §2 already plans an out-of-process Docling fixture for E2E; reusing it for Phase 1 integration tests avoids duplicate work and exposes shared bugs in one place. Configurable delay (`?delay=Nms`) makes saturation tests deterministic (test spec PERF-3).                                                                                                                                                                                                                                                                                                              | Inline test doubles inside each test file (rejected — duplicates fixture logic, doesn't support the saturation scenario).                                                                                      |

### Key Interfaces & Types

#### New: `AsyncParkingSentinel` (in `packages/connectors/src/types.ts`)

```typescript
/**
 * Sentinel object returned by a connector action that requires the workflow
 * engine to park the step on a durable callback. Recognized by
 * `executeConnectorAction()` at the workflow-engine layer.
 *
 * Reserved for native connectors only — third-party AP pieces do NOT use this.
 */
export interface AsyncParkingSentinel {
  readonly __asyncParking: true;
  /** Compose as `${executionId}:${stepId}` */
  readonly callbackId: string;
  /** Honors IntegrationNodeConfigSchema.timeout (5..1800s) */
  readonly callbackTimeoutMs: number;
  /** Ciphertext from `deps.encryptSecret(plaintext, tenantId)` */
  readonly encryptedCallbackSecret: string;
}

export function isAsyncParkingSentinel(value: unknown): value is AsyncParkingSentinel {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __asyncParking?: unknown }).__asyncParking === true
  );
}
```

#### Extended: `ActionContext.callbackContext` (in `packages/connectors/src/types.ts`)

```typescript
export interface CallbackContext {
  /** Builds `${WORKFLOW_ENGINE_URL}/api/v1/workflows/callbacks/${executionId}/${stepId}` */
  readonly callbackUrlBuilder: (executionId: string, stepId: string) => string;
  /** Returns ciphertext for the per-step HMAC secret, tenant-keyed */
  readonly encryptSecret: (plaintext: string, tenantId: string) => Promise<string>;
  /** `${executionId}:${stepId}` */
  readonly callbackId: string;
}

export interface ActionContext {
  // ... existing fields
  /** Set only when a native connector needs to enqueue+park (Docling). */
  callbackContext?: CallbackContext;
}
```

#### New: `WorkflowDoclingExtractionJobData` (in `packages/search-ai-sdk/src/types.ts`)

```typescript
/** Existing — kept verbatim. */
export interface DoclingExtractionJobData {
  indexId: string;
  documentId: string;
  sourceUrl: string;
  tenantId: string;
  pipelineStage?: PipelineStageConfig;
}

/** Extraction-only mode for the workflow-engine path. All new fields optional. */
export interface WorkflowDoclingExtractionJobData {
  tenantId: string;
  projectId: string;
  /** User-supplied public URL (re-validated for SSRF in the worker). */
  fileUrl: string;
  mode: 'extraction-only';
  options: {
    extractImages?: boolean;
    extractTables?: boolean;
    ocrEnabled?: boolean;
    language?: string;
    pages?: string;
    timeout?: number;
  };
  callbackId: string;
  callbackUrl: string;
  /** Plaintext HMAC secret. Class-1 internal — Redis treated as trusted. */
  callbackSecret: string;
  /** Optional trace correlation. */
  executionId?: string;
  stepId?: string;
  traceId?: string;
}

export type DoclingExtractionJob = DoclingExtractionJobData | WorkflowDoclingExtractionJobData;
```

#### New: `ExtractionEnvelopeSchema` (in `packages/connectors/src/native/extraction-envelope.ts`)

```typescript
import { z } from 'zod';

export const ExtractionTableSchema = z.object({
  rows: z.array(z.array(z.string())),
  markdown: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
});

export const ExtractionImageSchema = z.object({
  format: z.string(),
  base64: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
});

export const ExtractionHeadingSchema = z.object({ level: z.number().int(), text: z.string() });

export const ExtractionPageSchema = z.object({
  pageNumber: z.number().int().min(1),
  text: z.string(),
  tables: z.array(ExtractionTableSchema).default([]),
  images: z.array(ExtractionImageSchema).default([]),
  headings: z.array(ExtractionHeadingSchema).default([]),
});

export const ExtractionEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.enum(['docling', 'azure-document-intelligence']),
  sourceUrl: z.string().url(),
  contentType: z.string().min(1),
  markdown: z.string(),
  pages: z.array(ExtractionPageSchema),
  metadata: z.object({
    pageCount: z.number().int().min(0),
    language: z.string().optional(),
    languageConfidence: z.number().min(0).max(1).optional(),
    hasOCR: z.boolean().optional(),
    title: z.string().optional(),
    author: z.string().optional(),
    processingTimeMs: z.number().int().min(0).optional(),
  }),
  raw: z.unknown().optional(),
});

export type ExtractionEnvelope = z.infer<typeof ExtractionEnvelopeSchema>;
```

#### Extended: `StepDispatchResult.callbackRequest` (in `apps/workflow-engine/src/handlers/step-dispatcher.ts`)

```typescript
export interface StepDispatchResult {
  // ... existing fields unchanged
  /**
   * Set by `connector_action` step type when the connector action's run()
   * returns an `AsyncParkingSentinel`. Causes the workflow handler to park
   * the step on `sys:callback:${stepId}`.
   */
  callbackRequest?: {
    callbackId: string;
    callbackTimeoutMs: number;
    encryptedCallbackSecret: string;
  };
}
```

#### Extended: `IConnectorConnection` (in `packages/database/src/models/connector-connection.model.ts`)

```typescript
export interface IConnectorConnection {
  // ... existing fields unchanged
  // Cost-cap fields (Azure DI only; optional):
  usageCount?: number;
  usagePeriodStart?: Date;
  usageSoftCap?: number;
  usageHardCap?: number | null;
}
```

### Module Boundaries

| Module                                                                                       | Responsibility                                                                                                         | Depends On                                                                                                 |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/connectors/src/native/extraction-envelope.ts`                                      | Shared Zod `ExtractionEnvelopeSchema`; pure types — no runtime deps                                                    | `zod`                                                                                                      |
| `packages/connectors/src/native/docling/connector.ts`                                        | Docling native connector; `extract_document` action body: SSRF/HEAD/rate-limit, enqueue, return `AsyncParkingSentinel` | `assertUrlSafeForSSRF`, `safeFetch` (HEAD only), `RateLimiterRedis`, `getWorkflowDoclingExtractionQueue()` |
| `packages/connectors/src/native/docling/normalize.ts`                                        | Docling native response → `ExtractionEnvelope`                                                                         | `ExtractionEnvelopeSchema`                                                                                 |
| `packages/connectors/piece-azure-document-intelligence/`                                     | AP-format piece (`createPiece` + `extract_document` action)                                                            | `@activepieces/pieces-framework`, `safeFetch`, `RateLimiterMemory`                                         |
| `packages/connectors/src/adapters/activepieces/auth-adapters/azure-document-intelligence.ts` | Data-mapping shim: resolved `AuthProfile` → AP `CustomAuth` shape (pure function, NOT a `require.cache` monkey-patch)  | `AuthProfile` type only                                                                                    |
| `apps/search-ai/src/workers/docling-extraction-worker.ts`                                    | Existing worker; additively grows a second `new Worker(...)` + top-level branch                                        | unchanged                                                                                                  |
| `apps/search-ai/src/workers/branches/extraction-only.ts`                                     | Workflow-path branch: SSRF re-check + streaming-to-Docling + normalize + size cap + callback POST + retry              | `streaming-url-to-docling.ts`, `callback-poster.ts`, `ExtractionEnvelopeSchema`                            |
| `apps/search-ai/src/workers/branches/streaming-url-to-docling.ts`                            | True streaming HTTP helper: `safeFetch` inbound, `http.request` multipart outbound                                     | `safeFetch`, Node `http`                                                                                   |
| `apps/search-ai/src/workers/callback-poster.ts`                                              | HMAC-signed POST to engine callback route with exp backoff (1 s→30 s; max 5 attempts; 404 terminal)                    | Node `crypto.createHmac`, `safeFetch` for the engine callback (engine URL is internal, but body is small)  |
| `apps/workflow-engine/src/routes/integrations.ts`                                            | Project-scoped Docling toggle endpoints (`enable`, `disable`, `quota`)                                                 | `ConnectorConnection`, `AuthProfile`, `ConnectionService`                                                  |
| `apps/workflow-engine/src/routes/azure-di-usage.ts`                                          | Project-scoped Azure DI usage GET + cap PATCH                                                                          | `ConnectorConnection`                                                                                      |
| `apps/workflow-engine/src/handlers/workflow-handler.ts`                                      | Add `callbackRequest` suspension block (mirror of `toolRequest`)                                                       | `restateCtx`, `raceCancel`, `raceTimeout`                                                                  |

---

## 2. File-Level Change Map

> Verified paths (run on 2026-05-15). Every "MODIFIED" file is read at its referenced line range before editing — agents must NOT assume signatures.

### New Files

| File                                                                                                                                                                                                                                                              | Purpose                                                                                                                                                  | LOC  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `packages/connectors/src/native/extraction-envelope.ts`                                                                                                                                                                                                           | Shared Zod `ExtractionEnvelopeSchema` + types                                                                                                            | ~90  |
| `packages/connectors/src/native/docling/index.ts`                                                                                                                                                                                                                 | Barrel: re-exports connector + normalizer                                                                                                                | ~10  |
| `packages/connectors/src/native/docling/connector.ts`                                                                                                                                                                                                             | Native Docling connector definition + `extract_document` action body                                                                                     | ~280 |
| `packages/connectors/src/native/docling/normalize.ts`                                                                                                                                                                                                             | `DoclingExtractionResult` → `ExtractionEnvelope`                                                                                                         | ~120 |
| `packages/connectors/piece-azure-document-intelligence/package.json`                                                                                                                                                                                              | `@abl/piece-azure-document-intelligence` package descriptor                                                                                              | ~20  |
| `packages/connectors/piece-azure-document-intelligence/tsconfig.json`                                                                                                                                                                                             | TS config (mirror of `piece-shopify/tsconfig.json`)                                                                                                      | ~12  |
| `packages/connectors/piece-azure-document-intelligence/src/index.ts`                                                                                                                                                                                              | `createPiece` definition                                                                                                                                 | ~30  |
| `packages/connectors/piece-azure-document-intelligence/src/auth.ts`                                                                                                                                                                                               | `PieceAuth.CustomAuth({ endpoint, apiKey, apiVersion?, defaultModel? })` + `validate` against `/info`                                                    | ~80  |
| `packages/connectors/piece-azure-document-intelligence/src/actions/extract-document.ts`                                                                                                                                                                           | `createAction({ name: 'extract_document', run })` — SSRF/HEAD/POST `:analyze`/ctx.store stash/poll/cleanup                                               | ~360 |
| `packages/connectors/piece-azure-document-intelligence/src/normalize.ts`                                                                                                                                                                                          | Azure `analyzeResult` → `ExtractionEnvelope`                                                                                                             | ~150 |
| ~~`packages/connectors/piece-azure-document-intelligence/src/circuit-breaker.ts`~~ — **REMOVED Round 6**: replaced by `@agent-platform/circuit-breaker` (Redis-backed, already shipping at `packages/circuit-breaker/`, consumed by `apps/search-ai`). Net 0 LOC. | n/a                                                                                                                                                      | 0    |
| `packages/connectors/piece-azure-document-intelligence/src/__tests__/extract-document.test.ts`                                                                                                                                                                    | Integration test: action body, SSRF, 429+Retry-After, replay safety                                                                                      | ~280 |
| `packages/connectors/piece-azure-document-intelligence/src/__tests__/auth.test.ts`                                                                                                                                                                                | Unit: malformed `endpoint` rejected                                                                                                                      | ~40  |
| `packages/connectors/piece-azure-document-intelligence/src/__tests__/normalize.test.ts`                                                                                                                                                                           | Unit: envelope schema validation across Azure response variants                                                                                          | ~120 |
| `packages/connectors/src/adapters/activepieces/auth-adapters/azure-document-intelligence.ts`                                                                                                                                                                      | Pure data-mapping shim (NOT a `require.cache` patch)                                                                                                     | ~70  |
| `packages/connectors/src/__tests__/extraction-envelope.test.ts`                                                                                                                                                                                                   | Zod schema unit tests                                                                                                                                    | ~110 |
| `packages/connectors/src/__tests__/connection-resolver-none.test.ts`                                                                                                                                                                                              | `auth.type === 'none'` short-circuit returns empty auth context                                                                                          | ~80  |
| `apps/search-ai/src/workers/branches/extraction-only.ts`                                                                                                                                                                                                          | Workflow-path branch                                                                                                                                     | ~220 |
| `apps/search-ai/src/workers/branches/streaming-url-to-docling.ts`                                                                                                                                                                                                 | Streaming inbound + multipart outbound helper                                                                                                            | ~180 |
| `apps/search-ai/src/workers/callback-poster.ts`                                                                                                                                                                                                                   | HMAC-signed callback POST with exp backoff                                                                                                               | ~120 |
| `apps/search-ai/src/__tests__/workflow-docling-extraction-worker.test.ts`                                                                                                                                                                                         | Integration: new branch round-trip + streaming RSS + callback HMAC                                                                                       | ~320 |
| `apps/search-ai/src/__tests__/two-queue-isolation.test.ts`                                                                                                                                                                                                        | Slot-split reservation honored under saturation                                                                                                          | ~180 |
| `apps/search-ai/src/__tests__/extraction-timeout.test.ts`                                                                                                                                                                                                         | Unit: size-scaled timeout calculator                                                                                                                     | ~60  |
| `apps/search-ai/src/__tests__/fixtures/docling-fixture.ts`                                                                                                                                                                                                        | Express fixture Docling at port 8088 with `?delay=Nms` knob; call-count introspection                                                                    | ~140 |
| `apps/workflow-engine/src/routes/integrations.ts`                                                                                                                                                                                                                 | Docling toggle endpoints                                                                                                                                 | ~200 |
| `apps/workflow-engine/src/routes/azure-di-usage.ts`                                                                                                                                                                                                               | Azure DI usage GET + cap PATCH                                                                                                                           | ~150 |
| `apps/workflow-engine/src/services/redis-kv-store.ts`                                                                                                                                                                                                             | Redis-backed `KeyValueStore` adapter (D-9 wiring; Round 3 corrected from a Restate-backed adapter — Restate `WorkflowContext` has no `objectStore` API). | ~80  |
| `apps/workflow-engine/src/__tests__/workflow-docling-parking.test.ts`                                                                                                                                                                                             | Integration: Restate parked-promise survives engine restart + memory invariant at 1000 parked steps                                                      | ~220 |
| `apps/workflow-engine/src/__tests__/docling-toggle-routes.test.ts`                                                                                                                                                                                                | Toggle enable/disable/quota + idempotency + cross-tenant 404                                                                                             | ~180 |
| `apps/workflow-engine/src/__tests__/azure-di-usage-routes.integration.test.ts`                                                                                                                                                                                    | Atomic `$inc` under concurrency, month-boundary reset CAS, `QUOTA_EXCEEDED`                                                                              | ~240 |
| `apps/workflow-engine/src/__tests__/workflow-docling-callback-roundtrip.test.ts`                                                                                                                                                                                  | Callback HMAC verification, signature replay rejection                                                                                                   | ~200 |
| `apps/workflow-engine/src/__tests__/extraction-pii-redaction.test.ts`                                                                                                                                                                                             | PII redaction strips API keys / SSNs / emails before trace event                                                                                         | ~120 |
| `apps/workflow-engine/src/__tests__/docling-rate-limit.test.ts`                                                                                                                                                                                                   | Per-tenant burst + sustained + tenant-config override                                                                                                    | ~180 |
| `apps/workflow-engine/src/__tests__/connector-async-parking.test.ts`                                                                                                                                                                                              | Sentinel recognition in `executeConnectorAction` + `StepDispatchResult.callbackRequest` plumbing                                                         | ~140 |
| `apps/studio/src/pages/projects/[projectId]/settings/integrations.tsx`                                                                                                                                                                                            | Project Settings → Integrations tab (Docling toggle card)                                                                                                | ~140 |
| `apps/studio/src/components/projects/IntegrationsCard.tsx`                                                                                                                                                                                                        | Docling toggle card with static rate-limit info line                                                                                                     | ~180 |
| `apps/studio/src/components/projects/AzureDIUsageView.tsx`                                                                                                                                                                                                        | Usage view (current count + soft cap + hard cap)                                                                                                         | ~160 |
| `apps/studio/src/app/api/projects/[projectId]/integrations/docling/[action]/route.ts`                                                                                                                                                                             | Studio BFF proxy → workflow-engine                                                                                                                       | ~80  |
| `apps/studio/src/app/api/projects/[projectId]/integrations/azure-document-intelligence/usage/route.ts`                                                                                                                                                            | Studio BFF proxy → workflow-engine                                                                                                                       | ~70  |
| `apps/studio/e2e/workflows/document-extraction-docling.spec.ts`                                                                                                                                                                                                   | E2E: enable toggle → run PDF → envelope + SSRF rejection                                                                                                 | ~200 |
| `apps/studio/e2e/workflows/document-extraction-azure-di.spec.ts`                                                                                                                                                                                                  | E2E: AuthProfile → run XLSX → envelope + replay safety                                                                                                   | ~200 |
| `apps/studio/e2e/workflows/document-extraction-parity.spec.ts`                                                                                                                                                                                                    | E2E: cross-provider parity for same PDF                                                                                                                  | ~150 |
| `apps/studio/e2e/workflows/document-extraction-large-file.spec.ts`                                                                                                                                                                                                | E2E: 50 MB PDF under timeout; RSS delta                                                                                                                  | ~140 |
| `apps/studio/e2e/workflows/document-extraction-two-queue-isolation.spec.ts`                                                                                                                                                                                       | E2E: saturate ingestion → workflow drains at reserved rate                                                                                               | ~180 |
| `apps/studio/e2e/workflows/document-extraction-rate-limit.spec.ts`                                                                                                                                                                                                | E2E: 30 enqueues → burst → refill → RATE_LIMITED                                                                                                         | ~140 |
| `apps/studio/e2e/workflows/document-extraction-restate-replay.spec.ts`                                                                                                                                                                                            | E2E: engine pod restart between enqueue and callback                                                                                                     | ~160 |
| `apps/studio/e2e/workflows/document-extraction-rollback.spec.ts`                                                                                                                                                                                                  | E2E: rollback drill (D-15)                                                                                                                               | ~140 |
| `apps/studio/e2e/workflows/fixtures/docling-fixture.ts` _(shared with apps/search-ai)_                                                                                                                                                                            | Symlink / re-export of the shared fixture                                                                                                                | ~10  |
| `apps/studio/e2e/workflows/fixtures/azure-di-fixture.ts`                                                                                                                                                                                                          | Express fixture Azure DI: 202+Operation-Location, GET op poll endpoints                                                                                  | ~140 |

### Modified Files

| File                                                                                                                                         | Change Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Lines (approx) | Risk          |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ------------- |
| `apps/search-ai/src/workers/docling-extraction-worker.ts`                                                                                    | (a) Add top-level branch on `job.queueName === QUEUE_WORKFLOW_DOCLING_EXTRACTION` calling `processExtractionOnly(job)`. (b) Factory takes two concurrencies (default 3 ingestion + 2 workflow); add second `new Worker(QUEUE_WORKFLOW_DOCLING_EXTRACTION, ...)`. (c) Runtime assertion sums ≤ `INGESTION_MAX_CONCURRENT_JOBS`. The full-ingestion branch is **byte-for-byte unchanged** — assert via the existing `text-extraction-integration.test.ts`.                                                                                                                                                           | +~40 / -0      | High          |
| `apps/search-ai/src/queues/queue-factory.ts`                                                                                                 | Add `getWorkflowDoclingExtractionQueue()` (mirror of existing `getDoclingExtractionQueue()` at :125)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | +~25           | Low           |
| `packages/search-ai-sdk/src/constants.ts`                                                                                                    | Add `QUEUE_WORKFLOW_DOCLING_EXTRACTION = 'workflow-docling-extraction'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | +1             | Low           |
| `packages/search-ai-sdk/src/types.ts`                                                                                                        | Add `WorkflowDoclingExtractionJobData` interface + `DoclingExtractionJob` union                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | +~40           | Low           |
| `packages/search-ai-sdk/src/index.ts`                                                                                                        | Re-export new constant + type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | +2             | Low           |
| `packages/shared-encryption/src/encryption-manifest.ts`                                                                                      | Add `'workflow-docling-extraction': { fieldsToEncrypt: [] }` after the existing `'search-docling-extraction'` entry (line ~34)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | +1             | Low           |
| `apps/workflow-engine/src/handlers/step-dispatcher.ts`                                                                                       | (a) Add `callbackRequest?` field to `StepDispatchResult` (line 109–139). (b) Inside the `connector_action` case (lines 185–195), after `executeConnectorAction()` returns, check `isAsyncParkingSentinel(output)` and convert: `return { type, output: null, input, callbackRequest: { callbackId, callbackTimeoutMs, encryptedCallbackSecret } }`.                                                                                                                                                                                                                                                                | +~25           | Medium        |
| `apps/workflow-engine/src/handlers/workflow-handler.ts`                                                                                      | (a) Update `hasSuspension()` (line 3896–3903) to include `callbackRequest`. (b) Add new suspension block after the `toolRequest` block (line 3197, before the cancellation check at 3199). Block mirrors `toolRequest` shape: persist encrypted secret → publish `step.waiting_callback` → `restateCtx.promise(`sys:callback:${stepId}`).get()` with `raceCancel(raceTimeout)` → on `TimeoutError` fail with `STEP_TIMEOUT`. **DO NOT** touch the existing `webhookRequest` or `toolRequest` blocks.                                                                                                               | +~75           | High          |
| `apps/workflow-engine/src/index.ts`                                                                                                          | (a) Mount `integrationsRouter` and `azureDiUsageRouter` on the **authenticated `projectRouter`** (around line 1342) — NOT after the unauthenticated callback router at line 1225 (D-17). (b) Construct a process-level `RedisKvStore(redisConnection, 'connector-kv:')` singleton; extend `connectorDepsFactory(tenantId, projectId, workflowExecutionId?, stepId?)` to pass the singleton as the 4th ctor arg to `ConnectorToolExecutor` (**D-9 wiring, Redis-backed, NOT Restate state — `WorkflowContext` has no `objectStore`**).                                                                              | +~30 / -0      | High          |
| `apps/workflow-engine/src/index.ts`                                                                                                          | Wrap connector loading in flag check: `if (WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED) { /* register docling */ }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | +~6            | Low           |
| `packages/connectors/src/loader.ts`                                                                                                          | (a) Eagerly register `doclingConnector` (after `registry.register(httpConnector)` at line 95) — gate on env flag. (b) Add `['azure-document-intelligence', '@abl/piece-azure-document-intelligence']` to `PIECE_PACKAGES` (line 42–83) **conditionally on the env flag**. (c) Add adapter branch: `if (shortName === 'azure-document-intelligence') applyAzureDIAuthAdapter(localRequire);` — but since the adapter is data-mapping, **no `localRequire` is needed**; the adapter is invoked inline by the runtime-adapter's auth normalization path. **Document this divergence from `jira-cloud`/`servicenow`.** | +~15           | Medium        |
| `packages/connectors/src/auth/connection-resolver.ts`                                                                                        | Short-circuit `resolveAuth(connection)` when the resolved `AuthProfile.auth.type === 'none'` — return `{}` without calling `authProfileResolver.resolve(...)`. Avoids triggering `tenant-encryption-facade.decrypt` on a synthetic no-secret profile.                                                                                                                                                                                                                                                                                                                                                              | +~12           | Medium        |
| `packages/connectors/src/services/connection-service.ts`                                                                                     | Add `upsertSyntheticNoAuthProfile(tenantId, connectorName)` helper used by the Docling toggle. Idempotent — uses `findOneAndUpdate` with `upsert: true` on `{ tenantId, type: 'system-docling-none', connectorName }`.                                                                                                                                                                                                                                                                                                                                                                                             | +~50           | Medium        |
| `packages/connectors/src/adapters/activepieces/context-translator.ts`                                                                        | At the `connectionConfig` bridging point (lines 211–290), call `applyAzureDIAuthAdapter` when `connection.connectorName === 'azure-document-intelligence'` to transform `{ apiKey, connectionConfig: { endpoint, apiVersion?, defaultModel? } }` → AP `CustomAuth` shape `{ endpoint, apiKey, apiVersion, defaultModel }`. **Pure function call — no require.cache patching.**                                                                                                                                                                                                                                     | +~15           | Medium        |
| `packages/connectors/src/types.ts`                                                                                                           | Add `CallbackContext` interface; add `callbackContext?` to `ActionContext`; export `AsyncParkingSentinel` + `isAsyncParkingSentinel`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | +~30           | Low           |
| `packages/connectors/src/executor/connector-tool-executor.ts`                                                                                | (a) Constructor signature widens: 4th param `kvStore: KeyValueStore = NOOP_STORE` stays as default; add 5th optional param `callbackContext?: CallbackContext`. (b) Inside `execute()` (line 124–134), pass `callbackContext` through into `ActionContext`.                                                                                                                                                                                                                                                                                                                                                        | +~15           | Medium        |
| `apps/workflow-engine/src/executors/connector-action-executor.ts`                                                                            | After the existing `deps.connectorToolExecutor.execute(...)` call (line 87), check `isAsyncParkingSentinel(result)` and return it verbatim so the dispatcher can detect it. (No transform here; the dispatcher converts to `StepDispatchResult.callbackRequest`.)                                                                                                                                                                                                                                                                                                                                                  | +~10           | Low           |
| `packages/shared/src/types/workflow-schemas.ts`                                                                                              | Widen `IntegrationNodeConfigSchema.timeout` (line 168) from `.max(300)` to `.max(1800)`. Default and min unchanged. Workflows authored with `timeout ≤ 300` continue to validate.                                                                                                                                                                                                                                                                                                                                                                                                                                  | ±1             | Low (FR-6)    |
| `packages/database/src/models/connector-connection.model.ts`                                                                                 | Add optional schema fields: `usageCount: { type: Number }`, `usagePeriodStart: { type: Date }`, `usageSoftCap: { type: Number }`, `usageHardCap: { type: Number, default: null }`. Update `IConnectorConnection` interface analogously.                                                                                                                                                                                                                                                                                                                                                                            | +~15           | Low           |
| `packages/connectors/src/registry.ts`                                                                                                        | If `register` does not currently allow eager re-register on flag toggle, no change. If it errors on duplicate, add `if (!registry.has('docling'))` guard in `loader.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                           | 0–5            | Low           |
| `packages/connectors/src/generated/connector-catalog.json`                                                                                   | Regenerate via `pnpm connectors:generate-catalog` after both connectors are registered. Committed as a generated artifact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | +~80           | Low           |
| `apps/workflow-engine/src/routes/index.ts`                                                                                                   | Export `createIntegrationsRouter`, `createAzureDiUsageRouter`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | +2             | Low           |
| `apps/studio/src/components/workflows/canvas/config/IntegrationPickerModal.tsx`                                                              | **REUSED — no changes** (HLD §3.2). The picker already gates on `ConnectorConnection` presence via the catalog endpoint.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 0              | n/a           |
| `apps/studio/src/components/workflows/canvas/config/DynamicActionForm.tsx`                                                                   | **REUSED — no changes** (HLD §3.2). Auto-renders from AP CustomAuth `props`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 0              | n/a           |
| `apps/runtime/Dockerfile`, `apps/studio/Dockerfile`, `apps/search-ai/Dockerfile`, `apps/workflow-engine/Dockerfile`, `apps/admin/Dockerfile` | Add `COPY packages/connectors/piece-azure-document-intelligence ./packages/connectors/piece-azure-document-intelligence` after the existing `COPY packages/connectors` lines (CLAUDE.md "Dockerfile sync rule"). The two currently-modified Dockerfiles in the working tree (docling-service, preprocessing-service) are unrelated.                                                                                                                                                                                                                                                                                | +1 per app × 5 | Low (GAP-010) |

### Deleted Files

None. Feature commits must be additive (CLAUDE.md `deletion-ratio-guard.sh` blocks `feat()` >30% deletions).

---

## 3. Implementation Phases

> Each phase is independently deployable + testable. No phase leaves the system in a broken state. Phase 0 is the SDLC artifact phase (this LLD); Phase 1–5 build the feature; Phase 6 promotes to GA.

### Phase 1 — Worker branch + workflow callback suspension + two-queue topology

**Goal**: Land a fully testable enqueue→park→resume round-trip without any user-visible Studio surface or producer connector.

**Tasks (3.5 days):**

1.1. Add `QUEUE_WORKFLOW_DOCLING_EXTRACTION = 'workflow-docling-extraction'` to `packages/search-ai-sdk/src/constants.ts` and re-export from `index.ts`.

1.2. Add `WorkflowDoclingExtractionJobData` + `DoclingExtractionJob` union to `packages/search-ai-sdk/src/types.ts`.

1.3. Add `'workflow-docling-extraction': { fieldsToEncrypt: [] }` to `packages/shared-encryption/src/encryption-manifest.ts` (mirror existing line ~34).

1.4. Add `getWorkflowDoclingExtractionQueue()` to `apps/search-ai/src/queues/queue-factory.ts` — mirror `getDoclingExtractionQueue()` at line 125; same Redis cluster, same `{bull}` prefix conventions.

1.5. Write the fixture Docling server at `apps/search-ai/src/__tests__/fixtures/docling-fixture.ts` with `POST /extract?delay=N` and call-count introspection. Symlink into `apps/studio/e2e/workflows/fixtures/docling-fixture.ts`.

1.6. Implement `apps/search-ai/src/workers/branches/streaming-url-to-docling.ts` per D-7:

- Inbound: `safeFetch(fileUrl)` → consume `response.body` as Web `ReadableStream` → convert to Node `Readable` via `Readable.fromWeb()`.
- Outbound: build `form-data` `FormData`, append the Node `Readable` as `'file'`, post via raw `http.request` to `${DOCLING_SERVICE_URL}/extract` with `form.getHeaders()`. Size-scaled timeout: `60_000 + (sizeBytes / 1024 / 1024) * 10_000`, capped 1_800_000.
- Return the parsed Docling-native response (same shape as existing `DoclingExtractionResult`).

  1.7. Implement `apps/search-ai/src/workers/callback-poster.ts`:

- **Reuse `buildSignatureHeaders(secret, rawBody)` from `@agent-platform/shared-kernel/security`** (`packages/shared-kernel/src/security/webhook-signature.ts:43–51`). It returns `{ 'x-webhook-signature', 'x-webhook-timestamp', 'x-webhook-id' }` — the platform-standard naming. The callback route's `getHeader()` fallback at `workflow-callbacks.ts:103,110` accepts both `x-webhook-*` and `x-callback-*`, so using the platform helper outputs verbatim is preferred over hand-renaming to `x-callback-*` (Round 6 platform-audit finding 2).
- Do NOT call `crypto.createHmac` directly; the platform's helper handles the `whsec_` prefix and the `${timestamp}.${body}` signed-content composition expected by `verifyWebhookSignature` at the callback route.
- Exp backoff 1 s → 2 s → 4 s → 8 s → 16 s (cap 30 s); max 5 attempts; 404 terminal (no retry); 401/403 terminal with metric increment.
- Emit `workflow_docling_callback_post_attempts_total{tenant, attempt}` + `workflow_docling_callback_post_failures_total{tenant, error_class}`.

  1.8. Implement `apps/search-ai/src/workers/branches/extraction-only.ts`:

- Re-validate `assertUrlSafeForSSRF(fileUrl)` (Redis-hop defense).
- Stream URL → Docling via 1.6.
- Normalize Docling response → `ExtractionEnvelope` using `packages/connectors/src/native/docling/normalize.ts` (created in Phase 2 but the import is forward-referenced — Phase 1 lands a temporary local normalizer to be replaced in Phase 2.4 with the canonical one).
- `serializedSize = Buffer.byteLength(JSON.stringify(envelope), 'utf8')`. If > `DOCLING_WORKFLOW_INLINE_CAP_BYTES` → callback `{ status: 'failed', error: { code: 'EXTRACTION_TOO_LARGE', sizeBytes, limitBytes } }`.
- On success: callback `{ status: 'success', envelope }`. On failure: `{ status: 'failed', error: { code, message: sanitized } }`.

  1.9. Modify `apps/search-ai/src/workers/docling-extraction-worker.ts`:

- **(Round 3 fix)** Widen the processor's parameter type from `Job<DoclingExtractionJobData>` to `Job<DoclingExtractionJob>` (the union introduced in Task 1.2). The narrowing `job.data.mode === 'extraction-only'` (and `job.queueName`) discriminates the two shapes inside the branch.
- Add top-level branch at start of `processDoclingExtractionJob`: `if (job.queueName === QUEUE_WORKFLOW_DOCLING_EXTRACTION || job.data.mode === 'extraction-only') return processExtractionOnly(job as Job<WorkflowDoclingExtractionJobData>);`.
- Refactor `createDoclingExtractionWorker(concurrency)` → `createDoclingExtractionWorker({ ingestionConcurrency, workflowConcurrency })`. Default values: 3 + 2. Read env vars `DOCLING_INGESTION_CONCURRENCY` / `DOCLING_WORKFLOW_CONCURRENCY`. Runtime assertion: sum ≤ `INGESTION_MAX_CONCURRENT_JOBS` (`apps/search-ai/src/server.ts:548`).
- Create two `new Worker(...)` subscriptions sharing the processor. Both honor `lockDuration: 600_000` and `stalledInterval: 300_000` (unchanged from existing).
- **(Round 2 + Round 3 fix)** Return shape changes from `Worker<DoclingExtractionJobData>` to `{ ingestion: Worker; workflow: Worker }`. The actual call site is `apps/search-ai/src/workers/index.ts:94` (verified Round 3). Replace the current `createDoclingExtractionWorker(concurrency)` call with:
  ```typescript
  const docling = createDoclingExtractionWorker({
    ingestionConcurrency: Number(process.env.DOCLING_INGESTION_CONCURRENCY) || 3,
    workflowConcurrency: Number(process.env.DOCLING_WORKFLOW_CONCURRENCY) || 2,
  });
  workers.push({ name: 'docling-extraction', worker: docling.ingestion });
  if (process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED === 'true') {
    workers.push({ name: 'docling-extraction-workflow', worker: docling.workflow });
  }
  ```
- The `docling.workflow` worker is still constructed even when the flag is off (the factory builds both unconditionally), but its registration in `WorkerEntry[]` is gated on the flag (D-3 layer c). Constructing-but-not-registering means no Redis subscription is created (the factory must NOT call `.run()` on the worker — verify the existing pattern uses lazy start).

  1.10. Modify `apps/workflow-engine/src/handlers/step-dispatcher.ts`:

- Add `callbackRequest` field to `StepDispatchResult` (around line 109–139).
- In the `connector_action` case (lines 185–195), after `executeConnectorAction()` returns, check `isAsyncParkingSentinel(output)`. If true, return: `{ type: 'connector_action', output: null, input, callbackRequest: { callbackId: sentinel.callbackId, callbackTimeoutMs: sentinel.callbackTimeoutMs, encryptedCallbackSecret: sentinel.encryptedCallbackSecret } }`.
- Import `isAsyncParkingSentinel` from `@agent-platform/connectors`.

  1.11. Modify `apps/workflow-engine/src/handlers/workflow-handler.ts`:

- Update `hasSuspension()` at line 3896–3903: add `result.callbackRequest !== undefined`.
- Add new suspension block AFTER the `toolRequest` block's closing brace (line 3197) and BEFORE the cancellation check at line 3199. Block content:
  - `if (result.callbackRequest !== undefined && restateCtx) { ... }`
  - Persist `encryptedCallbackSecret` onto step record (mirror line 2843–2849: `rebuildStepContext` + `setStepContext` + `deps.persistence.updateStepStatus(..., 'waiting_callback', ...)`).
  - Publish `step.waiting_callback` event (mirror line 2903–2918).
  - Park: `callbackPayload = await raceCancel(restateCtx, raceTimeout(restateCtx, restateCtx.promise<unknown>(`sys:callback:${step.id}`).get(), result.callbackRequest.callbackTimeoutMs))`.
  - On `TimeoutError`: persist `failed` + `STEP_TIMEOUT` (mirror line 2933–2956), throw `WorkflowStepError`.
  - On success: write `callbackPayload` as step output (mirror line 2959–2971); call `markStepCompleted`.

    1.12. Modify `packages/connectors/src/types.ts`:

- Add `AsyncParkingSentinel`, `isAsyncParkingSentinel`, `CallbackContext`.
- Add `callbackContext?: CallbackContext` on `ActionContext`.
- **(D-9b)** Add optional `workflowExecutionId?: string` and `stepId?: string` on `ExecutorContext` AND `ActionContext`. These carry the workflow execution context that the Azure DI piece (Phase 3) needs for its `ctx.store` key. The existing `executionId: crypto.randomUUID()` field at `connector-tool-executor.ts:62` stays unchanged (it remains a per-invocation correlation id).
- **(Round 2 fix)** Add optional `connectionId?: string` to `ActionContext` (mirroring the existing `TriggerContext.connectionId` pattern at `packages/connectors/src/types.ts:166`). The Azure DI piece needs the raw `connectionId` for its tenant-scoped cost-cap queries (Phase 3 Task 3.5 steps 1 and 12).

  1.13. Modify `packages/connectors/src/executor/connector-tool-executor.ts`:

- Add 5th optional ctor param `callbackContext`; pass through into `ActionContext`.
- Widen the ctor signature so the 4th `kvStore` param remains as today (default `NOOP_STORE`).
- **(D-9b)** When constructing `ActionContext` (around line 124–134), propagate `workflowExecutionId` and `stepId` from `ExecutorContext` (currently typed `{ tenantId, projectId, userId? }` at line 25–29). Widen `ExecutorContext` accordingly.
- **(Round 2 fix)** Populate `actionContext.connectionId = resolved.connection._id` inside `execute()` (after the existing `connectionResolver.resolve(...)` call around lines 84–90, before the `ActionContext` is built).
- The new fields stay optional so non-workflow callers (e.g., agent-tool path) are unaffected.

  1.13b. **(D-9b — strategy resolved at Round 2)** Modify `apps/workflow-engine/src/executors/connector-action-executor.ts`:

- Widen `ConnectorActionStep` (line 15–32) to accept `workflowExecutionId` and `stepId` from the caller.
- **Resolved strategy (option a from Round 1)**: keep `ConnectorActionDeps` as `{ connectorToolExecutor: ConnectorToolExecutor }` (singleton-per-dispatch) and extend `connectorDepsFactory` (`apps/workflow-engine/src/index.ts:952–959`) signature to `(tenantId, projectId, workflowExecutionId?, stepId?) => ConnectorActionDeps`. Each step dispatch calls the factory with the live `ctx.workflow.executionId` and `step.id`; the factory builds a fresh `ConnectorToolExecutor` with the populated `ExecutorContext`. No change to `execute()` positional signature; no factory-of-factory complexity.
- The `dispatchStep()` `connector_action` case (`step-dispatcher.ts:185–195`) is the call site that passes `ctx.workflow.executionId` + `step.id` into the deps factory. Verify Round 3 that `WorkflowContextData.workflow.executionId` is available at this point (it is — the dispatcher receives `ctx: WorkflowContextData`).

  1.14. Widen `IntegrationNodeConfigSchema.timeout` in `packages/shared/src/types/workflow-schemas.ts` (line 168) from `.max(300)` to `.max(1800)`.

  1.15. **Phase 1 commit split (D-2)**:

- **Commit 1.A** — `[ABLP-1073] feat(workflow-docling): add extraction-only worker branch + queue topology`
  - `apps/search-ai/**` (worker refactor + new branch + streaming helper + callback poster + fixture)
  - `packages/search-ai-sdk/**` (constant + type)
  - `packages/shared-encryption/**` (manifest entry)
- **Commit 1.B** — `[ABLP-1073] feat(workflow-engine): wire connector_action async-parking suspension`
  - `apps/workflow-engine/src/handlers/**` (suspension block + dispatcher field)
  - `apps/workflow-engine/src/executors/connector-action-executor.ts` (sentinel pass-through)
  - `packages/connectors/src/types.ts` + `packages/connectors/src/executor/connector-tool-executor.ts` (ActionContext + ctor widening)
  - `packages/shared/src/types/workflow-schemas.ts` (timeout widening)

**Exit Criteria:**

- [ ] `pnpm build` succeeds with 0 errors across `apps/search-ai`, `apps/workflow-engine`, `packages/search-ai-sdk`, `packages/shared-encryption`, `packages/connectors`, `packages/shared`.
- [ ] `apps/search-ai/src/__tests__/text-extraction-integration.test.ts` runs **byte-for-byte unchanged** (backward-compat invariant; feature-spec success metric).
- [ ] New unit test `apps/search-ai/src/__tests__/extraction-timeout.test.ts` covers timeout calculator at sizes 1 / 50 / 500 MB.
- [ ] New integration test `workflow-docling-extraction-worker.test.ts` exercises: enqueue → SSRF re-check → stream → fixture Docling → callback HMAC POST → 200 OK. Asserts envelope shape via `ExtractionEnvelopeSchema.parse(...)`.
- [ ] New integration test `two-queue-isolation.test.ts` saturates ingestion (3 long jobs to fixture with `?delay=10000`) and asserts workflow jobs complete in <2 s. Per-pod `worker_active_jobs{queue=...}` never exceeds 3 / 2.
- [ ] New integration test `workflow-docling-parking.test.ts` enqueues 1000 parked steps and asserts pod RSS delta < 50 MB. Also forces an engine restart between enqueue and callback; promise re-attaches; exactly one Docling call observed via fixture call-count.
- [ ] New integration test `connector-async-parking.test.ts` asserts `isAsyncParkingSentinel(output)` → `StepDispatchResult.callbackRequest` plumbing.
- [ ] New integration test `workflow-docling-callback-roundtrip.test.ts` asserts HMAC signature is mandatory (401 on missing/invalid; replay-window check uses existing `CALLBACK_REPLAY_TOLERANCE_MS`).
- [ ] Streaming RSS invariant: integration test with a 100 MB synthetic PDF asserts worker pod RSS delta < 10 MB during call (use `process.memoryUsage().rss` baseline + post).
- [ ] **(Round 7 add)** Race-condition negative test (`workflow-docling-late-callback.test.ts`): force the engine's `raceTimeout` to fire BEFORE the worker's callback POST arrives; the late POST must receive HTTP 409 (`step.status !== 'waiting_callback'`) and NOT crash the engine. Asserts `workflow_docling_callback_post_failures_total{error_class='STEP_NOT_WAITING'}` is incremented.
- [ ] No mocks of `@agent-platform/*` or `@abl/*` in any new test (CLAUDE.md `platform-mock-lint.sh`).
- [ ] `npx prettier --write` run on all touched files.
- [ ] Each of the 2 commits is ≤ 40 non-doc files and ≤ 3 packages (`commit-scope-guard.sh`).

**Test Strategy:**

- **Unit**: timeout calculator (extraction-timeout.test.ts); envelope schema parse (extraction-envelope.test.ts).
- **Integration**: worker branch end-to-end via fixture; two-queue isolation under deterministic saturation; parking memory invariant; callback HMAC round-trip; sentinel→`callbackRequest` plumbing.
- **E2E**: defer to Phase 2 (no Studio UI yet).

**Rollback**: `git revert` both commits (1.A and 1.B). The two-queue topology refactor is the only structural change; `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED=false` does NOT undo it because the worker subscription gate is in Phase 2 wiring. To leave the topology in place but disable the workflow branch, set `DOCLING_WORKFLOW_CONCURRENCY=0`.

---

### Phase 2 — Docling native connector + project toggle + Studio surface

**Goal**: Workflow designers can enable Docling per-project and use the `extract_document` action in workflows.

**Tasks (3.5 days):**

2.1. Create `packages/connectors/src/native/extraction-envelope.ts` with the Zod schema from §1. Add `packages/connectors/src/__tests__/extraction-envelope.test.ts` with 12+ Zod parse cases (happy path, missing required fields, schemaVersion mismatch, malformed bbox, etc.).

2.2. Create `packages/connectors/src/native/docling/normalize.ts` mapping `DoclingExtractionResult` (from `apps/search-ai/src/workers/docling-extraction-worker.ts:82–102`) → `ExtractionEnvelope`. Replace the Phase 1 temporary normalizer in `branches/extraction-only.ts` with this canonical one.

2.3. Create `packages/connectors/src/native/docling/connector.ts`. The `extract_document` action's `run(ctx)`:

- Validate `ctx.params` against an input Zod schema (`fileUrl` required URL, others optional with defaults).
- `assertUrlSafeForSSRF(fileUrl)` from `@agent-platform/shared-kernel/security`.
- HEAD probe via `safeFetch(fileUrl, { method: 'HEAD' })` with 10 s timeout (D-8 — small response, buffered body is fine). Reject on unsupported content type (allowlist: pdf, docx, pptx, html, png, jpeg, tiff, bmp, webp, md, txt). Reject if `Content-Length > DOCLING_WORKFLOW_SIZE_HARD_CAP_BYTES`.
- `await rateLimiter.consume(`workflow:docling:${ctx.tenantId}`, 1)`. Throw typed `RATE_LIMITED` on `RateLimiterRes`.
- Generate plaintext HMAC secret via `randomBytes(32).toString('hex')`. Encrypt via `ctx.callbackContext.encryptSecret(plaintext, ctx.tenantId)`.
- Build `callbackUrl = ctx.callbackContext.callbackUrlBuilder(executionId, stepId)`.
- Enqueue `WorkflowDoclingExtractionJobData` onto `QUEUE_WORKFLOW_DOCLING_EXTRACTION` with `attempts: 1`.
- Return `AsyncParkingSentinel`.

  2.4. Wire the Docling rate-limiter singleton:

- In `apps/workflow-engine/src/index.ts`, instantiate one `RateLimiterRedis` at server startup (or lazy-init on first use, **analogous to** `mcp-auth-resolver.ts:248–276`'s `if (!redisRateLimiter) { ... }` pattern): key prefix `workflow:docling:`, points = `DOCLING_WORKFLOW_RATE_LIMIT_PER_MIN` (default 10), duration = 60, blockDuration = 0.
- Pass it into `ConnectorDepsFactory` so the Docling connector can `import { getDoclingRateLimiter }` from a small singleton module in `packages/connectors/src/native/docling/rate-limiter.ts` (injected via `callbackContext` augmentation or via a separate `connectorDeps` field).

  2.5. Modify `packages/connectors/src/loader.ts`:

- After the eager HTTP registration (line 95), if `process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED === 'true'` AND `!registry.has('docling')`, register the Docling native connector.

  2.6. Modify `packages/connectors/src/auth/connection-resolver.ts` per the no-auth short-circuit optimization: when the resolved `AuthProfile.auth.type === 'none'`, return `{}` without invoking `authProfileResolver.resolve(...)` — avoids triggering `tenant-encryption-facade.decrypt` on a synthetic no-secret profile (FR-15). Add `connection-resolver-none.test.ts`.

  2.7. Modify `packages/connectors/src/services/connection-service.ts` — add `upsertSyntheticNoAuthProfile(tenantId, connectorName, principal)`:

- `findOneAndUpdate({ tenantId, type: 'system-docling-none', connectorName, scope: 'tenant' }, { $setOnInsert: { auth: { type: 'none' }, displayName: 'Docling (system)' } }, { upsert: true, new: true })`.
- Returns the resulting `AuthProfile._id` for the toggle endpoint to bind on the `ConnectorConnection`.

  2.8. Create `apps/workflow-engine/src/routes/integrations.ts`:

- **All handlers validate request params/body with Zod `.safeParse()`** (CLAUDE.md route-validation rule). Param schema: `z.object({ projectId: z.string().min(1) })`. Body schemas defined per route (Docling toggle routes accept empty bodies; reject extras via `.strict()`).
- **Auth chain**: routes live on the authenticated `projectRouter` (`requireAuth` + `tenantContext` already applied). Each handler additionally calls `requireTenantProject(req, res)` and short-circuits on the typed reject envelope.
- **Routes (paths relative to the `projectRouter` mount point `/api/projects/:projectId/integrations`)**:
  - `POST /docling/enable` — verify env flag; on flag-off return HTTP **404** with `{ success: false, error: { code: 'FEATURE_DISABLED', message: 'Feature not available' } }` (D-18). On flag-on: call `upsertSyntheticNoAuthProfile(tenantId, 'docling')` (returns `authProfileId`); `ConnectorConnection.findOneAndUpdate({ tenantId, projectId, connectorName: 'docling' }, { $set: { status: 'active', authProfileId, displayName: 'Docling', scope: 'tenant' } }, { upsert: true, new: true })`. Return `{ success: true, data: connection }` (HTTP 200).
  - `POST /docling/disable` — `ConnectorConnection.findOneAndDelete({ tenantId, projectId, connectorName: 'docling' })`. Synthetic AuthProfile remains (harmless). Return `{ success: true, data: { deleted: true } }` (HTTP 200).
  - `GET /docling/quota` — read tenant config + env defaults. Return `{ success: true, data: { limitPerMinute, burst, scope: 'workspace' } }`.
- **Mount in `apps/workflow-engine/src/index.ts`** (**D-17 — corrected**): mount the router on the **authenticated `projectRouter`** (used by `connections.ts` and friends; located around line 1342 — verify exact line at Round 2). NOT after the unauthenticated callback router at line 1225. Example: `projectRouter.use('/integrations', integrationsRouter)`.

  2.9. Studio surface:

- Add `apps/studio/src/app/api/projects/[projectId]/integrations/docling/[action]/route.ts` (Next.js App-Router BFF proxy).
- Add `apps/studio/src/pages/projects/[projectId]/settings/integrations.tsx` — fetches `GET .../docling/quota`, renders `IntegrationsCard`.
- Add `apps/studio/src/components/projects/IntegrationsCard.tsx` — Switch from `components/ui/Switch.tsx` (NOT a native `<input type="checkbox">`). `useMutation` for enable/disable; `onError` callback displays the error to the user (CLAUDE.md Studio UI rule). Static info line uses i18n key `integrations.docling.rateLimitInfo` with interpolation: `"Rate limit: {limitPerMinute} extractions per minute (workspace-wide)"`.

  2.9b. **(Round 3 fix)** i18n strategy for Phase 2 Studio components:

- Namespace: `studio` (existing); use `useTranslations('studio')`.
- New keys in `packages/i18n/locales/en/studio.json` under prefix `integrations.docling.*`:
  - `integrations.docling.sectionTitle` → "Document Extraction"
  - `integrations.docling.toggleLabel` → "Enable Docling extraction"
  - `integrations.docling.toggleAriaLabel` → "Toggle Docling extraction"
  - `integrations.docling.rateLimitInfo` → "Rate limit: {limitPerMinute} extractions per minute (workspace-wide)"
  - `integrations.docling.enableSuccess` / `enableFailure` (toast strings)
  - `integrations.docling.disableSuccess` / `disableFailure`
  - `integrations.docling.disabledHint` → "Workflows using Docling will fail with INTEGRATION_DISABLED until re-enabled."
- All user-visible strings go through `t(...)`. No hard-coded English in JSX.

  2.10. Regenerate `packages/connectors/src/generated/connector-catalog.json` via `pnpm connectors:generate-catalog`.

  2.11. Add Studio E2E `apps/studio/e2e/workflows/document-extraction-docling.spec.ts` (test spec scenarios #1, #3, #5).

  2.12. **Phase 2 commits** — three additive commits, each ≤ 3 packages:

- **Commit 2.A** — `[ABLP-1073] feat(connectors): add docling native connector + extraction envelope`
  - `packages/connectors/src/native/**` (envelope + docling/\*\*)
  - `packages/connectors/src/auth/connection-resolver.ts` (none short-circuit) + `services/connection-service.ts` (synthetic profile)
  - `packages/connectors/src/loader.ts` (registration gated on flag)
- **Commit 2.B** — `[ABLP-1073] feat(workflow-engine): add docling project toggle routes`
  - `apps/workflow-engine/src/routes/integrations.ts` + wiring in `apps/workflow-engine/src/index.ts`
- **Commit 2.C** — `[ABLP-1073] feat(studio,i18n): docling toggle + integrations settings tab`
  - `apps/studio/src/app/api/projects/[projectId]/integrations/docling/**`
  - `apps/studio/src/pages/projects/[projectId]/settings/integrations.tsx`
  - `apps/studio/src/components/projects/IntegrationsCard.tsx`
  - `apps/studio/e2e/workflows/document-extraction-docling.spec.ts`
  - `packages/connectors/src/generated/connector-catalog.json` (regenerated)
  - `packages/i18n/locales/en/studio.json` (new `integrations.docling.*` keys per Task 2.9b)
  - Scope: 3 packages (`apps/studio`, `packages/connectors`, `packages/i18n`) — at the 3-package cap.

**Exit Criteria:**

- [ ] `pnpm build` clean across all affected packages.
- [ ] Studio E2E `document-extraction-docling.spec.ts` passes: enable toggle → drop Integration node → select Docling/extract_document → run workflow with a 5-page PDF fixture URL → envelope shape verified (`provider === 'docling'`, `metadata.pageCount === 5`, `markdown.length > 0`).
- [ ] SSRF rejection E2E: workflow with `fileUrl: 'http://169.254.169.254/latest/meta-data'` → step output `error.code === 'SSRF_BLOCKED'`. BullMQ queue depth gauge unchanged (no job enqueued).
- [ ] Toggle disable E2E: disable mid-workflow → next run gates with `INTEGRATION_DISABLED`.
- [ ] 5 integration tests covering Docling PDF / DOCX / PPTX / HTML / image inputs (against fixture Docling).
- [ ] `tools/field-propagation-check.sh` passes — boundary-shaped types (`ExtractionEnvelope`) have parity coverage between Docling normalizer and the (forthcoming) Azure normalizer's stub.
- [ ] `npx prettier --write` run; pre-commit hooks pass.

**Test Strategy:**

- **Unit**: envelope schema parse (12 cases); Docling normalizer pure-function tests with snapshot fixtures.
- **Integration**: toggle routes idempotency + cross-tenant 404; rate-limit consume; sentinel→callback path.
- **E2E**: happy-path PDF, SSRF, toggle disable.

**Rollback**: flip flag off → Studio Integration Picker stops surfacing Docling on next page load; new runs fail with `FEATURE_DISABLED`. In-flight extractions complete.

---

### Phase 3 — Azure Document Intelligence AP-format piece + cost cap

**Goal**: Tenants with Azure DI subscriptions can register a profile and use Azure DI in workflows; cost caps enforce monthly limits.

**Tasks (3.5 days):**

3.1. **Wire `kvStore` from a Redis-backed adapter** (D-9, BLOCKING task — corrected after Round 3 audit found Restate SDK `WorkflowContext` has no `objectStore` API):

- Create `apps/workflow-engine/src/services/redis-kv-store.ts` exporting `class RedisKvStore implements KeyValueStore`:
  - Ctor: `(redis: IORedis | Cluster, keyPrefix: string)` — `keyPrefix = 'connector-kv:'`.
  - `get(key)`: `redis.get(`${prefix}${key}`)` → JSON.parse or null.
  - `set(key, value, ttlMs?)`: `JSON.stringify(value)`; if `ttlMs` provided, `redis.set(prefixedKey, payload, 'PX', ttlMs)`; else `redis.set(prefixedKey, payload)`. Matches `KeyValueStore.set(key, value, ttlMs?: number)` at `packages/connectors/src/types.ts:144`.
  - `delete(key)`: `redis.del(prefixedKey)`.
- Modify `apps/workflow-engine/src/index.ts:952–959` (D-9b combined with D-9 wiring):
  - Reuse the existing BullMQ Redis connection (already available at composition root) — construct `RedisKvStore(redisConnection, 'connector-kv:')` **once** at server startup as a process-level singleton (RedisKvStore is stateless beyond the prefix; no per-call allocation needed).
  - Extend `connectorDepsFactory` signature to `(tenantId, projectId, workflowExecutionId?, stepId?) => ConnectorActionDeps`. Inside, build `new ConnectorToolExecutor(registry, connectionResolver, { tenantId, projectId, workflowExecutionId, stepId }, kvStoreSingleton)` — 4 args, with the singleton as kvStore.
  - The step dispatcher's `connector_action` case is the call site: `const deps = connectorDepsFactory(ctx.tenant.tenantId, ctx.tenant.projectId, ctx.workflow.executionId, step.id)`; pass `deps` into `executeConnectorAction`.
- Integration test: `apps/workflow-engine/src/__tests__/redis-kv-store.test.ts` — put/get/delete + TTL expiration verified via `redis.pttl` and a short TTL (2 s) + sleep + miss assertion.
- **TTL note** for Azure DI: keys live for `AZURE_DI_OPERATION_STORE_TTL_SECONDS` (default 86 400 = 24 h) — Redis TTL handles cleanup if the workflow never reaches the explicit `ctx.store.delete` (e.g., orphaned executions). On the happy path the piece deletes the key explicitly on terminal state (Phase 3 Task 3.5 step 11), and Redis TTL is the safety net.

  3.2. Scaffold `packages/connectors/piece-azure-document-intelligence/`:

- `package.json`: `@abl/piece-azure-document-intelligence`, type `commonjs`, dep on `@activepieces/pieces-framework`.
- `tsconfig.json`: extend `piece-shopify/tsconfig.json`.
- `src/index.ts`: `createPiece({ displayName: 'Azure Document Intelligence', logoUrl, authors: [], description, auth, actions: [extractDocumentAction], triggers: [] })`.

  3.3. Implement `packages/connectors/piece-azure-document-intelligence/src/auth.ts`:

- `PieceAuth.CustomAuth({ description: '...', required: true, props: { endpoint: Property.ShortText({ required: true, description: 'e.g. https://my-di.cognitiveservices.azure.com' }), apiKey: PieceAuth.SecretText({ required: true }), apiVersion: Property.ShortText({ required: false, defaultValue: '2024-11-30' }), defaultModel: Property.StaticDropdown({ required: false, defaultValue: 'prebuilt-layout', options: { options: [{ label: 'Read', value: 'prebuilt-read' }, { label: 'Layout', value: 'prebuilt-layout' }, { label: 'Document', value: 'prebuilt-document' }] } }) }, validate: async ({ auth }) => { const resp = await safeFetch(`${auth.endpoint}/documentintelligence/info?api-version=${auth.apiVersion ?? '2024-11-30'}`, { headers: { 'Ocp-Apim-Subscription-Key': auth.apiKey } }); return resp.ok ? { valid: true } : { valid: false, error: 'Azure DI returned ' + resp.status }; } })`.

  3.4. **(Round 6 fix — reinvention check)** Wire `@agent-platform/circuit-breaker` (existing Redis-backed package at `packages/circuit-breaker/`) instead of building a bespoke breaker:

- Add `@agent-platform/circuit-breaker` as a workspace dep on `@abl/piece-azure-document-intelligence/package.json`.
- The Azure DI piece imports `RedisCircuitBreaker` + `CircuitBreakerRegistry`. Construct ONE registry at workflow-engine startup using the existing Redis connection; expose it on the connector deps (or via the `callbackContext` augmentation).
- In the action body, wrap each Azure call: `await breaker.execute(`azure-di:${ctx.tenantId}`, async () => fetch(...))`. The package handles failure tracking + transitions atomically via Lua script. Multi-pod state coordination comes for free.
- Retire feature-spec GAP-013 entirely — the v1 design IS the v2 design.
- Step references to "circuit-breaker" elsewhere in the LLD (Task 3.5 step 5: `CircuitBreaker.canExecute(ctx.tenantId)`; step 12 / 13: `recordFailure`/`recordSuccess`) become a single `breaker.execute(...)` wrapper around the call, since `RedisCircuitBreaker.execute` records success/failure internally based on the wrapped function's outcome.
- **Removed files** (no longer needed): `packages/connectors/piece-azure-document-intelligence/src/circuit-breaker.ts`. The file map in §2 is updated to drop that row; the Phase 3 test file `extract-document.test.ts` covers the breaker integration via a mocked Redis or the existing `circuit-breaker` test harness.

  3.5. Implement `packages/connectors/piece-azure-document-intelligence/src/actions/extract-document.ts`:

- Inside `run(ctx)`:
  1. Tenant-scoped cost-cap: `ConnectorConnection.findOne({ _id: ctx.connectionId, tenantId: ctx.tenantId, projectId: ctx.projectId, status: 'active' })`; if `usageHardCap != null && usageCount >= usageHardCap` → throw `QUOTA_EXCEEDED`.
  2. `assertUrlSafeForSSRF(ctx.params.fileUrl)`.
  3. `safeFetch(fileUrl, { method: 'HEAD' })` with 10 s timeout (D-8).
  4. `await rateLimiter.consume(ctx.tenantId, 1)` using `RateLimiterMemory`.
  5. `if (!CircuitBreaker.canExecute(ctx.tenantId)) throw INTEGRATION_UNAVAILABLE`.
  6. **(D-9b)** Compose the workflow-execution-scoped store key: `const storeKey = `azuredi:${ctx.workflowExecutionId}:${ctx.stepId}``. **Hard fail with `INTEGRATION_UNAVAILABLE`** if either is undefined — that indicates the executor was invoked outside a workflow context (no replay safety possible). DO NOT fall back to `ctx.executionId`(which is`crypto.randomUUID()` per call).
  7. `const stashed = await ctx.store.get(storeKey)`. If `stashed != null` → `operationLocation = stashed`; skip POST. Else:
     - `const resp = await safeFetch(`${endpoint}/documentintelligence/documentModels/${model}:analyze?api-version=${apiVersion}`, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ urlSource: fileUrl, ...(pages ? { pages } : {}) }) })`.
     - On non-202: `CircuitBreaker.recordFailure(ctx.tenantId)`; throw `EXTRACTION_FAILED`.
     - `operationLocation = resp.headers.get('operation-location')`.
     - **Use positional TTL** (matches `KeyValueStore.set(key, value, ttlMs?)` at `packages/connectors/src/types.ts:144`): `await ctx.store.set(storeKey, operationLocation, AZURE_DI_OPERATION_STORE_TTL_SECONDS * 1000)`.
  8. **(Round 7 hardening)** Before entering the polling loop, validate that `new URL(operationLocation).hostname === new URL(endpoint).hostname`. A hostname mismatch indicates a misconfigured or malicious endpoint and is rejected with `INTEGRATION_UNAVAILABLE` (defense-in-depth on top of `safeFetch`'s pinning of the `:analyze` POST).
  9. Polling loop: raw `fetch(operationLocation, { headers: { 'Ocp-Apim-Subscription-Key': apiKey } })` (operation-location is Azure-provided, not user-supplied — DNS pinning N/A per HLD §3.4 step 4.g):
     - On 429: `await sleep(parseRetryAfter(resp, /* defaultMs */ 2_000))`; continue.
     - **(Round 7)** On 404: the previously-stashed Azure operation has expired server-side (Azure retains results ~24 h). Clear the `ctx.store` key, treat as a first-time POST: re-enter step 7 with `stashed = null`. Cap this re-POST at one retry to avoid infinite loops; if the new POST also yields a 404 within 60 s, fail with `EXTRACTION_FAILED`.
     - On 5xx: `breaker` records failure via wrapper; exponential backoff (2 s → 30 s); continue.
     - On 200 + `status === 'succeeded'`: break with `analyzeResult`. Also honor any `Retry-After` header on this and the non-terminal 200s (Round 7 improvement) if present.
     - On 200 + `status === 'failed'`: throw `EXTRACTION_FAILED`.
     - On 200 + `status in ('notStarted','running')`: honor `Retry-After` header if present, else exponential backoff (2 s → 30 s); continue.
  10. `const envelope = normalizeAzureAnalyzeResult(analyzeResult, { sourceUrl, contentType })`.
  11. Size cap: `Buffer.byteLength(JSON.stringify(envelope), 'utf8') > DOCLING_WORKFLOW_INLINE_CAP_BYTES` → throw `EXTRACTION_TOO_LARGE` (reuse same env var as Docling).
  12. `await ctx.store.delete(storeKey)`.
  13. Tenant-scoped atomic increment via the month-boundary CAS helper (Task 3.12). Internally: tenant-scoped `{ _id: ctx.connectionId, tenantId: ctx.tenantId, projectId: ctx.projectId }`.
  14. **(Step 5 wrapper applied)** Steps 7–11 are wrapped in `breaker.execute(`azure-di:${ctx.tenantId}`, async () => ...)` — success/failure is recorded automatically by `RedisCircuitBreaker.execute`.
  15. Return `envelope`.

  3.6. Implement `packages/connectors/piece-azure-document-intelligence/src/normalize.ts` — Azure `analyzeResult` → `ExtractionEnvelope`. Map `pages[].lines` → page text; `tables[].cells` → `ExtractionTable.rows` (with markdown synthesis); `pages[].selectionMarks` → headings; `languages[]` → `metadata.language`/`languageConfidence`.

  3.6b. **(Round 3 fix)** Implement `packages/connectors/piece-azure-document-intelligence/src/parse-retry-after.ts`:

- Signature: `export function parseRetryAfter(resp: Response, defaultMs: number = 2_000): number`.
- Read `resp.headers.get('Retry-After')`. Per RFC 7231 §7.1.3:
  - If header is **delta-seconds** integer (e.g., `"120"`) → return `parseInt(value, 10) * 1000`.
  - If header is **HTTP-date** (e.g., `"Fri, 31 Dec 2027 23:59:59 GMT"`) → return `Math.max(0, Date.parse(value) - Date.now())`.
  - If missing OR `Number.isNaN(parsed)` → return `defaultMs`.
- Cap the return at `30_000` (30 s) to bound the polling loop's max sleep regardless of what Azure returns.
- Unit test in `parse-retry-after.test.ts`: integer / HTTP-date / missing / malformed / clamping-at-30s cases.

  3.7. Implement `packages/connectors/src/adapters/activepieces/auth-adapters/azure-document-intelligence.ts`:

- **Pure data-mapping function** (NOT a `require.cache` patch).
- Signature: `export function bridgeAzureDIAuth(profile: ResolvedAuthProfile): AzureDICustomAuth`.
- Reads `profile.secrets.apiKey` + `profile.config.connectionConfig.{endpoint, apiVersion?, defaultModel?}` → returns `{ endpoint, apiKey, apiVersion: apiVersion ?? '2024-11-30', defaultModel: defaultModel ?? 'prebuilt-layout' }`.
- Defensive: throws `INTEGRATION_UNAVAILABLE` on missing required fields.

  3.8. Modify `packages/connectors/src/adapters/activepieces/context-translator.ts` at the connection-config bridging point (lines 211–290):

- `if (connection.connectorName === 'azure-document-intelligence') { authForPiece = bridgeAzureDIAuth(resolvedProfile); }`.

  3.9. Modify `packages/connectors/src/loader.ts`:

- Add `['azure-document-intelligence', '@abl/piece-azure-document-intelligence']` to `PIECE_PACKAGES` (line 42–83). Gate on env flag.
- **NO** new adapter branch at lines 111–116 — the Azure DI shim is invoked at the context-translator path (3.8), not at the require.cache patch path. Document the divergence in the package's `agents.md`.

  3.10. Modify `packages/database/src/models/connector-connection.model.ts`:

- Extend the Mongoose schema with optional fields:
  - `usageCount: { type: Number }` (no default — set atomically to `1` by the first `$inc`/CAS-reset cycle).
  - `usagePeriodStart: { type: Date }` (no default — set atomically by the first CAS-reset cycle).
  - `usageSoftCap: { type: Number, default: null }` (**Round 2 fix**: explicit `default: null` matches the model's existing pattern for optional fields like `userId`, `metadata`).
  - `usageHardCap: { type: Number, default: null }` (`null` = soft-only).
- Extend `IConnectorConnection` interface analogously.

  3.11. Create `apps/workflow-engine/src/routes/azure-di-usage.ts`. Mounted on `projectRouter` per D-17.

- **All handlers Zod-validate** params (`projectId: z.string().min(1)`) and bodies.
- **`GET /azure-document-intelligence/usage`** — `ConnectorConnection.findOne({ tenantId, projectId, connectorName: 'azure-document-intelligence' })`. Returns `{ success: true, data: { usageCount, usagePeriodStart, usageSoftCap, usageHardCap } }`. 404 with `{ success: false, error: { code: 'CONNECTION_NOT_FOUND' } }` if no connection bound.
- **`PATCH /azure-document-intelligence/usage-caps`** — body schema `z.object({ usageSoftCap: z.number().int().min(0).optional(), usageHardCap: z.number().int().min(0).nullable().optional() }).strict()`. Atomic `findOneAndUpdate({ tenantId, projectId, connectorName: 'azure-document-intelligence' }, { $set: { ...(body.usageSoftCap !== undefined ? { usageSoftCap: body.usageSoftCap } : {}), ...(body.usageHardCap !== undefined ? { usageHardCap: body.usageHardCap } : {}) } }, { new: true })`. Returns `{ success: true, data: connection }` or 404.
- Both routes return HTTP **404** with `{ success: false, error: { code: 'FEATURE_DISABLED' } }` when the env flag is off (D-18).

  3.12. Implement **month-boundary CAS reset** at increment time (FR-18, HLD §4.1 #2). Helper in `apps/workflow-engine/src/services/azure-di-usage-counter.ts`:

- `currentMonthStart = new Date(Date.UTC(year, month, 1))`.
- Step 1 (Round 7 fix — null/first-use handling): `findOneAndUpdate({ _id, tenantId, projectId, $or: [{ usagePeriodStart: null }, { usagePeriodStart: { $exists: false } }, { usagePeriodStart: { $lt: currentMonthStart } }] }, { $set: { usageCount: 1, usagePeriodStart: currentMonthStart } }, { new: true })`. If matched → return.
- Step 2 (loser path): on `matched === 0`, issue `$inc: { usageCount: 1 }` against the now-current-month doc (still tenant-scoped).

  3.13. Regenerate `packages/connectors/src/generated/connector-catalog.json`.

  3.14. Studio surface:

- Add `apps/studio/src/app/api/projects/[projectId]/integrations/azure-document-intelligence/usage/route.ts` (BFF proxy).
- Add `apps/studio/src/components/projects/AzureDIUsageView.tsx` — fetches usage; renders the static count + caps. `useMutation` for PATCH with `onError`.

  3.14b. **(Round 3 fix)** i18n strategy for Phase 3 Studio components:

- Same namespace (`studio`); prefix `integrations.azureDi.*`.
- New keys in `packages/i18n/locales/en/studio.json`:
  - `integrations.azureDi.usageTitle` → "Azure Document Intelligence Usage"
  - `integrations.azureDi.currentMonth` → "Current month: {usageCount} extractions"
  - `integrations.azureDi.softCapLabel` → "Soft cap (warn at 80%)"
  - `integrations.azureDi.hardCapLabel` → "Hard cap (reject at 100%)"
  - `integrations.azureDi.hardCapPlaceholder` → "No hard cap"
  - `integrations.azureDi.updateCapsButton` → "Save caps"
  - `integrations.azureDi.updateSuccess` / `updateFailure`
  - `integrations.azureDi.quotaExceededWarning` → "Quota exceeded — new extractions return QUOTA_EXCEEDED."
  - `integrations.azureDi.softCapWarning` → "Approaching cap: {pct}% used."

    3.15. **Phase 3 commits** (additive, each ≤ 3 packages):

- **Commit 3.A** — `[ABLP-1073] feat(workflow-engine): wire redis-backed kvStore into connector executor`
  - `apps/workflow-engine/src/services/redis-kv-store.ts`
  - `apps/workflow-engine/src/index.ts`
  - `apps/workflow-engine/src/__tests__/redis-kv-store.test.ts`
- **Commit 3.B** — `[ABLP-1073] feat(connectors): add @abl/piece-azure-document-intelligence`
  - `packages/connectors/piece-azure-document-intelligence/**`
  - `packages/connectors/src/adapters/activepieces/auth-adapters/azure-document-intelligence.ts`
  - `packages/connectors/src/adapters/activepieces/context-translator.ts` (bridging branch)
  - `packages/connectors/src/loader.ts` (PIECE_PACKAGES entry)
- **Commit 3.C** — `[ABLP-1073] feat(workflow-engine,database): add azure di usage routes + cost cap`
  - `packages/database/src/models/connector-connection.model.ts` (additive schema fields)
  - `apps/workflow-engine/src/routes/azure-di-usage.ts` + wiring
  - `apps/workflow-engine/src/services/azure-di-usage-counter.ts`
  - Scope: 2 packages (`packages/database`, `apps/workflow-engine`) — within the 3-package cap.
- **Commit 3.D** — `[ABLP-1073] feat(studio,i18n): azure di usage view + auth profile form auto-render`
  - `apps/studio/src/app/api/projects/[projectId]/integrations/azure-document-intelligence/**`
  - `apps/studio/src/components/projects/AzureDIUsageView.tsx`
  - `apps/studio/e2e/workflows/document-extraction-azure-di.spec.ts`
  - `packages/connectors/src/generated/connector-catalog.json` (regenerated)
  - `packages/i18n/locales/en/studio.json` (new `integrations.azureDi.*` keys per Task 3.14b)
  - Scope: 3 packages (`apps/studio`, `packages/connectors`, `packages/i18n`) — at the 3-package cap.
- **Commit 3.E** — Dockerfile sync (`apps/*/Dockerfile`) — separate commit, 5 files but 5 packages so use the "Dockerfile sync" exception (CLAUDE.md exempts pure Dockerfile sync from the 3-package limit; if not, split per app).

**Exit Criteria:**

- [ ] `pnpm build` clean.
- [ ] `redis-kv-store.test.ts` passes — put/get/delete + TTL.
- [ ] Azure DI happy-path E2E: register AuthProfile (Test Connection validates against fixture `/info`) → drop Integration node → select Azure DI / extract_document → run with XLSX URL → envelope `provider === 'azure-document-intelligence'`, tables present.
- [ ] Cross-provider parity E2E (same PDF): `pageCount` equal, `markdown.length` within 10 %. **Uses a shared committed fixture PDF** (`apps/studio/e2e/workflows/fixtures/sample-parity.pdf`); the Docling and Azure DI fixture servers are seeded with hand-crafted responses calibrated to produce matching page counts and approximately-matching markdown length. Without the calibrated fixtures, the parity assertion is non-deterministic.
- [ ] Replay safety integration test: simulate engine restart between `:analyze` POST and result → verify `ctx.store.get` returns the stashed `Operation-Location` → polling resumes the same Azure operation (fixture asserts exactly **one** `:analyze` invocation).
- [ ] 429 + Retry-After integration test: fixture returns 429 with `Retry-After: 2`; piece sleeps and retries; succeeds on the third try.
- [ ] **(Round 7 add)** Expired-operation integration test: after a stashed `operationLocation` is set in `ctx.store`, fixture Azure DI returns 404 on GET. Piece clears the stash, re-POSTs `:analyze`, and resumes polling. Second 404 within 60 s of re-POST fails with `EXTRACTION_FAILED`.
- [ ] **(Round 7 add)** `operationLocation` hostname mismatch test: fixture POST returns an `Operation-Location` pointing at a different hostname than the configured endpoint. Piece rejects with `INTEGRATION_UNAVAILABLE` before entering the polling loop.
- [ ] Atomic `$inc` concurrency test: 100 concurrent extractions → `usageCount === 100` (no lost updates).
- [ ] Month-boundary CAS test: prime doc with `usagePeriodStart` set to previous month; trigger two concurrent extractions on day 1 of new month → both succeed, final `usageCount === 2`, `usagePeriodStart === currentMonthStart` (exactly one reset).
- [ ] `QUOTA_EXCEEDED` enforced when `usageHardCap` reached.
- [ ] `pnpm connectors:generate-catalog` produces a clean diff committed in 3.D.
- [ ] `tools/field-propagation-check.sh` passes.

**Test Strategy:**

- **Unit**: Azure normalizer fixtures (3 Azure response variants); auth-adapter shim (mapping correctness); circuit breaker state machine; CAS reset math.
- **Integration**: real Express + MongoMemoryServer + nock-backed Azure fixture; redis-kv-store round-trip with a fake Restate context; concurrent `$inc` correctness.
- **E2E**: register profile via Studio → run workflow → assert envelope; replay-safety via forced engine restart.

**Rollback**: flip flag off → Azure DI hidden from Integration Picker; new runs fail `FEATURE_DISABLED`. The `kvStore` wiring (3.A) is structural and remains after rollback (harmless — `ConnectorToolExecutor` continues to accept the parameter; existing connectors don't use it).

---

### Phase 4 — Audits, observability, hardening

**Goal**: Production-readiness checks; metrics dashboards live; security review passes.

**Tasks (2 days):**

4.1. **`data-flow-audit` (2 rounds, mandatory per CLAUDE.md)**: pick `callbackSecret` as the sensitive value and trace it through every boundary: connector body → `AsyncParkingSentinel.encryptedCallbackSecret` → `StepDispatchResult.callbackRequest` → workflow-handler persist on step record → callback route decrypt → `verifyWebhookSignature`. Also trace the **plaintext** copy: connector body → BullMQ payload → worker `callback-poster` → outbound HMAC header. Log to `docs/sdlc-logs/document-extraction-integrations/data-flow-audit.md`.

4.2. **`pr-reviewer` (5 rounds, mandatory per CLAUDE.md)** on the commit set of Phase 1–3. Findings logged.

4.3. **Semgrep** — `./tools/run-semgrep.sh` (CLAUDE.md gate; this feature touches auth, crypto, HTTP, user input). Fix all HIGH findings.

4.4. **Metrics emission** — wire all 12 new metrics from HLD §4.2 + 2 new ones added at Round 7. No `prom-client` is in use today (oracle C3); use OpenTelemetry meter from `@opentelemetry/api` (already imported in `connector-tool-executor.ts:23`) where possible, falling back to a thin Prometheus exporter only if the OpenTelemetry collector is not configured for these process types. Concretely:

- `bullmq_queue_depth{queue}` — periodic gauge in worker process (every 15 s).
- `worker_active_jobs{queue}` — counter incremented on `job.processing`, decremented on `job.completed`/`job.failed`.
- `workflow_docling_wait_duration_seconds{tenant, status}` — histogram on engine side from park-start to promise-resolve.
- `workflow_docling_errors_total{tenant, error_class}` — counter.
- `workflow_docling_parked_promises_gauge{tenant}` — gauge.
- `workflow_docling_callback_post_attempts_total{tenant, attempt}` — counter.
- `workflow_docling_callback_post_failures_total{tenant, error_class}` — counter.
- `workflow_docling_rate_limited_total{tenant}` — counter.
- `workflow_extraction_too_large_total{provider, tenantId}` — counter.
- `azure_di_extractions_total{tenant, project, status}` — counter.
- `azure_di_circuit_breaker_state{tenant}` — gauge (0 closed, 1 half-open, 2 open).
- `azure_di_cost_cap_used_ratio{tenant, project}` — gauge (`usageCount / usageHardCap` or `/ usageSoftCap`).
- **(Round 7 add)** `workflow_extraction_envelope_bytes{provider}` — histogram of serialized envelope size to detect creeping payload growth before the 50 MB cap is hit. Buckets: 100 KB / 500 KB / 2 MB / 10 MB / 25 MB / 50 MB. If p95 exceeds 5 MB sustained, prioritize the Claim Check pattern (feature spec GAP-002 mitigation).
- **(Round 7 add)** Callback-poster `error_class` dimension must distinguish `TIMESTAMP_EXPIRED` (callback-route 401 with timestamp out-of-tolerance) from `SIGNATURE_INVALID` (401 with HMAC mismatch) so clock-skew between worker/engine pods is observable. The callback route returns 401 in both cases today; the LLD's Phase 1 Task 1.7 callback-poster classifies the error from the response body or a status-code subcode.

  4.5. **Grafana dashboard** — new panel "Workflows → Document Extraction" with all 12 metrics rendered. Commit dashboard JSON to the deploy repo (`abl-platform-deploy`); referenced by URL in `docs/sdlc-logs/document-extraction-integrations/dashboard.md`.

  4.6. **Alerts** — Prometheus alert rules:

- `bullmq_queue_depth{queue='search-docling-extraction'} > 200` for 10 min.
- `bullmq_queue_depth{queue='workflow-docling-extraction'} > 50` for 10 min.
- `workflow_docling_callback_post_failures_total / workflow_docling_callback_post_attempts_total > 0.001` for 10 min.
- `workflow_docling_rate_limited_total / workflow_docling_enqueues_total > 0.01` per tenant for 10 min.
- `azure_di_cost_cap_used_ratio > 0.8` per (tenant, project).

  4.7. **PII redaction integration test** (`extraction-pii-redaction.test.ts`) — synthetic extracted markdown containing API keys (`sk_live_...`), SSNs, credit cards → trace event has them redacted before persistence.

  4.7b. **(Round 3 fix — FR-20 explicit coverage)** Audit-event shape integration test (`apps/workflow-engine/src/__tests__/extraction-audit-events.test.ts`):

- Trigger one successful extraction; assert the emitted audit event has exactly the envelope `{ actor, tenantId, projectId, connector, action, sourceUrl, sizeBytes, durationMs, status }`.
- Assert `sourceUrl` is host-only (no path / query / hash) — protects against URL-bound secrets leaking into audit storage.
- Per **D-20**: trigger SSRF-blocked, rate-limited, quota-exceeded rejections and assert each emits an audit event with `status === <typed error code>` and `sizeBytes === 0`, `durationMs === 0` for pre-call rejections.

  4.8. **Rollback drill E2E** (D-15) — `document-extraction-rollback.spec.ts`:

- Enable feature; submit 3 extractions (1 in-flight, 2 pending).
- Flip `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED=false`; restart workflow-engine + Studio pods.
- Assert: in-flight extraction completes successfully; new submissions fail `FEATURE_DISABLED`; Worker B drains; Worker A (ingestion fixture) unaffected.

  4.9. **Update package `agents.md`** for each touched package:

- `packages/connectors/agents.md` — from-scratch AP piece pattern (Azure DI) vs require.cache shim pattern (jira/servicenow); new no-auth short-circuit in `connection-resolver.ts`; `ActionContext` widened with `callbackContext`, `workflowExecutionId`, `stepId`, `connectionId`.
- `apps/workflow-engine/agents.md` — new `callbackRequest` suspension block placement (after toolRequest); `kvStore` wiring through `ConnectorDepsFactory`; `connectorDepsFactory` signature widened with `workflowExecutionId` + `stepId`.
- `apps/search-ai/agents.md` — two-queue topology + env-configurable concurrencies + sum-cap assertion; buffered (ingestion) vs streaming (extraction-only) HTTP divergence; fixture Docling layout.
- `apps/studio/agents.md` — Integration Picker auto-gates on `ConnectorConnection` presence; new Settings → Integrations tab path; `Switch`/`Select` design-token usage.
- `packages/database/agents.md` — `ConnectorConnection` schema additive fields (`usageCount`/`usagePeriodStart`/`usageSoftCap`/`usageHardCap`); month-boundary CAS reset pattern.
- `packages/search-ai-sdk/agents.md` — new `QUEUE_WORKFLOW_DOCLING_EXTRACTION` constant; `WorkflowDoclingExtractionJobData` discriminated union pattern.
- `packages/shared/agents.md` — `IntegrationNodeConfigSchema.timeout` widened from `max(300)` to `max(1800)`; backward-compatible.
- `packages/shared-encryption/agents.md` — new manifest entry for `workflow-docling-extraction` queue.

  4.10. **`phase-auditor`** on the post-Phase-3 state (final cross-phase consistency check before beta).

  4.11. **Phase 4 commits** — additive, ≤ 3 packages each:

- **Commit 4.A** — `[ABLP-1073] feat(observability): wire document-extraction metrics + alerts`
- **Commit 4.B** — `[ABLP-1073] test(extraction): rollback drill + PII redaction E2E`
- **Commit 4.C** — `[ABLP-1073] docs(extraction): update agents.md for touched packages`

**Exit Criteria:**

- [ ] `data-flow-audit` log committed; no CRITICAL findings open.
- [ ] `pr-reviewer` 5 rounds completed; CRITICAL + HIGH findings closed; MEDIUM logged.
- [ ] `./tools/run-semgrep.sh` clean.
- [ ] All 12 metrics emitting in dev environment; Grafana dashboard renders.
- [ ] Alert rules deployed to staging.
- [ ] PII redaction E2E passes.
- [ ] Rollback drill E2E passes.
- [ ] All touched `agents.md` updated.
- [ ] `phase-auditor` PASS.

**Test Strategy:**

- **Audit**: `data-flow-audit`, `pr-reviewer`, `phase-auditor` (each agent reads artifacts fresh from disk).
- **E2E**: rollback drill is the headline.
- **Manual**: Grafana dashboard visual inspection on staging.

**Rollback**: revert observability commits if metrics emission causes pod-level CPU regression; the rollback drill E2E itself stays.

---

### Phase 5 — Beta rollout (1 week soak)

**Goal**: real-tenant traffic under monitoring; tune rate-limit defaults.

**Tasks:**

5.1. Enable `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED=true` for 3 internal tenants via tenant-config override.

5.2. Onboard 1 Azure DI subscription per internal tenant (engineering team Azure tenant).

5.3. Daily review of Grafana dashboard for the 12 metrics; tune `DOCLING_WORKFLOW_RATE_LIMIT_PER_MIN` based on observed peak concurrent-tenant counts.

5.4. Add capacity report `docs/sdlc-logs/document-extraction-integrations/load-test-results-2026-MM-DD.md` via the `load-test-analysis` skill (k6 + Coroot saturation analysis).

**Exit Criteria:**

- [ ] ≥ 100 successful extractions across the 3 tenants (oracle C5).
- [ ] 0 P0 / P1 incidents over 5 business days.
- [ ] p95 Docling extraction < 25 s, Azure DI < 20 s (HLD §4.3 #9 targets).
- [ ] Promote feature spec status to BETA via `/post-impl-sync`.

**Rollback**: per-tenant config override removed; feature returns to gated-off state.

---

### Phase 6 — GA

**Goal**: default-on for new tenants; subscription-tier gating.

**Tasks:**

6.1. Flip `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED` default to `true` in `apps/workflow-engine` + `apps/search-ai` + `apps/studio` env defaults.

6.2. Add `PLAN_FEATURES` entry for the appropriate subscription tiers in `@agent-platform/shared-kernel`.

6.3. Promote feature spec status to STABLE via `/post-impl-sync`.

6.4. Mark connectors as STABLE in `connector-catalog.json`.

**Exit Criteria:** feature spec STABLE; testing matrix shows ≥ 25 scenarios PASS.

**Rollback**: revert the env-default flip and the `PLAN_FEATURES` entry; tenants retain access until their tenant-config override is removed.

---

## 4. Wiring Checklist

> The #1 agent failure mode is writing code that nothing calls. Every item below is a concrete file edit on a real path.

- [ ] **Docling connector registered**: `packages/connectors/src/loader.ts` calls `registry.register(doclingConnector)` (eager, gated on env flag).
- [ ] **Azure DI piece registered**: `packages/connectors/src/loader.ts` adds `['azure-document-intelligence', '@abl/piece-azure-document-intelligence']` to `PIECE_PACKAGES` (gated on env flag).
- [ ] **Azure DI piece installed**: `packages/connectors/package.json` adds dep `"@abl/piece-azure-document-intelligence": "workspace:*"`.
- [ ] **Auth adapter wired**: `packages/connectors/src/adapters/activepieces/context-translator.ts` calls `bridgeAzureDIAuth` when `connectorName === 'azure-document-intelligence'` (NOT via the require.cache branch in `loader.ts`).
- [ ] **No-auth short-circuit**: `packages/connectors/src/auth/connection-resolver.ts` returns `{}` for `auth.type === 'none'`.
- [ ] **Synthetic AuthProfile auto-bind**: `packages/connectors/src/services/connection-service.ts` exports `upsertSyntheticNoAuthProfile` and Docling's enable route calls it.
- [ ] **Workflow callback suspension**: `apps/workflow-engine/src/handlers/workflow-handler.ts` adds the `callbackRequest` block after the `toolRequest` block (line 3197). `hasSuspension()` updated.
- [ ] **Dispatcher recognizes sentinel**: `apps/workflow-engine/src/handlers/step-dispatcher.ts` converts `AsyncParkingSentinel` → `StepDispatchResult.callbackRequest` in the `connector_action` case.
- [ ] **kvStore wired through executor (D-9, Round 3 revised)**: `apps/workflow-engine/src/index.ts:954` passes a process-level singleton `RedisKvStore(redisConnection, 'connector-kv:')` as the 4th arg to `ConnectorToolExecutor`. Backed by Redis (NOT Restate state — `WorkflowContext` has no `objectStore` per Round 3). Without this, Azure DI replay safety silently no-ops.
- [ ] **callbackContext wired into ActionContext**: `packages/connectors/src/executor/connector-tool-executor.ts` accepts an optional `callbackContext` and threads it into `ActionContext` for native connectors.
- [ ] **New BullMQ queue factory**: `apps/search-ai/src/queues/queue-factory.ts` exports `getWorkflowDoclingExtractionQueue()`.
- [ ] **Worker B subscription**: `apps/search-ai/src/workers/docling-extraction-worker.ts` factory creates two Workers; existing Worker concurrency drops from default 5 to 3 (`DOCLING_INGESTION_CONCURRENCY`).
- [ ] **Worker call-site updated**: `apps/search-ai/src/workers/index.ts:94` (NOT `server.ts`) calls the new `createDoclingExtractionWorker({ ingestionConcurrency, workflowConcurrency })` signature and pushes **two** `WorkerEntry` items (`docling-extraction`, `docling-extraction-workflow`); the second is registration-gated on `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED`.
- [ ] **Encryption manifest entry**: `packages/shared-encryption/src/encryption-manifest.ts` has `'workflow-docling-extraction': { fieldsToEncrypt: [] }`.
- [ ] **Routes mounted on the authenticated projectRouter (D-17)**: `apps/workflow-engine/src/index.ts` calls `projectRouter.use('/integrations', integrationsRouter)` and `projectRouter.use('/integrations', azureDiUsageRouter)` — NOT under the unauthenticated callback-router mount at line 1225. The exact `projectRouter` line anchor is verified at audit Round 2.
- [ ] **`executionId` + `stepId` threaded onto `ActionContext` (D-9b)**: `ExecutorContext` and `ActionContext` declare optional `workflowExecutionId?` and `stepId?`; `connector-action-executor.ts` populates them from the workflow context; Azure DI piece reads `ctx.workflowExecutionId` / `ctx.stepId` for its store key. Without this, FR-16 silently fails on Restate replay.
- [ ] **`connectionId` threaded onto `ActionContext` (Round 6 fix)**: `ConnectorToolExecutor.execute()` populates `actionContext.connectionId = resolved.connection._id` after the `connectionResolver.resolve(...)` call. The Azure DI piece consumes this for its tenant-scoped cost-cap query (Task 3.5 steps 1 and 12).
- [ ] **Routes exported**: `apps/workflow-engine/src/routes/index.ts` re-exports `createIntegrationsRouter` + `createAzureDiUsageRouter`.
- [ ] **`IConnectorConnection` schema updated**: `packages/database/src/models/connector-connection.model.ts` declares the four cost-cap fields (typed + optional).
- [ ] **Timeout schema widened**: `packages/shared/src/types/workflow-schemas.ts:168` is `.max(1800)`.
- [ ] **Connector catalog regenerated**: `packages/connectors/src/generated/connector-catalog.json` includes both new connectors.
- [ ] **Dockerfiles synced**: all 5 `apps/*/Dockerfile` files include `COPY packages/connectors/piece-azure-document-intelligence`.
- [ ] **Rate-limiter singleton**: `apps/workflow-engine/src/index.ts` constructs the `RateLimiterRedis` once at startup and injects into `ConnectorDepsFactory`.

**Studio UI (touches `apps/studio/`):**

- [ ] Each form's `onSubmit`/mutation has error handling (`useMutation` `onError` callback) — Docling toggle, Azure DI usage-caps PATCH, AuthProfile Test Connection.
- [ ] Each `useMutation` call has an `onError` callback OR every `mutateAsync` is in a `try`/`catch`.
- [ ] Submit buttons have `disabled={mutation.isPending}` or equivalent loading guard.
- [ ] Each new Studio API route (`apps/studio/src/app/api/projects/[projectId]/integrations/docling/[action]/route.ts`, `.../azure-document-intelligence/usage/route.ts`) is called from a UI component (IntegrationsCard, AzureDIUsageView) — no dead routes.
- [ ] Each new Studio API route proxies to workflow-engine (no stub data).
- [ ] `IntegrationsCard.tsx`, `AzureDIUsageView.tsx` are imported and rendered in `pages/projects/[projectId]/settings/integrations.tsx` — no orphans.
- [ ] No native `<select>` elements — uses `<Select>` from `components/ui/Select.tsx` for the model dropdown.
- [ ] Toggle uses `<Switch>` from `components/ui/Switch.tsx` (NOT `<input type="checkbox">`).
- [ ] No `bg-accent text-foreground` — uses `bg-accent text-accent-foreground`.

---

## 5. Cross-Phase Concerns

### Database Migrations

No schema migration. Additive optional Mongoose fields on `ConnectorConnection` (D-11). Existing documents validate unchanged (Mongoose defaults to schema-permissive for `findOne` reads). No index changes — existing `{ tenantId, projectId, connectorName }` covers the new query paths.

### Feature Flags

| Flag                                           | Default                               | Rollout Plan                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED` | `false` (production); `true` (dev/CI) | Phase 5 enables for 3 internal tenants via tenant-config override; Phase 6 flips env default.                                                                                                                                                                                                                                                                                          |
| `DOCLING_INGESTION_CONCURRENCY`                | `3`                                   | Operator override only.                                                                                                                                                                                                                                                                                                                                                                |
| `DOCLING_WORKFLOW_CONCURRENCY`                 | `2`                                   | Operator override only. Setting to `0` disables Worker B without removing the subscription.                                                                                                                                                                                                                                                                                            |
| `DOCLING_WORKFLOW_INLINE_CAP_BYTES`            | `52428800` (50 MiB)                   | Per-project override via tenant config (FR-18 escape hatch). **(Round 7 industry-audit note)**: 50 MB is 25× Temporal's 2 MB guideline; the `workflow_extraction_envelope_bytes` histogram is the primary observability signal. If p95 exceeds 5 MB sustained, prioritize Claim Check (GAP-002). Consider operationally setting a per-tenant 10 MB default until traffic mix is known. |
| `DOCLING_WORKFLOW_SIZE_HARD_CAP_BYTES`         | `524288000` (500 MiB)                 | Operator override only.                                                                                                                                                                                                                                                                                                                                                                |
| `DOCLING_WORKFLOW_RATE_LIMIT_PER_MIN`          | `10`                                  | Per-tenant override via tenant config.                                                                                                                                                                                                                                                                                                                                                 |
| `DOCLING_WORKFLOW_RATE_LIMIT_BURST`            | `5`                                   | Per-tenant override via tenant config.                                                                                                                                                                                                                                                                                                                                                 |
| `AZURE_DI_USAGE_SOFT_CAP_DEFAULT`              | `1000`                                | Per-project override via the usage-caps PATCH endpoint.                                                                                                                                                                                                                                                                                                                                |
| `AZURE_DI_OPERATION_STORE_TTL_SECONDS`         | `86400` (24 h)                        | Operator override only.                                                                                                                                                                                                                                                                                                                                                                |

### Configuration Changes

- New env vars (above) — added to `packages/config/src/constants.ts` if other code uses them indirectly; otherwise read inline with explicit defaults.
- `WORKFLOW_ENGINE_URL` (existing) — already documented in feature spec §11. Used by `apps/search-ai` worker to compose the callback URL on enqueue (the URL is built **on the engine side** by `callbackUrlBuilder` and passed in via the BullMQ payload; the worker does not assemble it).
- `DOCLING_SERVICE_URL` (existing) — used unchanged.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 6 implementation phases complete with their exit criteria met.
- [ ] E2E test spec scenarios (≥ 13) passing in CI.
- [ ] Integration test spec scenarios (≥ 18) passing.
- [ ] Unit test spec scenarios (≥ 10) passing.
- [ ] Security & isolation scenarios (≥ 15) passing — including cross-tenant 404, cross-project 404, missing-auth 401, HMAC missing/invalid/replay.
- [ ] No regressions in existing tests: `pnpm build && pnpm test` clean across the monorepo.
- [ ] Backward-compat invariant: `apps/search-ai/src/__tests__/text-extraction-integration.test.ts` runs byte-for-byte unchanged (Phase 1 exit criterion, re-asserted in Phase 4).
- [ ] Rollback drill E2E (D-15) passes — flag-off → in-flight extractions complete, new runs `FEATURE_DISABLED`, Worker B drains, Worker A unaffected.
- [ ] Feature spec status updated to BETA after Phase 5 soak (via `/post-impl-sync`); STABLE after Phase 6.
- [ ] Testing matrix in feature spec §17 updated with actual coverage per scenario.
- [ ] All package `agents.md` files touched updated with phase learnings.
- [ ] `data-flow-audit` 2-round log committed.
- [ ] `pr-reviewer` 5-round log committed.
- [ ] `./tools/run-semgrep.sh` clean before final merge.
- [ ] Grafana dashboard live in staging + production.
- [ ] Alert rules deployed in staging + production.
- [ ] All 5 `apps/*/Dockerfile` files have the new `COPY` line (CLAUDE.md Dockerfile sync rule).
- [ ] `npx prettier --write` run on every commit set.

---

## 7. Open Questions

1. **Existing flag in tenantConfig path?** The `RateLimiterRedis` tenant-config override hook (FR-13, HLD §7.2) requires reading `tenantConfig.integrations.docling.rateLimitPerMinute` on each `consume()`. Does `tenantConfig` resolution have a per-process cache (microseconds-level), or do we need to introduce one to avoid a Mongo read per workflow step? **Recommendation**: reuse the existing `TenantConfigStore` cache (if present) at LLD audit Round 2; otherwise add a 60 s in-memory LRU keyed by `tenantId`.

2. **`prom-client` vs OpenTelemetry exporter**: The feature emits 12 new metrics but the platform has no consistent metrics library today (oracle C3). The LLD provisionally uses OpenTelemetry meter from `@opentelemetry/api` (already a dep). **Audit Round 6 (platform) must confirm the platform-preferred path** — if `prom-client` is already in another app's runtime, switch to it for consistency.

3. ~~**Restate `ctx.objectStore` API surface**~~ — **RESOLVED at Round 3**: Restate's `WorkflowContext` (verified at `workflow-handler.ts:239–244`) exposes only `sleep`/`run`/`promise` — no `objectStore`. The HLD's `ctx.store` is now implemented via a **Redis-backed adapter** (D-9 revised; Phase 3 Task 3.1 rewritten). Redis natively supports TTL via `SET ... PX`.

4. **DNS pinning for the engine→callback POST?** The worker's `callback-poster` POSTs back to `WORKFLOW_ENGINE_URL` which is internal/static. Currently uses `safeFetch` for the JSON callback POST (small body, buffered). **No DNS pinning concern** for internal URLs but ensure `WORKFLOW_ENGINE_URL` is in `SSRF_ALLOWED_HOSTNAMES`.

5. **GAP-014 (new) — Azure DI cost counter survives connection delete?** HLD §9 #9 flags that deleting and recreating a `ConnectorConnection` resets the cost counter mid-month. v1 acceptance: admin permission to delete connections is a narrow attack surface. v2 mitigation deferred to a per-`{tenantId, projectId, connectorName, yearMonth}` collection. **Document as feature spec GAP-014 during `/post-impl-sync`**.

6. **Phase 1 commit 1.B contains `packages/shared` (timeout widening)** — touches a high-volume package. The 1-line Zod widening is low-risk but consumers downstream may have cached the previous compiled schema; ensure `pnpm build --filter=@agent-platform/shared` cascades before commit 1.B finalization.

---

## 8. References

- **Feature spec**: [`docs/features/document-extraction-integrations.md`](../features/document-extraction-integrations.md) — FRs 1–22, GAPs 1–13, §10 implementation files, §13 phasing
- **HLD**: [`docs/specs/document-extraction-integrations.hld.md`](../specs/document-extraction-integrations.hld.md) — §3.2.1 workflow-engine integration points, §4 architectural concerns, §5 data model
- **Test spec**: [`docs/testing/document-extraction-integrations.md`](../testing/document-extraction-integrations.md) — 56 scenarios (E2E 13, integration 18, unit 10, security 15)
- **Oracle log**: [`docs/sdlc-logs/document-extraction-integrations/lld.log.md`](../sdlc-logs/document-extraction-integrations/lld.log.md) — 20 clarifying questions with citations
- **Verified code anchors (re-verified 2026-05-15)**:
  - `apps/workflow-engine/src/handlers/workflow-handler.ts:2820–3197` — `async_webhook` + `toolRequest` parking blocks; line 3197 is the insertion point for `callbackRequest`
  - `apps/workflow-engine/src/handlers/step-dispatcher.ts:109–139` — `StepDispatchResult` interface; lines 185–195 the `connector_action` case
  - `apps/workflow-engine/src/routes/workflow-callbacks.ts:54–141` — mandatory HMAC verification
  - `apps/workflow-engine/src/services/restate-endpoint.ts:90–100` — `handleResolveCallback`
  - `apps/workflow-engine/src/index.ts:952–959` — `ConnectorDepsFactory` (D-9 wiring target); line 1220–1225 callback router mount
  - `apps/workflow-engine/src/executors/connector-action-executor.ts:66–88` — current synchronous executor
  - `apps/search-ai/src/workers/docling-extraction-worker.ts:108, 153, 540–679` — processor, `downloadDocument` (BUFFERED), `callDoclingService`, worker factory
  - `apps/search-ai/src/queues/queue-factory.ts:125` — `getDoclingExtractionQueue()` (template for new factory)
  - `apps/search-ai/src/server.ts:548` — `INGESTION_MAX_CONCURRENT_JOBS = 5`
  - `packages/search-ai-sdk/src/constants.ts:11` — existing `QUEUE_DOCLING_EXTRACTION = 'search-docling-extraction'`
  - `packages/connectors/src/loader.ts:42–83` — `PIECE_PACKAGES`; `:111–116` adapter branches
  - `packages/connectors/src/auth/connection-resolver.ts:50–157` — `ConnectionResolver` class
  - `packages/connectors/src/adapters/activepieces/auth-adapters/jira-cloud.ts`, `servicenow.ts` — existing require.cache shim templates
  - `packages/connectors/src/adapters/activepieces/context-translator.ts:211–290` — `connectionConfig` bridging point
  - `packages/connectors/src/executor/connector-tool-executor.ts:34–38, 40–134` — `NOOP_STORE` default + ctor + `ActionContext` build
  - `packages/connectors/src/types.ts:142–170` — `ActionContext`, `KeyValueStore` interfaces
  - `packages/connectors/piece-shopify/{package.json, src/index.ts}` — template piece layout
  - `packages/database/src/models/connector-connection.model.ts:19–34, 38–56` — `IConnectorConnection` + schema
  - `packages/shared/src/types/workflow-schemas.ts:162–169` — `IntegrationNodeConfigSchema` (`timeout` at :168)
  - `packages/shared/src/validation/auth-profile.schema.ts:168–175, 267` — `ApiKeyConfigSchema` + `connectionConfig` escape hatch
  - `packages/shared-kernel/src/security/ssrf-validator.ts:402, 454` — `validateUrlForSSRF`, `assertUrlSafeForSSRF`
  - `packages/shared-kernel/src/security/safe-fetch.ts:339–363, 365–403` — DNS-pinned response (streaming inbound); `normalizeBody` throws on streaming bodies (D-7 rationale)
  - `packages/shared-kernel/src/security/webhook-signature.ts` — `verifyWebhookSignature`
  - `packages/shared/src/services/mcp-auth-resolver.ts:248–276` — existing `RateLimiterRedis` pattern
  - `packages/shared-encryption/src/encryption-manifest.ts:1–34` — manifest shape + existing `'search-docling-extraction'` entry
- **CLAUDE.md** — platform invariants (tenant isolation, centralized auth, additive feature commits, max 40 files / 3 packages per commit, no platform mocks in tests)
- **`docs/sdlc/pipeline.md`** — SDLC phase order, audit minimums (LLD = 8 rounds: 5 sequential + 3 parallel)
