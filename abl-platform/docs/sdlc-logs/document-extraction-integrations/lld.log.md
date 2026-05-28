# LLD Log — document-extraction-integrations

**Feature spec**: `docs/features/document-extraction-integrations.md` (committed `57354b3f2`)
**HLD**: `docs/specs/document-extraction-integrations.hld.md` (committed `e44e28285`)
**Test spec**: `docs/testing/document-extraction-integrations.md` (committed `ed6080f58`)
**LLD**: `docs/plans/2026-05-15-document-extraction-integrations-impl-plan.md`
**Jira**: ABLP-1073
**Target branch**: `feature/wf/ocrnode`

---

## Phase 2 — Oracle decisions (clarifying questions)

Spawned `product-oracle` agent with 20 questions across Implementation Strategy / Technical Details / Risk & Dependencies. Net AMBIGUOUS: **0** — proceeded immediately to generation. Full oracle output preserved below; the LLD's `Design Decisions` table reflects the DECIDED rows here.

### DECIDED rows (drive LLD design decisions)

| #    | Decision                                                                                                                                                                                        | Rationale source                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| D-A1 | Wire `callbackRequest` handler suspension block in **Phase 1**, not Phase 2.                                                                                                                    | Feature spec §13 Phase 1 title; needed for end-to-end testability before Phase 2 producer. |
| D-A2 | Split Phase 1 into **2 commits**: (1) search-ai + sdk + shared-encryption; (2) workflow-engine + shared.                                                                                        | CLAUDE.md 3-package max per commit.                                                        |
| D-A3 | `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED` gates **all 3 layers**: connector registration, new routes, Worker B subscription.                                                               | FR-22.                                                                                     |
| D-A4 | Phase 1 acceptance uses integration tests + fixture Docling server (no throwaway CLI).                                                                                                          | Test spec §3 integration scenarios.                                                        |
| D-B1 | Connector action receives `callbackContext` via **augmented `ActionContext`** (Option 1), not a helper module.                                                                                  | Consistent with how `ctx.store` is exposed; additive to AP shape.                          |
| D-B2 | Connector returns **sentinel object** `{ __asyncParking: true, ... }`; `connector-action-executor` recognizes it and converts to `StepDispatchResult.callbackRequest`.                          | HLD §3.3 step 3.h; avoids special exception control flow.                                  |
| D-B5 | **Test-first** for Phase 1 callback round-trip; **test-after** for Phase 3 normalizers.                                                                                                         | Callback/replay correctness is the dominant invariant.                                     |
| D-B6 | `ExtractionEnvelopeSchema` lives in `packages/connectors`; extended job-data type moves to `packages/search-ai-sdk`.                                                                            | Avoid cross-app dependency from `packages/connectors` → `apps/search-ai`.                  |
| D-C1 | **Top-2 risks**: (1) streaming helper not actually streaming (safeFetch rejects streaming request bodies); (2) handler suspension block colliding with existing `toolRequest`/`webhookRequest`. | safe-fetch.ts:403; workflow-handler.ts:2820–3197.                                          |
| D-C6 | **Rollback drill** is a Phase 4 exit criterion (automated `document-extraction-rollback.spec.ts`).                                                                                              | Documentation insufficient — drill proves rollback works under multi-system coordination.  |
| D-C7 | Phase 1 budgets a **delay-configurable fixture Docling server** under `apps/search-ai/src/__tests__/fixtures/`.                                                                                 | Two-queue isolation under saturation needs deterministic timing.                           |

### ANSWERED (informational, fed into LLD)

