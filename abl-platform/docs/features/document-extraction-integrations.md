# Feature: Document Extraction Integrations (Docling + Azure Document Intelligence)

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `integrations`, `observability`, `enterprise`, `admin operations` (workflow-only; explicitly not `agent lifecycle`)
**Package(s)**: `apps/workflow-engine`, `apps/search-ai`, `apps/studio`, `packages/connectors`, `packages/connectors/piece-azure-document-intelligence` (new), `packages/shared`, `packages/shared-auth-profile`, `packages/search-ai-sdk`
**Owner(s)**: Workflows + Platform Eng
**Testing Guide**: [docs/testing/document-extraction-integrations.md](../testing/document-extraction-integrations.md)
**Source design plan**: `/Desktop/docling-azure-di-integration-plan.md` (1008-line plan, 2026-05-14)
**Target branch**: `feature/wf/ocrnode`
**Last Updated**: 2026-05-21

---

## 1. Introduction / Overview

### Problem Statement

Workflow designers in Studio cannot extract structured content from documents inside a workflow today. The platform has two production-grade extraction capabilities — the `docling-service` Python pipeline (used by SearchAI for knowledge-base ingestion via `multimodal-processing` ALPHA) and zero coverage for external SaaS extraction (Azure Document Intelligence, AWS Textract, etc.). Both are invisible to the workflow engine. Designers who need to read a PDF, DOCX, PPTX, HTML, or image as part of a workflow have to either (a) hand off to SearchAI's ingestion pipeline (wrong tool — that pipeline writes to Mongo/S3, fans out to embedding/indexing, and assumes the document is destined for the search index), or (b) write a custom tool. There is also a long-standing `doc_intelligence` `NodeType` stub in `packages/shared/src/types/workflow-schemas.ts:31` and `STUB_NODE_TYPES` in `packages/shared-kernel/src/types/workflow-types.ts:44-47` that was reserved for this purpose but never wired to an executor.

### Goal Statement

Ship two `extract_document` workflow-engine integrations behind a single normalized output envelope so workflow designers can read documents (PDF / DOCX / PPTX / HTML / images / XLSX-for-Azure) inline as a step. **Docling** handles internal layout-aware extraction (PDFs with tables, screenshots, per-page markdown) and routes through SearchAI's existing BullMQ worker via a new dedicated queue, parking the workflow via Restate `async_webhook` so the engine never holds an open `await` during long extractions. **Azure Document Intelligence** handles external SaaS extraction (XLSX, prebuilt models, 500 MB / 2000-page inputs) and is implemented as the first from-scratch Activepieces-format piece in the repo, calling Azure REST directly with `ctx.store`-backed Restate-replay safety to avoid duplicate Azure invoices. Both integrations expose an identical parameter shape and an identical output envelope so workflows can swap providers without changing downstream nodes.

### Summary

