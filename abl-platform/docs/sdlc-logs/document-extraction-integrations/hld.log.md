# Oracle + Audit Log: Document Extraction Integrations — HLD Phase

**Feature:** document-extraction-integrations
**Phase:** HLD
**Date:** 2026-05-15
**Branch:** `feature/wf/ocrnode`
**Oracle model:** Opus 4.6
**Prerequisite artifacts:**

- Feature spec: `docs/features/document-extraction-integrations.md` (committed `57354b3f2`)
- Test spec: `docs/testing/document-extraction-integrations.md` (committed `ed6080f58`)
- Feature-spec oracle log: `docs/sdlc-logs/document-extraction-integrations/feature-spec.log.md`
- Test-spec oracle log: `docs/sdlc-logs/document-extraction-integrations/test-spec.log.md`

---

## Context Consulted

- `docs/features/document-extraction-integrations.md` (full feature spec, 691 lines)
- `docs/testing/document-extraction-integrations.md` (test spec, 678 lines)
- `docs/sdlc-logs/document-extraction-integrations/feature-spec.log.md`
- `docs/sdlc-logs/document-extraction-integrations/test-spec.log.md`
- `CLAUDE.md` (core invariants, commit discipline, test architecture)
- `docs/specs/workflow-integration-node.hld.md` (integration node HLD, ALPHA)
- `docs/specs/workflow-http-tool-async-completion.hld.md` (async webhook HLD, IMPLEMENTED)
- `docs/specs/connectors.hld.md` (connector platform HLD, BETA)
- `docs/specs/integration-auth-profiles.hld.md` (auth profile integration HLD)
- `docs/specs/workflow-connector-oauth2-dual-auth.hld.md` (dual-auth HLD)
- `apps/workflow-engine/src/handlers/workflow-handler.ts:2820-2940` (HMAC + parking pattern)
- `apps/workflow-engine/src/handlers/step-dispatcher.ts:185-241` (connector_action + tool_call dispatch)
- `apps/workflow-engine/src/executors/connector-action-executor.ts` (synchronous executor)
- `apps/workflow-engine/src/executors/async-webhook-executor.ts` (async webhook executor)
- `apps/workflow-engine/src/routes/workflow-callbacks.ts:54-141` (mandatory HMAC verify)
- `apps/workflow-engine/src/handlers/canvas-to-steps.ts:69,976-987` (integration → connector_action mapping)
- `apps/search-ai/src/workers/docling-extraction-worker.ts:1-200` (existing worker)
- `packages/search-ai-sdk/src/constants.ts` (queue constants: `QUEUE_DOCLING_EXTRACTION = 'search-docling-extraction'`)
- `packages/shared-kernel/src/security/safe-fetch.ts`
- `packages/shared/src/services/mcp-auth-resolver.ts:248-276` (existing RateLimiterRedis pattern)

---

## Oracle Decisions (12 questions, 0 AMBIGUOUS)

### A1: Architecture pattern for the workflow-side Docling integration

**Classification:** DECIDED
**Answer:** Connector action `run()` owns the enqueue + signal logic; workflow-handler owns the parking; the existing `connector_action` step type gains an **optional** async-completion path that mirrors `tool_call` async_wait at `step-dispatcher.ts:210-241`. Specifically:

1. Docling's `extract_document` action `run()` validates SSRF, HEAD probe, rate-limits, generates the HMAC secret inside `ctx.run`, enqueues the BullMQ job, then returns a sentinel like `{ __asyncParking: true, callbackId, callbackTimeoutMs }`.
2. The `connector_action` step dispatcher recognizes the sentinel and returns a `callbackRequest` field on its `StepDispatchResult`.
3. The workflow-handler reads `callbackRequest` and routes to the existing parking machinery: persist `waiting_callback`, persist encrypted callback secret on step record, park on `restateCtx.promise<unknown>('sys:callback:${step.id}').get()` wrapped in `raceCancel(raceTimeout(...))`.

**Why not the existing `async_webhook` executor:** that executor builds an outbound HTTP request with a callback URL injected into the body/headers; here the "outbound call" is a BullMQ enqueue, not an HTTP request from the engine. Shape doesn't fit.