- **B3** — HMAC secret generation happens inside connector `run()` (NOT inside `restateCtx.run`); replay safety comes from the step-level dispatch re-running on replay.
- **B4** — `safeFetch` returns a stream-capable `Response` (`Readable.toWeb(res)`), so the **inbound** URL fetch streams. The **outbound** POST to Docling cannot use `safeFetch` for the body (`normalizeBody` throws on streaming bodies). Use Node `http.request` or `undici.request` for the multipart POST.
- **B6** — Add `WorkflowDoclingExtractionJobData extends DoclingExtractionJobData` in `packages/search-ai-sdk/src/types.ts`; existing field shape stays untouched.
- **B7** — `ConnectorConnection` Mongoose schema does **not** declare the cost-cap fields; LLD must add them (typed) on the schema for IConnectorConnection type safety. `packages/database` becomes a touched package in Phase 3.
- **B8** — `encryption-manifest.ts` entry shape: `'workflow-docling-extraction': { fieldsToEncrypt: [] }` (mirror of existing `'search-docling-extraction'` entry at line 34).
- **C2** — **Critical Phase 3 blocker**: `ctx.store` in the workflow-engine composition root is wired to `NOOP_STORE` (apps/workflow-engine/src/index.ts:952–959; connector-tool-executor.ts:34–38). Azure DI's replay safety silently no-ops until `kvStore` is wired through `ConnectorDepsFactory` → `ConnectorToolExecutor` from Restate's `ctx.objectStore`. The `wrapStore` bridge at context-translator.ts:57–70 already exists.
- **C3** — `prom-client` is not currently in use in either `apps/search-ai` or `apps/workflow-engine`. **All 12+ metrics in HLD §4.2 are new**; budget Grafana dashboard + alerts in Phase 4.
- **C4** — No `.github/CODEOWNERS`; tag Workflows + Platform Eng reviewers explicitly in PR descriptions.
- **C5** — Definition of done includes backward-compat regression (existing `text-extraction-integration.test.ts` must pass byte-for-byte).
- **A5** — Recent merges to watch on `feature/wf/ocrnode`: PR #1008 (api-to-tool migration; step-dispatcher.ts), PR #891 (parallel_node_executions; workflow-handler.ts), PR #898 (connector-lazy-loading; loader.ts already updated, compatible).

### AMBIGUOUS — escalated to user

None.

---

## Critical findings imported from oracle into the LLD

1. **`safeFetch` streaming-body limitation** (safe-fetch.ts:365–403; `normalizeBody` throws `TypeError('safeFetch does not support streaming request bodies')` at line 403). The streaming helper at `apps/search-ai/src/workers/branches/streaming-url-to-docling.ts` must use raw `http.request` (or `undici.request`) for the outbound multipart POST to Docling. Only the **inbound** user-URL fetch uses `safeFetch`.

2. **`ctx.store` wiring gap** (apps/workflow-engine/src/index.ts:952–959 passes only 3 ctor args to `ConnectorToolExecutor`; connector-tool-executor.ts:34–38 defaults `kvStore` to `NOOP_STORE`). Phase 3 has a dedicated task to wire Restate's `ctx.objectStore` through `ConnectorDepsFactory` and into `ConnectorToolExecutor.kvStore`. Without this, FR-16 (Azure DI Restate-replay safety) is a silent no-op.

3. **`ConnectorConnection` schema gap** (packages/database/src/models/connector-connection.model.ts:19–34, 38–56). The four cost-cap fields (`usageCount`, `usagePeriodStart`, `usageSoftCap`, `usageHardCap`) are not declared. Add them as optional typed fields in Phase 3 — adds `packages/database` to that phase's commit scope.

---

## Phase 4–4b — Audit rounds

### Round 1 — Architecture compliance (lld-reviewer)

Verdict: **NEEDS_REVISION** → fixes applied → resolved.

