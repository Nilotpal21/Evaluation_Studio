# HLD: Document Extraction Integrations (Docling + Azure Document Intelligence)

**Feature Spec:** [`docs/features/document-extraction-integrations.md`](../features/document-extraction-integrations.md) (committed `57354b3f2`)
**Test Spec:** [`docs/testing/document-extraction-integrations.md`](../testing/document-extraction-integrations.md) (committed `ed6080f58`)
**Oracle Log:** [`docs/sdlc-logs/document-extraction-integrations/hld.log.md`](../sdlc-logs/document-extraction-integrations/hld.log.md)
**Source Plan:** `/Desktop/docling-azure-di-integration-plan.md` (2026-05-14, 1008 lines; will be vendored to `docs/plans/document-extraction-integrations.source-plan.md` at LLD)
**Status:** DONE
**Target branch:** `feature/wf/ocrnode`
**Jira:** ABLP-1073
**Date:** 2026-05-15
**Last Updated:** 2026-05-20
**Audit minimum:** 3 phase-auditor rounds

---

## 0. Overview / Goal

Ship two `extract_document` workflow Integration Node actions — **Docling** (internal Python service, reused via a new dedicated BullMQ queue + Restate `async_webhook`-style parking) and **Azure Document Intelligence** (external SaaS, implemented as the first from-scratch Activepieces-format piece in the repo with `ctx.store`-backed Restate replay safety) — behind a **single normalized output envelope** so workflow designers can swap providers without rewiring downstream nodes. The design preserves the existing search-AI ingestion path byte-for-byte, leaves the Docling Python service untouched, makes no platform-wide `AuthProfile` schema change, and partitions the existing per-pod budget (3 ingestion + 2 workflow = 5, env-overridable) rather than adding a new pod fleet. Per-tenant rate limiting closes AF-105 noisy-neighbor; **per-(project, connection) Azure DI cost cap** (counters live on each `ConnectorConnection` record — projects are expected to have at most one Azure DI connection by virtue of the `{tenantId, projectId, connectorName}` compound index, but the cost-cap math is per-connection so any future multi-connection support is unaffected) bounds Azure DI billing exposure.

---

## 1. Problem Statement

Workflow designers in Studio cannot extract structured content (text, layout, tables, OCR) from documents inside a workflow today. Two production-grade extraction capabilities exist in the platform — the `docling-service` Python pipeline (consumed by SearchAI for knowledge-base ingestion via `multimodal-processing` ALPHA) and zero coverage for external SaaS extraction (Azure Document Intelligence, AWS Textract, etc.) — and **both are invisible to the workflow engine**. Designers either hand off to SearchAI's ingestion pipeline (wrong tool — it writes to Mongo/S3 + fans out to embedding/indexing/search-index assumptions) or write a custom tool. A `doc_intelligence` `NodeType` stub has been reserved in `packages/shared/src/types/workflow-schemas.ts:31` and `STUB_NODE_TYPES` for this purpose since the workflow engine's initial build but was never wired to an executor.

This HLD designs the addition of two `extract_document` workflow Integration Node actions — one routed through SearchAI's existing Docling pod fleet, one as a from-scratch Activepieces-format piece calling Azure DI REST directly — behind a single normalized output envelope so workflows can swap providers without rewiring downstream nodes. The design preserves the existing search-AI ingestion path byte-for-byte, leaves the Docling Python service untouched, and avoids any platform-wide schema changes by routing through the existing `integration` canvas node → `connector_action` step type.

---

## 2. Alternatives Considered

### Option A — Two-queue topology + Restate `async_webhook`-style parking on existing search-AI worker (CHOSEN)

- **Description:** Add a new `workflow-docling-extraction` BullMQ queue subscribed by the existing search-AI `docling-extraction-worker` process (second `new Worker(...)`, reserved per-queue concurrency 3+2). The Docling connector action's `run()` validates input, enqueues onto the new queue, returns a sentinel signaling async completion; the workflow-engine's `connector_action` step dispatcher recognizes the sentinel and routes the workflow-handler into the existing `waiting_callback` parking machinery (Restate durable promise on `sys:callback:${stepId}` + `raceTimeout`). The worker's new branch streams the URL into Docling's existing `/extract`, normalizes to the shared envelope, POSTs back to `/api/v1/workflows/callbacks/:executionId/:stepId` with mandatory HMAC. Azure DI is a from-scratch AP piece that calls Azure REST directly with `ctx.store`-backed Restate-replay safety.
- **Pros:** Reuses the existing callback infrastructure (secret generation + ciphertext-at-rest + mandatory HMAC verify) with **zero new endpoints**. Zero changes to the Docling Python service. Zero changes to the search-AI ingestion path (byte-for-byte unchanged when `job.queueName === 'search-docling-extraction'`). No new pod fleet, no new image, no new HPA — partitions the existing 5-slot per-pod budget into 3 ingestion + 2 workflow. No platform-wide `AuthProfile` schema change — Azure-specific config slots into the existing `connectionConfig: Record<string, string>` escape hatch. Closes AF-105 noisy-neighbor (per-tenant `RateLimiterRedis`). Two independent replay-safety mechanisms (Restate journal for Docling, `ctx.store` for Azure DI) — neither requires deterministic BullMQ job IDs.
- **Cons:** Plaintext HMAC secret in BullMQ payload deviates from the encrypted-then-header pattern of `async_webhook` (deliberate; documented in §7). Reserved-concurrency split runs at ~60% efficiency under fully skewed load (GAP-005). Workflow branch bugs share the search-AI pod blast radius. `workflow-docling-extraction` queue name breaks the existing `search-*` prefix convention (deliberate; signals queue ownership).
- **Effort:** M (13 dev-days per the source plan; ~3 calendar weeks to beta with pair/review).

### Option B — Dedicated workflow-extraction worker pod fleet

- **Description:** New Kubernetes Deployment + image + HPA for `workflow-docling-extraction-worker`. Same processor function, same Docling service target, same callback POST flow — but isolated pod fleet.
- **Pros:** Workflow branch bugs cannot disrupt ingestion SLOs. Independent HPA scales workflow pods to zero when idle. Per-queue active-job invariants are trivially enforced at the deployment boundary.
- **Cons:** Duplicates the ~2 GB Docling image + Python models per pod (storage + image-pull cost). Two deployments + two HPAs + two image-tag bumps to maintain. Higher base resource floor (idle workflow pods still consume CPU/memory). For v1 (low expected volume), this is over-engineering.
- **Effort:** L (extra Helm chart + values + Deployment manifests + Argo wiring).
- **Decision trigger for v2:** persistent queue-depth skew >30 min, workflow extraction volume >50% of total, or repeated workflow-branch crashes disrupting ingestion SLO.

### Option C — Direct Restate handler with `ctx.run`-journaled Docling call

- **Description:** Replace the BullMQ → worker → callback chain with a dedicated Restate handler in `apps/workflow-engine`. The Docling integration's `extract_document` step body calls Docling's `/extract` directly **inside `ctx.run('docling-extract', ...)`** so the response is journaled and the call is at-most-once across replays. No BullMQ queue, no callback POST, no HMAC.
- **Pros:** Removes two moving parts (the new queue and the callback POST infrastructure). No plaintext-HMAC-in-Redis question. Single replay-safety mechanism (Restate journal) covers both Docling and Azure DI.
- **Cons:** (a) The full extraction response is materialized in the Restate journal — for a 50 MB envelope this is a journal-bloat concern (Restate documents recommend keeping `ctx.run` outputs small; large outputs degrade replay performance and cost). (b) The engine pod holds the HTTP connection to Docling for the entire extraction (up to 30 min); engine pod count + Docling concurrency become coupled — the existing `INGESTION_MAX_CONCURRENT_JOBS = 5` per-pod budget would need to be enforced at the engine layer, where there is currently no equivalent semaphore. (c) Loses the SearchAI ingestion path's GPU-pod isolation — a workflow extraction bug in the engine cannot affect the search-AI worker fleet today; under this design, engine-side bugs (memory, timeout, leaked sockets) directly impact every workflow execution sharing the same engine pod. (d) HPA must now scale on a metric combining queue-depth (existing ingestion path) and engine-side extraction concurrency (new), making operational tuning harder. (e) No queue-depth backpressure surface for operators; observability metrics today track BullMQ queues, not engine-side in-flight HTTP requests.
- **Effort:** M — comparable to Option A, but the journal-bloat and engine-side semaphore concerns add unbudgeted risk during beta.
- **Why not chosen:** The journal-bloat concern (a) is the dominant disqualifier — `ctx.run` outputs are persisted on every step, and a 50 MB extraction envelope in the journal will degrade replay performance and persistence cost. Option A's approach (envelope returned via callback body, journal stores only the resolved promise value) keeps the journal small.