**Why not a new `connector_action_async` step type:** unnecessary complexity. The `connector_action` step type is already wired in `canvas-to-steps.ts:69` and works synchronously; we only need an additive async-completion path on top of it.
**Source:** `step-dispatcher.ts:185-195` (current synchronous dispatch), `step-dispatcher.ts:210-241` (tool_call async_wait precedent to mirror), `workflow-handler.ts:2823-2931` (parking pattern to reuse), `connector-action-executor.ts:66-88` (current synchronous execution).
**Confidence:** HIGH

### A2: BullMQ payload type location + plaintext-HMAC-in-Redis decision

**Classification:** DECIDED
**Answer:** Two sub-decisions:

**(a) Payload-shape location:** Extend `BullMQJobData` in `packages/search-ai-sdk/src/constants.ts` (or co-located type file in the same package). The SDK is the shared contract between workflow-engine (producer) and search-AI (consumer); `apps/search-ai/src/workers/shared.ts` is app-internal and apps don't import from each other.

**(b) Plaintext HMAC secret in Redis:** Class-1 (internal, trusted) for v1. Documented in feature spec section 7 and validated through 5 audit rounds. Ciphertext-at-rest on the workflow-engine step record is unchanged; the per-job plaintext copy in the BullMQ payload exists only so the worker can sign the outbound callback POST. The "encrypted-then-header" pattern used by `async_webhook` exists to protect the secret across an **external** HTTP hop, which we don't have here.

Hardening trigger documented: if threat modeling moves Redis compromise in-scope, switch to encrypt-in-payload + decrypt-in-worker.
**Source:** Feature spec section 7; feature-spec.log.md T3; `workflow-handler.ts:2833-2849`; `packages/search-ai-sdk/src/constants.ts`.
**Confidence:** HIGH

### A3: Expected scale targets (per-pod and cluster)

**Classification:** DECIDED
**Answer:** Provisional v1 targets:

- Cluster-wide concurrent extractions (Docling): 10–25 (2–5 pods × 5 slots/pod).
- Per-pod concurrent extractions (workflow path): 2 (default; env `DOCLING_WORKFLOW_CONCURRENCY`).
- Per-pod concurrent extractions (ingestion path): 3 (default; env `DOCLING_INGESTION_CONCURRENCY`).
- Peak burst per-tenant: 5 instantaneous + 10/min sustained (RateLimiterRedis at FR-11.4).
- p95 wait-in-queue (workflow): < 30 s under expected beta load.
- Peak cluster QPS (workflow extractions): ~1 QPS sustained, ~60/min.

The feature does **not** increase per-pod resource budget — it partitions the existing 5-slot total. Validate during Phase 5 beta soak; if workflow queue depth >50 sustained 10 min, retune split or scale HPA before GA.
**Source:** `server.ts:548`; `docling-extraction-worker.ts:660`; feature-spec.log.md D-U4; feature spec section 12.
**Confidence:** MEDIUM

### A4: Patterns to follow / patterns to deliberately deviate from

**Classification:** DECIDED
**Answer:**

**Follow verbatim (3):**

1. Workflow callback HMAC flow at `workflow-handler.ts:2833-2931` (per-step secret generation inside `ctx.run`, encrypted at rest, parked via `restateCtx.promise().get()` + `raceTimeout`).
2. `RateLimiterRedis` pattern at `mcp-auth-resolver.ts:248-276` (key prefix, `consume(key, 1)`, catch `RateLimiterRes` rejection).
3. AP auth-adapter shim pattern at `auth-adapters/jira-cloud.ts` and `servicenow.ts` — but as a pure data-mapping function (FR-14), NOT a `require.cache` monkey-patch, because Azure DI is a first-party in-repo piece.

**Deliberately deviate (2):**

1. Plaintext HMAC secret in BullMQ payload (vs. encrypted-then-header pattern of `async_webhook`). Justified in A2 and feature spec section 7.
2. Queue naming convention `workflow-docling-extraction` breaks the existing `search-*` prefix (other queues use `search-docling-extraction`, `search-ingestion`, …). Deliberate signal that this queue is workflow-owned, not search-AI-ingestion-owned.

**Source:** `workflow-handler.ts:2833-2931`; `mcp-auth-resolver.ts:248-276`; `auth-adapters/jira-cloud.ts`; `search-ai-sdk/src/constants.ts:9-31`; feature spec section 7.
**Confidence:** HIGH