The feature adds two providers behind a single `extract_document` action exposed via the existing workflow Integration Node (`integration` canvas node → `connector_action` engine step). Workflows pass a public `fileUrl` and optional flags (`extractImages`, `extractTables`, `ocrEnabled`, `language`, `model`, `timeout`) and receive a normalized envelope (`{ schemaVersion, provider, sourceUrl, contentType, markdown, pages[], metadata, raw? }`). **Docling** appears in the Integration Picker only when a project flips on the per-project Docling toggle (Studio → Project Settings → Integrations), which upserts a `ConnectorConnection` bound to a synthetic no-auth `AuthProfile`. The action body validates the URL (SSRF + HEAD probe + per-tenant rate limit), enqueues an `extraction-only` job onto the new `workflow-docling-extraction` BullMQ queue inside `ctx.run`, then parks the workflow on a Restate durable promise on `sys:callback:${stepId}`. The shared search-AI worker process subscribes to both `search-docling-extraction` (existing, ingestion) and `workflow-docling-extraction` (new, workflow-only) with reserved per-queue concurrency (default 3 + 2 = 5 per pod, env-configurable; same total as today's `INGESTION_MAX_CONCURRENT_JOBS` default). The shared processor branches on which queue dequeued the job and the workflow branch streams the URL into Docling's existing `/extract` endpoint (UNCHANGED) and POSTs the result back to `/api/v1/workflows/callbacks/:executionId/:stepId` with the mandatory HMAC signature already used by every other `async_webhook` step. **Azure DI** is authored as `@abl/piece-azure-document-intelligence`, declares its auth via `PieceAuth.CustomAuth({ endpoint, apiKey, apiVersion?, defaultModel? })`, bridges to the platform AuthProfile via a new shim at `packages/connectors/src/adapters/activepieces/auth-adapters/azure-document-intelligence.ts` (same pattern as `jira-cloud.ts` / `servicenow.ts`), and inside `run()` issues a direct POST to Azure's `:analyze` endpoint, stashes the `Operation-Location` in `ctx.store` keyed on `(executionId, stepId)` with a 24 h TTL, polls with exponential backoff honoring `Retry-After`, and cleans up the store key on terminal state. The Docling Python service is **untouched**; SearchAI's HTTP API and existing ingestion path are **untouched**. The platform-wide AuthProfile schema is **untouched** — Azure-specific config lives inside the AP CustomAuth definition and is bridged via the shim.

---

## 2. Scope

### Goals

1. Expose `extract_document` as a workflow Integration Node action for two providers behind a single normalized envelope so workflows can swap providers without rewiring.
2. Reuse SearchAI's existing Docling worker for the workflow path; do not add a new pod / Deployment / HPA / Helm chart.
3. Add a new dedicated BullMQ queue `workflow-docling-extraction` and have the existing worker process subscribe to it with **env-configurable reserved per-queue concurrency** (defaults 3 ingestion + 2 workflow = 5 per pod) so workflow and ingestion cannot starve each other.
4. Park long-running Docling extractions via the existing Restate `async_webhook` primitive so engine pod memory does not grow with concurrent extractions and engine restarts resume cleanly from the journal.
5. Ship Azure DI as the first from-scratch Activepieces-format piece (`@abl/piece-azure-document-intelligence`), reusing the existing AP runtime adapter (`mapProperty`, `translateActionContext`, `wrapStore`) so Studio's `DynamicActionForm` and Integration Picker auto-render with no Studio code changes.
6. Reuse the existing platform infrastructure end-to-end: `ConnectorRegistry`, `ConnectionResolver`, `ConnectionService`, `AuthProfile` (with `api_key` + `connectionConfig`), `tenant-encryption-facade`, `assertUrlSafeForSSRF`, `RateLimiterRedis` (`rate-limiter-flexible`), the workflow callback route with mandatory HMAC. **No new platform abstractions.**
7. Provide a project-level on/off toggle for Docling that is **off by default** so the new SSRF surface + GPU-cost vector is opt-in.
8. Enforce per-tenant fairness via a `RateLimiterRedis` token bucket keyed `workflow:docling:${tenantId}` (default 10/min sustained + 5 burst) at the workflow step body, closing the noisy-neighbor gap flagged in `docs/audit/tenant-isolation-review-2026-03-18.md:490` and AF-105.
9. Track per-project Azure DI usage on the existing `ConnectorConnection` document with atomic `$inc` and month-boundary reset; surface a soft cap (default 1000 extractions / month) and a configurable hard cap with `QUOTA_EXCEEDED` rejection.

### Non-Goals (Out of Scope)

1. No file-upload variant — input is **always a public URL** in v1.
2. No new Azure DI custom or prebuilt domain-specific models (invoices, receipts, IDs) — limited to `prebuilt-read`, `prebuilt-layout` (default), `prebuilt-document`.
3. No generic `Documents` MongoDB collection for extraction artifacts — workflows hold output in step state.
4. No changes to the **agent / DSL** execution path — this is workflow-engine-only.
5. No CSV / JSON / XML extraction route — those file types remain on their existing search-AI routes.
6. **No changes to the Docling Python service** — endpoint, schema, container image, Helm chart all untouched.
7. **No changes to SearchAI's HTTP API, MongoDB models, pipeline orchestration, downstream stages, or existing enqueue path** — only the worker file gains one new `new Worker(...)` subscription and the processor function gains a top-level conditional. The `full-ingestion` branch is byte-for-byte identical to today's behavior when invoked.
8. **No platform-wide `AuthProfileSchema` changes** — Azure-specific config lives inside the AP CustomAuth definition.
9. No large-envelope support (>50 MB serialized) — `EXTRACTION_TOO_LARGE` typed error directs users to SearchAI's bulk pipeline.
10. No live usage UI (counter bars, polling endpoints) — only a single static line on the Docling card displaying the configured rate limit; cost-cap status surfaces at 80% / 100% only.
11. No per-tenant or per-project Azure DI rate-limit configurability beyond the existing in-process token bucket protecting Azure's subscription quota.
12. No repurposing or removal of the orphan `doc_intelligence` `NodeType` — it remains a stub/hidden node in v1; this feature routes through `integration` node type instead.

---

## 3. User Stories

1. **US-1 — Workspace admin enables Docling for a project.** As a workspace admin, I want to flip a single toggle in Studio → Project Settings → Integrations so that workflow designers in this project can use Docling extraction without touching credentials or shared infrastructure, with the rate limit clearly displayed up front. **Acceptance**: toggle off by default; toggling on calls `POST /api/projects/:projectId/integrations/docling/enable` which idempotently upserts a `ConnectorConnection` bound to a synthetic no-auth `AuthProfile`; the integration appears in the workflow Integration Picker on the next page load; toggling off deletes the `ConnectorConnection` and gates new workflow runs with `INTEGRATION_DISABLED`.
2. **US-2 — Workspace admin onboards Azure Document Intelligence with their own subscription.** As a workspace admin, I want to register an Azure DI subscription via Studio → Auth Profiles → New Profile → Azure Document Intelligence and have **Test Connection** validate the credential before saving, so that workflow designers in tenants with Azure DI subscriptions can use it. **Acceptance**: the form auto-renders from the AP piece's `PieceAuth.CustomAuth` `props` (endpoint, apiKey, apiVersion?, defaultModel?) via the existing `mapProperty` path in `runtime-adapter.ts` (no Studio code changes); Test Connection invokes the piece's `validate` callback which hits Azure's `/info` endpoint and returns `200 OK` with valid metadata; secrets are encrypted at rest via `tenant-encryption-facade`; the `ConnectorConnection` is auto-created on save.
3. **US-3 — Workflow designer extracts a PDF in a workflow.** As a workflow designer, I want to drop an Integration Node, pick Docling → Extract Document, map `fileUrl` from a prior step, and connect the output to a downstream LLM summarization node, so that the workflow processes documents inline. **Acceptance**: the Integration Picker only shows Docling for projects with the toggle on and Azure DI for projects with an AuthProfile bound; the action returns the normalized envelope (`{ provider, markdown, pages[], metadata, ... }`); both providers return identical envelope shapes for the same PDF (page count matches; markdown length within 10%).
4. **US-4 — Workflow designer recovers gracefully from extraction failures.** As a workflow designer, when extraction fails (SSRF blocked, unsupported content type, rate limited, file too large, Azure 429, extraction timeout, oversized envelope), I want a typed error in the trace event with an actionable message so I can fix the workflow or escalate. **Acceptance**: trace events surface `SSRF_BLOCKED`, `UNSUPPORTED_CONTENT_TYPE`, `RATE_LIMITED` (with the configured limit value as static text), `EXTRACTION_TOO_LARGE` (with `sizeBytes`/`limitBytes`), `EXTRACTION_TIMEOUT`, `EXTRACTION_FAILED`, `INTEGRATION_DISABLED`, `QUOTA_EXCEEDED`. None of the typed errors expose Docling internal URLs, Azure subscription keys, or raw HTTP bodies.
5. **US-5 — End-user runs a public-facing workflow without leaking internal infrastructure.** As an end-user invoking a tenant-public workflow that performs document extraction, I want my request to succeed if the URL is fetchable from the public internet and fail-fast with a clean error if the URL points to private/loopback/metadata IPs, so that my workflows are reliable and the platform stays safe. **Acceptance**: the URL is validated against `assertUrlSafeForSSRF` (scheme allowlist + DNS-resolve-then-connect-by-IP + redirect re-validation + cloud-metadata blocklist) both **pre-enqueue** in the workflow step body and **at the worker** (defense in depth across the Redis hop); rejections return `SSRF_BLOCKED` before any BullMQ job is enqueued or any Azure call is made.
6. **US-6 — Platform operator monitors queue health, rate-limit rejections, and Azure DI cost.** As a platform operator, I want per-queue depth + active-job counters, per-tenant rate-limit rejection counts, callback POST delivery failure counts, and per-project Azure DI usage so I can scale HPA, triage abusive tenants, and forecast cost. **Acceptance**: Grafana dashboard emits `bullmq_queue_depth{queue}` for both queues, `worker_active_jobs{queue}` per pod, `workflow_docling_wait_duration_seconds{tenant, status}`, `workflow_docling_errors_total{tenant, error_class}`, `workflow_docling_parked_promises_gauge{tenant}`, `workflow_docling_callback_post_attempts_total{tenant, attempt}`, `workflow_docling_callback_post_failures_total{tenant, error_class}`, `workflow_docling_rate_limited_total{tenant}`, `workflow_extraction_too_large_total{provider, tenantId}`; alerts on queue depth >200 (ingestion) / >50 (workflow) for 10 minutes, rate-limit rejection >1 % per tenant for 10 minutes, callback POST failure rate >0.1 %, and Azure DI cost-cap 80 % per project.
7. **US-7 — Tenant billing admin reviews Azure DI usage and cost-cap.** As a tenant billing admin, I want a per-project usage view (current count + soft cap + hard cap) and an in-product warning when usage exceeds 80 % of the cap so I can plan budget or raise the cap. **Acceptance**: `GET /api/projects/:projectId/integrations/azure-document-intelligence/usage` returns `{ usageCount, usagePeriodStart, usageSoftCap, usageHardCap }`; Studio Project Settings → Usage renders the values; subsequent `extract_document` calls return `QUOTA_EXCEEDED` once `usageHardCap` is reached; counter resets atomically at the month boundary on next increment.

---

## 4. Functional Requirements

1. **FR-1**: The system must register two new connectors in `ConnectorRegistry` — a native Docling connector (`docling`, `auth.type === 'none'`) eagerly registered alongside the existing HTTP connector in `packages/connectors/src/loader.ts`, and an Activepieces-format Azure DI piece (`azure-document-intelligence`, `@abl/piece-azure-document-intelligence`) registered as a lazy entry in `PIECE_PACKAGES`. Both expose a single `extract_document` action.
2. **FR-2**: The system must surface both connectors in Studio's workflow Integration Picker only when the project has an active `ConnectorConnection` for them: Docling appears only when the project toggle is on; Azure DI appears only when a tenant- or project-scoped AuthProfile of type `api_key` for `azure-document-intelligence` is bound.
3. **FR-3**: The system must expose a project-level Docling toggle via three endpoints under `/api/projects/:projectId/integrations/docling/{enable,disable,quota}`. `enable` is idempotent and upserts a `ConnectorConnection` bound to a synthetic no-auth `AuthProfile`. `disable` deletes the `ConnectorConnection` so subsequent workflow runs gate with `INTEGRATION_DISABLED`. `quota` returns `{ limitPerMinute, burst, scope: 'workspace' }`.
4. **FR-4**: The system must accept the same parameter schema for both providers' `extract_document` action: `fileUrl` (required, string URL), `pages` (optional, string range expression like `"1-5"` or `"1,3,7"`; both providers honor it where supported — Azure DI passes it through `:analyze`'s `pages` parameter, Docling subsets the response post-extraction), `extractImages` (optional bool, default `true`), `extractTables` (optional bool, default `true`), `ocrEnabled` (optional bool, default `true`), `language` (optional ISO-639-1 string), `model` (optional dropdown, Azure DI only — `prebuilt-read` / `prebuilt-layout` / `prebuilt-document`, default `prebuilt-layout`), `timeout` (optional number, 5-1800 seconds, default 60).
5. **FR-5**: The system must return the same normalized output envelope from both providers: `{ schemaVersion: 1, provider: 'docling' | 'azure-document-intelligence', sourceUrl, contentType, markdown, pages: [{ pageNumber, text, tables: [{rows, markdown, bbox}], images: [{format, base64, bbox}], headings: [{level, text}] }], metadata: { pageCount, language, languageConfidence, hasOCR, title, author, processingTimeMs }, raw? }`. Schema version is `1`; adding fields is additive; renaming/removing fields is a breaking change requiring a schema-version bump.
6. **FR-6**: The system must extend `IntegrationNodeConfigSchema.timeout` in `packages/shared/src/types/workflow-schemas.ts` from `min(5).max(300).default(60)` to `min(5).max(1800).default(60)`. The change is backward compatible (wider max, same default); workflows authored with the prior `300` cap continue to validate.
7. **FR-7**: The system must add a new BullMQ queue constant `QUEUE_WORKFLOW_DOCLING_EXTRACTION = 'workflow-docling-extraction'` to `packages/search-ai-sdk/src/constants.ts` and a corresponding `getWorkflowDoclingExtractionQueue()` factory in `apps/search-ai/src/queues/queue-factory.ts` using the same Redis cluster and `{bull}` prefix as today.
8. **FR-8**: The system must add a second `new Worker(...)` subscription in `apps/search-ai/src/workers/docling-extraction-worker.ts` on the new queue, sharing the same processor function. The existing Worker's `concurrency` defaults to **3** and the new Worker's concurrency defaults to **2** (sum = 5 per pod = today's `INGESTION_MAX_CONCURRENT_JOBS` default). Both defaults must be env-overridable via `DOCLING_INGESTION_CONCURRENCY` and `DOCLING_WORKFLOW_CONCURRENCY` with a runtime assertion that their sum does not exceed `INGESTION_MAX_CONCURRENT_JOBS`.
9. **FR-9**: The system must branch the worker processor on `job.queueName === 'workflow-docling-extraction'` (or `job.data.mode === 'extraction-only'` for observability/compat). The new branch must (a) re-validate SSRF on the URL, (b) stream the URL into Docling's existing `/extract` multipart endpoint via a new streaming helper (the existing `downloadDocument()` at `apps/search-ai/src/workers/docling-extraction-worker.ts:153` buffers to memory and must NOT be used), (c) normalize the Docling-native response into the shared envelope, (d) check the serialized envelope size against the configured inline cap (default 50 MB), and (e) POST the result back to `${WORKFLOW_ENGINE_URL}/api/v1/workflows/callbacks/:executionId/:stepId` with mandatory HMAC headers (`x-callback-signature`, `x-callback-timestamp`) using the per-step HMAC secret carried in the BullMQ job payload. The existing `full-ingestion` branch must run byte-for-byte unchanged when `job.queueName === 'search-docling-extraction'`.
10. **FR-10**: The system must extend the BullMQ job payload type with optional `mode` (`'full-ingestion' | 'extraction-only'`), `options` (extraction parameter bag), `callbackId` (string), `callbackUrl` (string), and `callbackSecret` (string, plaintext HMAC secret; Redis treated as trusted internal store). All optional; the existing `full-ingestion` producer omits them and the worker's existing branch ignores them.
11. **FR-11**: The system must implement the Docling workflow step body inside `ctx.run` (durable side-effect, journaled at most once) performing: (1) param resolution; (2) `assertUrlSafeForSSRF`; (3) HEAD probe (reject early on unsupported content type or oversized payload, default 100 MB; hard cap 500 MB); (4) per-tenant `RateLimiterRedis` consume — key is `workflow:docling:${tenantId}` (**tenant-scoped, not project-scoped, for v1 by deliberate decision per oracle D-U3 / Open Question #6**), default 10/min sustained + 5 burst; (5) HMAC-secret generation (encrypted into the job payload); (6) enqueue with `attempts: 1` (workflow engine owns retries per node); (7) park on `restateCtx.promise<unknown>(`sys:callback:${stepId}`).get()` wrapped in `raceCancel(raceTimeout(callbackTimeoutMs))` — same pattern as `apps/workflow-engine/src/handlers/workflow-handler.ts:2921-2931`.
12. **FR-12**: The system must reuse the existing workflow callback route at `POST /api/v1/workflows/callbacks/:executionId/:stepId` (`apps/workflow-engine/src/routes/workflow-callbacks.ts`) which mandates HMAC signature verification via `verifyWebhookSignature()`. The Docling worker callback POST must include the `x-callback-signature` and `x-callback-timestamp` headers, signed with the per-step HMAC secret retrieved from the BullMQ job payload. The callback route resolves the parked promise via `handleResolveCallback` (`apps/workflow-engine/src/services/restate-endpoint.ts:90-100`).
13. **FR-13**: The system must implement Azure DI as a from-scratch AP piece package at `packages/connectors/piece-azure-document-intelligence/` exporting `@abl/piece-azure-document-intelligence` with `createPiece({ displayName: 'Azure Document Intelligence', logoUrl, auth, actions: [extractDocumentAction] })`, `PieceAuth.CustomAuth({ props: { endpoint, apiKey: SecretText, apiVersion?, defaultModel?: StaticDropdown }, validate: async ({ auth }) => GET /info })`, and a single `createAction({ name: 'extract_document', auth, props, run })`. No new platform-wide AuthProfile schema fields.
14. **FR-14**: The system must add a new auth-adapter shim at `packages/connectors/src/adapters/activepieces/auth-adapters/azure-document-intelligence.ts` that bridges the resolved platform `AuthProfile` (`api_key` type with `apiKey` in `secrets` and `endpoint` / `apiVersion` / `defaultModel` in `connectionConfig`) to the AP `CustomAuth` shape consumed by the piece's `run()`. **The shim is a pure data-mapping function — NOT a `require.cache` monkey-patch.** The existing `jira-cloud.ts` and `servicenow.ts` shims are runtime monkey-patches that intercept third-party AP package exports at load time; Azure DI is a from-scratch in-repo piece with no third-party module to patch. The Azure DI shim wires through the existing `connectionConfig` bridging point in `packages/connectors/src/adapters/activepieces/context-translator.ts:211-290`.
15. **FR-15**: The system must short-circuit the connection resolver for `auth.type === 'none'` so the Docling connector resolves without an authenticated principal lookup, and auto-bind a system-managed synthetic `AuthProfile` for the Docling connector on project enable (idempotent; harmless to leave behind on disable).
16. **FR-16**: The Azure DI action `run()` must achieve Restate-replay safety via `ctx.store` keyed `azuredi:${executionId}:${stepId}` with a 24 h TTL. First execution stashes the `Operation-Location` after the `:analyze` 202 response; replay reads the key and resumes polling the existing Azure operation rather than re-POSTing. Key is deleted on success or terminal failure.
17. **FR-17**: The Azure DI action `run()` must enforce: (a) SSRF + HEAD validation pre-submit, **with a dedicated HEAD-probe timeout of 10 seconds** independent of the extraction timeout (per FR-11 step 3); (b) per-tenant in-process token-bucket rate limit using `RateLimiterMemory` from `rate-limiter-flexible` (already a dependency; reuses the API surface of the `RateLimiterRedis` Docling limiter); (c) per-tenant in-process circuit breaker (5 consecutive 5xx in 30 s opens it; half-opens after 60 s) — **acknowledged as in-process-only for v1; state is lost on workflow-engine pod restart and not shared across multi-pod deployments. v2 migration to `@agent-platform/circuit-breaker` (Redis-backed) is documented as a follow-up**; (d) `Retry-After` honor on 429; (e) exponential poll backoff (start 2 s, max 30 s); (f) inline envelope cap (default 50 MB serialized) checked **before** returning, mirroring the Docling worker's check.
18. **FR-18**: The system must track per-project Azure DI usage on the existing `ConnectorConnection` document with atomic `$inc`, adding fields `usageCount`, `usagePeriodStart`, `usageSoftCap` (default 1000), `usageHardCap` (default `null` = soft only). Monthly reset is performed at increment time when `usagePeriodStart` falls in a previous month, using a **conditional `findOneAndUpdate`** (atomic CAS) of the shape `{ usagePeriodStart: { $lt: currentMonthStart } }` → `{ $set: { usageCount: 1, usagePeriodStart: currentMonthStart } }` so concurrent month-boundary writes converge to exactly-one-reset. Surface `GET /api/projects/:projectId/integrations/azure-document-intelligence/usage` returning the current values; reject `extract_document` calls with `QUOTA_EXCEEDED` when `usageHardCap` is reached.
19. **FR-19**: The system must emit a `TraceEvent` per extraction via the shared `TraceStore` carrying `provider`, `pageCount`, `processingTimeMs`, `executionId`, `traceId`, and (Docling) the BullMQ `jobId`. Trace events must surface typed error codes (`SSRF_BLOCKED`, `UNSUPPORTED_CONTENT_TYPE`, `RATE_LIMITED`, `EXTRACTION_TOO_LARGE`, `EXTRACTION_TIMEOUT`, `EXTRACTION_FAILED`, `INTEGRATION_DISABLED`, `QUOTA_EXCEEDED`, `INTEGRATION_UNAVAILABLE`, `CALLBACK_NOT_FOUND`) without exposing internal URLs, subscription keys, or raw HTTP bodies. `RATE_LIMITED` event renders the configured limit value as static text — no live usage query.
20. **FR-20**: The system must emit an audit log event `{ actor, tenantId, projectId, connector, action, sourceUrl(hostOnly), sizeBytes, durationMs, status }` per extraction. Workflow-initiated Docling extractions and all Azure DI calls are audited; SearchAI's full-ingestion audit path is unchanged.
21. **FR-21**: The system must regenerate `packages/connectors/src/generated/connector-catalog.json` via `pnpm connectors:generate-catalog` so both connectors appear with their action and parameter schemas. The catalog regeneration must be committed in the same change set that adds the connectors.
22. **FR-22**: The system must gate the entire feature behind `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED` (env var; default `false` in production until Phase 5 beta passes) so the connectors are hidden from the catalog, the workflow step type rejects the connector ids, and the project toggle API returns `FEATURE_DISABLED` when the flag is off.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                                                                  |
| -------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | New per-project Docling toggle + per-project Azure DI cost counter on `ConnectorConnection`.                                           |
| Agent lifecycle            | NONE         | Workflow-engine only. The agent / DSL execution path is explicitly out of scope (non-goal #4).                                         |
| Customer experience        | NONE         | No direct end-user surface. Workflows consume; end-users see workflow output.                                                          |
| Integrations / channels    | PRIMARY      | Two new connectors; first from-scratch AP-format piece in the repo; new auth adapter; queue topology addition.                         |
| Observability / tracing    | PRIMARY      | New trace events, new metrics per queue / tenant, new Grafana dashboard, new alerts.                                                   |
| Governance / controls      | SECONDARY    | Per-tenant rate limit closes AF-105; per-project cost cap; project toggle gating.                                                      |
| Enterprise / compliance    | SECONDARY    | Azure DI subscription is BYO; credentials encrypted at rest via existing facade; PII redaction reuses existing pipeline.               |
| Admin / operator workflows | PRIMARY      | Operator runbook for queue depth, callback delivery, rate-limit rejection; admin onboarding for Azure DI AuthProfile + Docling toggle. |

### Related Feature Integration Matrix

| Related Feature                                                                               | Relationship Type          | Why It Matters                                                                                                                           | Key Touchpoints                                                                                                                                                                                                | Current State |
| --------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| [`workflow-integration-node`](workflow-integration-node.md)                                   | extends                    | This feature is the first major use of the integration node's `connector_action` step with a long-running parked variant.                | Routes through `integration` canvas node → `connector_action` step; extends `IntegrationNodeConfigSchema.timeout` max from 300 s to 1800 s; gates connector visibility in the picker on `ConnectorConnection`. | ALPHA         |
| [`connectors`](connectors.md)                                                                 | depends on, extends        | Provides registry, lazy AP loader, connection resolver, auth profile resolver factory, AP runtime adapter, catalog generation.           | `ConnectorRegistry.register` + `registerLazy`; `PIECE_PACKAGES` array; `auth-adapters/`; `runtime-adapter.ts`; `connector-catalog.json`; new no-auth resolution short-circuit.                                 | BETA          |
| [`auth-profiles`](auth-profiles.md)                                                           | depends on                 | Encrypts Azure DI credentials at rest with tenant-scoped DEK; bridges to AP CustomAuth via the new auth-adapter shim.                    | Uses existing `api_key` auth type with `connectionConfig` for `endpoint` / `apiVersion` / `defaultModel`; no platform-wide schema change.                                                                      | BETA          |
| [`multimodal-processing`](multimodal-processing.md)                                           | shares infrastructure with | Both features call the same Docling Python service and share the search-AI worker process / pods. Two-queue topology enforces isolation. | Shared Docling service at port 8080 (UNCHANGED); shared `docling-extraction-worker.ts` (additive branch only); shared BullMQ Redis cluster; new dedicated queue `workflow-docling-extraction`.                 | ALPHA         |
| [`audit-logging`](audit-logging.md)                                                           | emits into                 | Every extraction emits an audit event.                                                                                                   | Reuses `{actor, tenantId, projectId, connector, action, sourceUrl(hostOnly), sizeBytes, durationMs, status}` envelope.                                                                                         | BETA          |
| [`encryption-at-rest`](encryption-at-rest.md)                                                 | depends on                 | Azure DI API keys encrypted via `tenant-encryption-facade`.                                                                              | `TenantEncryptionFacade.encrypt/decrypt` via the existing `auth-profile-resolver-factory.ts`.                                                                                                                  | STABLE        |
| [`rate-limiting`](rate-limiting.md) — if exists; otherwise reuses `mcp-auth-resolver` pattern | depends on                 | Per-tenant Docling rate limit closes AF-105.                                                                                             | `RateLimiterRedis` from `rate-limiter-flexible` (already in use at `packages/shared/src/services/mcp-auth-resolver.ts:248-276`).                                                                               | n/a           |

---

## 6. Design Considerations

- The Docling card in Studio → Project Settings → Integrations displays a single **static** line: `"Rate limit: 10 extractions per minute (workspace-wide)"` loaded once at page load from `GET /api/projects/:projectId/integrations/docling/quota`. No live counters, no polling, no usage bars in v1.
- The workflow trace event for `RATE_LIMITED` renders the configured limit value as static text — `"Workspace rate limit: 10 extractions/min — try again shortly."` — from config; no live usage query.
- The Integration Picker shows the existing connector tile UI. Both connectors get distinct logos and category mapping (suggested: `category: 'document-intelligence'`).
- The Azure DI AuthProfile form auto-renders via the existing `DynamicActionForm` → `mapProperty` path in `runtime-adapter.ts`. No new Studio form code. **Test Connection** runs the piece's `validate` callback hitting Azure `/info`.
- For accessibility, the toggle on the integrations card follows the existing design-system `Switch` component used elsewhere in Project Settings (referenced in `apps/studio/CLAUDE.md`).

---

## 7. Technical Considerations

- **The Docling Python service is not modified.** No new endpoints, no schema changes, no Helm changes, no Dockerfile changes.
- **SearchAI's HTTP API, MongoDB models, pipeline orchestration, and existing enqueue path are not modified.** Only `apps/search-ai/src/workers/docling-extraction-worker.ts` is modified, and additively (one new `new Worker(...)` subscription + one top-level processor branch + four optional payload fields + one streaming-URL helper).
- **The platform-wide `AuthProfile` validation schema is not modified.** Azure-specific config (`endpoint`, `apiVersion`, `defaultModel`) lives inside the AP CustomAuth definition (rendered to the form via `mapProperty`) and is bridged through the auth-adapter shim to the existing `api_key` AuthProfile (`apiKey` in `secrets`, the rest in `connectionConfig: Record<string, string>` at `packages/shared/src/validation/auth-profile.schema.ts:173`).
- **The SSRF guard is reused, not recreated.** Both the workflow step body and the worker's new branch import `assertUrlSafeForSSRF` from `@agent-platform/shared-kernel/security` (the existing utility at `packages/shared-kernel/src/security/ssrf-validator.ts`).
- **The HMAC callback secret flow is reused with a deliberate transport-shape change.** The existing `async_webhook` flow at `apps/workflow-engine/src/handlers/workflow-handler.ts:2833-2849` generates a per-step HMAC secret inside `ctx.run('gen-callback-secret', ...)`, encrypts it via `deps.encryptSecret`, persists ciphertext on the step record, and ships the **plaintext** out-of-band as an HTTP header (`x-callback-secret`) to the external webhook target; the callback route then decrypts the at-rest ciphertext and runs `verifyWebhookSignature()` (`apps/workflow-engine/src/routes/workflow-callbacks.ts:87-129`). For this feature, the "external webhook target" is the BullMQ job payload consumed by an internal search-AI worker — there is no external HTTP request to attach a header to. We therefore pass the **plaintext** HMAC secret in the BullMQ job `data` field. This is deliberate, not a regression of the existing pattern, and is safe because: (a) Redis is an internal, network-isolated store treated as trusted in the existing platform threat model (the same BullMQ Redis already carries job payloads containing tenant identifiers and resource ids); (b) the ciphertext-on-step pattern in the existing flow exists to protect the secret while the platform-engineered HTTP transport carries it externally — the threat surface is the external HTTP hop, not internal Redis; (c) the at-rest ciphertext on the workflow step record continues to be the canonical "encrypted secret" (it is the source of truth for callback verification on resume after pod restart). The worker's only role is to sign with the per-job plaintext copy. A future hardening pass may move to encrypt-in-payload + decrypt-in-worker; out of scope for v1 unless threat-modeling identifies a Redis compromise as in-scope.
- **The orphan `doc_intelligence` `NodeType` is left as-is.** It remains in `STUB_NODE_TYPES` / `HIDDEN_NODE_TYPES`. This feature routes through `integration` node → `connector_action` step. A future refactor may remove or repurpose the stub; that work is out of scope here.
- **Restate replay safety is owned by two different mechanisms.** Docling: the parked promise lives in the Restate journal, so engine restarts resume from `sys:callback:${stepId}` without re-enqueueing. Azure DI: `ctx.store` holds the `Operation-Location` for 24 h, so replay resumes polling the existing Azure operation without a second `:analyze` POST. Neither requires deterministic BullMQ jobIds.
- **The `IntegrationNodeConfigSchema.timeout` max is extended platform-wide from 300 s to 1800 s.** Backward compatible (wider max, same `default(60)`); long timeouts are cheap on the engine side because parked promises live in Restate's journal, not in pod memory.
- **Dockerfile sync rule:** the new `piece-azure-document-intelligence` package must be added to every `apps/*/Dockerfile` that runs `pnpm install --frozen-lockfile` (rule from CLAUDE.md). Two existing modified Dockerfiles are visible in the working tree (`services/docling-service/Dockerfile`, `services/preprocessing-service/Dockerfile`) and should be reviewed for unrelated drift.
- **The 13-day plan estimate is single-engineer; with pair/review, expect ~3 calendar weeks to beta.**

---

## 8. How to Consume

### Studio UI

- **Project Settings → Integrations (NEW tab)** — at route `/projects/:projectId/settings/integrations`. Contains the Docling toggle card (off by default; flipping on calls `POST /api/projects/:projectId/integrations/docling/enable`) and an info line displaying the configured rate limit. Existing Auth Profiles + Connections pages cover Azure DI registration.
- **Auth Profiles → New Profile** — selecting the `Azure Document Intelligence` tile renders a form auto-built from the AP piece's `CustomAuth.props` (endpoint, apiKey, apiVersion?, defaultModel?). Test Connection invokes the piece `validate` callback.
- **Workflow Canvas → Integration Node → Integration Picker** — both connectors appear conditionally (Docling if toggle on; Azure DI if AuthProfile bound). Selecting either opens the action list; selecting `Extract Document` renders the `DynamicActionForm` with the shared parameter schema.

### Surface Semantics Matrix

| Asset / Entity Type                     | Source of Truth / Ownership                     | Design-Time Surface(s)                                                  | Editable or Read-Only?                 | Consumer Reference / Binding Model                                                             | Runtime Materialization / Resolution                                                                                        | Notes / Unsupported State                                                                    |
| --------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `docling` connector                     | Repo (registered in `loader.ts`)                | Workflow Integration Picker (gated by project toggle); Project Settings | Read-only definition                   | Workflow step references it by `connectorId: 'docling'`                                        | Runtime: `ConnectorRegistry.get('docling')` returns the native connector; auth resolves to `{ }` for `auth.type === 'none'` | Hidden when the project toggle is off (no `ConnectorConnection`)                             |
| `azure-document-intelligence` connector | Repo (`@abl/piece-azure-document-intelligence`) | Workflow Integration Picker (gated by AuthProfile)                      | Read-only definition                   | Workflow step references it by `connectorId: 'azure-document-intelligence'` + `connectionId`   | Lazy load via `PIECE_PACKAGES`; auth-adapter bridges `AuthProfile` → AP `CustomAuth` shape                                  | Hidden when no AuthProfile of type `api_key` for this connector is bound to the project      |
| Docling `ConnectorConnection`           | Platform DB                                     | Project Settings (toggle on)                                            | Toggle on/off only; no fields editable | Workflow step resolves connection by tenant + project + `connectorName === 'docling'`          | Resolver short-circuits `auth.type === 'none'` and returns empty auth context                                               | Synthetic `AuthProfile` (hidden from the Auth Profiles list)                                 |
| Azure DI `AuthProfile` (api_key)        | Platform DB                                     | Auth Profiles                                                           | Editable                               | Workflow step uses `connectionId` → `ConnectorConnection.authProfileId` → resolved + decrypted | `auth-profile-resolver-factory.ts` decrypts `secrets.apiKey`; auth-adapter shim builds `CustomAuth` shape                   | `endpoint`, `apiVersion`, `defaultModel` stored in `connectionConfig: Record<string,string>` |

### Design-Time vs Runtime Behavior

- **Design-time:** Both connectors render in the Integration Picker / DynamicActionForm via the AP runtime-adapter's `mapProperty` path (no Studio code change). The catalog `connector-catalog.json` is regenerated at build time.
- **Runtime:** The Docling action enqueues + parks; the worker callback resolves the parked promise. The Azure DI action calls Azure directly; `ctx.store` carries the `Operation-Location` across replays. Both return the same envelope shape; downstream nodes see provider-agnostic output.
- **Author-facing vs runtime name parity:** No author-facing aliases — connector names match runtime ids 1:1 (`docling`, `azure-document-intelligence`). Action name `extract_document` is identical at design and runtime.

### API (Workflow Engine)

| Method | Path                                                                           | Purpose                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/workflows/callbacks/:executionId/:stepId`                             | **EXISTING route, reused.** Docling worker POSTs `{ callbackId, status: 'success' \| 'failed', envelope?, error? }` with mandatory HMAC headers. Resolves the parked Restate promise. |
| GET    | `/api/projects/:projectId/integrations/docling/quota`                          | Returns `{ limitPerMinute, burst, scope: 'workspace' }` for the Docling card's static info line. Reads tenant config; no rate-limiter introspection. Requires `'integrations:read'`.  |
| POST   | `/api/projects/:projectId/integrations/docling/enable`                         | Idempotently upserts a `ConnectorConnection` bound to a synthetic no-auth `AuthProfile`. Requires `requireProjectPermission(req, res, 'integrations:write')`.                         |
| POST   | `/api/projects/:projectId/integrations/docling/disable`                        | Deletes the `ConnectorConnection` (the synthetic AuthProfile remains; harmless). Requires `'integrations:write'`.                                                                     |
| GET    | `/api/projects/:projectId/integrations/azure-document-intelligence/usage`      | Returns `{ usageCount, usagePeriodStart, usageSoftCap, usageHardCap }` for the Usage view. Requires `'integrations:read'`.                                                            |
| PATCH  | `/api/projects/:projectId/integrations/azure-document-intelligence/usage-caps` | Updates `usageSoftCap` and/or `usageHardCap`. Requires `'integrations:write'`.                                                                                                        |

### API (Studio)

The Studio process proxies the above project-scoped endpoints under `/api/projects/...` consistent with the existing connector and integrations pattern; no new Studio-only routes.

### Admin Portal

Out of scope for v1. A future iteration may add a tenant-wide quota override page (deferred per plan §7.6).

### Channel / SDK / Voice / A2A / MCP Integration

Not channel-aware. The integrations execute inside workflow-engine step contexts; they do not interact with channels, SDK runtimes, Voice, A2A, or MCP servers.

---

## 9. Data Model

### Collections / Tables

```text
Collection: ConnectorConnection (EXISTING — additive fields for Azure DI usage)
Fields:
  - _id: string
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - connectorName: 'docling' | 'azure-document-intelligence' | <existing>
  - displayName: string
  - scope: 'tenant' | 'project'
  - userId?: string
  - authProfileId: string (synthetic for Docling no-auth; real api_key profile for Azure DI)
  - status: 'active' | 'disabled'
  - metadata?: object
  - createdAt: Date
  - updatedAt: Date

  # NEW fields for Azure DI cost tracking (apply only when connectorName === 'azure-document-intelligence'):
  - usageCount?: number        (atomic $inc'd on each successful extraction; 0 by default)
  - usagePeriodStart?: Date    (first-of-current-month boundary; resets at increment time when crossed)
  - usageSoftCap?: number      (default 1000; warning emitted at 80%)
  - usageHardCap?: number | null (default null = soft only; setting blocks at 100%)

Indexes:
  - { tenantId: 1, projectId: 1, connectorName: 1 }  (existing)
```

```text
Collection: AuthProfile (EXISTING — no schema changes)
  - Azure DI uses `auth.type === 'api_key'` with:
    - secrets.apiKey: <encrypted via TenantEncryptionFacade>
    - config.connectionConfig: Record<string, string> = { endpoint, apiVersion?, defaultModel? }
  - Docling uses synthetic per-tenant `auth.type === 'none'` profile (hidden from Auth Profiles list)
```

```text
Collection: WorkflowExecution (EXISTING — additive fields for relay-race timeout enforcement)
Fields (new/modified only):
  - hasHumanWait?: boolean      (set true when step parks with waiting_approval or waiting_human_task;
                                  cleared on resolveParkedStep; absent = false semantics)
  - rejectStepIds?: string[]    (stored at parkStep time from step.onRejectSteps; read by callback routes
                                  on rejection; ?? [] default; stripped from REST API responses)

Indexes (new):
  - { status: 1, startedAt: 1, hasHumanWait: 1 }  (compound partial, partialFilterExpression: { status: 'running' })
    Purpose: StuckExecutionSweeper queries running executions older than cutoff, excluding hasHumanWait=true.
    Created by Mongoose ensureIndex on startup — no migration script required.
```

```text
Redis keys (no new collections):
  - workflow:docling:${tenantId}                  (rate-limiter-flexible token bucket; sliding window)
  - azuredi:${executionId}:${stepId}              (ctx.store key, 24h TTL, holds Operation-Location)
  - sys:callback:${stepId}                         (Restate durable promise for the parked workflow step)
  - bull:{workflow-docling-extraction}:*           (BullMQ queue keys for the new queue)
  - bull:{search-docling-extraction}:*             (BullMQ queue keys for the existing queue — UNCHANGED)
```

### Key Relationships

- **Workflow step → ConnectorConnection → AuthProfile.** Resolved on each `connector_action` execution via `ConnectionResolver` and `AuthProfileResolverFactory`; no per-call caching.
- **Workflow step (Docling path) → BullMQ job → search-AI worker → workflow callback route → parked Restate promise.** End-to-end correlation is `callbackId = ${executionId}:${stepId}`.
- **Workflow step (Azure DI path) → `ctx.store` key → Azure DI Operation-Location → polling loop.** Replay-safe via the 24 h TTL key.
- **TraceEvent ↔ workflow step.** Each `extract_document` invocation emits exactly one trace event (success or typed-error); deeper detail in audit log.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                                               | Purpose                                                                                                 |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/connectors/src/native/docling/connector.ts` (NEW)                                        | Native Docling connector definition + `extract_document` action (workflow step body)                    |
| `packages/connectors/src/native/docling/streaming-url-to-docling.ts` (NEW)                         | Streaming helper used by the worker's new branch — replaces buffered `downloadDocument()` for that path |
| `packages/connectors/piece-azure-document-intelligence/src/index.ts` (NEW)                         | `createPiece` for Azure DI                                                                              |
| `packages/connectors/piece-azure-document-intelligence/src/auth.ts` (NEW)                          | `PieceAuth.CustomAuth` definition (`endpoint`, `apiKey`, `apiVersion?`, `defaultModel?`) + `validate`   |
| `packages/connectors/piece-azure-document-intelligence/src/actions/extract-document.ts` (NEW)      | Azure DI `createAction` `run()` — SSRF/HEAD/POST `:analyze`/`ctx.store`/poll/normalize                  |
| `packages/connectors/piece-azure-document-intelligence/src/normalize.ts` (NEW)                     | Azure `analyzeResult` → shared envelope                                                                 |
| `packages/connectors/src/adapters/activepieces/auth-adapters/azure-document-intelligence.ts` (NEW) | Bridges resolved `AuthProfile` → AP `CustomAuth` shape (mirror of `jira-cloud.ts` / `servicenow.ts`)    |
| `packages/connectors/src/native/docling/normalize.ts` (NEW)                                        | Docling response → shared envelope                                                                      |
| `packages/connectors/src/native/extraction-envelope.ts` (NEW)                                      | Shared `ExtractionEnvelopeSchema` (Zod, `schemaVersion: 1`)                                             |
| `packages/connectors/src/loader.ts` (MODIFIED)                                                     | Register Docling eagerly + add Azure DI to `PIECE_PACKAGES` + add auth-adapter branch                   |
| `packages/connectors/src/services/connection-resolver.ts` (MODIFIED)                               | Short-circuit `auth.type === 'none'`                                                                    |
| `packages/connectors/src/services/connection-service.ts` (MODIFIED)                                | Auto-bind synthetic system AuthProfile for `none` connectors (idempotent)                               |
| `packages/shared/src/types/workflow-schemas.ts` (MODIFIED)                                         | Extend `IntegrationNodeConfigSchema.timeout` to `max(1800)`                                             |
| `packages/shared-encryption/src/encryption-manifest.ts` (MODIFIED, additive)                       | Add `'workflow-docling-extraction': { fieldsToEncrypt: [] }` per GAP-012                                |

### Routes / Handlers

| File                                                                                      | Purpose                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/handlers/workflow-handler.ts` (MODIFIED)                        | `executeWorkflow()` entry point + `WorkflowRunInput` type — relay-race execution engine. Each relay slice reads `inputSnapshot` from MongoDB cold-start; no Restate journal dependency.                                                |
| `apps/workflow-engine/src/services/restate-endpoint.ts` (MODIFIED)                        | `buildWorkflowExecutorObject()` — builds `workflow-executor` Restate virtual object with `runWorkflow` (exclusive) / `cancelWorkflow` (shared) handlers. Registered alongside legacy `workflow-runner`.                                |
| `apps/workflow-engine/src/services/restate-client.ts` (MODIFIED)                          | `startWorkflow()` (relay-race: POSTs to `/workflow-executor/{id}/runWorkflow/send`), `cancelWorkflow()` (relay-race), `startLegacyWorkflow()` (old Restate path), `cancelLegacyWorkflow()` (old path — kept for in-flight executions). |
| `apps/workflow-engine/src/persistence/execution-store.ts` (MODIFIED)                      | `parkStep()`, `resolveParkedStep()`, `initStepBarrier()`, `atomicBarrierIncrement()`, `storeLoopData()`, `readLoopData()`, `getExecutionForLeg()`, `runCounter` field for invocation sequence tracking.                                |
| `apps/workflow-engine/src/index.ts` (MODIFIED)                                            | `relayStartWorkflow()` wrapper — routes ALL trigger-fired executions (TriggerEngine, TriggerScheduler, ConnectorTriggerEngine, webhook router, polling worker, connector webhook router) through relay-race.                           |
| `apps/workflow-engine/src/routes/workflow-callbacks.ts` (MODIFIED)                        | Added tri-path callback resolution: relay-race (`startWorkflow`) vs legacy awakeable (`resolveAwakeable`) vs legacy shared handler (`resolveCallback`). 12MB route-specific body limit.                                                |
| `apps/workflow-engine/src/routes/integrations.ts` (NEW)                                   | Project-scoped Docling toggle endpoints (`enable`, `disable`, `quota`)                                                                                                                                                                 |
| `apps/workflow-engine/src/routes/azure-di-usage.ts` (NEW)                                 | Project-scoped Azure DI usage `GET` + `PATCH usage-caps`                                                                                                                                                                               |
| `apps/workflow-engine/src/executors/connector-action-executor.ts` (UNCHANGED — call site) | Existing executor at `apps/workflow-engine/src/executors/connector-action-executor.ts` invokes the connector via `ConnectorToolExecutor`                                                                                               |

### UI Components

| File                                                                                                 | Purpose                                                   |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/studio/src/pages/projects/[projectId]/settings/integrations.tsx` (NEW)                         | Project Settings → Integrations tab (Docling toggle card) |
| `apps/studio/src/components/projects/IntegrationsCard.tsx` (NEW)                                     | Docling toggle card with static rate-limit info line      |
| `apps/studio/src/components/workflows/canvas/config/IntegrationPickerModal.tsx` (REUSED, no changes) | Existing picker; gates on `ConnectorConnection` presence  |
| `apps/studio/src/components/workflows/canvas/config/DynamicActionForm.tsx` (REUSED, no changes)      | Renders extract_document form from AP CustomAuth `props`  |
| `apps/studio/src/components/projects/AzureDIUsageView.tsx` (NEW)                                     | Project Settings → Usage view for Azure DI counters       |

### Jobs / Workers / Background Processes

| File                                                                           | Purpose                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/search-ai/src/workers/docling-extraction-worker.ts` (MODIFIED, additive) | Add second `new Worker('workflow-docling-extraction', processor, { concurrency: 2 })`; existing Worker concurrency drops to 3 (envs override). Add top-level branch in `processor`.               |
| `apps/search-ai/src/queues/queue-factory.ts` (MODIFIED, additive)              | Add `getWorkflowDoclingExtractionQueue()` factory                                                                                                                                                 |
| `packages/search-ai-sdk/src/constants.ts` (MODIFIED, additive)                 | Add `QUEUE_WORKFLOW_DOCLING_EXTRACTION = 'workflow-docling-extraction'`                                                                                                                           |
| `apps/search-ai/src/workers/branches/extraction-only.ts` (MODIFIED)            | Pages filter removed (`d4c0da7593`) — filter was in-memory post-extraction with no effect on Docling load                                                                                         |
| `apps/search-ai/src/workers/callback-poster.ts` (NEW)                          | HMAC-signed callback POST helper with exponential backoff (1 s → 30 s, max 5 attempts; 404 terminal)                                                                                              |
| `apps/workflow-engine/src/services/adi-poll-worker.ts` (NEW)                   | BullMQ poll worker for ADI — replaces inline Restate polling. Single GET per job, re-enqueues with 2s fixed interval, exponential backoff on 429/5xx, HMAC callback, re-encryption on re-enqueue. |

### Tests

| File                                                                                                 | Type        | Coverage Focus                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/connectors/src/__tests__/extraction-envelope.test.ts` (NEW)                                | unit        | Envelope schema validation; provider adapters map Docling/Azure native → envelope correctly                                                                             |
| `packages/connectors/src/__tests__/connection-resolver-none.test.ts` (NEW)                           | unit        | `auth.type === 'none'` short-circuit returns empty auth context                                                                                                         |
| `packages/connectors/piece-azure-document-intelligence/src/__tests__/extract-document.test.ts` (NEW) | integration | Action body: SSRF / HEAD / POST `:analyze` / ctx.store stash / poll / 429 with Retry-After / replay safety (forced engine restart)                                      |
| `apps/search-ai/src/__tests__/workflow-docling-extraction-worker.test.ts` (NEW)                      | integration | New branch: SSRF re-check; streaming memory profile; envelope size cap; HMAC-signed callback POST + retry + 404 terminal                                                |
| `apps/search-ai/src/__tests__/two-queue-isolation.test.ts` (NEW)                                     | integration | Slot-split reservation honored: Worker A ≤3 active per pod, Worker B ≤2 active per pod, neither queue can consume the other's slots                                     |
| `apps/workflow-engine/src/__tests__/workflow-docling-parking.test.ts` (NEW)                          | integration | Restate parked-promise survives engine restart; engine-side memory invariant (1000 parked steps cap pod RSS delta within ~50 MB)                                        |
| `apps/workflow-engine/src/__tests__/docling-toggle-routes.test.ts` (NEW)                             | integration | Project toggle enable/disable/quota; idempotency; cross-tenant 404                                                                                                      |
| `apps/workflow-engine/src/__tests__/azure-di-usage-routes.integration.test.ts` (NEW)                 | integration | Usage GET + cap PATCH; atomic `$inc` under concurrency; month-boundary reset; `QUOTA_EXCEEDED` enforcement                                                              |
| `apps/studio/e2e/workflows/document-extraction-docling.spec.ts` (NEW)                                | e2e         | Full workflow: enable toggle → run with PDF URL → assert envelope; toggle off → `INTEGRATION_DISABLED`; SSRF rejection on `169.254.169.254`                             |
| `apps/studio/e2e/workflows/document-extraction-azure-di.spec.ts` (NEW)                               | e2e         | Full workflow: create AuthProfile → run with XLSX URL → assert envelope `provider === 'azure-document-intelligence'`; replay safety; cross-provider parity for same PDF |
| `apps/studio/e2e/workflows/document-extraction-rate-limit.spec.ts` (NEW)                             | e2e         | 30 sequential enqueues → first 10 succeed (burst) → next ~5 succeed (refill) → remainder `RATE_LIMITED`; trace event renders the configured limit value as static text  |

---

## 11. Configuration

### Environment Variables

| Variable                                       | Default                                               | Description                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED` | `false`                                               | Feature flag gating the entire feature. `true` to enable.                                                                                                                                                                                                                                                                              |
| `RESTATE_WORKFLOW_RUNNER_INACTIVITY_TIMEOUT`   | `1h`                                                  | NEW. Bumps Restate's per-service `inactivity_timeout` for `workflow-runner` from the 1m default so async-wait handlers stay in-flight long enough for the resolve to land pre-suspension. Workflow-engine PATCHes this on each successful Restate registration. Value uses Restate's duration string format (`1m`, `30m`, `1h`, etc.). |
| `DOCLING_SERVICE_URL`                          | `http://localhost:8080` (existing)                    | Reused; not modified.                                                                                                                                                                                                                                                                                                                  |
| `INGESTION_MAX_CONCURRENT_JOBS`                | `5` (existing, at `apps/search-ai/src/server.ts:548`) | Total per-pod cap (sum of ingestion + workflow). Runtime assertion enforces `DOCLING_INGESTION_CONCURRENCY + DOCLING_WORKFLOW_CONCURRENCY ≤ this`.                                                                                                                                                                                     |
| `DOCLING_INGESTION_CONCURRENCY`                | `3`                                                   | NEW. Reserved slots for the existing `search-docling-extraction` queue.                                                                                                                                                                                                                                                                |
| `DOCLING_WORKFLOW_CONCURRENCY`                 | `2`                                                   | NEW. Reserved slots for the new `workflow-docling-extraction` queue.                                                                                                                                                                                                                                                                   |
| `DOCLING_WORKFLOW_INLINE_CAP_BYTES`            | `52428800` (50 MiB)                                   | Inline-envelope size cap for Docling. Configurable per project via tenant config.                                                                                                                                                                                                                                                      |
| `AZURE_DI_WORKFLOW_INLINE_CAP_BYTES`           | `10485760` (10 MiB)                                   | NEW (2026-05-18). Inline-envelope size cap for Azure DI. Independently tunable from Docling. Also controls the route-specific Express body limit for `/api/v1/workflows/callbacks` (cap + 2MB headroom).                                                                                                                               |
| `AZURE_DI_POLL_INTERVAL_MS`                    | `2000`                                                | NEW (2026-05-18). Fixed poll interval for the ADI BullMQ poll worker. Fixed (not exponential) to minimize latency after Azure completes.                                                                                                                                                                                               |
| `AZURE_DI_POLL_CONCURRENCY`                    | `50`                                                  | NEW (2026-05-18). BullMQ worker concurrency for `workflow-adi-poll` queue. High because jobs are I/O-bound (single HTTP GET); Azure self-limits via 429.                                                                                                                                                                               |
| `AZURE_DI_RATE_PER_MIN`                        | `10`                                                  | Per-tenant rate limit for ADI extractions. Now Redis-backed (`RateLimiterRedis`) to hold across replicas.                                                                                                                                                                                                                              |
| `DOCLING_WORKFLOW_SIZE_HARD_CAP_BYTES`         | `524288000` (500 MiB)                                 | NEW. Hard pre-enqueue size limit (from HEAD probe).                                                                                                                                                                                                                                                                                    |
| `DOCLING_WORKFLOW_RATE_LIMIT_PER_MIN`          | `10`                                                  | NEW. Per-tenant sustained rate. Overridable per tenant via tenant config.                                                                                                                                                                                                                                                              |
| `DOCLING_WORKFLOW_RATE_LIMIT_BURST`            | `5`                                                   | NEW. Per-tenant burst capacity.                                                                                                                                                                                                                                                                                                        |
| `AZURE_DI_USAGE_SOFT_CAP_DEFAULT`              | `1000`                                                | NEW. Default monthly soft cap for Azure DI extractions per project.                                                                                                                                                                                                                                                                    |
| `AZURE_DI_OPERATION_STORE_TTL_SECONDS`         | `86400` (24 h)                                        | NEW. `ctx.store` TTL for `Operation-Location` keys.                                                                                                                                                                                                                                                                                    |
| `WORKFLOW_ENGINE_URL`                          | existing                                              | Reused — base URL used by the search-AI worker to build the callback URL.                                                                                                                                                                                                                                                              |
| `STUCK_EXECUTION_MAX_AGE_MS`                   | `14400000` (4 h)                                      | NEW (2026-05-21). StuckExecutionSweeper age threshold. Executions in `running` status older than this (without `hasHumanWait`) are swept to `failed`. Default 4h covers ADI/Docling worst-case extraction times.                                                                                                                       |
| `AZURE_DI_MAX_POLL_COUNT`                      | `1000`                                                | NEW (2026-05-21). Maximum poll iterations for ADI BullMQ poll worker before declaring extraction timed out. Prevents infinite polling on stuck Azure operations.                                                                                                                                                                       |
| `RELAY_RACE_DISABLED`                          | `false`                                               | NEW (2026-05-21). Emergency escape hatch — when `true`, restores legacy Restate `workflow.run` awakeable suspension path for all new executions. Use only for rollback if relay-race model has critical bugs.                                                                                                                          |

### Runtime Configuration

- **Tenant config:** `tenantConfig.integrations.docling.rateLimitPerMinute` and `tenantConfig.integrations.docling.burst` allow per-tenant overrides; loaded by the workflow step body when consuming a rate-limit token.
- **Project config:** `project.integrations.azureDocumentIntelligence.usageSoftCap` and `.usageHardCap` (stored on the `ConnectorConnection` record per FR-18).
- **Feature flag:** `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED` (env var) for backend gating. The Studio Integration Picker additionally gates via the `isFeatureEnabled()` resolver (`apps/studio/src/lib/feature-resolver.ts`) once a `PLAN_FEATURES` entry is added in `@agent-platform/shared-kernel`.

### DSL / Agent IR / Schema

- **Workflow IR — Integration step:**

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
      language: 'en' # optional
      model: 'prebuilt-layout' # optional, Azure DI only
      timeout: 60 # 5..1800
    paramModes:
      fileUrl: expression
  ```

- **Output envelope (returned as step output):**

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

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Toggle / quota / usage endpoints are mounted under `/api/projects/:projectId/...` and use `requireProjectPermission(req, res, 'integrations:read'                                                                                                                                     | 'integrations:write')`. Cross-project access returns 404. The `ConnectorConnection`lookup is scoped by`{ tenantId, projectId, connectorName }`. |
| Tenant isolation  | Every BullMQ job carries `tenantId` (audit + per-tenant rate-limit key). Rate-limiter key includes `tenantId`. Restate `ctx.store` key composition uses `executionId` + `stepId` (already tenant-isolated by execution context). Trace events filter by tenant in TraceStore queries. |
| User isolation    | The workflow step inherits the workflow execution's principal context. `ConnectorToolExecutor` already enforces principal-aware resolution. Project-toggle endpoints follow CLAUDE.md project isolation rules — never silently widen to tenant scope.                                 |

### Security & Compliance

- **SSRF:** Two-layer guard. Pre-enqueue: workflow step body calls `assertUrlSafeForSSRF` from `@agent-platform/shared-kernel/security`. At worker: re-validates because the URL crosses the Redis hop. Scheme allowlist (`http`, `https`), DNS-resolve-then-connect-by-IP, redirect re-validation, cloud-metadata blocklist (`169.254.169.254`, `metadata.google.internal`, etc.). **DNS pinning** is required to close the DNS-rebinding TOCTOU window (resolve hostname once → connect by IP, do NOT re-resolve at request time; documented vulnerabilities in 2025-2026 include FastGPT GHSA-cc8x-jrqv-hmwh, Gotenberg CVE-2026-42592). The LLD must verify the existing utility implements pinned connections; if not, the LLD must extend it before this feature merges. All managed via the existing utility — **no new SSRF code**, but a DNS-pinning verification check is an LLD gate.
- **HMAC callback signing:** The Docling worker callback POST is signed with HMAC-SHA256 using the per-step secret carried in the BullMQ job payload. The callback route (`apps/workflow-engine/src/routes/workflow-callbacks.ts:87-129`) **mandates** verification — unsigned callbacks are rejected.
- **TLS:** Strict cert validation. No `rejectUnauthorized: false`. Applies to Docling HTTP (loopback in v1 — `http://`), worker → callback POST (HTTPS), and Azure DI REST (HTTPS).
- **Credential handling:** Azure DI API key encrypted at rest via `TenantEncryptionFacade` (existing). Decrypted only inside the auth resolver. **Never logged.** Error payloads sanitized; HTTP body excerpts truncated to host-only in trace events. Secrets redacted from all `console.*` and `pino` outputs by the existing sanitization pipeline.
- **PII:** Extracted text passes through the existing PII redaction pipeline (project's PII confidence threshold) **before** being persisted to workflow trace events. The redaction strips API keys, SSNs, credit cards, emails per existing rules.
- **Audit log:** Every extraction emits an audit event `{ actor, tenantId, projectId, connector, action, sourceUrl(hostOnly), sizeBytes, durationMs, status }` per FR-20. Both Docling (workflow path) and all Azure DI calls are audited.
- **Semgrep:** `./tools/run-semgrep.sh` is mandated before PRs touching auth, crypto, HTTP handlers, or user input (CLAUDE.md). This feature touches all of those; semgrep is a gate.

### Performance & Scalability

- **Targets (provisional, lock in Phase 5 beta):**

  | Metric                       | Target (Docling)                                          | Target (Azure DI)       |
  | ---------------------------- | --------------------------------------------------------- | ----------------------- |
  | p50 extraction (10-page PDF) | < 8 s                                                     | < 6 s                   |
  | p95 extraction (10-page PDF) | < 25 s                                                    | < 20 s                  |
  | p99 extraction (10-page PDF) | < 60 s                                                    | < 45 s                  |
  | Error rate (excluding 4xx)   | < 1 %                                                     | < 1 %                   |
  | Throughput (per pod)         | 5 concurrent (3 ingestion + 2 workflow; env-configurable) | bounded by Azure quotas |

- **Backpressure:** Per-queue depth → HPA scales worker pods (existing behavior; new metrics expose each queue's depth separately).
- **Memory invariant:** 1000 simultaneously parked Docling workflow steps cap pod RSS delta within ~50 MB (parked promises live in the Restate journal, not in pod memory) — verified by integration test (FR-9 corollary).
- **Streaming memory profile:** the worker's new branch must keep RSS delta < 10 MB during a 100 MB PDF extraction (streaming, not buffered) — verified by integration test.
- **Per-pod efficiency under skew:** under fully skewed load (one queue empty, other backlogged), per-pod efficiency drops to 60 % (3 of 5 slots active). Mitigation: HPA scales pods; per-queue depth alerts trigger v2 upgrade discussion (work-stealing scheduler or BullMQ Pro Groups).

### Reliability & Failure Modes

- **Retries:**
  - Full-ingestion jobs: unchanged from today (BullMQ's existing config).
  - Extraction-only jobs: `attempts: 1` at BullMQ (workflow engine owns per-node retries).
  - Worker callback POST: exp backoff 1 s → 30 s, max 5 attempts; 404 from callback route is terminal.
- **Timeouts:**
  - Workflow side: `IntegrationNodeConfigSchema.timeout` (5-1800 s, default 60). Enforced by `raceTimeout(restateCtx, ..., callbackTimeoutMs)`.
  - Worker side: size-scaled `60 s base + 10 s/MB`, capped at 1800 s (existing pattern at `docling-extraction-worker.ts:585-587`).
- **Idempotency / replay safety:**
  - Docling: Restate journal owns single-execution. The step body's `ctx.run` enqueues at most once per logical execution; the park is durable across pod restarts.
  - Azure DI: `ctx.store` key `azuredi:${executionId}:${stepId}` (24 h TTL) holds the `Operation-Location`; replay resumes polling the **same** Azure operation. Single invoice per logical extraction.
- **Inline envelope cap:** Both providers serialize their result and check `serializedSize > inlineCap` (default 50 MB). Oversized → `EXTRACTION_TOO_LARGE` with `{ sizeBytes, limitBytes }`; never propagates the payload through to the engine. Protects journal + Redis. **Industry comparison note:** 50 MB is significantly above Temporal's default 2 MB inline payload guidance. The plan and spec acknowledge this as a deliberate v1 tradeoff (larger envelopes serve workflow designers handling multi-page PDFs with embedded images); the per-project configurability and `workflow_extraction_too_large_total` telemetry let support raise or lower the cap per tenant. **A v2 Claim Check pattern** (store envelope in S3, pass an S3 pointer through the journal) is the architectural escape hatch; tracked in GAP-002.
- **Azure DI circuit breaker:** Per-tenant; opens after 5 consecutive 5xx in 30 s, half-opens after 60 s. Lives inside the piece module.
- **Failure-mode table (subset):**

  | Failure                                   | Where surfaced                 | Behavior                                                                                                                                     |
  | ----------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
  | URL SSRF-blocked                          | Workflow step (pre-enqueue)    | `SSRF_BLOCKED`; no job enqueued, no Azure call.                                                                                              |
  | Tenant rate limit exceeded                | Workflow step (pre-enqueue)    | `RATE_LIMITED`; trace event renders configured limit value as static text.                                                                   |
  | Envelope exceeds inline cap (50 MB)       | Worker / Azure piece           | `EXTRACTION_TOO_LARGE` with `{ sizeBytes, limitBytes }`; no retry; designer-visible actionable message pointing to SearchAI's bulk pipeline. |
  | Worker timeout / Docling 5xx              | Worker → callback → engine     | `EXTRACTION_FAILED`; engine applies per-node retry policy.                                                                                   |
  | Worker pod crash mid-job (`attempts: 1`)  | Workflow handler `raceTimeout` | No callback POSTed; step times out per `callbackTimeoutMs`; engine retry policy applies.                                                     |
  | Engine pod restart during park            | Restate journal                | Parked promise re-attaches on restart; worker's callback POST resumes the workflow. **No duplicate Docling call.**                           |
  | Callback POST 404 (stale execution)       | Worker                         | Terminal — does not retry.                                                                                                                   |
  | Worker callback POST retries exhausted    | Worker                         | Step times out; `CALLBACK_DELIVERY_FAILED` logged + metric incremented; Docling cost incurred once.                                          |
  | Restate replay during Azure DI poll       | Azure DI action                | `ctx.store` returns existing `Operation-Location` → polling resumes the same Azure operation. **No second invoice.**                         |
  | Azure DI 4xx (bad request / invalid auth) | Azure DI action                | Typed error to workflow step; not retried.                                                                                                   |
  | Azure DI 429                              | Azure DI action poll loop      | Sleeps `Retry-After`; resumes polling.                                                                                                       |
  | Azure DI 5xx repeated                     | Circuit breaker                | Opens after threshold; subsequent calls fail-fast with `INTEGRATION_UNAVAILABLE` until breaker half-opens.                                   |
  | Per-project Azure DI cost cap exceeded    | Azure DI action (pre-submit)   | `QUOTA_EXCEEDED`; no Azure call.                                                                                                             |

### Observability

- **Trace events:** Each call emits a `TraceEvent` via `TraceStore` with `provider`, `model`, `pageCount`, `processingTimeMs`, propagating `executionId` + `traceId` into the BullMQ job metadata.
- **Metrics (new):**
  - `bullmq_queue_depth{queue}` — alert: ingestion >200, workflow >50, sustained 10 min.
  - `worker_active_jobs{queue}` — per-pod reservation enforcement.
  - `workflow_docling_wait_duration_seconds{tenant, status}`
  - `workflow_docling_errors_total{tenant, error_class}`
  - `workflow_docling_parked_promises_gauge{tenant}`
  - `workflow_docling_callback_post_attempts_total{tenant, attempt}`
  - `workflow_docling_callback_post_failures_total{tenant, error_class}` — alert: >0.1 %.
  - `workflow_docling_rate_limited_total{tenant}` — alert: >1 % per tenant for 10 min.
  - `workflow_extraction_too_large_total{provider, tenantId}` — alert: sustained >1 % per tenant.
  - `azure_di_extractions_total{tenant, project, status}`
  - `azure_di_circuit_breaker_state{tenant}`
  - `azure_di_cost_cap_used_ratio{tenant, project}`
- **Structured logs:** JSON, one line per call with the audit-event field set plus `jobId` (Docling) or `operationLocation` (Azure DI).
- **Dashboard:** New Grafana panel under **Workflows** — per-queue depth + active jobs, p50/p95/p99 wait + extraction latency, error rate, rate-limit rejections, parked-promise count, Azure DI cost-cap utilization.

### Data Lifecycle

- **`ctx.store` keys:** 24 h TTL by default (`AZURE_DI_OPERATION_STORE_TTL_SECONDS`); deleted on terminal state. Orphans expire naturally.
- **BullMQ job retention:** unchanged from existing `removeOnComplete` config — replay safety is owned by the Restate journal, not the queue.
- **Audit events:** retained per the platform's existing audit retention policy (see [`audit-logging`](audit-logging.md)).
- **Trace events:** retained per existing TraceStore TTL.
- **Connector usage counters:** monthly reset at increment time; no separate cleanup job. Counters persist on `ConnectorConnection` for the connection's lifetime.
- **Right to erasure:** when a project is deleted, cascading deletes remove `ConnectorConnection` (and counters), associated `AuthProfile` records for project-scoped profiles, and Redis keys (`ctx.store`, rate-limiter buckets) which expire naturally.

---

## 13. Delivery Plan / Work Breakdown

1. **Phase 0 — SDLC artifacts** (this doc + downstream)
   1.1 Feature spec → `docs/features/document-extraction-integrations.md` (this doc)
   1.2 Testing guide → `docs/testing/document-extraction-integrations.md`
   1.3 HLD → `docs/specs/document-extraction-integrations.hld.md`
   1.4 LLD → `docs/plans/document-extraction-integrations.lld.md`
   1.5 All artifacts pass `phase-auditor`
2. **Phase 1 — Worker branch + workflow `async_webhook` step + two-queue topology** (4 days)
   2.1 Add `QUEUE_WORKFLOW_DOCLING_EXTRACTION` constant in `packages/search-ai-sdk/src/constants.ts`
   2.2 Add `getWorkflowDoclingExtractionQueue()` factory in `apps/search-ai/src/queues/queue-factory.ts`
   2.3 Refactor `docling-extraction-worker.ts` to two `new Worker(...)` subscriptions; env-configurable concurrencies + total-cap assertion
   2.4 Implement `extraction-only` branch (SSRF re-check, streaming-URL helper, envelope normalize, size cap)
   2.5 Implement HMAC-signed callback POST helper (1 s → 30 s, max 5 attempts; 404 terminal)
   2.6 Extend BullMQ job payload type with optional `mode`, `options`, `callbackId`, `callbackUrl`, `callbackSecret`
   2.7 Add new branch metrics + structured-log emitter
   2.8 Exit: existing search-AI E2E suite stays green; new unit + integration tests pass; streaming RSS delta < 10 MB on 100 MB PDF; engine-side memory invariant verified at 1000 parked steps
3. **Phase 2 — Docling workflow connector + project toggle** (3 days)
   3.1 Native `docling` connector + `extract_document` action (workflow step body)
   3.2 `ConnectionResolver` short-circuit for `auth.type === 'none'`
   3.3 `ConnectionService` system-managed AuthProfile auto-bind (idempotent)
   3.4 Project toggle endpoints + Studio Settings tab + IntegrationsCard
   3.5 Regenerate `connector-catalog.json`
   3.6 Exit: E2E enable toggle → run with PDF URL → assert envelope; disable → `INTEGRATION_DISABLED`; 5 integration tests across PDF / DOCX / PPTX / HTML / image
4. **Phase 3 — Azure Document Intelligence AP-format piece** (3 days)
   4.1 Scaffold `packages/connectors/piece-azure-document-intelligence/` alongside `piece-shopify`
   4.2 `PieceAuth.CustomAuth` with `validate` against `/info`
   4.3 `createAction('extract_document')` `run()` — SSRF + HEAD → `ctx.store` check → POST `:analyze` → stash Operation-Location → poll with exp backoff + `Retry-After` → cleanup → normalize
   4.4 Auth-adapter shim `auth-adapters/azure-document-intelligence.ts`
   4.5 Add to `PIECE_PACKAGES` + adapter branch in `loader.ts`
   4.6 Per-tenant in-process circuit breaker + token-bucket rate limit
   4.7 Per-project cost counter + soft cap + hard cap + usage endpoints
   4.8 Regenerate `connector-catalog.json`
   4.9 Exit: E2E Azure DI AuthProfile creation → run with PDF + XLSX URLs → assert envelope; replay safety test (forced engine restart between POST and result → no second invoice)
5. **Phase 4 — Audits & hardening** (2 days)
   5.1 `data-flow-audit` (2 rounds) — feature crosses schema / route / auth / serializer / worker / UI boundaries
   5.2 `pr-reviewer` (5 rounds)
   5.3 `./tools/run-semgrep.sh` — auth/crypto/HTTP/user-input changes
   5.4 Grafana dashboard live + alerts wired
   5.5 Update package `agents.md` files
6. **Phase 5 — Beta rollout** (1 week soak)
   6.1 Enable for internal tenants via feature flag + `isFeatureEnabled` Deal flag
   6.2 Monitor latency, error rate, Azure DI cost, queue depth, callback-failure rate, RSS delta
   6.3 Re-tune rate-limit defaults based on observed concurrent-tenant counts
   6.4 Exit: no P0 / P1 for 5 business days → promote feature spec to BETA via `/post-impl-sync`
7. **Phase 6 — GA**
   7.1 Flip `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED` default to `true`
   7.2 Add to `PLAN_FEATURES` for the appropriate subscription tiers
   7.3 Mark integrations as `STABLE` in catalog; promote feature spec to STABLE via `/post-impl-sync`

---

## 14. Success Metrics

| Metric                                                     | Baseline | Target                                                          | How Measured                                                                                                               |
| ---------------------------------------------------------- | -------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Workflow document extraction adoption                      | 0        | ≥ 10 internal workflows using `extract_document` by end of beta | Count distinct workflows invoking `extract_document` per week (TraceStore query)                                           |
| p95 Docling extraction latency (10-page PDF)               | n/a      | < 25 s                                                          | `workflow_docling_wait_duration_seconds{tenant, status='success'}` p95                                                     |
| p95 Azure DI extraction latency (10-page PDF)              | n/a      | < 20 s                                                          | `azure_di_extraction_duration_seconds` p95                                                                                 |
| Two-queue isolation correctness                            | n/a      | 0 violations                                                    | `worker_active_jobs{queue}` never exceeds reserved per-pod cap during E2E load test                                        |
| Engine memory under 1000 parked steps                      | n/a      | RSS delta < 50 MB / pod                                         | Integration test asserting RSS before vs after                                                                             |
| Streaming RSS during 100 MB PDF extraction                 | n/a      | RSS delta < 10 MB / worker pod                                  | Integration test                                                                                                           |
| Per-tenant rate-limit rejection rate                       | n/a      | < 1 % rejection per tenant under expected load                  | `workflow_docling_rate_limited_total{tenant}` / total enqueues                                                             |
| Azure DI cost-cap warning surfacing                        | n/a      | 100 % accuracy at 80 % / 100 % thresholds                       | Integration test on `ConnectorConnection.usageCount` atomic increments + reset semantics                                   |
| Callback POST delivery success rate                        | n/a      | ≥ 99.9 %                                                        | `workflow_docling_callback_post_attempts_total` final-attempt success ratio                                                |
| Backwards-compat invariant (existing ingestion unaffected) | green    | green                                                           | Existing `apps/search-ai/src/__tests__/text-extraction-integration.test.ts` stays green; baseline pre-change suite re-runs |

---

## 15. Open Questions

1. **Cost-cap UX placement.** Should the cost-cap warning / hard-cap modal live in Project Settings → Integrations, in the Workflow Designer trace panel, in both, or somewhere else (e.g., a workspace-level "Usage" page)? Plan defers to UI design.
2. **Region selection for Azure DI.** v1 stores `endpoint` in `connectionConfig` (free-form URL). Should the Studio form provide a curated region picker (East US, West Europe, etc.) that constructs the endpoint, or stay free-form? Free-form is simpler but error-prone.
3. **Output schema versioning policy.** `schemaVersion: 1`. Do we pin downstream nodes to a specific schema version (forcing migration when bumped) or allow any version (and require downstream nodes to handle multiple)? Recommend pin-and-migrate but pending design.
4. **Plan §12 Q6 — Docling on XLSX.** Docling cannot parse XLSX (Azure DI handles it). Plan recommends a hard fail with `UNSUPPORTED_CONTENT_TYPE`; should the workflow designer experience auto-redirect to Azure DI when both are enabled? Risk: surprising behavior.
5. **GA criteria — minimum tenants for beta.** Plan says "5 business days no P0 / P1" but doesn't specify a minimum tenant or extraction-count threshold. Recommend ≥ 3 internal tenants and ≥ 100 successful extractions before flipping the env default.
6. **Per-project rate-limit override.** v1 rate limit is per-tenant via tenant config. Should enterprise tenants get per-project overrides too (some projects high-volume, others bursty)? Deferred to v2 per plan but worth flagging.
7. **Audit-event scope for failed extractions.** Should `SSRF_BLOCKED` and `RATE_LIMITED` rejections (no Docling / Azure call made) emit an audit event, or only successful + Docling-reachable failures? Recommend audit-all for security-event traceability.

---

## 15b. Implementation Phase 5: Approval/Data-Entry Fixes, Timeout Enforcement, Security Hardening (2026-05-21)

This section documents the changes landed on `feature/wf/ocrnode` after the 2026-05-20 relay-race refactor. All changes are additive; no migration script is required.

### Approval Rejection Routing

- `rejectStepIds` stored at `parkStep` time, extracted from `step.onRejectSteps` in the handler. Callback/approval routes read them from MongoDB — never from the request body (prevents spoofing).
- `isRejection` normalization: `decision === 'reject' || decision === 'rejected'` — Studio sends past tense on resolves, engine sends present tense on initial dispatch. Both are handled.
- When `isRejection && nextStepIds.length === 0` the execution terminates with `updateExecutionStatus('rejected')`. Without this, executions would stay in `running` forever.
- `resolveParkedStep` status derivation: `reject`/`rejected` → `rejected`, `expired` → `failed`, `skipped` → `skipped`, `approved` → `completed`, `output.status=failed` → `failed`, else → `completed`.

### Data Entry Parity

- `apps/workflow-engine/src/routes/human-task-resolution.ts` mirrors all 5 approval behaviors identically (park resolution, status derivation, relay dispatch, loop scratch cleanup, execution terminal check).
- Data Entry (`data_entry` / `human_task` engine type) has no reject button in UI — Case B (reject) is N/A. The route handles it identically to approval for symmetry but it will never be called.

### Restate-Native Exact Timer

- Replaces 60s sweeper polling for step timeouts. Uses `deps.startWorkflow(executionId, { stepTimeoutFor: {...} }, { delayMs: humanTimeoutMs })` for an exact Restate timer with zero lag.
- `stepTimeoutFor` input block carries: `stepKey`, `stepId`, `expectedStatus`, `onTimeout` (`'terminate'`|`'skip'`), `timeoutDecision` (`'expired'`|`'skipped'`|`'approved'`), `nextStepIds`.
- The timeout block at the top of `executeWorkflow` resolves the parked step and routes accordingly.
- Known gap (F-2): the `startWorkflow` for timeout scheduling is outside `restateCtx.run()` — on replay it will re-send the delayed invocation, creating a duplicate timer. The `resolveParkedStep` CAS guard prevents data corruption. Low priority.

### StuckExecutionSweeper

- `apps/workflow-engine/src/services/stuck-execution-sweeper.ts` — 4h default for ADI/Docling extraction timeouts.
- Queries `{ status: 'running', startedAt: { $lt: cutoff }, hasHumanWait: { $ne: true } }`.
- Excludes `hasHumanWait` executions so long-running approval/data-entry steps are not swept as "stuck".
- Configurable via `STUCK_EXECUTION_MAX_AGE_MS` env var.

### HumanStepTimeoutEnforcer

- `apps/workflow-engine/src/services/human-step-timeout-enforcer.ts` — 60s fallback backstop for human-task timeouts.
- Retained as defense-in-depth alongside the Restate-native exact timer. If the Restate timer fails to fire (e.g., Restate is down), this sweeper catches it within 60s.

### hasHumanWait Schema Field

- `packages/database/src/models/workflow-execution.model.ts` — `hasHumanWait?: boolean` on `IWorkflowExecution` interface + Mongoose schema.
- Set `true` in `parkStep` when `status === 'waiting_approval' || status === 'waiting_human_task'`. Cleared in `resolveParkedStep` for the same statuses.
- Compound partial index `{ status: 1, startedAt: 1, hasHumanWait: 1 }` with `partialFilterExpression: { status: 'running' }`. Mongoose creates it automatically on startup via `ensureIndex`.

### Strip Set Parity (F-WS-1)

- Three strip sets must stay in sync: `STEP_SENSITIVE_FIELDS` (REST API), `PUBLISH_SENSITIVE_STEP_FIELDS` (Redis pub-sub), `SNAPSHOT_STEP_SENSITIVE_FIELDS` (WS snapshot).
- All three now contain the same 11 fields: `callbackSecret`, `awakeableId`, `parkPoint`, `nextStepIds`, `rejectStepIds`, `joinStepId`, `barrierTotal`, `barrierCount`, `barrierFailCount`, `branchId`, `failureStrategy`.
- Previously the WS/Redis sets had only 2 fields. Discovered and fixed during PR review Round 1.

### SEC-10: callbackUrl Hostname Validation in Docling Worker

- `apps/search-ai/src/workers/branches/extraction-only.ts` now validates `callbackUrl` hostname against `WORKFLOW_ENGINE_PUBLIC_URL` post-decrypt, before `postCallback()`.
- Parity fix with ADI worker, which already had this validation. Discovered during data-flow audit Round 2.

### Studio Canvas Fixes

- `computeExecutionEdges.ts` uses `canvasNodeType ?? step.nodeType` to distinguish `data_entry` from `human` (both compile to engine type `human_task`).
- `data_entry` returns `on_success`/`on_failure` handles; `human`/`human_task` returns `on_approve`/`on_reject`.
- `StepLogItem` status union extended: `rejected` → XCircle red "Rejected"; `approved` → CheckCircle2 green "Approved".

### Loop Scratch Cleanup

- `updateExecutionStatus` purges `context.steps` loop iteration keys (`loop:*:i*:*`) on terminal status. Prevents stale loop data from accumulating on completed/failed/rejected/cancelled executions.

### Data-Flow Audit (Rounds 1-3)

- 3 rounds completed on 2026-05-21; all CRITICAL/HIGH findings closed. 3 boundary test gaps remain open.
- Audit log at `docs/sdlc-logs/wf-ocr-approval/data-flow-audit.md`.

### PR Review

- Phase A complete. F3 (test drift) and F1 (strip set parity) fixed. 1280 tests passing. F2 (duplicate timer) accepted as non-blocking.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Severity        | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GAP-001 | Public-URL-only input — file uploads not supported in v1. Workflows whose upstream produces an in-memory buffer must publish to S3 first.                                                                                                                                                                                                                                                                                                                                                                                                      | Medium          | Accepted for v1 (non-goal #3). Tracked for v2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GAP-002 | Large-envelope support absent — extractions producing > 50 MB serialized envelopes fail with `EXTRACTION_TOO_LARGE`. No S3-pointer pattern in v1.                                                                                                                                                                                                                                                                                                                                                                                              | Medium          | Accepted for v1 (R13). Monitored via `workflow_extraction_too_large_total{provider, tenantId}`. Per-project cap is configurable as an escape hatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GAP-003 | Azure DI region latency variability — per-region SLOs not yet documented. Tenants choose region implicitly via endpoint.                                                                                                                                                                                                                                                                                                                                                                                                                       | Low             | Open. Operator dashboard to track latency per `endpoint` host once telemetry lands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GAP-004 | No multi-region failover for Azure DI within a single AuthProfile. Tenants can register multiple AuthProfiles (one per region) but the workflow step picks one explicitly.                                                                                                                                                                                                                                                                                                                                                                     | Low             | Accepted for v1 (non-goal #2). Workspace owner picks the AuthProfile per workflow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GAP-005 | Per-pod efficiency drops to ~60 % under fully skewed load (one queue empty). Reserved slots cannot be borrowed across queues in v1.                                                                                                                                                                                                                                                                                                                                                                                                            | Low             | Accepted for v1 (R14). Mitigated by env-configurable splits and HPA scaling. v2 upgrade path: work-stealing scheduler or BullMQ Pro Groups; trigger if telemetry shows persistent skew.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| GAP-006 | Restate replay of Azure DI **after** `ctx.store` 24 h TTL elapses re-POSTs `:analyze` → rare double-bill. Workflows that retry manually beyond 24 h experience this.                                                                                                                                                                                                                                                                                                                                                                           | Low             | Accepted (R2b). TTL is configurable. Audit-log + cost-cap mitigate financial risk.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GAP-007 | The orphan `doc_intelligence` `NodeType` (in `STUB_NODE_TYPES` / `HIDDEN_NODE_TYPES`) remains in the codebase. v1 does not repurpose or remove it.                                                                                                                                                                                                                                                                                                                                                                                             | Low             | Open. Future refactor decides removal vs. repurpose.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GAP-008 | No usage UI in v1 — only a static rate-limit info line on the Docling card and pass/fail cost-cap status for Azure DI. Live counters / usage bars deferred.                                                                                                                                                                                                                                                                                                                                                                                    | Low             | Accepted for v1. Plan §7.6 explicitly defers UI work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GAP-009 | `IntegrationNodeConfigSchema.timeout` change from `max(300)` to `max(1800)` is platform-wide. Workflow nodes other than `extract_document` could accidentally pick very long timeouts.                                                                                                                                                                                                                                                                                                                                                         | Low             | Accepted (FR-6 backwards-compat analysis). Long timeouts are cheap because Restate parking. Designer-facing tooltip recommends conservative values for non-extraction nodes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GAP-010 | The two updated Dockerfiles in the current working tree (`services/docling-service/Dockerfile`, `services/preprocessing-service/Dockerfile`, plus `ecosystem.config.js`) carry pre-existing modifications unrelated to this feature; need triage.                                                                                                                                                                                                                                                                                              | Low             | Open. To be reconciled or noted as base-branch drift before LLD.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GAP-011 | Workflow-engine routes do not currently use `requireProjectPermission` (an existing Studio Next.js-only helper). The platform's `apps/workflow-engine/src/routes/connections.ts` explicitly notes RBAC is not wired in workflow-engine routes. Spec assumes `requireProjectPermission` middleware exists.                                                                                                                                                                                                                                      | Medium          | Open. LLD must either (a) introduce a workflow-engine-compatible Express middleware mirroring Studio's helper and register `integrations:read` / `integrations:write` permissions in RBAC, or (b) accept that v1 ships with `requireTenantProject()`-only scoping (tenant + project isolation) and defers RBAC permission checks to a follow-up.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GAP-012 | `packages/shared-encryption/src/encryption-manifest.ts` carries a per-queue entry for every queue today (`'search-docling-extraction': { fieldsToEncrypt: [] }`). The new `workflow-docling-extraction` queue needs an analogous entry — missing entries can trigger validation warnings or break future encryption-at-rest enforcement.                                                                                                                                                                                                       | Low             | Open. Add `'workflow-docling-extraction': { fieldsToEncrypt: [] }` to the manifest as part of FR-7 implementation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GAP-013 | Azure DI circuit breaker is in-process (per-tenant, per-pod). State is lost on pod restart; in a multi-pod deployment each pod has its own breaker so N pods allow N×threshold failures before all breakers open.                                                                                                                                                                                                                                                                                                                              | Low             | Accepted for v1 (FR-17c). v2 migration path: `@agent-platform/circuit-breaker` (Redis-backed). Triggered when multi-pod workflow-engine becomes the norm or when telemetry shows persistent Azure 5xx storms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| GAP-014 | Restate 1.6.2 server doesn't reliably re-dispatch a suspended workflow `run` after a `workflow.shared` handler resolves a durable promise (`sys:callback:STEPID`, `sys:approval:STEPID`, `sys:human_task:STEPID`). Once Restate suspends a handler (after `inactivity_timeout` of idle), subsequent resolutions succeed at the Restate level but don't wake the suspended invocation, so the workflow record stays at `waiting_callback`/`waiting_approval`/`waiting_human_task` forever. Reproducible on develop branch with a fresh Restate. | ~~HIGH~~ CLOSED | **Root-cause fixed (2026-05-20, relay-race refactor)**: Replaced Restate `workflow.run` awakeable suspension entirely with a MongoDB `parkStep` + `startWorkflow` relay model. Every execution slice runs as a short-lived exclusive `restate.object()` handler (`workflow-executor`). Async wait sites write `{ parkPoint: true, nextStepIds, callbackSecret }` to MongoDB and return cleanly; callback routes read `parkPoint` and dispatch the next relay via `startWorkflow()`. No Restate journal dependency for suspension. Intermediate awakeable fix (2026-05-18, commits `20391e22f5`, `d65d4716ab`) superseded. All 6 trigger paths now go through `relayStartWorkflow()`. `RELAY_RACE_DISABLED=true` env var restores legacy path for emergency rollback. |
| GAP-015 | `auth.type='none'` connectors (Docling) need a `connectionId` on workflow steps for the engine's `connectionResolver` to honor the step, but there's no AuthProfile to pick. Studio's IntegrationNodeConfig auto-binds a synthetic `system-<connector>-none` sentinel; `connection-resolver` resolves the sentinel via a regex-guarded `authProfileId` lookup, preserving tenant + project isolation.                                                                                                                                          | Low             | **Closed** in `a1c12c84e` + `fd2d8a0c9` + `82367ef4e`. Documented behavior; UI hides the picker, resolver accepts the sentinel only when it matches `^system-[a-z0-9-]+-none$` AND the same tenant+project owns an active ConnectorConnection with that `authProfileId`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GAP-016 | Test coverage at the data-flow boundary level is incomplete: no regression tests for (a) auth-profile POST/PATCH live-validate failure cleanup, (b) empty-body `/execute` 202 path, (c) `connection-resolver` sentinel tenant/project isolation. Currently no security regression risk, but a future change could silently break any of these.                                                                                                                                                                                                 | Medium          | Tracked from data-flow audit R3-R5 (findings F-V1-1, F-V4-1, F-V5-1). Scheduled for BETA hardening.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GAP-017 | `system-human-task-store.test.ts` lines 275, 303, 331, 358 use stale 3-argument `findBySource` signature — must be updated to pass `projectId` as second argument.                                                                                                                                                                                                                                                                                                                                                                             | Medium          | Open. Discovered in data-flow audit Round 2 (F-5.7). Tests compile but query without `projectId` filter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GAP-018 | `workflow-callbacks.test.ts:162` stale test expects 403 for private IP but route has no IP blocking — test must be removed or corrected.                                                                                                                                                                                                                                                                                                                                                                                                       | Medium          | Open. Discovered in data-flow audit Round 2 (BT-8). Test is asserting non-existent behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GAP-019 | GET listing route for pending approvals described in `workflow-approvals.ts` JSDoc header but not implemented.                                                                                                                                                                                                                                                                                                                                                                                                                                 | Medium          | Open. Stale JSDoc from planning phase. Route was intentionally deferred; JSDoc should be updated to reflect.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GAP-020 | Missing boundary test — rate limiter 429 behavior untested (`createCallbackRateLimit`).                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Medium          | Open. Discovered in data-flow audit Round 2 (BT-1). Rate limiter is wired and functional but has no regression test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GAP-021 | Missing boundary test — step-level `STEP_SENSITIVE_FIELDS` stripping (`callbackSecret`, `parkPoint`, `awakeableId`) not verified in any test.                                                                                                                                                                                                                                                                                                                                                                                                  | Medium          | Open. Discovered in data-flow audit Round 2 (BT-2). Security-critical stripping has no regression coverage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| GAP-022 | Missing boundary test — `inputSnapshot` absent from GET /executions response not verified in any test.                                                                                                                                                                                                                                                                                                                                                                                                                                         | Medium          | Open. Discovered in data-flow audit Round 2 (BT-3). `inputSnapshot` is stripped from responses but no test asserts absence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| GAP-023 | `docker-compose.override.yml` not in `.gitignore` — risk of accidental commit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Low             | Open. File is currently untracked (`git status` shows `??`). Should be added to `.gitignore`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| F-WS-1  | Strip set parity — `PUBLISH_SENSITIVE_STEP_FIELDS` (Redis pub-sub) and `SNAPSHOT_STEP_SENSITIVE_FIELDS` (WS snapshot) had only 2 fields vs `STEP_SENSITIVE_FIELDS` (REST API) 11 fields. Internal step data (parkPoint, nextStepIds, rejectStepIds, joinStepId, barrierTotal, barrierCount, barrierFailCount, branchId, failureStrategy) leaked over WS and Redis pub-sub channels.                                                                                                                                                            | ~~HIGH~~ CLOSED | **Fixed (2026-05-21)**: All three strip sets now contain the same 11 fields. Discovered during PR review Round 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| F-CB-1  | Legacy callback route `/api/v1/workflows/callbacks/:executionId/:stepId` still unscoped by tenantId. HMAC signature verification prevents unauthorized access but route does not enforce tenant isolation at the DB query level.                                                                                                                                                                                                                                                                                                               | Medium          | Open. TODO deprecation added. Safe due to HMAC + per-step secret. Tracked for v2 route hardening.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| F-RJ-2  | No `onTimeout: 'reject'` routing in timeout enforcer — step timeout always terminates or skips, never routes to reject path.                                                                                                                                                                                                                                                                                                                                                                                                                   | Medium          | Open. Out of scope for Phase 5. Requires design discussion on timeout-as-decision semantics.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| F-2     | Timeout `startWorkflow` for Restate-native exact timer is outside `restateCtx.run()`. Duplicate timer on replay. CAS guard prevents data corruption.                                                                                                                                                                                                                                                                                                                                                                                           | Low             | Accepted as non-blocking per PR review Phase A. CAS guard prevents data impact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Mitigated since last sync (2026-05-21, data-flow audit Round 3 + PR review Phase A):**

- **F-WS-1 (was HIGH)**: Strip set parity — WS/Redis pub-sub strip sets had only 2 fields vs REST API's 11. Fixed: all three sets now contain 11 fields.
- **F3 (was MEDIUM)**: Test drift — stale mock entries in auth-profile-resolver and search-ai shared.js mocks. Fixed in commits `5fc3578d37` through `f974c03ea8`.
- **SEC-10 (was MEDIUM)**: Docling worker missing callbackUrl hostname validation (ADI had it). Fixed: `extraction-only.ts` now validates hostname against `WORKFLOW_ENGINE_PUBLIC_URL`.

**Mitigated since last sync (2026-05-20, data-flow audit Rounds 1-2):**

- **F-1 (was MEDIUM)**: Callback route execution enumeration → rate limiter added (`createCallbackRateLimit`, 120 req/60s per IP). Wired before JSON parser + DB access.
- **F-5 (was MEDIUM)**: `findBySource` missing `projectId` → fixed across all callers (`HumanTaskStoreLike`, `MongoHumanTaskStore`, `syncHumanTaskOnResolve`, `ensureHumanTaskMirror`, `finalizeHumanTaskOnTimeout`). `projectId` now in MongoDB filter.
- **Relay-race implementation bugs (were HIGH)**: ConnectorActionDeps not configured in relay-race `executeLeg`, end step displaying pending after workflow completion, `ensureHumanTaskMirror` not called in relay path, `callbackRequest` not checked in `needsSuspension` — all fixed in commits `5d20dd4f14` through `0a5a0da3ab`.

---

## 17. Testing & Validation

> **Canonical test spec**: [`../testing/document-extraction-integrations.md`](../testing/document-extraction-integrations.md) (committed 2026-05-15). The table below is a summary; the test spec defines the authoritative E2E (13), integration (16), unit (10), and security/isolation (15) scenarios with full preconditions, steps, expected results, auth context, and FR-to-test-file mapping.
>
> **Implementation status (2026-05-20):** core happy-path verified end-to-end. Docling and Azure DI both complete on a fresh Restate stack. Approval workflows confirmed via Studio inbox. **Relay-race refactor (2026-05-20):** replaced Restate `workflow.run` awakeable suspension with MongoDB `parkStep` + `startWorkflow` relay model. Every execution slice runs as a short-lived exclusive `restate.object()` handler (`workflow-executor`). All 6 trigger paths (TriggerEngine, TriggerScheduler, ConnectorTriggerEngine, webhook router, polling worker, connector webhook router) now go through `relayStartWorkflow()` — no execution path uses the legacy `workflow.run` handler for new executions. Terminology cleanup: "leg" replaced with `executeWorkflow`, `WorkflowRunInput`, `WORKFLOW_EXECUTOR_SERVICE_NAME`, `runCounter`. Data-flow audit (Round 1 + Round 2, 2026-05-18 through 2026-05-20) found and fixed all CRITICAL/HIGH findings; remaining MEDIUM/LOW boundary-test gaps tracked in §16. **Test counts (2026-05-20):** 1045 unit/integration tests passing, 0 failures. Boundary tests added: HMAC rejection (`workflow-callbacks.test.ts:144`), `findBySource` projectId isolation (`human-task-resolution-routes.test.ts:109`, `workflow-approvals.test.ts:203`). Missing boundary tests documented as GAP-020 through GAP-022.
>
> **Deviations from original plan**: (1) ADI originally planned as inline polling inside Restate handler — changed to BullMQ poll worker in `apps/workflow-engine/src/services/adi-poll-worker.ts` for production-grade memory isolation. (2) Docling pages filter removed (`d4c0da7593`) — was in-memory post-extraction filter with no effect on Azure-side load. (3) `callbackContext` forwarding into `ctx.abl` for AP-format pieces added (`8337493377`) — required because Docling (native piece, inside connectors package) reads `callbackContext` directly from `ActionContext` while ADI (AP-format piece in separate package) reads via `ctx.abl`. (4) Relay-race refactor (2026-05-20): awakeable suspension approach (2026-05-18) superseded by MongoDB `parkStep` + relay model to fully eliminate Restate journal dependency for async waits. (5) Approval rejection routing, data-entry parity, Restate-native exact timer, StuckExecutionSweeper, HumanStepTimeoutEnforcer, hasHumanWait field, strip set parity fix (F-WS-1), SEC-10 Docling hostname validation, Studio canvas edge fixes — all landed 2026-05-21 (see section 15b).
>
> **Test counts (2026-05-21):** 1280 unit/integration tests passing (up from 1045), 0 failures. 155 HTTP/integration tests passing (up from 71). Strip set parity (F-WS-1) now covered. callbackUrl at-rest encryption covered (Round 2 fix + test). Remaining boundary test gaps: rejectStepIds stripping from REST, hasHumanWait persistence, computeExecutionEdges data_entry. New test files: `workflow-executions-routes.test.ts` (relay-race assertions), `execution-store.session.test.ts` (terminal status findOneAndUpdate).

### Required Test Coverage

| #   | Scenario                                                                                                                                                           | Coverage Type | Status     | Test File / Note                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| 1   | Docling workflow happy-path: enable toggle → run workflow with PDF URL → envelope `provider==='docling'`, pageCount > 0, markdown present                          | e2e           | NOT TESTED | `apps/studio/e2e/workflows/document-extraction-docling.spec.ts`                                |
| 2   | Azure DI workflow happy-path: AuthProfile registration → run with XLSX URL → envelope `provider==='azure-document-intelligence'`, tables present                   | e2e           | NOT TESTED | `apps/studio/e2e/workflows/document-extraction-azure-di.spec.ts`                               |
| 3   | Project toggle gating: disable mid-workflow → `INTEGRATION_DISABLED`; re-enable → next run succeeds                                                                | e2e           | NOT TESTED | (same file as #1)                                                                              |
| 4   | Cross-provider parity: same PDF through both connectors → identical pageCount, markdown length within 10 %                                                         | e2e           | NOT TESTED | `apps/studio/e2e/workflows/document-extraction-parity.spec.ts`                                 |
| 5   | SSRF rejection: URL `http://169.254.169.254/...` → `SSRF_BLOCKED`; no BullMQ job enqueued                                                                          | e2e           | NOT TESTED | (same file as #1)                                                                              |
| 6   | Large file: 50 MB PDF completes within schema timeout; worker RSS delta < 10 MB                                                                                    | e2e           | NOT TESTED | `apps/studio/e2e/workflows/document-extraction-large-file.spec.ts`                             |
| 7   | Two-queue isolation: saturate ingestion → workflow jobs still drained at Worker B's full rate; per-queue active-job counters never exceed reserved limits          | e2e           | NOT TESTED | `apps/studio/e2e/workflows/document-extraction-two-queue-isolation.spec.ts`                    |
| 8   | Search-AI default-flag invariant: existing search-AI ingestion E2E suite runs against new worker — bit-for-bit identical to pre-change baseline                    | e2e           | NOT TESTED | Existing suite re-runs as part of CI                                                           |
| 9   | Restate replay: engine pod restart between enqueue and callback → workflow resumes from journal; exactly one Docling call + exactly one callback consumed          | e2e           | NOT TESTED | `apps/studio/e2e/workflows/document-extraction-restate-replay.spec.ts`                         |
| 10  | Engine memory invariant: 1000 simultaneously parked steps → pod RSS delta < 50 MB                                                                                  | integration   | NOT TESTED | `apps/workflow-engine/src/__tests__/workflow-docling-parking.test.ts`                          |
| 11  | Worker callback POST round-trip: `{ callbackId, status, envelope }` → callback route resolves parked promise → step output equals posted envelope                  | integration   | NOT TESTED | `apps/workflow-engine/src/__tests__/workflow-docling-callback-roundtrip.test.ts`               |
| 12  | Worker full-ingestion branch unaffected when `mode` omitted                                                                                                        | integration   | NOT TESTED | `apps/search-ai/src/__tests__/workflow-docling-extraction-worker.test.ts`                      |
| 13  | Azure DI 429 with `Retry-After` honored during polling                                                                                                             | integration   | NOT TESTED | `packages/connectors/piece-azure-document-intelligence/src/__tests__/extract-document.test.ts` |
| 14  | Azure DI replay safety: forced engine-restart between `:analyze` POST and result → polling resumes same Azure operation; exactly one invoice generated             | integration   | NOT TESTED | (same file as #13)                                                                             |
| 15  | Azure DI `ctx.store` cleanup: on success and on terminal failure, the key is deleted; no orphan keys accumulate                                                    | integration   | NOT TESTED | (same file as #13)                                                                             |
| 16  | ConnectionResolver short-circuit returns empty `auth` for `auth.type === 'none'`                                                                                   | integration   | NOT TESTED | `packages/connectors/src/__tests__/connection-resolver-none.test.ts`                           |
| 17  | System AuthProfile auto-bind idempotent on repeated enable calls (race-tolerant)                                                                                   | integration   | NOT TESTED | `apps/workflow-engine/src/__tests__/docling-toggle-routes.test.ts`                             |
| 18  | PII redaction strips API keys / SSNs from extracted markdown before trace event persistence                                                                        | integration   | NOT TESTED | `apps/workflow-engine/src/__tests__/extraction-pii-redaction.test.ts`                          |
| 19  | Workflow connector enqueues with `attempts: 1`; worker failure surfaces as `EXTRACTION_FAILED` to engine without BullMQ retry                                      | integration   | NOT TESTED | (same as #12)                                                                                  |
| 20  | Streaming memory profile: 100 MB synthetic PDF → worker RSS delta < 10 MB during call                                                                              | integration   | NOT TESTED | (same as #12)                                                                                  |
| 21  | Per-tenant rate limit: 30 sequential enqueues from one tenant → first 10 succeed (burst), next ~5 succeed (refill), remainder `RATE_LIMITED`                       | integration   | NOT TESTED | `apps/workflow-engine/src/__tests__/docling-rate-limit.test.ts`                                |
| 22  | Tenant config override (raise to 100/min) honored on next enqueue without restart                                                                                  | integration   | NOT TESTED | (same as #21)                                                                                  |
| 23  | Azure DI cost-cap atomic `$inc` under concurrency; month-boundary reset; `QUOTA_EXCEEDED` when hard cap reached                                                    | integration   | NOT TESTED | `apps/workflow-engine/src/__tests__/azure-di-usage-routes.integration.test.ts`                 |
| 24  | HMAC callback signature: callback POST without correct `x-callback-signature` rejected with 401                                                                    | integration   | NOT TESTED | (same as #11)                                                                                  |
| 25  | Envelope schema (Zod): both providers produce envelopes that validate against `ExtractionEnvelopeSchema`                                                           | unit          | NOT TESTED | `packages/connectors/src/__tests__/extraction-envelope.test.ts`                                |
| 26  | Content-type sniffer rejects all SSRF-relevant hostnames                                                                                                           | unit          | NOT TESTED | `packages/connectors/src/__tests__/extraction-envelope.test.ts` (or a dedicated SSRF test)     |
| 27  | Auth profile schema: Azure DI config rejects malformed `endpoint`                                                                                                  | unit          | NOT TESTED | `packages/connectors/piece-azure-document-intelligence/src/__tests__/auth.test.ts`             |
| 28  | Timeout calculator returns expected values for boundary sizes (60 s, 1800 s, mid-size scaling)                                                                     | unit          | NOT TESTED | `apps/search-ai/src/__tests__/extraction-timeout.test.ts`                                      |
| 29  | Capacity / load: ramp 5 → 50 concurrent extractions over 10 min via `load-test-analysis` skill; p95 within SLO; Coroot saturation < 80 % on docling pod and worker | manual        | NOT TESTED | Capacity report `docs/sdlc-logs/document-extraction-integrations/load-test-results-<date>.md`  |

### Testing Notes

- All E2E scenarios MUST use HTTP-only interaction (no direct DB writes / reads) per CLAUDE.md.
- No mocking of `@agent-platform/*` or `@abl/*` — only external SaaS calls (Azure DI) may be mocked, via DI in the AP piece's `run()`.
- Docling worker tests have no existing template — closest reference is `apps/search-ai/src/__tests__/text-extraction-integration.test.ts`. New tests create a fresh template.
- E2E suite must include the **pre-change regression baseline** — running the existing search-AI ingestion E2E suite against the modified worker without the feature flag set, asserting bit-for-bit identical behavior.

> Full testing details: [../testing/document-extraction-integrations.md](../testing/document-extraction-integrations.md)

---

## 18. References

- **Source design plan**: `/Desktop/docling-azure-di-integration-plan.md` (2026-05-14, 1008 lines) — author-local desktop path; copy into `docs/plans/document-extraction-integrations.source-plan.md` before LLD so the reference is portable
- **Known divergences from source plan** (deliberate, spec is authoritative):
  - Plan section 3.3 uses `"azure-doc-intelligence"` as the envelope `provider` value; spec uses `"azure-document-intelligence"` (matches the `connectorId` registered in `packages/connectors/src/loader.ts`). Spec wins.
  - Plan §7.1 talks about deterministic BullMQ jobIds for idempotency; spec relies entirely on Restate journal + `ctx.store` for replay safety per FR-11/FR-16. No BullMQ-level dedup is required. Spec wins.
  - Plan describes the Docling worker callback POST without HMAC; spec mandates HMAC per FR-12 because the existing callback route enforces verification (callback-route line 87-129). Spec wins; plan should be updated in next revision.
- **Related feature docs**:
  - [`connectors`](connectors.md) — connector platform (BETA)
  - [`auth-profiles`](auth-profiles.md) — credential layer (BETA)
  - [`multimodal-processing`](multimodal-processing.md) — SearchAI Docling ingestion (ALPHA, shared infra)
  - [`workflow-integration-node`](workflow-integration-node.md) — integration node base (ALPHA)
  - [`audit-logging`](audit-logging.md) — audit envelope (BETA)
  - [`encryption-at-rest`](encryption-at-rest.md) — `TenantEncryptionFacade` (STABLE)
- **Architecture / SDLC reference**:
  - [`docs/sdlc/pipeline.md`](../sdlc/pipeline.md) — SDLC phase order, audit minimums
  - [`docs/feature-matrix.md`](../feature-matrix.md), [`docs/enterprise-readiness.md`](../enterprise-readiness.md)
  - [`docs/2026-03-25-architecture-fitness-remediation-backlog.md`](../2026-03-25-architecture-fitness-remediation-backlog.md) — AF-105 noisy-neighbor (closed by FR-11)
  - [`docs/audit/tenant-isolation-review-2026-03-18.md`](../audit/tenant-isolation-review-2026-03-18.md) — tenant-fairness audit
- **Code anchors (verified 2026-05-15)**:
  - `apps/workflow-engine/src/executors/async-webhook-executor.ts:45-81`
  - `apps/workflow-engine/src/handlers/workflow-handler.ts:2833-2931` (HMAC secret generation + parking pattern)
  - `apps/workflow-engine/src/services/restate-endpoint.ts:90-100` (`handleResolveCallback`)
  - `apps/workflow-engine/src/routes/workflow-callbacks.ts:87-129` (mandatory HMAC verification)
  - `apps/search-ai/src/workers/docling-extraction-worker.ts:153, 585-587, 659-660`
  - `apps/search-ai/src/server.ts:548` (`INGESTION_MAX_CONCURRENT_JOBS`)
  - `packages/shared/src/types/workflow-schemas.ts:31, 162-169, 307`
  - `packages/shared/src/validation/auth-profile.schema.ts:168-175` (`ApiKeyConfigSchema` with `connectionConfig: z.record(z.string(), z.string()).optional()` at line 173) and `:267` (`ApiKeySecretsSchema` carrying the encrypted `apiKey`)
  - `packages/shared-kernel/src/security/ssrf-validator.ts:402` (`validateUrlForSSRF`) and `:454` (`assertUrlSafeForSSRF`) — existing SSRF guard
  - `packages/shared/src/services/mcp-auth-resolver.ts:248-276` (existing RateLimiterRedis pattern)
  - `packages/connectors/src/loader.ts:42-83, 111-116` (`PIECE_PACKAGES`, auth-adapter branches)
  - `packages/connectors/src/adapters/activepieces/auth-adapters/jira-cloud.ts`, `servicenow.ts` (template shims)
  - `packages/connectors/src/registry.ts:21-54`
  - `packages/connectors/piece-shopify/` (template piece layout)