### Recommendation — **Option A** (CHOSEN)

Reuses every existing platform primitive (Restate parking + HMAC + RateLimiterRedis + AP runtime adapter + AuthProfile encryption facade), preserves the search-AI ingestion path verbatim, and partitions the existing per-pod budget rather than adding a new fleet. Trade-offs (plaintext HMAC in Redis, 60% efficiency under skew, blast-radius sharing) are deliberate, documented, and have v2 upgrade paths.

---

## 3. Architecture

### 3.1 System Context Diagram

```
                      ┌────────────────────────────────────┐
                      │  Studio (React + Next.js)          │
                      │  - Project Settings → Integrations │
                      │    (Docling toggle card)           │
                      │  - Auth Profiles → Azure DI form   │
                      │  - Workflow Canvas → Integration   │
                      │    Picker → DynamicActionForm      │
                      └────────────────┬───────────────────┘
                                       │  HTTP
                                       ▼
        ┌──────────────────────────────────────────────────────────┐
        │   apps/workflow-engine (Express + Restate)               │
        │                                                          │
        │   ┌──────────────────────┐   ┌─────────────────────┐    │
        │   │  routes/integrations │   │ routes/azure-di-    │    │
        │   │  (Docling toggle)    │   │ usage (cost cap)    │    │
        │   └──────────────────────┘   └─────────────────────┘    │
        │   ┌──────────────────────────────────────────────────┐  │
        │   │  routes/workflow-callbacks (EXISTING, REUSED)    │  │
        │   │  mandatory HMAC + replay-window verify           │  │
        │   └──────────────────────────────────────────────────┘  │
        │   ┌──────────────────────────────────────────────────┐  │
        │   │  step-dispatcher.ts (EXISTING + extended)        │  │
        │   │  connector_action: recognizes async-parking      │  │
        │   │  sentinel; returns callbackRequest               │  │
        │   └────────────────────┬─────────────────────────────┘  │
        │                        │                                 │
        │   ┌────────────────────┴─────────────────────────────┐  │
        │   │  workflow-handler.ts (EXISTING, REUSED)          │  │
        │   │  • generate + encrypt callback secret in ctx.run │  │
        │   │  • persist 'waiting_callback' on step record     │  │
        │   │  • park: restateCtx.promise().get() + raceTimeout│  │
        │   └────────────────────┬─────────────────────────────┘  │
        └────────────────────────┼─────────────────────────────────┘
                                 │
                  ┌──────────────┼──────────────────────────────┐
                  │              │                              │
                  ▼ (Docling)    ▼ (Azure DI)                  ▼ (callback IN)
        ┌────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
        │  packages/      │  │  packages/connectors/ │  │  callback POST       │
        │  connectors/    │  │  piece-azure-         │  │  /api/v1/workflows/  │
        │  src/native/    │  │  document-            │  │  callbacks/          │
        │  docling/       │  │  intelligence/        │  │  :execId/:stepId     │
        │  connector.ts   │  │  (AP-format piece)    │  │  (HMAC verified)     │
        │  - SSRF + HEAD  │  │  - SSRF + HEAD probe  │  └────────┬─────────────┘
        │  - rate-limit   │  │  - in-process         │           │
        │  - enqueue      │  │    RateLimiterMemory  │           │
        │  - return       │  │  - in-process circuit │           ▼
        │    sentinel     │  │    breaker            │  ┌──────────────────────┐
        └───────┬─────────┘  │  - ctx.store          │  │ restate-endpoint.ts  │
                │            │    (24h TTL key)      │  │ handleResolveCallback│
                │            │  - POST :analyze      │  │ resolves the         │
                ▼            │  - poll w/ Retry-After│  │ parked promise       │
        ┌────────────────┐   │  - normalize envelope │  └──────────────────────┘
        │ BullMQ queue:  │   └────────────┬──────────┘
        │ workflow-      │                │
        │ docling-       │                ▼
        │ extraction     │      ┌─────────────────────┐
        │ (NEW)          │      │ Azure Document      │
        └───────┬────────┘      │ Intelligence REST   │
                │               │ (external SaaS)     │
                ▼               └─────────────────────┘
        ┌─────────────────────────────────────────────┐
        │ apps/search-ai docling-extraction-worker.ts │
        │  Worker A: search-docling-extraction (3)    │ ◄── existing ingestion
        │  Worker B: workflow-docling-extraction (2)  │ ◄── NEW workflow branch
        │  Shared processor; branches on job.queueName│
        │  - SSRF re-check (Redis-hop defense)        │
        │  - streaming URL → Docling /extract         │
        │  - normalize → envelope                     │
        │  - serializedSize cap (50 MB default)       │
        │  - HMAC-signed callback POST to engine      │
        └────────────────┬────────────────────────────┘
                         │
                         ▼
        ┌──────────────────────────────────────┐
        │ Docling Python service (port 8080)   │
        │ (UNCHANGED — endpoint, schema, image)│
        └──────────────────────────────────────┘
```

### 3.2 Component Diagram

```
WORKFLOW-ENGINE (apps/workflow-engine)
├── routes/
│   ├── integrations.ts                       (NEW: Docling toggle endpoints)
│   ├── azure-di-usage.ts                     (NEW: cost-cap routes)
│   └── workflow-callbacks.ts                 (EXISTING, REUSED — mandatory HMAC)
├── handlers/
│   ├── step-dispatcher.ts                    (MODIFIED: async-parking sentinel for connector_action)
│   ├── workflow-handler.ts                   (REUSED — parking + HMAC secret generation)
│   └── canvas-to-steps.ts                    (UNCHANGED — already maps integration → connector_action)
├── executors/
│   └── connector-action-executor.ts          (REUSED unchanged — call site only)
└── services/
    └── restate-endpoint.ts                   (REUSED — handleResolveCallback)

CONNECTORS (packages/connectors)
├── src/native/
│   ├── docling/
│   │   ├── connector.ts                      (NEW: Docling connector + extract_document action body)
│   │   ├── streaming-url-to-docling.ts       (NEW: streaming helper for the worker branch)
│   │   └── normalize.ts                      (NEW: Docling response → envelope)
│   └── extraction-envelope.ts                (NEW: shared Zod ExtractionEnvelopeSchema)
├── src/loader.ts                             (MODIFIED: register Docling eagerly + add Azure DI to PIECE_PACKAGES)
├── src/services/connection-resolver.ts       (MODIFIED: short-circuit auth.type === 'none')
├── src/services/connection-service.ts        (MODIFIED: auto-bind synthetic system AuthProfile for none)
├── src/adapters/activepieces/auth-adapters/
│   └── azure-document-intelligence.ts        (NEW: data-mapping shim, not require.cache patch)
└── piece-azure-document-intelligence/        (NEW package)
    ├── src/index.ts                          (createPiece)
    ├── src/auth.ts                           (PieceAuth.CustomAuth + validate)
    ├── src/actions/extract-document.ts       (createAction.run() — POST :analyze, ctx.store, poll)
    └── src/normalize.ts                      (Azure analyzeResult → envelope)

SEARCH-AI (apps/search-ai)
├── src/workers/
│   ├── docling-extraction-worker.ts          (MODIFIED additively — second new Worker(), processor branch)
│   ├── branches/extraction-only.ts           (NEW — workflow branch: SSRF re-check, stream, normalize, cap)
│   └── callback-poster.ts                    (NEW — HMAC-signed POST with 1s→30s exponential backoff)
└── src/queues/
    └── queue-factory.ts                      (MODIFIED additively — getWorkflowDoclingExtractionQueue())

SDK (packages/search-ai-sdk)
└── src/constants.ts                          (MODIFIED additively — QUEUE_WORKFLOW_DOCLING_EXTRACTION + extended job-data type)

SHARED (packages/shared)
└── src/types/workflow-schemas.ts             (MODIFIED — IntegrationNodeConfigSchema.timeout.max(1800))

ENCRYPTION (packages/shared-encryption)
└── src/encryption-manifest.ts                (MODIFIED additively — 'workflow-docling-extraction' entry)

STUDIO (apps/studio)
├── src/pages/projects/[projectId]/settings/integrations.tsx  (NEW — Settings tab)
├── src/components/projects/
│   ├── IntegrationsCard.tsx                  (NEW — Docling toggle card)
│   └── AzureDIUsageView.tsx                  (NEW — usage view)
└── src/components/workflows/canvas/config/
    ├── IntegrationPickerModal.tsx            (REUSED unchanged)
    └── DynamicActionForm.tsx                 (REUSED unchanged)
```