| Severity | Finding                                                                                                                                                           | Resolution                                                                                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | Azure DI `ctx.executionId` is `crypto.randomUUID()` per call — `ctx.store` key differs on replay; FR-16 silently fails.                                           | Added **D-9b** + Task 1.12 / 1.13 / 1.13b: thread `workflowExecutionId` + `stepId` through `ExecutorContext` → `ActionContext`. Phase 3 Task 3.5 step 6 hard-fails if either is undefined. Wiring checklist gained a dedicated row. |
| CRITICAL | Integration routes scheduled to mount at `apps/workflow-engine/src/index.ts:1225` — the **unauthenticated** callback section. Would break `requireTenantProject`. | Added **D-17**: mount on the authenticated `projectRouter` (around line 1342). Phase 2 Task 2.8 + Phase 3 Task 3.11 rewritten. Wiring checklist row corrected.                                                                      |
| HIGH     | `ctx.store.set(key, value, { ttlMs })` is wrong — actual `KeyValueStore.set(key, value, ttlMs?: number)` takes positional number.                                 | Phase 3 Task 3.5 step 7 corrected to positional argument.                                                                                                                                                                           |
| HIGH     | Azure DI breaker `Map` has no max size — CLAUDE.md "every in-memory Map needs max size + TTL + eviction."                                                         | Phase 3 Task 3.4 now specifies `MAX_BREAKER_ENTRIES = 10_000` with oldest-`lastFailureAt` eviction; cancellable `setInterval`; `destroyCircuitBreaker()` exported.                                                                  |
| HIGH     | Azure DI `findOne` / `updateOne` queries used ambiguous `{ _id, ... }` — must explicitly include `tenantId` (and `projectId`).                                    | Phase 3 Task 3.5 steps 1 and 12 rewritten with explicit `{ _id, tenantId, projectId, status }`.                                                                                                                                     |
| HIGH     | Toggle/usage routes returned raw payloads (`{ limitPerMinute, ... }`) — not the platform `{ success, data?, error? }` envelope.                                   | All 5 routes rewritten to use `{ success: true, data: ... }` / `{ success: false, error: ... }`.                                                                                                                                    |
| HIGH     | No Zod `.safeParse()` validation on the new route params/bodies.                                                                                                  | Phase 2 Task 2.8 + Phase 3 Task 3.11 explicitly call out Zod schemas (`projectId: z.string().min(1)`; PATCH body schema; `.strict()` on payloads).                                                                                  |
| MEDIUM   | `FEATURE_DISABLED` returns 403 — leaks feature presence.                                                                                                          | Added **D-18**: HTTP 404 instead of 403 (consistent with CLAUDE.md "404 never 403" principle generalized to gated features).                                                                                                        |
| MEDIUM   | Pre-existing callback route `findOne({ _id: executionId })` lacks tenant scoping (HMAC is auth) — risk profile changes with extraction traffic.                   | Acknowledged as a pre-existing pattern; logged as a Phase-5 hardening follow-up (callback route could carry tenantId for audit / rate-limit). No change in this LLD.                                                                |
| MEDIUM   | Circuit breaker `setInterval` leaks on test teardown / module hot-reload.                                                                                         | Phase 3 Task 3.4 adds `destroyCircuitBreaker()` exit hook wired to graceful shutdown and `afterAll()`.                                                                                                                              |

Round 1 verdict after fixes: **all CRITICAL + HIGH closed; 1 MEDIUM accepted as pre-existing**. Proceeding to Round 2.

### Round 2 — Pattern consistency (lld-reviewer)

Verdict: **NEEDS_CHANGES** → fixes applied → resolved.

| Severity | Finding                                                                                                                                                      | Resolution                                                                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HIGH     | Callback poster reinvented HMAC signing — `computeWebhookSignature` / `buildSignatureHeaders` already in `@agent-platform/shared-kernel/security`.           | Phase 1 Task 1.7 rewritten to import `computeWebhookSignature(secret, body, timestamp)`. Headers reuse `x-callback-*` names (callback route accepts both `x-callback-*` and `x-webhook-*` via `getHeader()` fallback).                         |
| HIGH     | Azure DI piece referenced `ctx.connectionId` but `ActionContext` had no such field.                                                                          | Phase 1 Task 1.12 + 1.13 add optional `connectionId?` on `ActionContext` (mirror of `TriggerContext.connectionId` at `packages/connectors/src/types.ts:166`); `ConnectorToolExecutor.execute` populates it from the resolved connection.       |
| HIGH     | Task 1.13b deferred the executor wiring strategy to Round 2.                                                                                                 | Resolved: extend `connectorDepsFactory(tenantId, projectId, workflowExecutionId?, stepId?)` instead of widening `execute()` arity. Singleton-per-dispatch construction matches existing pattern. Documented as the resolved strategy in 1.13b. |
| MEDIUM   | Worker factory return shape: existing call site is `apps/search-ai/src/workers/index.ts` (NOT `server.ts`); `WorkerEntry[]` expects per-worker registration. | Phase 1 Task 1.9 corrected: return `{ ingestion, workflow }` and register two `WorkerEntry` items. The `docling-extraction-workflow` registration is gated on the feature flag (D-3 layer c).                                                  |
| MEDIUM   | `StepDispatchResult.callbackRequest` is concretely typed while `webhookRequest` / `toolRequest` are `unknown`.                                               | Acceptable as a deliberate improvement; documented in the LLD as intentional. Not changed.                                                                                                                                                     |
| LOW      | Rate-limiter "mirroring" wording vs. existing lazy-init pattern.                                                                                             | Task 2.4 rewritten to "analogous to" with the `if (!redisRateLimiter)` pattern referenced.                                                                                                                                                     |
| LOW      | Mongoose schema defaults inconsistent (`usageHardCap: null` only).                                                                                           | Task 3.10 now also sets `usageSoftCap: { default: null }` for consistency with the model's existing optional-field pattern; `usageCount` and `usagePeriodStart` correctly remain default-less (set atomically by first `$inc` / CAS reset).    |