### A5: Deployment topology — shared fleet vs. dedicated workflow pod

**Classification:** DECIDED
**Answer:** Shared search-AI worker process; two `new Worker(...)` subscriptions on the same pod fleet; reserved per-queue concurrency 3+2 (env-configurable). This is FR-8 and was validated by phase-auditor across 5 rounds.

Trade-off matrix and v2 upgrade triggers (persistent queue skew >30 min, workflow extraction volume >50% of total, repeated workflow-branch crashes disrupting ingestion SLO) are captured in feature spec GAP-005.
**Source:** Feature spec FR-8, section 12; feature-spec.log.md D-T6; GAP-005.
**Confidence:** HIGH

### I1: Direct service / package dependencies

**Classification:** ANSWERED
**Answer:** Runtime depends on (unchanged): `@agent-platform/shared-kernel/security`, `rate-limiter-flexible`, `@activepieces/pieces-framework`, Docling service (port 8080), Restate, MongoDB (`ConnectorConnection`, `AuthProfile`), Redis (BullMQ + `ctx.store` + rate-limiter), `@agent-platform/connectors/executor`, `@agent-platform/connectors/auth`.

Modified additively: `packages/search-ai-sdk/src/constants.ts`, `packages/connectors/src/loader.ts`, `packages/connectors/src/services/connection-resolver.ts`, `packages/connectors/src/services/connection-service.ts`, `packages/shared/src/types/workflow-schemas.ts`, `packages/shared-encryption/src/encryption-manifest.ts`, `apps/search-ai/src/workers/docling-extraction-worker.ts`, `apps/search-ai/src/queues/queue-factory.ts`.

New packages: `packages/connectors/piece-azure-document-intelligence/`, `packages/connectors/src/native/docling/`, `packages/connectors/src/native/extraction-envelope.ts`.

No `@activepieces/pieces-framework` version bump — uses existing APIs.
**Source:** Feature spec section 10; `loader.ts:42-83`.
**Confidence:** HIGH

### I2: Azure DI — SDK vs REST direct

**Classification:** DECIDED
**Answer:** REST direct. The Azure SDKs (`@azure/ai-form-recognizer`, `@azure-rest/ai-document-intelligence`) wrap the `:analyze` + `Operation-Location` poll into a `LongRunningOperation` abstraction that conflicts with `ctx.store`-based Restate replay safety (FR-16) — on replay, the SDK re-fires `:analyze`, causing duplicate Azure invoice.

HTTP transport: `safeFetch` from `packages/shared-kernel/src/security/safe-fetch.ts:158` for the initial `:analyze` POST (SSRF + ttl); standard `fetch` for the polling `GET` to the Azure-provided `Operation-Location` (trusted, HTTPS); `Retry-After` header parsing + exponential backoff inline.
**Source:** Feature spec FR-16; feature-spec.log.md OSS Library Audit round 5; `safe-fetch.ts:158`.
**Confidence:** HIGH

### I3: API contract with upstream consumers (Studio + workflow author)

**Classification:** ANSWERED
**Answer:** Confirmed on all four sub-questions.

(a) `connector-catalog.json` regenerated at build time via `pnpm connectors:generate-catalog` (FR-21); Studio BFF serves it as static JSON via `GET /api/projects/:id/connectors`; both new connectors appear as additive entries.

(b) Azure DI auth + action props auto-render via existing `DynamicActionForm` + `mapProperty` in `runtime-adapter.ts`. Docling has `auth.type === 'none'` so the auth form is skipped. **No Studio form code changes** — only a new IntegrationsCard for the project-level toggle.

(c) Workflow IR shape: `type: integration` with `config.{connectorId, actionName, connectionId, params, paramModes}` per feature spec section 11; maps to `connector_action` step type via `canvas-to-steps.ts:69`.

(d) Output envelope per FR-5: `{ schemaVersion: 1, provider, sourceUrl, contentType, markdown, pages[], metadata, raw? }`. Schema is additive across providers.
**Source:** `workflow-integration-node.hld.md` §6; `canvas-to-steps.ts:69,976-987`; feature spec FR-5, FR-21, section 11.
**Confidence:** HIGH

### I4: Breaking changes