### 3.2.1 Workflow-engine integration points (NEW)

This feature introduces three additive integration points in the existing workflow-engine that the LLD must implement. They are deliberately small and patterned after the existing `tool_call` async-wait suspension at `workflow-handler.ts:2976-3035` (NOT after `webhookRequest`, which does an outbound HTTP request before parking — here the enqueue happens inside the connector action body).

**(a) New `callbackRequest` field on `StepDispatchResult`** (`apps/workflow-engine/src/handlers/step-dispatcher.ts:109-139`):

```typescript
export interface StepDispatchResult {
  // ... existing fields: delayMs, approvalRequest, webhookRequest, toolRequest, humanTaskRequest, ...

  /**
   * Set by connector_action step type when the action's run() returns the
   * async-parking sentinel. The handler routes this to the parking block.
   */
  callbackRequest?: {
    callbackId: string; // ${executionId}:${stepId}
    callbackTimeoutMs: number; // honors IntegrationNodeConfigSchema.timeout (5..1800s)
    encryptedCallbackSecret: string; // ciphertext from ctx.run('gen-callback-secret', ...)
  };
}
```

**(b) `hasSuspension()` update** (`workflow-handler.ts:3896-3903`):

```typescript
// existing function adds the new field to its OR-check:
function hasSuspension(result: StepDispatchResult): boolean {
  return (
    result.delayMs !== undefined ||
    result.approvalRequest !== undefined ||
    result.webhookRequest !== undefined ||
    result.toolRequest !== undefined ||
    result.humanTaskRequest !== undefined ||
    result.callbackRequest !== undefined // NEW
  );
}
```

**(c) New suspension block in `workflow-handler.ts`** — placed immediately after the `toolRequest` block's closing brace (after `await markStepCompleted(step, ctx, deps, executionId);` at line **3196** and the closing `}` at line **3197**, and **before** the cancellation-check at line **3199**: `// Check for cancellation between non-suspension steps`). Patterned on `toolRequest`'s shape (the full `toolRequest` block spans approximately lines 2976-3197):

```typescript
if (result.callbackRequest !== undefined && restateCtx) {
  const cbReq = result.callbackRequest;

  // 1. Persist the encrypted callbackSecret onto the step record (mirrors lines 2843-2849).
  setStepContext(
    ctx,
    step,
    rebuildStepContext(step.type, getStepContext(ctx, step), {
      status: 'waiting_callback',
      callbackSecret: cbReq.encryptedCallbackSecret,
    }),
  );
  await deps.persistence.updateStepStatus(
    executionId,
    ctx.tenant.tenantId,
    ctx.tenant.projectId,
    step.id,
    'waiting_callback',
    stepPersistArgs(ctx, step),
  );

  // 2. Publish step.waiting_callback (mirrors lines 2903-2918).
  await deps.publisher.publish(/* same shape as async_webhook */);

  // 3. Park on the durable promise (mirrors lines 2921-2931).
  let callbackPayload: unknown;
  try {
    callbackPayload = await raceCancel(
      restateCtx,
      raceTimeout(
        restateCtx,
        restateCtx.promise<unknown>(`sys:callback:${step.id}`).get(),
        cbReq.callbackTimeoutMs,
      ),
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      // Mirror lines 2933-2956: persist 'failed' with STEP_TIMEOUT, throw WorkflowStepError.
    }
    throw err;
  }

  // 4. Resume: completed-step bookkeeping, emit trace event, return.
}
```

**Why mirror `toolRequest`, not `webhookRequest`:** the `webhookRequest` path includes an outbound HTTP fetch inside `ctx.run` before parking (lines 2856-2873). For this feature the "outbound request" is a BullMQ enqueue performed inside the connector action's `run()` (not inside the handler), so the handler only does secret-persist + park — exactly what `toolRequest` does.

**Dependency-injection path for the connector action `run()`:** the action body needs `deps.encryptSecret`, `tenantId`, `executionId`, `stepId`, and a callback-URL builder. These are NOT available on the AP `ActionContext` today. The LLD must thread them via the existing `ConnectorToolExecutor` → AP-runtime-adapter → `ActionContext` chain. Two options for the LLD to pick:

1. **Augment `ActionContext` with an optional `callbackContext`** containing `{ tenantId, executionId, stepId, callbackUrlBuilder, encryptSecret, restateCtx }`. Added to the in-repo `ConnectorActionContext` type only; AP third-party pieces ignore it (additive, opt-in).
2. **Add a new connector-side helper module** (`packages/connectors/src/runtime/async-parking.ts`) that the Docling connector imports directly, with `deps` injected at registration time via `loadConnectors(deps)`.

Either is acceptable; option 1 keeps the AP shape consistent with how `ctx.store` is exposed; option 2 keeps AP pieces unaware of platform-specific suspension semantics. **Pick at LLD; do not block HLD.** The HMAC-secret-generation must happen inside the connector action body (NOT the handler) because the plaintext copy must reach the BullMQ payload, which is constructed inside `run()`. The handler's job is restricted to persisting the ciphertext and parking.

### 3.3 Data Flow — Docling (workflow path)

```
1. Studio: workflow execution reaches an integration node with connectorId='docling'
   ├─ canvas-to-steps.ts maps integration → connector_action step (existing wiring)
   └─ step-dispatcher.ts dispatches connector_action

2. step-dispatcher → connector-action-executor.execute()
   └─ ConnectorToolExecutor invokes Docling connector's extract_document.run(ctx)

3. extract_document.run() (inside engine pod, inside Restate's ctx.run):
   a. Resolve params; validate against extraction-envelope input schema
   b. assertUrlSafeForSSRF(fileUrl)          — pre-enqueue SSRF (DNS-pinned)
   c. HEAD probe (10s timeout, hard cap 500 MB, reject on unsupported MIME)
   d. RateLimiterRedis.consume('workflow:docling:${tenantId}', 1)
      └─ on RateLimiterRes throw: typed RATE_LIMITED error
   e. Generate HMAC secret inside restateCtx.run('gen-callback-secret', ...):
      └─ secret = randomBytes(32).hex
      └─ ciphertext = await deps.encryptSecret(secret, tenantId)
   f. Build callbackUrl = ${WORKFLOW_ENGINE_URL}/api/v1/workflows/callbacks/${executionId}/${stepId}
   g. Enqueue BullMQ job onto 'workflow-docling-extraction' with:
        { tenantId, projectId, fileUrl, mode: 'extraction-only',
          options: { extractImages, extractTables, ocrEnabled, language, model, pages, timeout },
          callbackId: `${executionId}:${stepId}`,
          callbackUrl, callbackSecret: secret  (plaintext, Class-1 internal),
          attempts: 1 }
   h. Return sentinel: { __asyncParking: true, callbackId, callbackTimeoutMs, encryptedCallbackSecret: ciphertext }

4. step-dispatcher sees __asyncParking sentinel → returns StepDispatchResult with callbackRequest field

5. workflow-handler reads callbackRequest:
   a. Persist encryptedCallbackSecret onto step record (rebuildStepContext + persistence.updateStepStatus)
   b. Set step.status = 'waiting_callback'
   c. Publish step.waiting_callback event to pub/sub
   d. Park: callbackPayload = await raceCancel(restateCtx, raceTimeout(restateCtx,
                restateCtx.promise<unknown>(`sys:callback:${step.id}`).get(),
                callbackTimeoutMs))
   e. On TimeoutError → fail step with STEP_TIMEOUT

— ASYNC BOUNDARY — engine pod is now free; the parked promise lives in Restate's journal —

6. search-ai docling-extraction-worker (Worker B subscription, concurrency=2):
   ├─ BullMQ delivers the job; processor branches on job.queueName === 'workflow-docling-extraction'
   ├─ NEW BRANCH: extraction-only:
   │  a. assertUrlSafeForSSRF(fileUrl)        — static re-check across Redis hop
   │  b. stream(fileUrl) → Docling /extract multipart via safeFetch (DNS-pinned),
   │      streamed body, NO buffering — closes the DNS-rebinding TOCTOU window
   │  c. extraction = await Docling /extract response
   │  d. envelope = normalizeDoclingResponse(extraction, { provider: 'docling', sourceUrl, contentType })
   │  e. serializedSize = JSON.stringify(envelope).length
   │     └─ if > DOCLING_WORKFLOW_INLINE_CAP_BYTES → callback with EXTRACTION_TOO_LARGE typed error
   │  f. callback-poster.postCallback(callbackUrl, envelope, callbackSecret):
   │     ├─ sign HMAC-SHA256 over rawBody using callbackSecret
   │     ├─ headers: x-callback-signature: sha256=..., x-callback-timestamp: epochSeconds
   │     ├─ POST with exponential backoff (1s, 2s, 4s, 8s, 16s; max 5 attempts; 404 terminal)
   │     └─ emit workflow_docling_callback_post_attempts_total / _failures_total
   └─ EXISTING BRANCH (queueName === 'search-docling-extraction') runs byte-for-byte unchanged

7. Engine receives callback at POST /api/v1/workflows/callbacks/:executionId/:stepId:
   ├─ Load execution by _id; locate step by stepId
   ├─ Reject if step.status !== 'waiting_callback' (409)
   ├─ Verify HMAC (MANDATORY) via verifyWebhookSignature(secret, rawBody, signature, timestamp)
   │   └─ Decrypt step.callbackSecret using tenantId; compare signatures
   ├─ resolveCallback → Restate resolves sys:callback:${stepId} with req.body
   └─ Return { ok: true }

8. Workflow resumes (the parked promise.get() returns the envelope):
   ├─ Step transitions to 'completed' with output = envelope
   ├─ TraceEvent emitted via TraceStore
   ├─ Audit event emitted
   └─ Downstream nodes see {{ steps.<nodeId>.output.markdown }}, .pages, .metadata
```