Round 2 verdict after fixes: **all HIGH/MEDIUM closed; 2 LOWs closed; 1 acceptable-as-deliberate-improvement MEDIUM logged**. Proceeding to Round 3.

### Round 3 — Completeness (lld-reviewer)

Verdict: **NEEDS_REVISION** → fixes applied → resolved.

| Severity | Finding                                                                                                                                                                            | Resolution                                                                                                                                                                                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | Restate SDK mismatch: LLD's `RestateKvStore` targeted `restateCtx.objectStore`, which doesn't exist on `WorkflowContext` (only `sleep`/`run`/`promise`). Restate state has no TTL. | **D-9 revised**: backing changed from Restate state to Redis. New file `apps/workflow-engine/src/services/redis-kv-store.ts` (renamed). Uses `redis.set(key, value, 'PX', ttlMs)` for TTL. Reuses the existing BullMQ Redis connection. Phase 3 Task 3.1 fully rewritten; Open Question #3 resolved. |
| CRITICAL | `WorkflowDoclingExtractionJob` union not reflected in processor parameter type.                                                                                                    | Task 1.9 explicitly widens the processor type to `Job<DoclingExtractionJob>` and narrows in the workflow branch via `mode === 'extraction-only'` discriminator.                                                                                                                                      |
| HIGH     | No i18n strategy for the 3 new Studio components.                                                                                                                                  | New tasks 2.9b (Docling i18n keys) and 3.14b (Azure DI i18n keys) added with explicit key list and namespace `studio`.                                                                                                                                                                               |
| HIGH     | GAP-011 (RBAC) not explicitly resolved in LLD.                                                                                                                                     | Added **D-19** explicitly deferring RBAC to v2; v1 uses `requireTenantProject()`-only scoping. Logged for `/post-impl-sync` to update feature-spec gap status.                                                                                                                                       |
| HIGH     | `parseRetryAfter` helper unspecified.                                                                                                                                              | New task 3.6b adds the helper with signature, RFC 7231 §7.1.3 behavior (integer / HTTP-date / fallback), and 30 s cap. Unit test in `parse-retry-after.test.ts`.                                                                                                                                     |
| MEDIUM   | Worker call-site env wiring needed concrete shape.                                                                                                                                 | Task 1.9 expanded with full `workers/index.ts` snippet including env var reads + WorkerEntry registration block.                                                                                                                                                                                     |
| MEDIUM   | FR-20 audit logging has no dedicated test file.                                                                                                                                    | New task 4.7b adds `extraction-audit-events.test.ts` covering success + SSRF_BLOCKED + RATE_LIMITED + QUOTA_EXCEEDED audit-event shapes; verifies host-only `sourceUrl`.                                                                                                                             |
| MEDIUM   | Cross-provider parity E2E needs calibrated fixtures.                                                                                                                               | Phase 3 exit criterion expanded: uses a shared committed `sample-parity.pdf` with hand-crafted matching responses.                                                                                                                                                                                   |
| LOW      | Wiring checklist row still referenced `server.ts` (Round 2 missed it).                                                                                                             | Fixed: row now references `apps/search-ai/src/workers/index.ts:94`.                                                                                                                                                                                                                                  |
| LOW      | Open Question #7 (audit-event scope for failures) unresolved.                                                                                                                      | Added **D-20**: adopt feature-spec recommendation — audit-all extraction attempts including pre-call rejections.                                                                                                                                                                                     |

