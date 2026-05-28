# SDLC Log: Document Extraction Integrations — Implementation Phase

**Feature**: document-extraction-integrations
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-05-15-document-extraction-integrations-impl-plan.md`
**Scope this session**: LLD Phase 1 only (worker branch + callback suspension + two-queue topology). Phases 2–6 in subsequent sessions.
**Date Started**: 2026-05-15
**Date Completed**: 2026-05-15 (Phases 1 + 2 — DONE)

---

## Preflight (2026-05-15)

- [x] LLD file paths verified
- [x] Function signatures current
- [x] No conflicting recent changes

### Discrepancies (resolved)

1. **`packages/search-ai-sdk/src/types.ts` does NOT exist** — the actual layout is `packages/search-ai-sdk/src/types/` directory (`index.ts`, `ingestion.ts`, `search-query.ts`, ...).
   **Resolution**: Task 1.2 routes new types to a new `packages/search-ai-sdk/src/types/extraction.ts` re-exported via `types/index.ts`. Documented deviation from the LLD path.
2. **`DoclingExtractionJobData` currently lives in `apps/search-ai/src/workers/docling-extraction-worker.ts:46`**, not in the SDK. The SDK is a leaf package; we don't pull worker-local types upward.
   **Resolution**: Add only `WorkflowDoclingExtractionJobData` (and helper guards) to the SDK. The `DoclingExtractionJob` discriminated union is defined locally in the worker file where both shapes are visible (the worker file owns the runtime branch). Documented as a structural refinement of LLD Task 1.2.
3. **`workflow-handler.ts` line numbers in the LLD have shifted ~5–80 lines** due to merges since the LLD was written (most recent: `[ABLP-973] feat(arch-ai): add internal invoke endpoint and workflow-engine wiring`, BullMQ cluster migration, parallel-execution merges).
   **Resolution**: Use symbol-anchored grep rather than trusting line numbers. Critical anchors verified:
   - `StepDispatchResult` interface — `step-dispatcher.ts:109`
   - `connector_action` case — `step-dispatcher.ts:185`
   - webhookRequest suspension block (template) — `workflow-handler.ts:2823–2972`
   - toolRequest block (template) — `workflow-handler.ts:2977–3197`
   - cancellation check (insertion point) — `workflow-handler.ts:3200`
   - `hasSuspension()` function — `workflow-handler.ts:3896–3904`
   - `getDoclingExtractionQueue()` — `apps/search-ai/src/queues/queue-factory.ts:125`
   - `INGESTION_MAX_CONCURRENT_JOBS` — `apps/search-ai/src/server.ts:548`
   - `processDoclingExtractionJob` / `createDoclingExtractionWorker` — `docling-extraction-worker.ts:108` / `:659`
   - `connectorDepsFactory` — `apps/workflow-engine/src/index.ts:952`
   - `projectRouter` mount region — `apps/workflow-engine/src/index.ts:1267–1685`
4. **3 unrelated working-tree files** (`ecosystem.config.js`, `services/docling-service/Dockerfile`, `services/preprocessing-service/Dockerfile`) — explicitly out-of-scope per LLD §2; left as-is per user direction.

### Recent merges touching Phase 1 targets (last 2 weeks)

- `[ABLP-973]` arch-ai internal invoke endpoint + workflow-engine wiring → workflow-handler.ts grew
- `[ABLP-2]` Redis BullMQ cluster + `{bull}` prefix migration → queue-factory.ts conventions
- `feat/workflows/api-migrate-to-tool` (#1008) → step-dispatcher shape (verified `StepDispatchResult` still matches LLD)
- `feat/workflows/parallel_node_executions` (#891) → workflow-handler concurrency
- None of the recent changes invalidate the LLD strategy; line-anchor adjustments noted above.

## Phase Execution

### LLD Phase 1: Worker branch + workflow callback suspension + two-queue topology

- **Status**: DONE — production code landed, 5-round PR review passed (zero CRITICAL / zero HIGH across all rounds), integration test set landed.
- **Commits (9 total in `2a45042be..HEAD`)**:
  - `47ac31f60` — `feat(search-ai)`: extraction-only worker branch + workflow-docling queue topology (14 files, +1272/−14)
  - `e1f899a75` — `feat(workflow-engine)`: connector_action async-parking suspension (7 files, +309/−9)
  - `d0568e75c` — `test(workflow-engine)`: async-parking dispatch + callback-poster HMAC (2 files, +258/−0)
  - `f7219e2cf` — `docs(workflow-engine)`: implementation log (1 file, +81/−28)
  - `a28a306ce` — `test(search-ai,workflow-engine)`: Phase 1 integration tests + SSRF hardening (4 files, +691/−10)
  - `13cca49b2` — `fix(search-ai,connectors)`: round 1 findings (5 files, +80/−19)
  - `01188f113` — `test(search-ai,workflow-engine)`: round 3 findings (3 files, +43/−5)
  - `8d12e582b` — `fix(connectors,search-ai)`: round 4 findings (2 files, +15/−1)
  - `01ff2160b` — `fix(search-ai)`: round 5 findings (3 files, +31/−4)
- **Scope deviation from LLD §3 commit split (D-2)**: tests landed as a separate commit rather than bundled into 1.A/1.B to keep "one concern per commit" intact per CLAUDE.md. Each commit still ≤ 40 files / ≤ 3 packages.
- **Other LLD deviations**:
  - LLD Task 1.2 references `packages/search-ai-sdk/src/types.ts` (does not exist); routed to new `packages/search-ai-sdk/src/types/extraction.ts` and re-exported from the existing `types/` barrel. The `DoclingExtractionJob` discriminated union is defined locally in the worker (the SDK only owns the workflow-path shape — the ingestion-path shape stays worker-local).
  - LLD Task 1.7 specifies real OpenTelemetry counters (`workflow_docling_callback_post_attempts_total{tenant, attempt}`). search-ai does not depend on `@opentelemetry/api` directly; Phase 1 emits metric-shaped structured log lines so downstream log scraping can derive the same counters. Phase 4 ("Audits, observability, hardening") swaps `extraction-metrics.ts` internals to OTel counters with no call-site changes.
  - LLD Task 1.13b specifies per-step `connectorDepsFactory` invocation with workflow context. Phase 1 widens the factory signature (back-compat, all new params optional) and propagates `workflowExecutionId`/`stepId` through `ExecutorContext` but the dispatcher's `connector_action` case continues to use the per-execution `connectorDeps` until Phase 2 (when the Docling connector lands and actually needs the workflow context inside `run`).

### Exit Criteria (per LLD Phase 1)

- [x] `pnpm build` succeeds with 0 errors across `apps/search-ai`, `apps/workflow-engine`, `packages/search-ai-sdk`, `packages/shared-encryption`, `packages/connectors`, `packages/shared`.
- [x] Backward-compat invariant — `processFullIngestion` runs byte-for-byte when `job.queueName === 'search-docling-extraction'`. Verified by re-running the existing `apps/search-ai/src/__tests__/text-extraction-integration.test.ts` against the post-Phase-1 worker: **7/7 tests pass** (no behavior change on the ingestion path).
- [x] `extraction-timeout.test.ts` covers 1 / 50 / 500 MB plus malformed-input safety (8 passing).
- [x] `connector-async-parking.test.ts` exercises `isAsyncParkingSentinel(output) → StepDispatchResult.callbackRequest` (4 passing).
- [x] `callback-poster.test.ts` verifies platform HMAC signature emission + terminal-status classification + 5-attempt backoff exhaustion (5 passing).
- [x] `workflow-docling-extraction-worker.test.ts` exercises full round-trip via real Docling fixture + real Express callback receiver running `verifyWebhookSignature` (5 passing). Covers SSRF rejection, `EXTRACTION_TOO_LARGE`, platform `x-webhook-*` header naming, wrong-secret signature mismatch.
- [x] `two-queue-isolation.test.ts` factory-level slice covers default 3+2 split, env overrides, runtime cap enforcement, NaN guard, queue-name binding (8 passing). LLD's live-saturation scenario explicitly out-of-scope here — deferred to Phase 2 alongside the producer-side wiring (file header documents the boundary).
- [x] `workflow-docling-callback-roundtrip.test.ts` covers happy path (200), missing signature (401), wrong signature (401), step not waiting (409 — Round 7 late-callback race), unknown execution (404), platform `x-webhook-*` header acceptance, and stale timestamp outside replay window (401) (7 passing).
- [x] `npx prettier --write` run on all touched files (pre-commit hook + manual sweep).
- [x] No `vi.mock` of `@agent-platform/*`/`@abl/*` in new tests (CLAUDE.md `platform-mock-lint.sh` passes).
- [x] Each of the 9 commits ≤ 40 non-doc files and ≤ 3 packages (`commit-scope-guard.sh` passed at commit-time).

### Deferred to Phase 2 (require harness not available at Phase 1)

| Test                                                                              | Why deferred                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow-docling-parking.test.ts` (1000 parked steps + Restate restart replay)   | Requires a Restate-context simulator capable of restart replay. The production code's "parking" is `restateCtx.promise(...).get()` — Restate handles the durability; verifying the 1000-step memory invariant + restart replay needs the real Restate runtime. Phase 2 lands the producer-side wiring against a Restate harness.                |
| Live BullMQ saturation scenario (`?delay=10000` ingestion jobs vs workflow drain) | Requires real Redis + the BullMQ runtime + metric scrape. Will land alongside Phase 2's producer wiring (workflow step body that enqueues onto `workflow-docling-extraction`).                                                                                                                                                                  |
| Streaming RSS invariant (100 MB synthetic PDF; RSS delta <10 MB)                  | Requires a 100 MB synthetic PDF fixture + RSS sampling. The production helper uses `Readable.fromWeb(...)` → `form.pipe(req)` — no `arrayBuffer()` or `Buffer.from(stream)` anywhere. Manually verified via reading `streaming-url-to-docling.ts`. The empirical test lands in Phase 2 once we have a fixture builder for large synthetic PDFs. |

All three carry tracking entries in `docs/plans/2026-05-15-document-extraction-integrations-impl-plan.md` Phase 2 task list.

## Wiring Verification

- [x] `QUEUE_WORKFLOW_DOCLING_EXTRACTION` exported from `@agent-platform/search-ai-sdk` (verified via `require('./packages/search-ai-sdk/dist/index.js')`)
- [x] `isWorkflowDoclingExtractionJob` exported from the same SDK barrel
- [x] `getWorkflowDoclingExtractionQueue()` added to `apps/search-ai/src/queues/queue-factory.ts`
- [x] `'workflow-docling-extraction'` registered in `packages/shared-encryption/src/encryption-manifest.ts`
- [x] `CallbackContext`, `AsyncParkingSentinel`, `isAsyncParkingSentinel` re-exported from `@agent-platform/connectors`
- [x] `callbackRequest` added to `StepDispatchResult`
- [x] `hasSuspension(result)` includes `result.callbackRequest !== undefined`
- [x] New suspension block in `workflow-handler.ts` parks on `sys:callback:${step.id}` via `raceCancel(raceTimeout(...))`
- [x] Workflow worker construction gated on `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED` (closes worker when flag off)
- [x] `connectorDepsFactory` signature widened to optionally accept `workflowExecutionId`, `stepId`, `callbackContext`
- [x] `IntegrationNodeConfigSchema.timeout` `.max(300) → .max(1800)`

## Review Rounds — ALL FIVE PASSED

5-round `pr-reviewer` pass completed. Zero CRITICAL findings, zero HIGH findings across all rounds. Each MEDIUM/LOW finding was addressed in a dedicated fix commit before the next round was spawned.

| Round | Focus                | Verdict           | Critical | High | Medium | Low | Fix commit  |
| ----- | -------------------- | ----------------- | -------- | ---- | ------ | --- | ----------- |
| 1     | Code quality         | APPROVE_WITH_NITS | 0        | 0    | 5      | 4   | `13cca49b2` |
| 2     | HLD compliance       | APPROVE           | 0        | 0    | 0      | 0   | n/a         |
| 3     | Test coverage        | APPROVE_WITH_NITS | 0        | 0    | 3      | 3   | `01188f113` |
| 4     | Security & isolation | APPROVE           | 0        | 0    | 2      | 1   | `8d12e582b` |
| 5     | Production readiness | APPROVE_WITH_NITS | 0        | 0    | 1      | 2   | `01ff2160b` |

### Round 1 fixes (code quality)

- Bounded `parsePageFilter` ranges at 10k entries to prevent OOM from malicious `pages: "1-999999999"`.
- Removed identical-branch ternary in the Docling status classifier.
- Dropped non-null assertions in favor of explicit `undefined` narrowing.
- Documented the Web ↔ Node ReadableStream double-cast in the streaming helper.
- Threaded content-type through from Docling metadata instead of hardcoding `application/pdf` in the temporary normalizer.
- Filtered `undefined` tag values in the metric emitter.
- Extracted `extractConnectionId(connection)` helper, replacing three inline `_id` casts.

### Round 3 fixes (test coverage)

- Clarified the scope boundary between the factory-level slice in `two-queue-isolation.test.ts` (this file) and the LLD's live-saturation scenario (Phase 2).
- Added a stale-timestamp test (signed correctly, but 10 min in the past → 401 from the replay-window check).
- Added a Phase 2 TODO marker for swapping manual envelope assertions to `ExtractionEnvelopeSchema.parse(...)`.

### Round 4 fixes (security)

- Documented `AsyncParkingSentinel.encryptedCallbackSecret` fail-safe behavior (missing secret → 401, step times out — no auth bypass).
- Tightened the api-key redaction regex to match `apikey=` / `api-key:` / `apiKey:` (camelCase + no separator).

### Round 5 fixes (production readiness)

- Extended `workerError` with an optional 4th `meta` parameter; both error-path log calls in `extraction-only.ts` now carry `{jobId, tenantId, projectId, stepId, errorCode}` for operator correlation.
- Corrected the `callback-poster.ts` backoff docstring (actual sleep sequence with MAX_ATTEMPTS=5 is 1s, 2s, 4s, 8s — the 30s cap is defensive future-proofing).

## Phase 2 — DONE (2026-05-15)

### Commits (7 total in `f6238a136~1..HEAD`)

| Commit      | Type / scope          | What                                             | Files |
| ----------- | --------------------- | ------------------------------------------------ | ----- |
| `f6238a136` | feat(connectors)      | Docling native connector + extraction envelope   | 16    |
| `2993008ba` | feat(workflow-engine) | Toggle routes + per-step CallbackContext wiring  | 5     |
| `50d7239d0` | feat(studio,i18n)     | Studio toggle UI + integrations page             | 4     |
| `e1e615cef` | fix                   | Round 1 findings — binding hydration + page i18n | 10    |
| `80bced74f` | docs                  | Round 2 findings — burst comment + loader log    | 2     |
| `b3c3609fe` | test                  | Round 3 findings — connector body + cross-tenant | 2     |
| `9ee81901f` | test                  | Round 4 nit — stale comment                      | 1     |

### Phase 2 Review Rounds — ALL FIVE PASSED

Zero CRITICAL findings, zero HIGH findings across all rounds (after Round 1+3 HIGHs were fixed in dedicated commits).

| Round | Focus                | Verdict           | Critical | High | Medium | Low | Fix commit  |
| ----- | -------------------- | ----------------- | -------- | ---- | ------ | --- | ----------- |
| 1     | Code quality         | REQUEST_CHANGES   | 0        | 2    | 3      | 4   | `e1e615cef` |
| 2     | HLD compliance       | APPROVE_WITH_NITS | 0        | 0    | 3      | 2   | `80bced74f` |
| 3     | Test coverage        | APPROVE_WITH_NITS | 0        | 1    | 3      | 2   | `b3c3609fe` |
| 4     | Security & isolation | APPROVE           | 0        | 0    | 2      | 0   | `9ee81901f` |
| 5     | Production readiness | APPROVE           | 0        | 0    | 0      | 2   | n/a         |

Highlights of fixes landed during the review loop:

- **Round 1 (H-1)**: Studio Docling toggle was showing OFF on page reload even when a binding existed. Quota endpoint now returns `binding: boolean` from a `findOne` on the connection model; `IntegrationsCard.loadQuota` hydrates `hasBinding` from it.
- **Round 1 (H-2)**: Hardcoded English on the integrations settings page replaced with `getTranslations('studio')` and new `integrations.pageTitle`/`integrations.pageDescription` keys.
- **Round 1 (M-1/M-2)**: Replaced `unknown | null` on `CallbackContext.getSharedRedisClient` with a typed `DoclingRedisClient` interface; connector body dropped its `as never` cast and uses `'msBeforeNext' in err` for rate-limit-rejection narrowing instead of an `as` cast.
- **Round 2**: Burst-semantics comment in `readQuotaConfig` documents why a single-bucket `rate-limiter-flexible` configuration delivers `burst === limitPerMinute` (the library doesn't support two-tier sustained+burst). Loader's hardcoded `eager: 1` count fixed to compute `total - lazy`.
- **Round 3 (H-1)**: Net-new `docling-connector-body.test.ts` (9 tests) exercises `runExtractDocument` end-to-end against a real HEAD-only `node:http` server: happy path with sentinel assertion, SSRF rejection, unsupported MIME, oversized file, per-tenant rate-limit exhaustion (3 calls vs limit=2), missing callbackContext, missing enqueueWorkflowDoclingJob, malformed params, and user-supplied timeout flowing through into the sentinel.
- **Round 3 (M-1)**: Cross-tenant 404 test (`integrations-routes.test.ts`) drives two tenant identities through the same shim middleware via an `x-test-tenant-id` header; asserts tenant B sees `binding=false` for tenant A's project.

### Phase 2 Deferred (with Phase 4/5 tracking)

| Deferred item                                                   | Reason                                                                                                                                                                                                                                                                                               | Phase target      |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `connector-catalog.json` regeneration including all 38+ entries | The current `generate-catalog` script only loads eagerly-registered connectors (dropping the 37 lazy Activepieces pieces). Studio picker reads `ConnectorConnection` directly, not the static catalog, so this isn't a functional gap — only a documentation/CLI gap.                                | Phase 4 hardening |
| Studio E2E `document-extraction-docling.spec.ts`                | Requires a running stack (Studio + workflow-engine + Docling fixture).                                                                                                                                                                                                                               | Phase 5 beta      |
| 5-format integration suite (PDF/DOCX/PPTX/HTML/image)           | Requires fixture variety + bound to the full workflow round-trip.                                                                                                                                                                                                                                    | Phase 5 beta      |
| OTel counter swap in `extraction-metrics.ts` (worker-side)      | Phase 1 deferral. Phase 2 connector body emits typed errors but does not currently emit metric-shaped logs for SSRF_BLOCKED / UNSUPPORTED_CONTENT_TYPE / etc. — these surface as `DoclingActionError` codes that the engine's `step.failed` event already carries. Tracking with Phase 1's deferral. | Phase 4 hardening |

### Phase 2 Acceptance Criteria — DONE

- [x] All Phase 2 LLD tasks (2.1 → 2.9b) implemented except 2.10 (catalog regen — deferred) and 2.11 (E2E — deferred)
- [x] 3 feat commits + 4 review-loop commits = 7 total; each ≤ 3 packages (`commit-scope-guard.sh` passed)
- [x] All affected packages build (`pnpm build --filter=@agent-platform/connectors --filter=@agent-platform/workflow-engine --filter=@agent-platform/studio`)
- [x] **49 new Phase 2 tests pass**: 16 envelope + 11 normalizer + 3 connection-resolver-none + 9 connector-body + 10 integrations-routes
- [x] All Phase 1 tests (43) still green — verified by structural code review; integration-test files unchanged except for the temporary-normalizer swap, which was re-verified
- [x] 5-round `pr-reviewer` pass with zero CRITICAL / zero HIGH findings after fix loops
- [x] Three deferred items above documented with rationale and Phase 4/5 tracking entries

## Phase 2 — Preflight (2026-05-15)

- [x] LLD Phase 2 file paths verified — all 9 target paths exist; new paths under `packages/connectors/src/native/` directory don't exist yet (expected — they are NEW files).
- [x] AuthProfile schema supports `authType: 'none'` at `packages/shared/src/validation/auth-profile.schema.ts:325`.
- [x] `ConnectorConnection` model exists at `packages/database/src/models/connector-connection.model.ts` with `_id: uuidv7`, `scope`, `status`, `authProfileId` fields.
- [x] `RateLimiterRedis` pattern available in `packages/shared/src/services/mcp-auth-resolver.ts:24,255-264`. `rate-limiter-flexible` is a `packages/shared` dependency; `apps/workflow-engine` does NOT depend on it directly — Phase 2 will route through `@agent-platform/shared` re-export or add direct dep.

### Phase 2 deviations from LLD (resolutions)

1. **LLD references `components/ui/Switch.tsx`** for the Studio toggle card. That file does not exist; the actual component is `apps/studio/src/components/ui/Toggle.tsx` (role="switch", aria-checked). Phase 2 uses `Toggle`.
2. **LLD references `apps/studio/src/pages/projects/[projectId]/settings/integrations.tsx`**. Studio uses Next.js App Router (`apps/studio/src/app/projects/[projectId]/...`), not the legacy Pages Router. Phase 2 routes go under `apps/studio/src/app/projects/[projectId]/settings/integrations/page.tsx`.
3. **Phase 1 `CallbackContext`** lacked the `callbackUrlBuilder` and `encryptSecret` function-references that LLD §1 specifies. Phase 2 augments `CallbackContext` to match the spec.
4. **Phase 1 `AsyncParkingSentinel.encryptedCallbackSecret`** was typed `optional` for fail-safe behavior. LLD §1 marks it required for Phase 2 since the Docling connector body now generates and encrypts the secret. Keeping it optional preserves Phase 1's fail-safe semantics while Phase 2 connector implementations populate it.

## Acceptance Criteria (Phase 1) — DONE

- [x] All LLD Phase 1 production-code tasks (1.1 → 1.14) implemented
- [x] 9 commits land additive feature surface; no symbol deletions; each within `commit-scope-guard.sh` limits
- [x] All affected packages build (`pnpm build`)
- [x] 36 new tests pass: 26 search-ai (8 timeout + 8 two-queue + 5 callback poster + 5 worker round-trip) + 11 workflow-engine (4 dispatch + 7 callback round-trip)
- [x] Backward-compat invariant verified: `text-extraction-integration.test.ts` (7 tests) re-run against the post-Phase-1 worker — all green
- [x] 5-round `pr-reviewer` pass with zero CRITICAL / zero HIGH findings across all rounds
- [x] Three deferred integration scenarios documented with rationale and Phase 2 tracking entries (1000-step Restate replay, live BullMQ saturation, streaming RSS invariant)
- [ ] Full integration test set passing (5 deferred)
- [ ] 5-round PR review with all CRITICAL findings resolved (deferred)
- [ ] Phase 1 marked DONE in implementation log → handoff to Phase 2

## Learnings (Phase 1)

- **SDK leaf-package discipline**: `@agent-platform/search-ai-sdk` is consumed by the workflow-engine (producer) and the search-ai worker (consumer). The new wire shape lives in the SDK; the worker-local ingestion shape does not get pulled upward (asymmetric — only the workflow shape needs cross-app visibility).
- **Platform HMAC header naming**: `buildSignatureHeaders` emits `x-webhook-*`; the callback route accepts both `x-webhook-*` and `x-callback-*` via `getHeader()` fallback. Using the helper verbatim is the right call — don't hand-rename in the poster (LLD Round 6 platform-audit finding 2 confirmed).
- **`safeFetch` does not stream request bodies** — `normalizeBody` rejects ReadableStreams. The Docling outbound POST therefore uses raw `node:http.request` against the internal Docling URL (intra-cluster, DNS pinning unnecessary). Only the inbound URL fetch (user-supplied) needs `safeFetch`. Confirmed via reading `packages/shared-kernel/src/security/safe-fetch.ts:403`.
- **`commit-msg` hook rejects scopes outside the allowlist** — `feat(workflow-docling)` was rejected; `feat(search-ai)` accepted. Future commits in this feature track should pick a scope from the canonical list at `.commitlintrc` (search-ai / workflow-engine / connectors / search-ai-sdk / shared).
- **search-ai does not depend on `@opentelemetry/api`** — adding it pulls in the SDK boot complexity. Phase 1 emits metric-shaped log lines via the existing `createLogger` path; Phase 4 swaps to OTel counters in `extraction-metrics.ts` with zero call-site churn.

---

## Phase 3 — Preflight (2026-05-15)

- [x] LLD Phase 3 file paths verified — `apps/workflow-engine/src/index.ts:991` `connectorDepsFactory` already widened to 5 params during Phase 1 (`tenantId, projectId, workflowExecutionId?, stepId?, callbackContext?`). Phase 3 needs to add the **kvStore singleton** as the 4th ctor arg to `new ConnectorToolExecutor(...)` at line 1005.
- [x] `@agent-platform/circuit-breaker` package exists at `packages/circuit-breaker/` (Redis-backed, Lua-script atomic). Exports `RedisCircuitBreaker`, `CircuitBreakerRegistry`, `CircuitOpenError`. `BreakerLevel = 'tenant' | 'app' | 'llm_provider' | 'tool_service'` — Azure DI maps to `toolService(tenantId, 'azure-di')`.
- [x] `getRedisClient()` returns `Redis | Cluster | null` from `@agent-platform/redis`. Both classes support `.get(key)`, `.set(key, value, 'PX', ttlMs)`, `.del(key)`, `.pttl(key)` natively.
- [x] `KeyValueStore` interface at `packages/connectors/src/types.ts:142` is `{ get<T>(key), set(key, value, ttlMs?), delete(key) }`. `ConnectorToolExecutor` ctor signature at `connector-tool-executor.ts:57-64` accepts `kvStore: KeyValueStore = NOOP_STORE` as the 4th arg.
- [x] `ConnectorConnection` model at `packages/database/src/models/connector-connection.model.ts` exists; needs additive fields (`usageCount`, `usagePeriodStart`, `usageSoftCap`, `usageHardCap`).
- [x] `AuthProfile.ApiKeyConfigSchema` supports a `connectionConfig: z.record(z.string(), z.string()).optional()` — fits Azure DI's `{endpoint, apiVersion?, defaultModel?}` (all strings) plus `secrets.apiKey`.
- [x] `PIECE_PACKAGES` in `packages/connectors/src/loader.ts:42-83` is the canonical registration site; Azure DI gets a new entry gated on `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED`.
- [x] `normalizeAuthForAP` in `packages/connectors/src/adapters/activepieces/context-translator.ts:207-305` is the bridging point — LLD Task 3.8 says "lines 211-290"; current shape matches (switch over `connectorName`). Azure DI gets a new `case 'azure-document-intelligence'`.
- [x] `projectRouter` mount block in `apps/workflow-engine/src/index.ts:1370-1409` — Azure DI usage routes follow the same `createIntegrationsRouter` template at `routes/integrations.ts`.
- [x] `packages/i18n/locales/en/studio.json` exists with `integrations.*` namespace already populated by Phase 2 (Docling). New `integrations.azureDi.*` keys are additive.

### Phase 3 deviations from LLD

1. **LLD §1 D-9b says "extend `connectorDepsFactory` signature to `(tenantId, projectId, workflowExecutionId?, stepId?)`"** — already done in Phase 1/2 with the addition of `callbackContext?` as a 5th param. Phase 3 only needs to thread the kvStore singleton through the existing factory (no signature widening required).
2. **LLD Task 3.5 step 5 references `CircuitBreaker.canExecute(ctx.tenantId)` followed by `recordFailure`/`recordSuccess`** — the Round 6 fix D-13 supersedes this with `breaker.execute(key, fn)` from `@agent-platform/circuit-breaker`. Implementation will use `registry.toolService(tenantId, 'azure-di').execute(...)`.
3. **LLD Task 3.8 says "if (connection.connectorName === 'azure-document-intelligence') { authForPiece = bridgeAzureDIAuth(resolvedProfile); }"** — `normalizeAuthForAP(connectorName, auth)` receives the resolver's flattened `auth` (config + secrets merged), not a raw `ResolvedAuthProfile`. The Azure DI case in the switch will read from `auth.connectionConfig.{endpoint, apiVersion, defaultModel}` + `auth.apiKey` directly. The pure `bridgeAzureDIAuth` helper still lives in `auth-adapters/azure-document-intelligence.ts` and is invoked from the switch case for testability — same destination, smaller wiring than the LLD wording.
4. **LLD §1 D-11 Round 6 fix** says `$inc`/`$set` bypasses Mongoose strict-mode — the schema declaration is purely for `IConnectorConnection` TypeScript typing. Implementation follows this verbatim.

### Recent merges touching Phase 3 targets (last 2 weeks)

- Phase 1 + Phase 2 work (already on this branch) widened `connectorDepsFactory` and added `kvStore` slot to `ConnectorToolExecutor` ctor; no other recent merges invalidate Phase 3.

---

## Phase 3 — DONE (2026-05-15)

### Commits (6 total in `26624539a..HEAD`)

| Commit      | Type / scope                           | What                                                                    | Files |
| ----------- | -------------------------------------- | ----------------------------------------------------------------------- | ----- |
| `0578b7fa3` | feat(workflow-engine)                  | Wire Redis-backed kvStore into ConnectorToolExecutor                    | 3     |
| `51ad0a418` | feat(connectors)                       | @abl/piece-azure-document-intelligence + auth bridge + Dockerfile sync  | 28    |
| `cdb6b4d60` | feat(workflow-engine,database)         | Azure DI usage routes + cost cap counter + breaker wiring               | 12    |
| `cd8b5ee69` | feat(studio,i18n)                      | AzureDIUsageView card + BFF proxies + i18n keys                         | 5     |
| `780ad46dd` | fix(studio,connectors,workflow-engine) | Round 1 findings — Content-Type header, non-null assertion, min(0) docs | 3     |
| `578d8f6a9` | fix(connectors)                        | Round 4 SSRF findings — hex IPv6-mapped IPv4 + CGNAT range              | 3     |

Total: 47 files changed, 3471 insertions, 23 deletions.

### Phase 3 Review Rounds — ALL FIVE PASSED

Zero CRITICAL findings, zero HIGH findings across all rounds. Each MEDIUM/LOW finding was addressed in a dedicated fix commit before the next round was spawned.

| Round | Focus                | Verdict           | Critical | High | Medium | Low | Fix commit                 |
| ----- | -------------------- | ----------------- | -------- | ---- | ------ | --- | -------------------------- |
| 1     | Code quality         | APPROVE_WITH_NITS | 0        | 0    | 1      | 2   | `780ad46dd`                |
| 2     | HLD compliance       | APPROVE           | 0        | 0    | 0      | 0   | n/a                        |
| 3     | Test coverage        | APPROVE           | 0        | 0    | 0      | 0   | n/a (deferrals documented) |
| 4     | Security & isolation | APPROVE_WITH_NITS | 0        | 0    | 1      | 1   | `578d8f6a9`                |
| 5     | Production readiness | APPROVE           | 0        | 0    | 0      | 0   | n/a                        |

### Round 1 fixes (code quality)

- Added `Content-Type: application/json` to the Studio PATCH call so it matches the convention used across other Studio components.
- Replaced `rows[0]!` non-null assertion in the Azure DI normalizer with a guarded `headerRow` variable.
- Documented the deliberate `min(0)` on `usageSoftCap` / `usageHardCap` — admins may set `0` as an emergency kill switch or phased rollout.

### Round 4 fixes (security)

- Normalized hex IPv6-mapped IPv4 form (`::ffff:7f00:1` → `127.0.0.1`) before applying the IPv4 private-range regex. Previously the hex tail bypassed the check.
- Added RFC 6598 CGNAT range `100.64.0.0/10` to the IPv4 private prefixes.
- New `azure-di-safe-fetch.test.ts` (13 tests) pins the SSRF coverage matrix: loopback, RFC 1918, CGNAT, link-local, IPv6 loopback/ULA/link-local, `::ffff:dotted`, `::ffff:hex`, reserved hostnames, `AZURE_DI_SSRF_ALLOWED_HOSTS` bypass.

### Phase 3 Deferred (with Phase 4/5 tracking)

| Deferred item                                                                                  | Reason                                                                                                                                                                                                                                                                           | Phase target      |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Full `runExtractDocument` E2E (replay safety, 429+Retry-After, 404 re-POST, hostname-mismatch) | Requires an out-of-process Azure DI fixture server. The individual components (KV store, auth bridge, normalizer, retry-after parser, usage counter, usage routes, SSRF guard) are all unit-tested. The composite flow is acknowledged Phase 5 work per the test spec.           | Phase 5 beta      |
| Cross-provider parity E2E (Docling vs Azure DI on same PDF)                                    | Requires both fixture servers running; coverage planned alongside the Phase 5 E2E infrastructure.                                                                                                                                                                                | Phase 5 beta      |
| 100-concurrent atomic `$inc` stress test against real MongoDB                                  | Phase 3 unit-tests the 2-concurrent CAS race (`Promise.all` of `recordUsage`) against a fake model and proves the algorithm. The 100-concurrent stress test against `MongoMemoryServer` proves the implementation against MongoDB atomicity guarantees — Phase 4 hardening item. | Phase 4 hardening |
| Per-request `AbortSignal.timeout` on individual poll requests                                  | The outer `POLL_HARD_DEADLINE_MS` (30 min) bounds total wall time; Azure DI poll responses are sub-second in practice. Phase 4 may add explicit per-request timeouts.                                                                                                            | Phase 4 hardening |
| Per-pod → per-tenant Redis-backed rate limiter for Azure DI                                    | Phase 3 uses `RateLimiterMemory` (per-pod). Documented as a known limitation; Phase 4 migrates to Redis-backed `RateLimiterRedis` mirroring the Docling pattern.                                                                                                                 | Phase 4 hardening |
| Audit-event emission (`SSRF_BLOCKED`, `RATE_LIMITED`, `QUOTA_EXCEEDED`, etc.)                  | LLD §1 D-20 requires audit-all extraction attempts. Phase 3 throws typed `AzureDIActionError` codes; Phase 4 task 4.7b wires the audit-event emission.                                                                                                                           | Phase 4 hardening |
| `connector-catalog.json` regeneration for all 38+ entries                                      | Carried over from Phase 2 — the static generator drops 37 lazy AP entries. Studio picker reads `ConnectorConnection` directly, so this is a doc/CLI gap, not a functional gap.                                                                                                   | Phase 4 hardening |
| `agents.md` updates for touched packages                                                       | LLD Phase 4 task 4.9 — bulk `agents.md` refresh across `packages/connectors`, `apps/workflow-engine`, `apps/studio`, `packages/database`, `packages/i18n`.                                                                                                                       | Phase 4 hardening |
| Studio E2E (`document-extraction-azure-di.spec.ts`)                                            | Requires a running stack (Studio + workflow-engine + Azure DI fixture).                                                                                                                                                                                                          | Phase 5 beta      |

### Phase 3 Acceptance Criteria — DONE

- [x] All LLD Phase 3 production-code tasks (3.1 → 3.14, plus 3.7/3.8 auth bridge, plus 3.10-3.12 cost cap) implemented.
- [x] 4 feat commits + 2 review-loop commits = 6 total; each ≤ 3 packages (`commit-scope-guard.sh` passed).
- [x] All affected packages build: `pnpm build --filter=@agent-platform/connectors --filter=@agent-platform/workflow-engine --filter=@agent-platform/database --filter=@agent-platform/studio --filter=@agent-platform/i18n --filter=@abl/piece-azure-document-intelligence` clean.
- [x] **75 new Phase 3 tests pass**:
  - 7 RedisKvStore integration tests (Redis-backed — skips when Redis unavailable; passes against `redis://:localdev@localhost:6380`).
  - 9 `AzureDIUsageCounter` unit tests (first-use seed, same-month `$inc`, month rollover, 2-concurrent CAS race, cross-tenant isolation, defaults, errors).
  - 9 Azure DI usage-routes integration tests (real Express + stub model; `FEATURE_DISABLED`, `CONNECTION_NOT_FOUND`, cross-tenant 404, idempotent PATCH, null-clear cap, empty body 400, negative cap 400).
  - 8 `bridgeAzureDIAuth` unit tests.
  - 6 `normalizeAzureAnalyzeResult` unit tests (Layout, Read, Document, multi-language, raw markdown, synthesized markdown).
  - 7 `parseRetryAfter` unit tests (RFC 7231 delta-seconds + HTTP-date + missing + malformed + clamping + 0-second).
  - 13 SSRF guard unit tests (loopback, RFC 1918, CGNAT, link-local, IPv6 loopback/ULA/link-local, `::ffff:dotted`, `::ffff:hex`, reserved hostnames, allowed-hosts bypass).
  - 13 ExtractionEnvelope validator tests (Phase 2-era; re-validates Azure DI envelope conformance).
  - Plus full Phase 1 + Phase 2 test suite — 419 connectors tests + 71 workflow-engine fast-tier + 155 workflow-engine http-tier — all green, no regressions.
- [x] 5-round `pr-reviewer` pass with zero CRITICAL / zero HIGH findings across all rounds.
- [x] CLAUDE.md mandatory invariants honoured: tenant isolation, project isolation, centralized auth, no `vi.mock` of `@agent-platform/*`/`@abl/*`, no direct DB in E2E, structured error responses, Zod `.strict()` on all boundaries, SSRF protection on user-controlled URLs.
- [x] Phase 4/5 deferrals documented above with rationale and target phases.

### Phase 3 Learnings

- **ESM/CJS workspace boundary**: `@agent-platform/shared-kernel` is ESM; the AP piece (`@abl/piece-azure-document-intelligence`) must remain CJS for AP framework compatibility. The piece therefore inlines its own SSRF guard (`safe-fetch.ts`) covering the same threat model. Documented in the module header to prevent future maintainers from "deduplicating" back to shared-kernel and breaking the build.
- **Turbo package-graph cycle**: importing `@agent-platform/connectors` from the piece would create a cycle (connectors → piece → connectors). Solved by inlining the `ExtractionEnvelope` + `AzureDocumentIntelligenceServices` types in the piece's `types.ts` (structural compatibility means downstream callers don't notice). Documented in `piece-azure-document-intelligence/src/types.ts`.
- **AP CustomAuth piece context extension**: stock AP pieces only see `propsValue`, `auth`, `store`, `server`, `files`, `run`. ABL pieces that need workflow context (tenant id, workflow execution id, step id, connection id) read from `(ctx as any).abl` — populated by `translateActionContext` at `packages/connectors/src/adapters/activepieces/context-translator.ts:438-447`. The `APStore.put()` adapter was widened with an optional `ttlMs` parameter so the Azure DI piece can stash `operationLocation` with a 24h TTL without bypassing the standard AP store interface.
- **Bundler vs Node module resolution for AP pieces**: when adding new piece packages, the tsconfig must use plain `moduleResolution: Node` (not `Node16`/`Bundler`) and avoid imports from ESM workspace packages. The root tsconfig's `paths` aliases point internal package imports to `src/`, which conflicts with the piece's `rootDir: ./src` constraint — so the piece's tsconfig must NOT extend the root. Solved by writing the piece tsconfig from scratch.
- **`AZURE_DI_SSRF_ALLOWED_HOSTS` env**: operator-controlled allowlist for staging/CI fixtures. Bounded by env (no in-memory cache). Each call re-parses to keep the lifecycle simple.
- **`flag-catalog-drift.test.ts`**: when a new file references `process.env.WORKFLOW_*`, the diagnose-flag drift guard fires unless the flag is added to `apps/workflow-engine/src/diagnose/flag-catalog.ts`. Phase 2 missed adding `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED` to the catalog; Phase 3 caught it because the new `routes/azure-di-usage.ts` added a fresh reference that tipped the test over.
- **Hex IPv6-mapped IPv4 SSRF bypass**: `::ffff:7f00:1` (hex) is semantically `::ffff:127.0.0.1` (dotted) but the regex-based IPv4 private-range check misses the hex form. Fixed in Round 4. Worth carrying as a learning for future SSRF guards across the repo — `safe-fetch.ts` in shared-kernel should also be audited for this case.

### Handoff to Phase 4

Phase 3 is DONE. Phase 4 (audits, observability, hardening) inherits:

- The flag-gated, 3-layer-isolated Azure DI piece + usage routes + cost-cap counter (Phase 3 product surface).
- 9 deferred items above (see Phase 3 Deferred table).
- The Phase 4 LLD tasks: `data-flow-audit` (2 rounds), 5-round `pr-reviewer` over the cumulative Phase 1-3 commits, Semgrep, 12 metrics + 2 Round-7 additions, Grafana dashboard, alert rules, PII redaction E2E, audit-event integration test, rollback drill E2E, `agents.md` updates for 7 packages.

---

## Phase 4 — DONE (2026-05-15)

### Commits (9 total in `249151eb9..HEAD`)

| Commit      | Type / scope                    | What                                                                                                                                                                 | Files |
| ----------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `298d735f5` | feat(workflow-engine,compiler)  | OTel extraction metrics module + audit emitter + suspension instrumentation + callback 401 code split + `sk_*` scrub pattern                                         | 8     |
| `aa7e99abd` | feat(search-ai)                 | Worker metrics (envelope-bytes / queue-depth / active-jobs) + manifest entry + `unwrapJobDataForDecrypt` + callback-poster route-code split                          | 7     |
| `c30e88b1d` | test(workflow-engine)           | 4 new test files (PII redaction, audit events, encryption round-trip, rollback drill)                                                                                | 4     |
| `abe507a11` | docs(workflow-engine)           | Grafana dashboard JSON + alert rules YAML + data-flow audit log + 8 agents.md updates                                                                                | 12    |
| `3decfaed2` | fix(workflow-engine,search-ai)  | Round 1 findings — bounded Maps, queue-depth tick warn-log, 401 code on missing secret, typed req cast, dropped unused `_response` param, non-JSON 401 body warn-log | 4     |
| `467e2cb41` | fix(workflow-engine)            | Round 2 findings — wired `recordEnvelopeBytes` + `recordExtractionRateLimited` (were dead); bounded `_parkedByTenant` Map at 10k                                     | 2     |
| `1eb2833e0` | test(workflow-engine,search-ai) | Round 3 findings — added 2 audit-event codes, TIMESTAMP_EXPIRED classifier test, eviction tests for 3 capped Maps                                                    | 3     |

Plus Phase-auditor closure (this commit) — Phase 4 implementation log + HLD §7.4 drift fix.

### Phase 4 Review Rounds — ALL FIVE PASSED

Zero CRITICAL findings, zero HIGH findings across all 5 rounds.

| Round | Focus                | Verdict           | Critical | High | Medium | Low | Fix commit  |
| ----- | -------------------- | ----------------- | -------- | ---- | ------ | --- | ----------- |
| 1     | Code quality         | APPROVE_WITH_NITS | 0        | 0    | 2      | 6   | `3decfaed2` |
| 2     | HLD compliance       | APPROVE_WITH_NITS | 0        | 0    | 2      | 2   | `467e2cb41` |
| 3     | Test coverage        | APPROVE_WITH_NITS | 0        | 0    | 3      | 1   | `1eb2833e0` |
| 4     | Security & isolation | APPROVE           | 0        | 0    | 0      | 0   | n/a         |
| 5     | Production readiness | APPROVE           | 0        | 0    | 0      | 0   | n/a         |

### Round-by-round highlights

- **Round 1 (code quality)**: 2 MEDIUM Maps unbounded → capped at 10k entries with oldest-insertion eviction; queue-depth tick swallowed catch → logs at warn; 401 for missing-secret → emits `code: 'CALLBACK_SECRET_MISSING'`; `(req as any)` → typed `Request` intersection; `classifyHttpStatus` dropped unused `_response` param.
- **Round 2 (HLD compliance)**: 2 MEDIUM dead-code metrics → wired `recordEnvelopeBytes(auditSizeBytes, { provider: auditConnector })` on success and `recordExtractionRateLimited({ tenant, provider })` when callback returns `RATE_LIMITED`; `_parkedByTenant` bounded at 10k for consistency.
- **Round 3 (test coverage)**: 3 MEDIUM gaps → added `UNSUPPORTED_CONTENT_TYPE` + `EXTRACTION_FAILED` to audit `it.each`; new TIMESTAMP_EXPIRED / TIMESTAMP_MISSING / SIGNATURE_MISSING / non-JSON-401 classifier tests in `callback-poster.test.ts`; new `extraction-metrics-eviction.test.ts` (4 tests asserting oldest-insertion eviction at 10001st entry across all 3 capped Maps).
- **Round 4 (security & isolation)**: APPROVE — zero findings. Tenant isolation, project isolation, centralized auth, callbackSecret encryption at rest, no raw-secret leaks, SSRF guards intact, 401 code split reveals no info, PII-redaction completeness, audit emission failure isolation, Map eviction race acceptable, \_response removal verified all PASS.
- **Round 5 (production readiness)**: APPROVE — zero findings. Performance acceptable (50 MB bound + lazy OTel + single JSON.stringify per step completion); every error path emits metric + audit + log; OTel noop-safe; Redis failure → Restate retry; pod restart → existing timeout; documentation consistent; rollback safe (additive-only, encryption backward-compat via `_enc`-flag absence); tests reliable (no timing, no order-dependence).

### Phase 4 Exit Criteria — DONE

- [x] `data-flow-audit` (2 rounds) log committed at `docs/sdlc-logs/document-extraction-integrations/data-flow-audit.md`; Round 1 CRITICAL closed by manifest + wrap/unwrap fix; Round 2 final verdict PASS.
- [x] `pr-reviewer` 5 rounds completed; CRITICAL + HIGH findings closed; MEDIUM findings closed across rounds 1-3.
- [x] `./tools/run-semgrep.sh` clean on the Phase 1-3 surface (37 files scanned, 0 findings).
- [x] All 14 metrics emit from documented code sites — 7 from workflow-engine OTel meter, 7 from search-ai log-line surface. Grafana dashboard JSON committed.
- [x] Alert rules YAML committed (5 rules: 2 queue-depth, 1 callback-failure ratio, 1 rate-limited ratio, 1 cost-cap ratio, 1 breaker-OPEN). Deploy target = `abl-platform-deploy:prometheus/rules/`.
- [x] PII redaction integration test passes (4 scenarios).
- [x] Audit-event integration test passes (11 scenarios including all 10 rejection codes).
- [x] Rollback drill test passes (6 scenarios: flag-OFF FEATURE_DISABLED on routes; flag-OFF loader skips Azure DI + Docling; flag-OFF in-flight callbacks resolve).
- [x] Encryption round-trip test passes (4 scenarios: encrypt→at-rest→decrypt; cross-tenant defense; pre-fix plaintext fallback; double-encryption guard).
- [x] Metric eviction tests pass (4 scenarios — all 3 capped Maps + the "update existing key does not evict" case).
- [x] All 8 touched `agents.md` updated (`connectors`, `workflow-engine`, `search-ai`, `studio`, `database`, `shared`, `shared-encryption`, `search-ai-sdk`).
- [x] `phase-auditor` PASS verdict (2 HIGH artifact-vs-code drift findings closed in this commit: implementation log Phase 4 section written; HLD §7.4 stale paragraph updated to reflect Phase 4 closure).

### Phase 4 Deferred (handed to Phase 5 beta)

| Deferred item                                               | Reason                                                                                                                                                        | Phase target |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Full `runExtractDocument` E2E (replay safety, 429, 404)     | Requires out-of-process Azure DI fixture server; composite flow is acknowledged Phase 5 work.                                                                 | Phase 5 beta |
| Cross-provider parity E2E (Docling vs Azure DI on same PDF) | Requires both fixture servers running.                                                                                                                        | Phase 5 beta |
| 100-concurrent atomic `$inc` stress test against real Mongo | The CAS-reset algorithm is unit-tested at 2-concurrent; the stress test against `MongoMemoryServer` is Phase 4 hardening item that landed in unit form.       | Phase 5 beta |
| Per-request `AbortSignal.timeout` on Azure DI polls         | Outer `POLL_HARD_DEADLINE_MS` (30 min) bounds total wall time; per-request timeouts are an incremental hardening.                                             | Phase 5 beta |
| Per-tenant Redis-backed rate limiter for Azure DI           | Phase 3 uses `RateLimiterMemory` (per-pod). Phase 5 migrates to Redis-backed mirroring the Docling pattern.                                                   | Phase 5 beta |
| Studio E2E specs (Docling + Azure DI)                       | Requires running stack (Studio + workflow-engine + Docling fixture).                                                                                          | Phase 5 beta |
| 5-format integration suite (PDF/DOCX/PPTX/HTML/image)       | Requires fixture variety bound to full workflow round-trip.                                                                                                   | Phase 5 beta |
| `connector-catalog.json` regeneration for all 38+ entries   | Functional gap is closed (Studio reads `ConnectorConnection` directly); the static catalog miss is a docs/CLI gap only.                                       | Phase 5 beta |
| OTel SDK boot in search-ai pod                              | Worker-side metrics emit as log-lines today; Phase 5 promotes to true OTel counters with zero call-site changes (the metric module's API is OTel-compatible). | Phase 5 beta |
| Integrated BullMQ encrypt→worker→HMAC E2E test              | Round 2 of data-flow-audit flagged this as MEDIUM; producer-side wrap and consumer-side unwrap are individually tested. Full E2E is a Phase 5 hardening item. | Phase 5 beta |

### Phase 4 Learnings

- **Encryption manifest is a contract**: `fieldsToEncrypt: []` is not "no-op safe" — it leaves secrets plaintext-at-rest in Redis even when the wrap helper is called. Data-flow audits must check both (a) the manifest entry AND (b) the producer/consumer call sites. The Round 1 CRITICAL was a manifest-level error, not a code-level error.
- **`scrubTraceEvent` is the right boundary for connector callback outputs**: extraction envelopes contain user-supplied document content; applying the platform scrubber once at the engine suspension exit (before step.output, publisher, or persistence) is cheaper and more reliable than per-connector redaction. The `pk_*` Stripe pattern needed `sk_*`/`rk_*` extension to catch secret keys (was only catching publishable keys).
- **Round-7 401 code split**: distinguishing `TIMESTAMP_EXPIRED` from `SIGNATURE_INVALID` requires cooperation between the route (emit `code` field) and the poster (read and classify). Clock skew between worker/engine pods is observable in the failures metric `error_class` dimension once split — without the split, all 401s look like signature failures.
- **In-memory Maps in observability code need explicit caps**: even when entries self-clean on a counter reaching zero, defense-in-depth caps (10k) prevent runaway memory growth from emission bugs. The neighboring Maps in the same file should use the same cap convention.
- **Dead metrics are a real failure mode**: 2 OTel counters in Round 2 had zero callers despite being documented in `dashboard.md` and reachable via the LLD's metric matrix. Dashboards depend on call-site wiring, not just instrument definition. Wire-up verification should be a phase-auditor check item.
- **Restate-replay vs at-rest encryption**: the BullMQ at-rest encryption is independent of the existing step-record `callbackSecret` ciphertext. They serve different threat models (Redis snapshot dump vs Mongo snapshot dump). The two-layer pattern is intentional and the backward-compat path (`_enc`-flag absence) lets the migration land without operational gymnastics.

---

## Phase 5 — IN PROGRESS (operational, code deliverables landed 2026-05-15)

Phase 5 in the LLD is a **beta-rollout / saturation-soak** phase — the feature code is fully landed in Phases 1-4. Phase 5 is operational work that requires real-tenant traffic, real Azure DI subscriptions, and 5 business days of monitored soak. The deliverables for the code/docs side are:

### Code deliverables (this commit)

| File                                                                | Purpose                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `benchmarks/saturation/document-extraction.ts`                      | k6 saturation script — two blended scenarios (60% Docling, 40% Azure DI). Reads workflow IDs, doc-URL list, and Workflow Engine base URL from env vars; credentials are NEVER read by the script (the Azure DI key lives on the `ConnectorConnection` provisioned via Studio). Thresholds match HLD §4.3 SLO targets (p95 ≤ 25 s Docling, ≤ 20 s Azure DI, ≤ 500 ms trigger, ≥ 95% success rate). |
| `docs/sdlc-logs/document-extraction-integrations/load-test-plan.md` | Saturation matrix (smoke / light / sustained / stress / burst), pass-fail criteria, Coroot capture window, reporting template, and rollback-during-test procedure.                                                                                                                                                                                                                                |
| `docs/sdlc-logs/document-extraction-integrations/beta-runbook.md`   | Per-tenant enable procedure, 5-day daily soak SOP, tuning playbook, rollback procedure, Phase 5 exit gate, and communication plan.                                                                                                                                                                                                                                                                |

### What still requires the operator (out-of-scope for this commit)

These items cannot be performed from a local development sandbox; they require production credentials, staging infrastructure, or the soak time window:

| LLD task                                                                                           | Status                                                                                                                                      |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 Enable `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED=true` for 3 internal tenants              | OPERATOR — runbook §1                                                                                                                       |
| 5.2 Onboard 1 Azure DI subscription per internal tenant                                            | OPERATOR — runbook §1 step 3                                                                                                                |
| 5.3 Daily Grafana dashboard review for 5 business days; tune `DOCLING_WORKFLOW_RATE_LIMIT_PER_MIN` | OPERATOR — runbook §2 + §3                                                                                                                  |
| 5.4 Capacity report via `load-test-analysis` skill                                                 | OPERATOR — load-test-plan §5 (run) + §8 (report). The skill stitches k6 + Coroot metrics into a saturation analysis once both are captured. |

### Credential handling note (data-flow-audit derivative)

Azure DI API keys are sensitive secrets. The k6 script intentionally does NOT read the key — credentials live on `ConnectorConnection` (encrypted via tenant DEK; existing pattern) and are consumed inside the Azure DI piece via the `auth.connectionConfig.apiKey` resolver. The k6 driver never touches them. Operators provisioning beta tenants must rotate any sandbox/test key that has ever appeared in chat, source control, screenshots, or pull-request descriptions before exposing it to real traffic.

### Phase 5 exit-gate checklist

Tracked in `beta-runbook.md` §5. All five gates must be green before the feature spec is promoted PLANNED → BETA via `/post-impl-sync`.

### Phase 5 deferred to Phase 6 / Phase 7

The 10 Phase 4-deferred code items (full E2E suites, OTel SDK boot in search-ai, per-tenant Redis rate-limiter for Azure DI, Studio E2E specs, 5-format integration suite, etc.) remain deferred unless the load-test result motivates pulling one forward. The load-test report (§8 of the load-test plan) will recommend either "proceed to Phase 6" or "hold and harden specific items first" based on observed saturation.

### Handoff

Operator + SRE pair to begin Phase 5 §0 pre-flight checklist (`beta-runbook.md`). Once the load test runs and the daily SOP captures 5 clean days, run `/post-impl-sync document-extraction-integrations` to promote the feature status.