### 3.4 Data Flow — Azure DI (in-process path)

```
1. Studio: workflow execution reaches an integration node with connectorId='azure-document-intelligence'
2. step-dispatcher → connector-action-executor → ConnectorToolExecutor → AP runtime adapter
3. context-translator.ts:
   ├─ Resolve params (coerceParams handles JSON/bool/number from string)
   ├─ Resolve connection via ConnectionResolver:
   │  ├─ Find ConnectorConnection by { tenantId, projectId, connectorName, _id: connectionId }
   │  ├─ Resolve AuthProfile (api_key type) via AuthProfileResolverFactory
   │  ├─ Decrypt secrets.apiKey via tenant-encryption-facade
   │  └─ Bridge to AP CustomAuth via auth-adapters/azure-document-intelligence.ts:
   │     auth = {
   │       endpoint: connectionConfig.endpoint,
   │       apiKey: decrypted,
   │       apiVersion: connectionConfig.apiVersion ?? '2024-11-30',
   │       defaultModel: connectionConfig.defaultModel ?? 'prebuilt-layout',
   │     }
   ├─ wrapStore(ctx.store) — backed by Restate's ctx.objectStore
   └─ Invoke piece extract_document.run(APActionContext)

4. extract_document.run() (in-process, replay-safe via ctx.store):
   a. Cost-cap check: query ConnectorConnection.usageCount; if >= hardCap → QUOTA_EXCEEDED
   b. assertUrlSafeForSSRF(fileUrl) + HEAD probe (10s timeout, via safeFetch — DNS-pinned) + size guard
   c. RateLimiterMemory.consume(tenantId, 1) — in-process token bucket
   d. CircuitBreaker.canExecute(tenantId) — open after 5 consecutive 5xx in 30s
   e. existing = await ctx.store.get(`azuredi:${executionId}:${stepId}`)
   f. if existing → operationLocation = existing.value (RESUME on replay; no second :analyze POST)
      else:
        ├─ response = await safeFetch(`${endpoint}/documentintelligence/documentModels/${model}:analyze?api-version=${apiVersion}`,
        │     { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': apiKey, 'Content-Type': 'application/json' },
        │       body: { urlSource: fileUrl, ...optionalParams } })   — DNS-pinned via safeFetch
        ├─ operationLocation = response.headers.get('Operation-Location')
        └─ await ctx.store.put(`azuredi:${executionId}:${stepId}`, operationLocation, { ttlMs: 86400_000 })
   g. Poll loop: while not terminal:
        ├─ // raw fetch acceptable here: operationLocation is Azure-provided, not user-supplied;
        ├─ //   DNS-pinning defense is for the user-controlled fileUrl only (covered by the
        ├─ //   safeFetch on the :analyze POST at step 4.f).
        ├─ pollResp = await fetch(operationLocation, { headers: { 'Ocp-Apim-Subscription-Key': apiKey } })
        ├─ on 429: sleep(Retry-After * 1000); continue
        ├─ on 5xx: CircuitBreaker.recordFailure(tenantId); backoff(2s → 30s exp); continue
        ├─ on 200 + status==='succeeded': break with pollResp.analyzeResult
        ├─ on 200 + status==='failed': throw EXTRACTION_FAILED with sanitized message
        └─ on 200 + status in ('notStarted','running'): backoff; continue
   h. envelope = normalizeAzureAnalyzeResult(analyzeResult, { provider: 'azure-document-intelligence', sourceUrl, contentType })
   i. serializedSize check; throw EXTRACTION_TOO_LARGE if over cap
   j. await ctx.store.delete(`azuredi:${executionId}:${stepId}`)   — cleanup on success
   k. ConnectorConnection.updateOne(filter, { $inc: { usageCount: 1 } })  — atomic counter
   l. Return envelope to ConnectorToolExecutor → step output

5. TraceEvent + audit event emitted; downstream nodes see steps.<nodeId>.output
```

### 3.5 Sequence Diagram — Docling: enqueue → park → resume

```
Studio   Engine     DocURL     Worker     Docling   Engine-callback
  │ step  │           │          │           │           │
  │ ─────►│ run()     │          │           │           │
  │       │ assertSSRF│          │           │           │
  │       │ HEAD ────►│ (probe)  │           │           │
  │       │◄──── 200  │          │           │           │
  │       │ rate-limit│          │           │           │
  │       │ gen secret│          │           │           │
  │       │ enqueue ──┼──────────►│ BullMQ    │           │
  │       │ (sentinel)│           │ (Redis)   │           │
  │       │           │           │           │           │
  │       │ persist:  │           │           │           │
  │       │ waiting_cb│           │           │           │
  │       │           │           │           │           │
  │       │ park on   │           │           │           │
  │       │ Restate   │           │           │           │
  │       │ promise   │           │           │           │
  │       │ (sleeping)│           │           │           │
  │       │           │           │ pickup    │           │
  │       │           │           │ assertSSRF│           │
  │       │           │           │ safeFetch (DNS-pinned)│
  │       │           │ stream ◄──┤◄ stream ──┤           │
  │       │           │           │ POST ────►│ /extract  │
  │       │           │           │           │ (process) │
  │       │           │           │◄──────────┤           │
  │       │           │           │ normalize │           │
  │       │           │           │ size check│           │
  │       │           │           │ sign HMAC ┼──────────►│ POST callback
  │       │           │           │           │           │ verify HMAC
  │       │◄──────────┼───────────┼───────────┼───────────┤ resolveCallback
  │       │ promise resolves                              │
  │       │ step.completed                                │
  │◄──────┤ output:envelope                               │
```

### 3.6 Sequence Diagram — Azure DI: replay-safe in-process polling

```
Engine                              Azure DI                        ctx.store (Restate)
  │ run() start                       │                                │
  │ assertSSRF, HEAD, rate-limit      │                                │
  │ ctx.store.get(azuredi:exec:step) ─┼────────────────────────────────► nil (first run)
  │                                   │                                │
  │ POST :analyze ───────────────────►│                                │
  │◄─────────────────────────── 202 + Operation-Location               │
  │ ctx.store.put(... , ttl:24h) ─────┼────────────────────────────────► persisted
  │                                   │                                │
  │ GET Op-Loc ──────────────────────►│ status: running                │
  │ sleep(2s)                         │                                │
  │ GET Op-Loc ──────────────────────►│ status: running                │
  │ sleep(4s)                         │                                │
  │ GET Op-Loc ──────────────────────►│ status: succeeded + result     │
  │ normalize, size-check, $inc usage │                                │
  │ ctx.store.delete(...) ────────────┼────────────────────────────────► gone
  │ return envelope                   │                                │

  ─── ENGINE POD RESTART (Restate replay scenario) ───
  │ run() replay start                │                                │
  │ assertSSRF, HEAD, rate-limit      │                                │
  │ ctx.store.get(azuredi:exec:step) ─┼────────────────────────────────► hit: Op-Loc
  │ SKIP :analyze POST                │  ← duplicate invoice avoided   │
  │ GET Op-Loc ──────────────────────►│ status: succeeded + result     │
  │ ...                               │                                │
```

---

## 4. The 12 Architectural Concerns