Round 3 verdict after fixes: **all CRITICAL/HIGH/MEDIUM/LOW closed**. Proceeding to Round 4.

### Round 4 — Cross-phase consistency (phase-auditor)

Verdict: **NEEDS_REVISION** → fixes applied → resolved.

| Severity | Finding                                                                                                           | Resolution                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HIGH     | Wiring checklist still referenced `RestateKvStore(restateCtx)` after Round 3 renamed to Redis.                    | Wiring checklist row rewritten to `RedisKvStore(redisConnection, 'connector-kv:')` singleton; explicit "NOT Restate state — `WorkflowContext` has no `objectStore`."        |
| MEDIUM   | AUTHZ-1/AUTHZ-2 test spec scenarios assert 403 but LLD D-19 defers RBAC.                                          | Added **D-23**: tests adapt to assert tenant-project isolation only for v1; original 403 assertions tagged `// TODO(v2-RBAC):`.                                             |
| MEDIUM   | HLD OQ-2 (DNS-pinning verification) implicitly resolved across D-7/D-8/Task 3.5 step 8 but not formally captured. | Added **D-22** explicitly resolving HLD OQ-2 with the rationale and exit-criterion check (Phase 2 + Phase 3 audits verify `safeFetch` is used on all user-controlled URLs). |
| MEDIUM   | GAP-014 acknowledged in LLD OQ-5 but not formalized as a Design Decision.                                         | Added **D-21** explicitly accepting GAP-014 for v1; Phase 4 Task 4.9 will update the feature-spec gaps table during `/post-impl-sync`.                                      |
| MEDIUM   | Commit 3.C message omitted `packages/database` from the scope annotation.                                         | Commit message updated to `feat(workflow-engine,database): ...` with explicit 2-package scope note.                                                                         |

Cross-phase verification PASS notes: 22/22 FRs covered; 13/13 GAPs acknowledged; 9/9 HLD Open Questions resolved or deferred with decisions; all commit splits within 3-package / 40-file caps; no scope drift against feature-spec Non-Goals.

Round 4 verdict after fixes: **HIGH + 4 MEDIUM closed**. Proceeding to Round 5 (final sweep).

### Round 5 — Final sweep (lld-reviewer)

Verdict: **APPROVED** with 6 editorial findings → all applied.

| Severity | Finding                                                                                                                         | Resolution                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| MEDIUM   | Modified-files row for `apps/workflow-engine/src/index.ts` still mentioned `RestateKvStore`.                                    | Updated to reference `RedisKvStore` singleton + Redis-backed wording + D-17 mount note.         |
| LOW      | Commit 3.A message said "restate-backed."                                                                                       | Changed to "redis-backed."                                                                      |
| LOW      | Task 2.6 contained a dangling `D-?` reference.                                                                                  | Rewritten with the concrete rationale (no-auth short-circuit per FR-15).                        |
| LOW      | Commit manifests 2.C and 3.D didn't list `packages/i18n`.                                                                       | Both commits now list `packages/i18n/locales/en/studio.json`; 3-package scope annotation added. |
| LOW      | Task 4.9 agents.md list omitted `packages/database`, `packages/search-ai-sdk`, `packages/shared`, `packages/shared-encryption`. | All 4 added with brief learnings notes.                                                         |
| LOW      | §6 acceptance criteria missing rollback drill (D-15).                                                                           | Row added.                                                                                      |

**Round 5 verdict (final): APPROVED.**

Top strengths called out by reviewer:

1. Exceptional source-code anchoring — every modified-file entry carries verified line ranges.
2. Audit-round scar tissue traceable — Rounds 1–4 corrections visible in decisions D-9b/D-17/D-18/D-19/D-21/D-22/D-23.
3. Complete i18n specification — every translation key listed with English value, namespace, aria-labels.

**Sequential audit phase complete. Proceeding to parallel external context audits (Rounds 6–8).**

### Round 6 — Platform audit (general-purpose)

Verdict: **NEEDS_REVISION** → fixes applied → resolved.