**Classification:** ANSWERED
**Answer:** None — purely additive.

- `IntegrationNodeConfigSchema.timeout` widens `max(300) → max(1800)`; same default of 60; existing workflows continue to validate.
- 5 new project-scoped routes under `/api/projects/:projectId/integrations/...`; no collision.
- Existing callback route `POST /api/v1/workflows/callbacks/:executionId/:stepId` reused unchanged.
- Catalog regeneration: existing entries byte-for-byte identical; new entries appended.
- BullMQ `DoclingExtractionJobData` extends with 5 optional fields; existing producers omit; worker branches on `job.queueName` first; existing branch byte-for-byte unchanged (FR-9).

**Source:** Feature spec FR-6, FR-9, FR-10, FR-21, non-goal #7.
**Confidence:** HIGH

### R1: Top-3 technical risks for v1

**Classification:** DECIDED
**Answer:**

1. **Callback POST delivery failure stranding the workflow step** (HIGHEST). Docling cost incurred once with no result delivered if all 5 retry attempts fail; workflow hangs until `raceTimeout`. Mitigations: 5-retry exponential backoff (1 s→30 s), 404 terminal, `callback_post_failures_total` metric + alert at >0.1%, audit log capture, `raceTimeout`. Owner at HLD level: `apps/search-ai/src/workers/callback-poster.ts` (NEW).
2. **Restate replay >24 h → `ctx.store` expired → Azure DI double-bill** (GAP-006). Mitigations: configurable TTL (`AZURE_DI_OPERATION_STORE_TTL_SECONDS`), cost-cap hard limit (FR-18), audit log for reconciliation. v2: move `Operation-Location` persistence to MongoDB with 7-day retention.
3. **Two-queue reservation enforcement under skewed load** (GAP-005). Mitigations: env-configurable splits, HPA scaling on combined queue depth, per-queue depth alerts. Operational issue, not a correctness issue. v2 upgrade: work-stealing scheduler or BullMQ Pro Groups.

**Source:** Feature spec section 12 failure-mode table; GAP-005, GAP-006; FR-9e, FR-16.
**Confidence:** HIGH

### R2: Data migration

**Classification:** ANSWERED
**Answer:** No migration required. All schema changes are additive (optional `ConnectorConnection` usage fields, optional BullMQ payload fields, widened `IntegrationNodeConfigSchema.timeout` max). No new MongoDB collections; no new indexes (existing `{tenantId, projectId, connectorName}` compound index sufficient). Docling synthetic AuthProfile created on demand.
**Source:** Feature spec section 9; FR-3, FR-10, FR-15, FR-18.
**Confidence:** HIGH

### R3: Rollback strategy

**Classification:** DECIDED
**Answer:** Flip `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED=false` and rolling-restart workflow-engine + Studio pods.

Edge-case handling:

- **In-flight workflows already past step dispatch:** complete normally (worker doesn't re-check the flag; callback route doesn't either — by design, since the GPU work was already paid for).
- **New workflow runs hitting the step:** fail with `FEATURE_DISABLED` at step dispatch.
- **BullMQ queue:** no manual drain needed. Existing jobs process to completion; new producers are gated, so the queue naturally idles.
- **Studio client cache:** the catalog is fetched fresh on each `IntegrationNodeConfig` mount; the next page load picks up the disabled state. No long-lived cache to flush.

Residual data (`ConnectorConnection` records for Docling/Azure DI) is harmless — Docling has no credentials, Azure DI credentials remain encrypted. Optional cleanup post-rollback.
**Source:** Feature spec FR-22; `apps/studio/src/lib/feature-resolver.ts`; `workflow-integration-node.hld.md` §6.
**Confidence:** HIGH

---

## Decisions Summary (DECIDED items)