### 4.1 Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant isolation**    | Every Mongo query scoped by `tenantId`. `ConnectionResolver.resolve({ _id, tenantId, projectId, status: 'active' })` — no `findById`. RateLimiterRedis key composition: `workflow:docling:${tenantId}`. `ctx.store` key composition: `azuredi:${executionId}:${stepId}` (already tenant-isolated via execution context). BullMQ job payload carries `tenantId` for audit + rate-limit. TraceStore queries filter by tenant. Project toggle / quota / usage endpoints scoped under `/api/projects/:projectId/...` and use **`requireTenantProject()`** middleware for v1 (RBAC permission strings reserved for v2 per §6.1) — cross-project access returns 404.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2   | **Data access pattern** | No new MongoDB collections. Additive fields on `ConnectorConnection` (`usageCount`, `usagePeriodStart`, `usageSoftCap`, `usageHardCap`) populated only when `connectorName === 'azure-document-intelligence'`. No new indexes (existing `{tenantId, projectId, connectorName}` compound index sufficient). Cost counter incremented atomically via `$inc`; month-boundary reset is a conditional `findOneAndUpdate` (atomic CAS: `{ usagePeriodStart: { $lt: currentMonthStart } }` → `{ $set: { usageCount: 1, usagePeriodStart: currentMonthStart } }`). **Loser path under concurrent boundary writes:** when the CAS returns `matched === 0` (another concurrent thread already won the reset), the caller falls through to a standard `$inc: { usageCount: 1 }` on the now-current-month document. Two-step pattern: (1) attempt CAS reset; (2) on `matched === 0` issue `$inc`. This guarantees exactly-one-reset semantics + correct count for all concurrent threads at the month boundary. No per-call MongoDB caching — `ConnectionResolver` runs once per step.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3   | **API contract**        | New routes use `{ success, data?, error?: { code, message } }` envelope (CLAUDE.md). Five new project-scoped routes (Docling enable/disable/quota; Azure DI usage GET + caps PATCH). Existing callback route reused unchanged. Workflow IR is the existing `type: integration` with `config.{connectorId, actionName, connectionId, params}`. Output envelope versioned (`schemaVersion: 1`); adding fields additive; removing/renaming requires version bump. **No author-facing aliases** — connectorId matches runtime id 1:1 (`docling`, `azure-document-intelligence`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 4   | **Security surface**    | (a) **SSRF defence in depth — two independent layers.** Layer 1 is static URL analysis via `assertUrlSafeForSSRF` at `packages/shared-kernel/src/security/ssrf-validator.ts:454` (scheme allowlist, private-IP-text check, cloud-metadata hostname blocklist, redirect re-validation); runs **pre-enqueue inside the connector action body** AND **again at the worker** (across the Redis hop). Layer 2 closes the DNS-rebinding TOCTOU window via **`safeFetch`** at `packages/shared-kernel/src/security/safe-fetch.ts:2-6,138-146` which does `dns.lookup` → validates every resolved IP → pins the socket to the validated address (no per-request re-resolution). **Layer 2 is what actually fetches the document** — the worker's streaming-URL helper (`apps/search-ai/src/workers/branches/extraction-only.ts`) and the Azure DI piece's `:analyze` POST MUST use `safeFetch`, not raw `fetch` (a raw `fetch` defeats the DNS pinning). The static check is necessary but not sufficient; only `safeFetch` closes the rebinding window. (b) **HMAC callback signing:** mandatory — callback route rejects unsigned/invalid; per-step secret encrypted at rest on the step record; plaintext-in-Redis is a deliberate Class-1 internal transport (see §7). (c) **TLS:** strict cert validation (no `rejectUnauthorized: false`). (d) **Credentials:** Azure DI API key encrypted at rest via `TenantEncryptionFacade`; never logged. (e) **PII:** extracted markdown passes through existing PII redaction pipeline before TraceEvent persistence. (f) **Audit log:** every extraction emits `{actor, tenantId, projectId, connector, action, sourceUrl(hostOnly), sizeBytes, durationMs, status}`. (g) **Semgrep:** `./tools/run-semgrep.sh` is a gate (touches auth, crypto, HTTP, user input). |

### 4.2 Behavioral Concerns

| #   | Concern                         | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error model**                 | All failures surface as typed `ConnectorActionError` with codes: `SSRF_BLOCKED`, `UNSUPPORTED_CONTENT_TYPE`, `RATE_LIMITED`, `EXTRACTION_TOO_LARGE` (with `{sizeBytes, limitBytes}`), `EXTRACTION_TIMEOUT`, `EXTRACTION_FAILED`, `INTEGRATION_DISABLED`, `QUOTA_EXCEEDED`, `INTEGRATION_UNAVAILABLE`, `CALLBACK_NOT_FOUND`, `FEATURE_DISABLED`. None expose Docling internal URLs, Azure subscription keys, or raw HTTP bodies. `RATE_LIMITED` renders the configured limit value as static text from config; no live usage query. Error messages are designer-actionable ("upload to S3 first", "raise project cost cap").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 6   | **Failure modes**               | Full table in feature spec §12. Key handling: (a) Worker pod crash mid-job with `attempts: 1` → no callback delivered → engine `raceTimeout` fires → step fails with `STEP_TIMEOUT` → engine per-node retry policy applies. (b) Engine pod restart during park → Restate journal re-attaches the parked promise; worker callback POST resumes the workflow; **no duplicate Docling call**. (c) Callback POST 404 → terminal (stale execution). (d) Callback POST retries exhausted → `CALLBACK_DELIVERY_FAILED` metric incremented; Docling cost incurred once with no result. (e) Azure DI 429 → sleep `Retry-After`. (f) Azure DI 5xx repeated → in-process circuit breaker opens (per-tenant, per-pod). (g) Restate replay within 24 h → `ctx.store` hit → resume polling same Azure operation, no second invoice.                                                                                                                                                                                                                                                                                       |
| 7   | **Idempotency / replay safety** | Docling: Restate journal owns single-execution. The `ctx.run` enqueue lambda runs at-most-once per logical execution; the park on `restateCtx.promise().get()` is durable across pod restarts. Azure DI: `ctx.store` key `azuredi:${executionId}:${stepId}` (24h TTL via `AZURE_DI_OPERATION_STORE_TTL_SECONDS`) holds the `Operation-Location`; replay reads the key and resumes polling the same Azure operation rather than re-POSTing. Key deleted on success or terminal failure. **Neither path requires deterministic BullMQ job IDs.** The 24h `ctx.store` TTL is the only known double-bill window — tracked as **feature-spec GAP-006**: acceptable for v1 because the per-project `usageHardCap` (FR-18) is the financial backstop; v2 mitigation path is MongoDB-backed persistence with 7-day retention, designed before the feature processes >1000 extractions/day per tenant.                                                                                                                                                                                                               |
| 8   | **Observability**               | Every extraction emits a `TraceEvent` via shared `TraceStore` carrying `provider`, `pageCount`, `processingTimeMs`, `executionId`, `traceId`, and (Docling) `jobId`. New metrics (Grafana panel under "Workflows"): `bullmq_queue_depth{queue}` (alert ingestion >200, workflow >50, sustained 10 min), `worker_active_jobs{queue}` (per-pod reservation enforcement), `workflow_docling_wait_duration_seconds{tenant, status}`, `workflow_docling_errors_total{tenant, error_class}`, `workflow_docling_parked_promises_gauge{tenant}`, `workflow_docling_callback_post_attempts_total{tenant, attempt}`, `workflow_docling_callback_post_failures_total{tenant, error_class}` (alert >0.1%), `workflow_docling_rate_limited_total{tenant}` (alert >1% per tenant for 10 min), `workflow_extraction_too_large_total{provider, tenantId}`, `azure_di_extractions_total{tenant, project, status}`, `azure_di_circuit_breaker_state{tenant}`, `azure_di_cost_cap_used_ratio{tenant, project}`. Structured logs (JSON, one line per call) include the audit-event payload plus `jobId` or `operationLocation`. |