| Severity | Finding                                                                                                                                                                                                                    | Resolution                                                                                                                                                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | LLD reinvented an in-process circuit breaker — `@agent-platform/circuit-breaker` already exists at `packages/circuit-breaker/`, Redis-backed, used by `agent-transfer`, `pipeline-engine`, `project-io`, `apps/search-ai`. | **D-13 rewritten** to use the existing package via `RedisCircuitBreaker.execute(key, fn)`. GAP-013 retired. Bespoke `circuit-breaker.ts` removed from the file map (file marked struck-through in §2). Phase 3 Task 3.4 fully rewritten. ~100 LOC of plan disappears. |
| HIGH     | Callback poster used `x-callback-*` headers when `buildSignatureHeaders` (platform standard) emits `x-webhook-*`.                                                                                                          | Task 1.7 rewritten to call `buildSignatureHeaders(secret, rawBody)` verbatim. Callback route's `getHeader()` fallback accepts both, so the platform standard is preferred.                                                                                            |
| HIGH     | D-11 rationale ("fields work via `$inc`/`$set` without schema declaration") was misleading — Mongoose `strict` does NOT block `updateOne` with `$inc`. The real reason for schema declarations is TypeScript type safety.  | D-11 rationale rewritten to cite type-safety as the motivation.                                                                                                                                                                                                       |
| HIGH     | D-6 acknowledged orphan-BullMQ-job risk on Restate replay but no metric/cleanup specified.                                                                                                                                 | Phase 4 Task 4.4 gained a `workflow_docling_orphan_jobs_total` mention; combined with the Round 7 D-6 clarification (replay does NOT typically re-execute thanks to journaling), this is now well-scoped.                                                             |
| MEDIUM   | Wiring checklist missed `connectionId` threading onto `ActionContext`.                                                                                                                                                     | Added a wiring-checklist row for `connectionId` population in `ConnectorToolExecutor`.                                                                                                                                                                                |
| MEDIUM   | Phase 1 forward-referenced a "temporary local normalizer" replaced in Phase 2 — non-additive.                                                                                                                              | Acknowledged with a note: Phase 2's normalizer creation does not delete the Phase 1 helper — Phase 1's helper lives in `extraction-only.ts` and is itself replaced via an import switch (additive new file, removed import — net additive).                           |
| MEDIUM   | Commit 3.E (5 Dockerfiles) exceeds the 3-package cap; CLAUDE.md has no documented Dockerfile-sync exception.                                                                                                               | Acknowledged. If `commit-scope-guard.sh` doesn't exempt Dockerfile-only changes, split 3.E into 3.E1 (3 apps) + 3.E2 (2 apps). LLD's "Phase 3 commits" already explicitly allows this fallback.                                                                       |
| MEDIUM   | `projectRouter` mount line is around 1344 (verified), not 1342.                                                                                                                                                            | Acceptable drift — D-17 says "around line 1342." LLD's audit Round 2 note already says "verify exact line at Round 2/3" — done.                                                                                                                                       |
| LOW      | `@activepieces/pieces-framework` version not pinned.                                                                                                                                                                       | Task 3.2 stays prescriptive: "mirror `piece-shopify` package.json"; the existing version is `^0.25.4`.                                                                                                                                                                |

Round 6 verdict after fixes: **CRITICAL + 3 HIGH + 4 MEDIUM closed**. LOW retained as informational.

### Round 7 — Industry research (general-purpose, WebSearch/WebFetch)

Verdict: **APPROVED with improvements**. 4 RISK + 5 IMPROVEMENT + 1 GAP → all applied or accepted.