| #    | Decision                                                                                                                                                                        | Rationale                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| D-A1 | Connector action `run()` owns enqueue+signal; workflow-handler owns parking; `connector_action` step type gains optional async-completion path (mirrors `tool_call async_wait`) | Reuses existing infra; matches `tool_call` precedent at `step-dispatcher.ts:210-241`   |
| D-A2 | BullMQ payload type in `packages/search-ai-sdk`; plaintext HMAC in payload for v1                                                                                               | SDK is shared contract; Redis is internal/trusted; documented deviation                |
| D-A3 | 2 workflow slots/pod, 10-25 cluster concurrent, ~1 QPS sustained; provisional pending beta soak                                                                                 | Preserves per-pod total; no production data yet                                        |
| D-A4 | Follow HMAC, RateLimiterRedis, AP auth shim; deviate on plaintext-in-Redis and `workflow-*` queue prefix                                                                        | Deviations are deliberate and auditor-validated                                        |
| D-A5 | Shared search-AI fleet with 3+2 reserved-concurrency split                                                                                                                      | Avoids ~2 GB image duplication; single HPA; sufficient isolation                       |
| D-I2 | Azure DI REST direct; no SDK                                                                                                                                                    | SDK's `LongRunningOperation` conflicts with `ctx.store` replay safety                  |
| D-R1 | Risk ranking: callback delivery > ctx.store expiry > queue skew                                                                                                                 | Matches failure-mode-table severity ordering                                           |
| D-R3 | Rollback: flag flip + rolling restart; in-flight workflows complete; queue drains naturally                                                                                     | Flag gates all entry points; deliberate decision to let in-flight extractions complete |

---

## Escalations to user

**None.** All 12 oracle questions resolved without AMBIGUOUS. Proceeding to HLD generation.

---

## Audit Log

### Round 1 — NEEDS_REVISION (1 CRITICAL, 3 HIGH, 5 MEDIUM, 2 LOW/NIT)

**CRITICAL — fixed:**

- **HD-5:** The `callbackRequest` field on `StepDispatchResult` and the `hasSuspension()` update were never specified. **Fix:** new §3.2.1 "Workflow-engine integration points (NEW)" added with the typed `callbackRequest` shape, the `hasSuspension()` diff, the new suspension block placement (mirrors `toolRequest` at `workflow-handler.ts:2976-3035`), and a DI-path note for the connector action's access to `encryptSecret` + ids + URL builder.

**HIGH — fixed:**

- **HD-4 (DNS-pinning attribution):** corrected — `assertUrlSafeForSSRF` is **static** URL analysis; DNS pinning lives in `safeFetch` at `safe-fetch.ts:2-6,138-146`. Worker streaming helper + Azure DI piece MUST use `safeFetch`; raw `fetch` would defeat the pinning. Updated §4.1 concern 4, Open Question #2, and the §3.3/§3.4 data-flow steps.
- **HD-6 (HMAC secret DI path):** §3.2.1 now explicitly documents the dependency-injection path for `encryptSecret`/`tenantId`/`executionId`/`stepId`/callback-URL-builder into the connector action's `run()` (deliberate deviation from handler-owns-secret pattern), with two LLD-pick options.
- **HD-2 (Option C strawman):** replaced with "Direct Restate handler with `ctx.run`-journaled Docling call" — a viable alternative whose dominant disqualifier is journal-bloat from 50 MB envelopes, not invariant violation.

**MEDIUM — fixed:**

- **HD-10:** §6.1 GAP-011 internal contradiction resolved — v1 ships with `requireTenantProject()`-only scoping; `integrations:read|write` reserved for v2. Removed the permission strings from the routes table. Open Question #1 marked resolved.
- **HD-7:** §7.4 now states ciphertext-at-rest on the step record is the canonical recovery path on replay; BullMQ plaintext is consumed exactly once.
- **HD-3:** §3.5 sequence diagram corrected — added a `DocURL` column; HEAD probe now arrows engine → DocURL, not engine → worker.
- **HD-8:** §4.3 concern 11 rollback plan now flags `IntegrationNodeConfigSchema.timeout.max(1800)` as a one-way schema widening not reverted by the feature flag.
- **HD-9:** §4.2 concern 7 cross-references feature-spec GAP-006 explicitly; v2 mitigation gated by usage threshold (>1000 extractions/day/tenant).

**LOW/NIT — fixed:**

- §0 clarified Azure DI cost cap is per-(project, connection); per `{tenantId, projectId, connectorName}` compound index, projects are expected to have at most one connection but the math is per-connection.

**Deferred / accepted as-is:**

- §3.2 `branches/` subdirectory note — non-blocking, search-ai agents.md will pick this up at LLD.

### Round 2 — NEEDS_REVISION (0 CRITICAL, 2 HIGH, 4 MEDIUM)