### 4.3 Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance budget** | **Per-pod:** 5 concurrent extractions total (existing `INGESTION_MAX_CONCURRENT_JOBS = 5`); partitioned 3 ingestion + 2 workflow via `DOCLING_INGESTION_CONCURRENCY` + `DOCLING_WORKFLOW_CONCURRENCY`. Runtime assertion: sum ≤ `INGESTION_MAX_CONCURRENT_JOBS`. **Cluster targets (provisional, lock in Phase 5 beta):** p50 < 8s (Docling 10-page PDF), p95 < 25s, p99 < 60s, error rate < 1%, peak ~1 QPS sustained. **Memory invariants:** 1000 parked Docling workflow steps → engine pod RSS delta < 50 MB (parked promises in Restate journal, not pod memory); 100 MB PDF extraction → worker pod RSS delta < 10 MB (streaming, not buffered). **Inline envelope cap:** 50 MB default (`DOCLING_WORKFLOW_INLINE_CAP_BYTES`), per-project configurable. **Per-tenant fairness:** RateLimiterRedis 10/min + 5 burst (default), env-overridable per tenant.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 10  | **Migration path**     | None. All schema changes additive (optional `ConnectorConnection` fields, optional BullMQ payload fields, widened `IntegrationNodeConfigSchema.timeout` max). No new MongoDB collections; no backfill; no index changes. Docling synthetic `AuthProfile` created on demand. **Existing workflows continue to validate unchanged** (timeout max widened from 300→1800 with same default of 60).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 11  | **Rollback plan**      | Feature flag `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED=false` + rolling restart of workflow-engine + Studio pods. In-flight extractions complete (worker doesn't re-check the flag — GPU work was already paid for). New runs fail at step dispatch with `FEATURE_DISABLED`. BullMQ queue drains naturally. Studio catalog refreshes on next `IntegrationNodeConfig` mount. Residual `ConnectorConnection` records are harmless (Docling: no credentials; Azure DI: encrypted secrets remain at rest). Optional manual cleanup. **One-way schema change:** the `IntegrationNodeConfigSchema.timeout.max(1800)` widening is a permanent, backward-compatible Zod schema change in `packages/shared`; it is NOT reverted by the feature flag. Workflows authored with `timeout > 300` during the active period continue to validate after rollback (intentional — wider timeouts are cheap because parking lives in the Restate journal, and the change benefits every integration-node type, not just extraction).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 12  | **Test strategy**      | **Unit (10):** envelope schema, normalizers, content-type sniffer, timeout calculator, rate-limiter key derivation, circuit-breaker state machine, auth schema, ctx.store TTL math. Pure-function only, no mocks. **Integration (18):** real Express + MongoMemoryServer + real BullMQ Redis + fake/in-process Restate stub (DI). Covers worker branch, callback round-trip, two-queue isolation, rate-limit semantics, cost-cap atomic `$inc`, replay safety, HMAC verification, PII redaction, encryption-manifest entry. `nock` is restricted to integration tests only (in-process worker scope). **E2E (13):** Playwright against real Studio + workflow-engine + search-AI; **two out-of-process Express fixture servers** (Docling at port 8088 and Azure DI on a random port) managed by Playwright `globalSetup`/`globalTeardown`, each serving canned responses with configurable delay and call-count introspection — non-trivial test infrastructure the LLD must budget for. No `vi.mock`, no platform mocks. **Mandatory scenarios:** `WIRING-1` (end-to-end Studio UI → Studio API → workflow-engine → BullMQ → search-AI worker → Docling fixture → callback → Restate chain verification); `FORM-ERR-1..4` (toggle 403, Azure DI invalid URL, Test Connection upstream 401, DynamicActionForm out-of-range). Other coverage: Docling happy-path, Azure DI happy-path, project toggle gating, cross-provider parity, SSRF rejection, large file streaming, two-queue isolation under load, ingestion-baseline regression, Restate replay across pod restart. **Security & isolation (15):** cross-tenant/project/user 404, missing-auth 401, permission 403, HMAC missing/invalid/replay-window. **Full test spec:** `docs/testing/document-extraction-integrations.md` (56 scenarios). |

---

## 5. Data Model

### 5.1 New Collections / Tables

**None.** All persistence reuses existing collections.

### 5.2 Modified Collections / Tables

#### `ConnectorConnection` (additive fields, all optional)

Applied only when `connectorName === 'azure-document-intelligence'`:

```typescript
{
  // ... existing fields unchanged ...

  // NEW (FR-18) — Azure DI cost-cap tracking:
  usageCount?:        number;          // atomic $inc on each successful extraction (default 0)
  usagePeriodStart?:  Date;             // first-of-current-month boundary
  usageSoftCap?:      number;          // default 1000; warning surfaced at 80%
  usageHardCap?:      number | null;   // default null = soft-only; setting blocks at 100%
}
```

No new indexes — existing `{ tenantId: 1, projectId: 1, connectorName: 1 }` compound index already covers all access patterns.

#### `AuthProfile` (no schema changes — uses existing `connectionConfig` escape hatch)

- Azure DI uses `auth.type === 'api_key'` with:
  - `secrets.apiKey` encrypted via `TenantEncryptionFacade`
  - `config.connectionConfig: Record<string,string>` = `{ endpoint, apiVersion?, defaultModel? }` (the existing `connectionConfig` field at `packages/shared/src/validation/auth-profile.schema.ts:173`)
- Docling uses a synthetic per-tenant `auth.type === 'none'` profile (hidden from the Auth Profiles list; auto-created on toggle-enable).

**No platform-wide schema change.**

### 5.3 Redis Keys (no new collections)

```text
workflow:docling:${tenantId}                  RateLimiterRedis token bucket (10/min + 5 burst, sliding window)
azuredi:${executionId}:${stepId}              ctx.store key (24h TTL, holds Operation-Location)
sys:callback:${stepId}                        Restate durable promise for the parked workflow step
bull:{workflow-docling-extraction}:*          BullMQ queue keys for the new queue
bull:{search-docling-extraction}:*            BullMQ queue keys for the existing queue (UNCHANGED)
```

### 5.4 Workflow IR — Integration Step

```yaml
type: integration
config:
  connectorId: docling | azure-document-intelligence
  actionName: extract_document
  connectionId: <ConnectorConnection._id>
  params:
    fileUrl: '{{ context.steps.upload.output.publicUrl }}'
    extractImages: true
    extractTables: true
    ocrEnabled: true
    language: 'en' # optional ISO-639-1
    model: 'prebuilt-layout' # optional, Azure DI only
    timeout: 60 # 5..1800 (FR-6 widening)
  paramModes:
    fileUrl: expression
```

### 5.5 Output Envelope (versioned)

```jsonc
{
  "schemaVersion": 1,
  "provider": "docling" | "azure-document-intelligence",
  "sourceUrl": "https://...",
  "contentType": "application/pdf",
  "markdown": "# Document\n\n…",
  "pages": [
    {
      "pageNumber": 1,
      "text": "…markdown for this page…",
      "tables": [{ "rows": [["..."]], "markdown": "| … |", "bbox": [/*x,y,w,h*/] }],
      "images": [{ "format": "png", "base64": "…", "bbox": [/*x,y,w,h*/] }],
      "headings": [{ "level": 1, "text": "Section A" }]
    }
  ],
  "metadata": {
    "pageCount": 12,
    "language": "en",
    "languageConfidence": 0.98,
    "hasOCR": true,
    "title": "…",
    "author": "…",
    "processingTimeMs": 4321
  },
  "raw": { /* provider-native shape — opaque, may be omitted */ }
}
```

**Versioning policy:** additive field changes keep `schemaVersion: 1`; renaming or removing a field bumps to `schemaVersion: 2` and requires downstream-node migration. Open Question #3 in the feature spec captures the pin-and-migrate vs. permissive-consumer policy decision (recommend pin-and-migrate).

---

## 6. API Design

### 6.1 New Endpoints (workflow-engine)

**Authorization model for v1 (decided at HLD):** all five new routes use the existing workflow-engine `requireTenantProject()` middleware (tenant + project scoping, principal = authenticated user inside the resolved tenant/project). This matches `apps/workflow-engine/src/routes/connections.ts` (which also notes RBAC is not currently wired). The `integrations:read` / `integrations:write` permission strings are **reserved for v2** (when an Express-compatible `requireProjectPermission` lands platform-wide) and are **not enforced** in v1.

Rationale: introducing a workflow-engine-specific RBAC layer here would be a precedent-setting platform decision that should not be made under feature-feature pressure. GAP-011 in the feature spec remains the canonical reference; closing it is out of scope for this feature.