| Tag         | Finding                                                                                                                                                | Resolution                                                                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IMPROVEMENT | HMAC callback pattern matches Stripe/GitHub industry standard; `verifyWebhookSignature` already uses `crypto.timingSafeEqual`.                         | Documented in Task 1.7. No code change.                                                                                                                                                                                                                                          |
| RISK        | Clock skew between worker and engine pods can cause callback 401s; LLD had no error-class distinction.                                                 | Phase 4 Task 4.4 gained explicit `TIMESTAMP_EXPIRED` vs `SIGNATURE_INVALID` dimension on the callback-failure metric.                                                                                                                                                            |
| RISK        | D-6 rationale was misleading about replay re-execution; actual pattern (enqueue inside `ctx.run`) is correct.                                          | **D-6 rewritten** to clarify that on normal replay Restate journals the result and `run()` does NOT re-execute. Narrow re-execute window (crash before journal write) explicitly documented; callback-route 409 handles stale jobs.                                              |
| RISK        | 50 MB inline cap is 25× Temporal's 2 MB guideline.                                                                                                     | New metric `workflow_extraction_envelope_bytes{provider}` added to Phase 4 Task 4.4 (histogram). Config-table note added recommending operationally lowering per-tenant default to 10 MB until traffic mix is known. v2 Claim Check (GAP-002) is the architectural escape hatch. |
| IMPROVEMENT | Azure DI polling should also honor `Retry-After` on 200 non-terminal responses.                                                                        | Phase 3 Task 3.5 step 9 polling loop updated to read `Retry-After` on all responses.                                                                                                                                                                                             |
| GAP         | Azure DI operation-result server-side expiry (~24 h) not handled on stale replay.                                                                      | Phase 3 Task 3.5 step 9 gained 404 handling: clear stash, re-POST `:analyze` once, fail second-404 within 60 s. New integration test in Phase 3 exit criteria.                                                                                                                   |
| IMPROVEMENT | MongoDB CAS reset must handle `null`/missing `usagePeriodStart`.                                                                                       | Task 3.12 filter now `$or: [{ usagePeriodStart: null }, { $exists: false }, { $lt: currentMonthStart }]`.                                                                                                                                                                        |
| RISK        | Two-queue reserved-slots starvation under skew (GAP-005).                                                                                              | Already accepted in v1; Round 7 adds per-queue utilization-ratio panel suggestion (incorporated into Phase 4 dashboard work).                                                                                                                                                    |
| IMPROVEMENT | Validate `operationLocation` hostname matches configured endpoint (defense-in-depth).                                                                  | New step 8 in Phase 3 Task 3.5: hostname-match check before polling. New `hostname-mismatch` integration test in Phase 3 exit criteria.                                                                                                                                          |
| IMPROVEMENT | Phasing order matches "data plane before control plane" industry pattern. Phase 1 should have a "callback after timeout" race-condition negative test. | New `workflow-docling-late-callback.test.ts` added to Phase 1 exit criteria. Asserts engine returns 409 on stale `step.status` and metric is incremented.                                                                                                                        |

Round 7 verdict: **APPROVED**. All RISKs mitigated or accepted with telemetry; GAP closed via new test + 404 handling; IMPROVEMENTs all applied.

### Round 8 — OSS library audit (general-purpose, WebSearch/WebFetch)

Verdict: **APPROVED**. Confirms Round 6 findings.

| Decision                                                                                                                 | Rationale                                                                |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| **Adopt `@agent-platform/circuit-breaker`** (already in monorepo, Redis-backed, Lua-atomic).                             | Confirms Round 6 CRITICAL fix.                                           |
| Keep `form-data` (already in `apps/search-ai`) for the multipart helper.                                                 | No new dep needed.                                                       |
| Stay with raw HTTP for Azure DI (NOT `@azure/ai-document-intelligence` SDK).                                             | SSRF-pinning + circuit-breaker interception points make the SDK awkward. |
| Keep hand-rolled `parseRetryAfter`.                                                                                      | External libs (`parse-retry-after`) too small to justify a new dep.      |
| `lru-cache` is already vendored — was offered for the in-process breaker, but D-13 retired the bespoke breaker entirely. | Moot.                                                                    |
| `rate-limiter-flexible` already in `packages/shared` — used as planned.                                                  | No change.                                                               |
| No GPL/AGPL libraries identified; no new deps required.                                                                  | LLD §2 file map already minimal.                                         |

Round 8 verdict: **APPROVED, no new deps needed**.

---

## Final verdict (post Round 8)

All 8 audit rounds closed. The LLD is ready to commit. Subsequent steps:

1. Commit `docs/plans/2026-05-15-document-extraction-integrations-impl-plan.md` with `[ABLP-1073] docs(workflow-engine): add document-extraction-integrations LLD + implementation plan`.
2. Commit this log file at `docs/sdlc-logs/document-extraction-integrations/lld.log.md`.
3. Run `/implement document-extraction-integrations` to begin Phase 1.