All 10 Round 1 findings verified fixed.

**HIGH — fixed:**

- **HD-5a (internal auth contradiction):** §4.1 concern 1 still referenced `requireProjectPermission(...)`. Fix: replaced with `requireTenantProject()` for v1 consistent with §6.1.
- **HD-3a (line reference for suspension block insertion):** §3.2.1(c) said "around line 3035" — that's _inside_ the `toolRequest` retry loop. Fix: corrected to "after line 3196/3197 (`toolRequest` closing brace) and before line 3199 (cancellation check)". Verified via Read.

**MEDIUM — fixed:**

- **HD-4a (raw `fetch` for Operation-Location polling):** §3.4 step 4.g now includes a 3-line comment explaining the raw `fetch` is acceptable for the Azure-provided URL (DNS-pinning defence is for the user-controlled `fileUrl`, covered by `safeFetch` on the `:analyze` POST).
- **HD-4b (month-boundary CAS loser path):** §4.1 concern 2 now documents the two-step pattern: attempt CAS reset → on `matched === 0` fall through to `$inc`. Guarantees exactly-one-reset for all concurrent threads.
- **HD-6a (Azure DI counter reset via connection delete/recreate):** added §9 Open Question #9 acknowledging the gap and recommending feature-spec `GAP-014` (Severity: Low). v2 mitigation = standalone usage-counter collection keyed by `{tenantId, projectId, connectorName, yearMonth}`.
- **HD-12a (test-strategy mandates):** §4.3 concern 12 now names the **out-of-process fixture servers** (Docling port 8088, Azure DI random port, managed by Playwright `globalSetup`/`globalTeardown`), the mandatory **`WIRING-1`** and **`FORM-ERR-1..4`** scenarios, and the `nock`-restricted-to-integration policy.

**Cross-phase note (advisory, not blocking):** feature spec's API table (`docs/features/document-extraction-integrations.md` lines 184-188) still uses `'integrations:read'` / `requireProjectPermission(...)` strings. HLD §6.1 is the authoritative v1 decision (`requireTenantProject()`-only). The `/post-impl-sync` phase should reconcile the feature spec.

### Round 3 — APPROVED (0 CRITICAL, 0 HIGH, 3 MEDIUM — all cross-phase reconciliation deferred to `/post-impl-sync`)

All Round 2 findings verified fixed. Cross-phase consistency check passed. All 12 oracle decisions faithfully reflected. All 22 FRs reachable. Code anchors (line 3196/3197/3199, `hasSuspension()` at 3896-3903, `StepDispatchResult` at 109-139, `safeFetch` at 138-146, `assertUrlSafeForSSRF` at 454, `workflow-callbacks.ts` at 54-141) all verified.

**MEDIUM findings deferred to `/post-impl-sync` (not HLD blockers):**

- **HD-M1 (cosmetic numbering):** §9 had items 1-5, then 9, then 6-8. **Fixed** in this round — renumbered sequentially 1-9.
- **XP-3a (feature-spec API table drift):** feature spec lines 184-188 still use `integrations:read|write` permission strings. HLD §6.1 is the v1 authoritative decision (`requireTenantProject()`-only). Defer to `/post-impl-sync`.
- **XP-3b (test-spec AUTHZ-1/SEC-4/SEC-5 drift):** test spec expects 403 for `integrations:write`-lacking roles; v1's `requireTenantProject()`-only auth would not produce 403. Defer to `/post-impl-sync` (mark as v2-gated) or address at LLD.

**Final verdict:** the HLD is APPROVED and ready for `/lld document-extraction-integrations`. The auditor explicitly noted: "the artifact is internally consistent, architecturally sound, and faithfully reflects all 12 oracle decisions, all 22 FRs, and the code anchors verified against the live codebase."

**Audit summary:**

| Round | Verdict        | Findings (C/H/M/L) |
| ----- | -------------- | ------------------ |
| 1     | NEEDS_REVISION | 1 / 3 / 5 / 2      |
| 2     | NEEDS_REVISION | 0 / 2 / 4 / 0      |
| 3     | **APPROVED**   | 0 / 0 / 3 / 0      |

3 rounds total (HLD playbook minimum: 3). 14 findings resolved across rounds; 3 MEDIUMs deferred to `/post-impl-sync`.