| Method | Path                                                                           | Auth (v1)                | Purpose                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/projects/:projectId/integrations/docling/quota`                          | `requireTenantProject()` | Returns `{ limitPerMinute, burst, scope: 'workspace' }` for the Docling card's static info line. Reads tenant config; no rate-limiter introspection. |
| POST   | `/api/projects/:projectId/integrations/docling/enable`                         | `requireTenantProject()` | Idempotent. Upserts a `ConnectorConnection` bound to a synthetic no-auth `AuthProfile`. Returns the resulting connection record.                     |
| POST   | `/api/projects/:projectId/integrations/docling/disable`                        | `requireTenantProject()` | Deletes the `ConnectorConnection`. Subsequent workflow runs gate with `INTEGRATION_DISABLED`. The synthetic AuthProfile remains (harmless).          |
| GET    | `/api/projects/:projectId/integrations/azure-document-intelligence/usage`      | `requireTenantProject()` | Returns `{ usageCount, usagePeriodStart, usageSoftCap, usageHardCap }` from the `ConnectorConnection` record.                                        |
| PATCH  | `/api/projects/:projectId/integrations/azure-document-intelligence/usage-caps` | `requireTenantProject()` | Updates `usageSoftCap` and/or `usageHardCap` atomically.                                                                                             |

### 6.2 Reused Endpoints

| Method | Path                                                | Source                                                                 | Purpose                                                                                              |
| ------ | --------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/workflows/callbacks/:executionId/:stepId`  | `apps/workflow-engine/src/routes/workflow-callbacks.ts` (lines 54-141) | **EXISTING.** Docling worker POSTs `{ callbackId, status, envelope?                                  | error? }`with mandatory`x-callback-signature`+`x-callback-timestamp` HMAC headers. Resolves the parked Restate promise. |
| GET    | `/api/projects/:projectId/connectors`               | Studio BFF                                                             | **EXISTING.** Serves `connector-catalog.json` regenerated at build time with the two new connectors. |
| GET    | `/api/projects/:projectId/connectors/:name/actions` | Studio BFF → workflow-engine                                           | **EXISTING.** Returns action schemas including `extract_document` props.                             |

### 6.3 Error Responses (typed)

All errors follow `{ success: false, error: { code, message } }`:

| Code                       | When                                                             | Surface                                                             |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `FEATURE_DISABLED`         | Feature flag off; project toggle disabled at the workflow-engine | Step output + trace event                                           |
| `INTEGRATION_DISABLED`     | Project Docling toggle off at step dispatch                      | Step output + trace event                                           |
| `SSRF_BLOCKED`             | URL fails SSRF guard (pre-enqueue OR worker re-check)            | Step output + trace event                                           |
| `UNSUPPORTED_CONTENT_TYPE` | HEAD probe content-type not in allow-list                        | Step output + trace event                                           |
| `RATE_LIMITED`             | RateLimiterRedis consume rejected                                | Step output + trace event (renders configured limit as static text) |
| `EXTRACTION_TOO_LARGE`     | Serialized envelope > inline cap; HEAD probe > hard cap          | Step output + trace event (with `{sizeBytes, limitBytes}`)          |
| `EXTRACTION_TIMEOUT`       | `raceTimeout` fires before callback                              | Step output + trace event                                           |
| `EXTRACTION_FAILED`        | Docling 5xx or Azure DI terminal failure                         | Step output + trace event                                           |
| `QUOTA_EXCEEDED`           | Azure DI `usageHardCap` reached                                  | Step output + trace event                                           |
| `INTEGRATION_UNAVAILABLE`  | Azure DI in-process circuit breaker open                         | Step output + trace event                                           |
| `CALLBACK_NOT_FOUND`       | Callback POST hits stale execution (404 from callback route)     | Worker → terminal, no retry                                         |

---

## 7. Cross-Cutting Concerns

### 7.1 Audit logging

Every extraction emits an audit event:

```typescript
{ actor, tenantId, projectId, connector, action, sourceUrl: hostOnly,
  sizeBytes, durationMs, status: 'success' | <typed-error-code> }
```

Both Docling (workflow path only — ingestion path's audit is unchanged) and all Azure DI calls are audited. **Open Question #7:** whether `SSRF_BLOCKED` and `RATE_LIMITED` rejections (no Docling/Azure call made) should audit — HLD recommendation: yes (security-event traceability).

### 7.2 Rate limiting

- **Docling, per-tenant:** `RateLimiterRedis` token bucket keyed `workflow:docling:${tenantId}`, default 10/min sustained + 5 burst, env-overridable via `DOCLING_WORKFLOW_RATE_LIMIT_PER_MIN` + `DOCLING_WORKFLOW_RATE_LIMIT_BURST`, per-tenant overridable via tenant config. Closes AF-105.
- **Azure DI, per-tenant, in-process:** `RateLimiterMemory` token bucket protecting Azure subscription quota; not Redis-backed because Azure quotas are per-tenant and don't need cross-pod coordination at v1's expected QPS. State lost on pod restart (acceptable — Azure-side quotas are the canonical authority).

### 7.3 Caching

No connection caching (per-call `ConnectionResolver` resolution; existing pattern). No catalog caching beyond the build-time static file. No envelope caching — extractions are deterministic by URL but the API doesn't guarantee idempotency beyond the workflow execution scope.

### 7.4 Encryption

- **At rest:** Azure DI `apiKey` encrypted via `TenantEncryptionFacade` (existing); `callbackSecret` ciphertext persisted on the workflow step record (existing pattern).
- **In transit:** TLS everywhere; no `rejectUnauthorized: false`. Docling HTTP is loopback (`http://`) on the pod boundary; engine ↔ callback is HTTPS; Azure DI REST is HTTPS.
- **At-rest in BullMQ payload (Phase 4 closure):** the `callbackSecret` field in the BullMQ job payload is encrypted at-rest in Redis via the standard field-encryption manifest. The Phase 2 HLD shipped with `fieldsToEncrypt: []` (a documented "deliberate deviation" deferring encryption until threat modeling moved Redis compromise in-scope); the `data-flow-audit` Round 1 (Phase 4) classified this as a CRITICAL leak and Phase 4 closed it by changing the manifest entry to `fieldsToEncrypt: ['callbackSecret']`. The engine wraps the payload via `wrapJobDataForEncrypt` at the enqueue site (`apps/workflow-engine/src/index.ts:enqueueWorkflowDoclingJob`); the worker unwraps via `unwrapJobDataForDecrypt` at the dequeue site (`apps/search-ai/src/workers/branches/extraction-only.ts:processExtractionOnly`). Backward-compat: pre-encryption jobs that landed before the manifest change pass through unchanged (the `_enc` flag is absent → no-op decrypt). **Canonical recovery path on engine restart / Restate replay:** the callback verification key is decrypted from the at-rest **ciphertext on the step record** (same path as `async_webhook` at `workflow-handler.ts:2843-2846`), NOT recovered from the BullMQ payload. The BullMQ encrypted copy is decrypted exactly once by the worker to sign the outbound callback POST. The step record remains the single source of truth for callback verification; the BullMQ-payload copy is transient.
- **Encryption manifest:** `'workflow-docling-extraction': { fieldsToEncrypt: ['callbackSecret'] }` in `packages/shared-encryption/src/encryption-manifest.ts` (closes GAP-012 + data-flow-audit Round 1 CRITICAL).

---

## 8. Dependencies

### 8.1 Upstream (this feature depends on)

| Dependency                                          | Type          | Risk                                                                                                                                                            |
| --------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@agent-platform/shared-kernel/security`            | runtime       | Low. `assertUrlSafeForSSRF`, `safeFetch`, `verifyWebhookSignature` are all existing and stable.                                                                 |
| `rate-limiter-flexible` (RateLimiterRedis / Memory) | runtime       | Low. Already a dependency at `mcp-auth-resolver.ts:248-276`. Same API surface; no version bump needed.                                                          |
| `@activepieces/pieces-framework`                    | runtime       | Low. The from-scratch piece pattern uses existing `createPiece`, `PieceAuth.CustomAuth`, `createAction` (template: `piece-shopify`).                            |
| Docling Python service (port 8080)                  | runtime       | Low. **UNCHANGED.** This feature does not touch its endpoint, schema, image, or Helm chart.                                                                     |
| Restate (durable promises + `ctx.store`)            | runtime       | Low. The parking pattern is already used by `async_webhook` and workflow-as-tool async-wait.                                                                    |
| MongoDB (`ConnectorConnection`, `AuthProfile`)      | runtime       | Low. Additive optional fields; no migration.                                                                                                                    |
| Redis (BullMQ, RateLimiterRedis, `ctx.store`)       | runtime       | Low. Same cluster as today.                                                                                                                                     |
| Azure Document Intelligence REST API                | external SaaS | Medium. New external dependency; subject to Azure-side quotas, regional availability, breaking API changes. Mitigated by per-tenant circuit breaker + cost cap. |

### 8.2 Downstream (depends on this feature)

| Consumer                            | Impact                                                                                                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow designers in Studio        | New `extract_document` capability appears in the Integration Picker when project toggle is on / Azure DI AuthProfile is bound.                                                                |
| `multimodal-processing` (ALPHA)     | **Zero impact.** Existing ingestion path runs byte-for-byte unchanged when `job.queueName === 'search-docling-extraction'`.                                                                   |
| `workflow-integration-node` (ALPHA) | This feature is the first major use of the integration node's `connector_action` step with a long-running parked variant. Extends `IntegrationNodeConfigSchema.timeout` max from 300 to 1800. |
| `connectors` platform (BETA)        | Two new registered connectors; first from-scratch AP-format piece in the repo; new auth adapter pattern (data-mapping shim).                                                                  |
| `auth-profiles` (BETA)              | Uses existing `api_key` type with `connectionConfig` for Azure DI; new synthetic no-auth profile pattern for Docling.                                                                         |
| `audit-logging` (BETA)              | Emits per-extraction audit events using the existing envelope.                                                                                                                                |

---

## 9. Open Questions & Decisions Needed

1. ~~Workflow-engine `requireProjectPermission` middleware (GAP-011)~~ — **resolved in §6.1**. v1 ships with `requireTenantProject()`-only scoping. RBAC permission strings (`integrations:read|write`) are reserved for v2. GAP-011 in the feature spec remains the canonical follow-up tracker.
2. ~~**DNS-pinning wiring (HLD-resolved).**~~ Static URL analysis lives in `assertUrlSafeForSSRF` (`ssrf-validator.ts:454`); DNS pinning lives in `safeFetch` (`safe-fetch.ts:2-6,138-146`). **Resolved during implementation:** verified that both the worker streaming helper and ADI piece use `safeFetch`.
3. ~~**Cost-cap UX placement (Feature spec OQ-1).**~~ **Resolved:** Project Settings → Integrations tab (implemented).
4. ~~**Region selection for Azure DI (Feature spec OQ-2).**~~ **Resolved:** free-form `endpoint` field (implemented as HLD recommended).
5. ~~**Output schema versioning policy (Feature spec OQ-3).**~~ **Resolved:** pin-and-migrate (implemented; `schemaVersion: 1` is mandatory).
6. ~~**Docling on XLSX (Feature spec OQ-4).**~~ **Resolved:** fails with `UNSUPPORTED_CONTENT_TYPE` as HLD recommended.
7. **GA criteria — minimum tenants and extraction count for beta-to-GA promotion.** HLD recommendation stands: >= 3 internal tenants and >= 100 successful extractions over 5 business days without P0/P1. Not yet gated (still in BETA).
8. ~~**Audit-event scope for failed pre-enqueue rejections (Feature spec OQ-7).**~~ **Resolved:** audit-all implemented for security-event traceability.
9. ~~**Azure DI usage-counter persistence under connection delete + recreate.**~~ Added to feature spec as GAP-014 (subsequently superseded by GAP-014's Restate bug closure). Usage-counter-reset-on-delete remains an accepted Low-severity gap; v2 migration path documented.

---

## 9.1 Post-Implementation Notes (2026-05-20)

**Restate 1.6.2 re-dispatch bug was the root cause requiring relay-race refactor.**
The original HLD designed around Restate `workflow.run` handlers with durable promises (`sys:callback:${stepId}`, `sys:approval:${stepId}`, `sys:human_task:${stepId}`). In testing, Restate 1.6.2 server did not reliably re-dispatch a suspended workflow `run` after a `workflow.shared` handler resolved a durable promise. Once Restate suspended a handler (after `inactivity_timeout` of idle), subsequent resolutions succeeded at the Restate level but did not wake the suspended invocation. Workflows stayed stuck at `waiting_callback` / `waiting_approval` / `waiting_human_task` forever.

**Relay-race refactor replaced the entire suspension model:**

- `workflow-executor` Restate object (formerly `workflow-leg-runner`) with `runWorkflow` and `cancelWorkflow` handlers
- Every execution slice runs as a short-lived exclusive `restate.object()` handler
- Async wait sites write `{ parkPoint: true, nextStepIds, callbackSecret }` to MongoDB and return cleanly
- Callback routes read `parkPoint` and dispatch the next relay via `startWorkflow()`
- No Restate journal dependency for suspension

**`relayStartWorkflow` wrapper covers all 6 trigger paths:**
TriggerEngine, TriggerScheduler, ConnectorTriggerEngine, webhook router, polling worker, connector webhook router. All trigger paths now go through `relayStartWorkflow()`.

**Terminology cleanup:**

- `executeLeg` -> `executeWorkflow`, `WorkflowLegInput` -> `WorkflowRunInput`
- `runCounter` tracks relay iterations per execution
- `startLegacyWorkflow` / `cancelLegacyWorkflow` preserved for backward compat
- `RELAY_RACE_DISABLED=true` env var restores legacy path for emergency rollback

---

## 10. References

- **Feature spec:** [`docs/features/document-extraction-integrations.md`](../features/document-extraction-integrations.md)
- **Test spec:** [`docs/testing/document-extraction-integrations.md`](../testing/document-extraction-integrations.md)
- **HLD oracle + audit log:** [`docs/sdlc-logs/document-extraction-integrations/hld.log.md`](../sdlc-logs/document-extraction-integrations/hld.log.md)
- **Related HLDs:**
  - [`workflow-integration-node.hld.md`](workflow-integration-node.hld.md) — Integration Node base (ALPHA); this feature extends `IntegrationNodeConfigSchema.timeout`.
  - [`workflow-http-tool-async-completion.hld.md`](workflow-http-tool-async-completion.hld.md) — Async-wait pattern (IMPLEMENTED); mirror for the `connector_action` async-parking extension.
  - [`connectors.hld.md`](connectors.hld.md) — Connector platform (BETA).
  - [`integration-auth-profiles.hld.md`](integration-auth-profiles.hld.md) — `AuthProfile` integration with connectors.
- **Source plan:** `/Desktop/docling-azure-di-integration-plan.md` (2026-05-14, 1008 lines) — to be vendored at LLD as `docs/plans/document-extraction-integrations.source-plan.md`.
- **Verified code anchors** (from feature spec §18, re-verified 2026-05-15):
  - `apps/workflow-engine/src/handlers/workflow-handler.ts:2833-2931` — HMAC secret generation + parking pattern
  - `apps/workflow-engine/src/handlers/step-dispatcher.ts:185-241` — connector_action + tool_call async_wait
  - `apps/workflow-engine/src/executors/connector-action-executor.ts:66-88` — current synchronous executor
  - `apps/workflow-engine/src/executors/async-webhook-executor.ts:1-89` — async-webhook executor (pattern reference)
  - `apps/workflow-engine/src/routes/workflow-callbacks.ts:54-141` — mandatory HMAC + replay-window verify
  - `apps/workflow-engine/src/services/restate-endpoint.ts:90-100` — `handleResolveCallback`
  - `apps/workflow-engine/src/handlers/canvas-to-steps.ts:69,976-987` — integration → connector_action mapping
  - `apps/search-ai/src/workers/docling-extraction-worker.ts:153,585-587,659-660` — existing worker, timeout calculator
  - `apps/search-ai/src/server.ts:548` — `INGESTION_MAX_CONCURRENT_JOBS`
  - `packages/search-ai-sdk/src/constants.ts:11` — `QUEUE_DOCLING_EXTRACTION = 'search-docling-extraction'`
  - `packages/shared/src/types/workflow-schemas.ts:31,162-169,307`
  - `packages/shared/src/validation/auth-profile.schema.ts:168-175,267` — `ApiKeyConfigSchema` + `connectionConfig` escape hatch
  - `packages/shared-kernel/src/security/ssrf-validator.ts:402,454` — `validateUrlForSSRF`, `assertUrlSafeForSSRF`
  - `packages/shared-kernel/src/security/safe-fetch.ts:158`
  - `packages/shared/src/services/mcp-auth-resolver.ts:248-276` — existing `RateLimiterRedis` pattern
  - `packages/connectors/src/loader.ts:42-83,111-116` — `PIECE_PACKAGES`, auth-adapter branches
  - `packages/connectors/src/adapters/activepieces/auth-adapters/jira-cloud.ts`, `servicenow.ts` — shim templates
  - `packages/connectors/piece-shopify/` — template piece layout for the new Azure DI piece
- **Policy / audit references:**
  - [`docs/audit/tenant-isolation-review-2026-03-18.md:490`](../audit/tenant-isolation-review-2026-03-18.md) — AF-105 noisy-neighbor (closed by FR-11)
  - [`docs/2026-03-25-architecture-fitness-remediation-backlog.md`](../2026-03-25-architecture-fitness-remediation-backlog.md)
  - `CLAUDE.md` — core invariants (tenant isolation, centralized auth, stateless runtime, traceability, compliance)
  - [`docs/sdlc/pipeline.md`](../sdlc/pipeline.md) — SDLC phase order, audit minimums
