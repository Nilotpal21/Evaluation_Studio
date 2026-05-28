# Test Specification: Document Extraction Integrations (Docling + Azure Document Intelligence)

**Feature Spec**: [`../features/document-extraction-integrations.md`](../features/document-extraction-integrations.md)
**HLD**: `../specs/document-extraction-integrations.hld.md` _(pending — next SDLC phase)_
**LLD**: `../plans/document-extraction-integrations.lld.md` _(pending — next SDLC phase)_
**Status**: PARTIAL (implementation BETA — relay-race refactor (2026-05-20) replaced awakeable suspension with MongoDB `parkStep` + `startWorkflow` relay model; all 6 trigger paths use relay-race; ADI uses BullMQ poll worker; data-flow audit Round 1 + Round 2 + Round 3 (2026-05-18 through 2026-05-21) complete — all CRITICAL/HIGH findings fixed, remaining MEDIUM/LOW boundary-test gaps tracked below. 1280 unit/integration tests passing (up from 1045), 155 HTTP/integration tests passing (up from 71), 0 failures. Relay-race execution model tests COVERED in `restate-client.test.ts` and `execution-store.test.ts`. Boundary tests COVERED: HMAC rejection (`workflow-callbacks.test.ts:144`), `findBySource` projectId isolation (`human-task-resolution-routes.test.ts:109`, `workflow-approvals.test.ts:203`), connector async parking (`connector-async-parking.test.ts`), callbackUrl at-rest encryption (Round 2 fix + test), strip set parity F-WS-1 (Round 3 fix — all 3 strip sets now 11 fields). Boundary tests MISSING: rate limiter 429 (`createCallbackRateLimit`), `rejectStepIds` stripping from REST, `hasHumanWait` persistence round-trip, `computeExecutionEdges` data_entry edge handles, `inputSnapshot` stripping. Stale tests NEEDS_FIX: `system-human-task-store.test.ts` (4 cases use old 3-arg `findBySource`), `workflow-callbacks.test.ts:162` (expects 403 for private IP — route has no IP blocking). E2E test suite from §1 not yet written — manual validation ongoing on live stack. STABLE gate requires 5+ E2E + 5+ integration passing in CI.)
**Last Updated**: 2026-05-21
**Source design plan**: `/Desktop/docling-azure-di-integration-plan.md` (1008-line plan, 2026-05-14)
**Target branch**: `feature/wf/ocrnode`

---

## Test integrity invariants (CLAUDE.md)

- **No mocks of `@agent-platform/*`, `@abl/*`, or relative imports.** Only external third-party SaaS (Azure DI) may be mocked, and only via dependency injection inside the AP piece's `run()`. The Docling Python service is stubbed at the HTTP layer via `nock` (integration tests only; E2E uses out-of-process fixture servers — see §2 header and §7 Test Infrastructure).
- **E2E tests interact only via HTTP API** — they MUST NOT introspect BullMQ Redis state, query MongoDB directly, or import Mongoose models. Integration tests may use real BullMQ Redis / real MongoMemoryServer.
- E2E tests run real Express servers (via PM2 in `apps/studio/playwright.config.ts` or `{ port: 0 }` for self-hosted tests) with the full middleware chain.
- Round-trip coverage MUST include all envelope content types — `pages[]`, `tables[]`, `images[]`, `headings[]`, `metadata{}` — not just plain strings.
- **Form error path E2E scenarios are mandatory** for every form: at least one invalid-input submission asserting the DOM error, and at least one 4xx server response asserting the UI surfaces the error.
- **Wiring verification scenario is mandatory** for any new Studio API route: at least one E2E proves the Studio UI → Studio API → workflow-engine → search-AI worker → Docling → callback chain end-to-end.
- All structured error responses use `{ success, data?, error: { code, message } }` per CLAUDE.md.

---

## 1. Coverage Matrix

Maps every FR (and the cross-cutting ISO / AUTH / AUTHZ / PERF / FORM-ERR / WIRING categories) to test types and tracks status. `⬜` = required, not yet implemented. `✅` = passing. `❌` = failing. `—` = not applicable.

| FR / Category                               | Description                                                                                                                       | Unit | Integration | E2E | Manual | Status  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ------- |
| FR-1                                        | Both connectors registered in `ConnectorRegistry` and discoverable via the loader                                                 | —    | ⬜          | —   | —      | PLANNED |
| FR-2                                        | Integration Picker gating — Docling: project toggle; Azure DI: AuthProfile bound                                                  | —    | ⬜          | ⬜  | —      | PLANNED |
| FR-3                                        | Project toggle endpoints (`enable` / `disable` / `quota`) — idempotency, cross-project 404                                        | —    | ⬜          | ⬜  | —      | PLANNED |
| FR-4                                        | Shared parameter schema validation (`fileUrl`, `pages`, `extractImages`, `extractTables`, `ocrEnabled`, …)                        | ⬜   | ⬜          | —   | —      | PLANNED |
| FR-5                                        | `ExtractionEnvelopeSchema` Zod validation across both providers; full round-trip coverage of content types                        | ⬜   | ⬜          | ⬜  | —      | PLANNED |
| FR-6                                        | `IntegrationNodeConfigSchema.timeout` accepts 5–1800 s; default 60; rejects out-of-range; engine `raceTimeout` honors the new max | ⬜   | ⬜          | —   | —      | PLANNED |
| FR-7                                        | New `QUEUE_WORKFLOW_DOCLING_EXTRACTION` constant + factory; `encryption-manifest.ts` entry                                        | ⬜   | ⬜          | —   | —      | PLANNED |
| FR-8                                        | Two-Worker subscriptions; env-overridable concurrencies; sum-cap assertion                                                        | ⬜   | ⬜          | ⬜  | —      | PLANNED |
| FR-9                                        | Worker `extraction-only` branch — SSRF re-check, streaming URL, envelope normalize, size cap, HMAC POST + retry                   | —    | ⬜          | ⬜  | —      | PLANNED |
| FR-10                                       | BullMQ job payload additive fields default safely; existing `full-ingestion` producers unchanged                                  | —    | ⬜          | —   | —      | PLANNED |
| FR-11                                       | Docling workflow step body inside `ctx.run` — SSRF, HEAD, rate-limit, HMAC secret gen, enqueue, park                              | —    | ⬜          | ⬜  | —      | PLANNED |
| FR-12                                       | Callback route HMAC verification mandatory; signed POST resolves parked promise; bad signature returns 401                        | —    | ⬜          | ⬜  | —      | PLANNED |
| FR-13                                       | Azure DI AP piece — `PieceAuth.CustomAuth` + `validate` against `/info` + `createAction('extract_document')`                      | ⬜   | ⬜          | ⬜  | —      | PLANNED |
| FR-14                                       | Auth-adapter data-mapping shim — `AuthProfile` (`api_key` + `connectionConfig`) → AP `CustomAuth` shape                           | ⬜   | ⬜          | —   | —      | PLANNED |
| FR-15                                       | `ConnectionResolver` short-circuit for `auth.type === 'none'`; system AuthProfile auto-bind idempotency                           | —    | ⬜          | —   | —      | PLANNED |
| FR-16                                       | Azure DI `ctx.store` replay safety — single Azure invoice per logical extraction; key cleanup on terminal                         | —    | ⬜          | ⬜  | —      | PLANNED |
| FR-17                                       | Azure DI guards — SSRF, HEAD timeout, rate limit, circuit breaker, `Retry-After`, poll backoff, inline cap                        | ⬜   | ⬜          | ⬜  | —      | PLANNED |
| FR-18                                       | Per-project Azure DI cost — atomic `$inc`, CAS monthly reset, soft-cap warning, hard-cap `QUOTA_EXCEEDED`                         | —    | ⬜          | ⬜  | —      | PLANNED |
| FR-19                                       | `TraceEvent` emission with typed error codes; no internal-URL / subscription-key leakage                                          | —    | ⬜          | ⬜  | —      | PLANNED |
| FR-20                                       | Audit log envelope per extraction (both providers); existing search-AI audit unchanged                                            | —    | ⬜          | —   | —      | PLANNED |
| FR-21                                       | `connector-catalog.json` regenerated; both connectors with action + parameter schemas                                             | —    | ⬜          | —   | —      | PLANNED |
| FR-22                                       | Feature flag `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED=false` hides both connectors; toggle API rejects                       | —    | ⬜          | ⬜  | —      | PLANNED |
| **ISO-1** — Cross-tenant 404                | Toggle / quota / usage endpoints return `{ success:false, error:{ code:'NOT_FOUND'} }` for foreign tenant context                 | —    | ⬜          | —   | —      | PLANNED |
| **ISO-2** — Cross-project 404               | Same routes return 404 for project-of-another-tenant access                                                                       | —    | ⬜          | —   | —      | PLANNED |
| **ISO-3** — User isolation                  | Workflow execution principal inherited; ConnectorToolExecutor enforces principal-aware resolution                                 | —    | ⬜          | —   | —      | PLANNED |
| **AUTH-1** — Unauthenticated 401            | Missing bearer / API key → 401 on all 5 new project-scoped routes                                                                 | —    | ⬜          | —   | —      | PLANNED |
| **AUTH-2** — HMAC callback signature        | Missing / invalid `x-callback-signature` → 401 on callback POST                                                                   | —    | ⬜          | —   | —      | PLANNED |
| **AUTHZ-1** — Insufficient permission 403   | Viewer role attempting `integrations:write` → 403                                                                                 | —    | ⬜          | ⬜  | —      | PLANNED |
| **AUTHZ-2** — Reader denied write           | Reader role attempting PATCH cost-caps → 403                                                                                      | —    | ⬜          | —   | —      | PLANNED |
| **FORM-ERR-1** — Toggle form 403            | Viewer flipping Docling toggle → DOM error message; toggle reverts to off                                                         | —    | —           | ⬜  | —      | PLANNED |
| **FORM-ERR-2** — Azure DI form invalid URL  | AuthProfile form with `endpoint=not-a-url` → DOM field-level validation error                                                     | —    | —           | ⬜  | —      | PLANNED |
| **FORM-ERR-3** — Test Connection 401        | Azure DI `Test Connection` returns 401 from Azure `/info` → form surfaces the upstream error                                      | —    | —           | ⬜  | —      | PLANNED |
| **FORM-ERR-4** — DynamicActionForm range    | `timeout: 2` (below `min(5)`) → form-level error; submit disabled or rejected with surfaced server 422                            | —    | —           | ⬜  | —      | PLANNED |
| **WIRING-1** — End-to-end Studio → Docling  | Single E2E proves Studio UI → Studio API → workflow-engine → BullMQ → search-AI worker → Docling → callback chain                 | —    | —           | ⬜  | —      | PLANNED |
| **PERF-1** — Engine parked-promise memory   | 1000 simultaneously parked Docling steps → workflow-engine pod RSS delta < 50 MB                                                  | —    | ⬜          | —   | —      | PLANNED |
| **PERF-2** — Worker streaming RSS           | 100 MB synthetic PDF streamed → worker-process RSS delta < 10 MB                                                                  | —    | ⬜          | —   | —      | PLANNED |
| **PERF-3** — Two-queue isolation under load | Saturate ingestion → Worker A ≤3 active, Worker B ≤2 active; workflow drained at Worker B's full rate                             | —    | —           | ⬜  | —      | PLANNED |
| **PERF-4** — Capacity ramp                  | k6 ramp 5 → 50 concurrent over 10 min; p95 within SLO; Coroot saturation < 80 %                                                   | —    | —           | —   | ⬜     | PLANNED |

---

## 2. E2E Test Scenarios (MANDATORY — minimum 5; 13 listed)

All E2E tests are Playwright specs. Most files live under `apps/studio/e2e/workflows/` (consolidated there with a feature-related prefix; no new subdirectory); the two Azure DI AuthProfile-form specs live under `apps/studio/e2e/auth-profiles/` matching the existing repo convention for auth-profile flows. They run against the existing dev stack via `apps/studio/playwright.config.ts` (`reuseExistingServer: true`, Chromium only). Auth uses `loginAndSetup()` from `apps/studio/e2e/workflows/helpers.ts` returning `{ projectId, token }`. **Stub infrastructure** — Playwright runs in a separate Chromium process, so `nock` (in-process Node interception) does NOT work for E2E. Two real out-of-process fixtures are used: (a) a lightweight Express **Docling fixture server** (`apps/studio/e2e/workflows/fixtures/docling-fixture-server.ts`) started on a known port (e.g., `8088`) before each Playwright run, serving canned `/extract` responses; `DOCLING_SERVICE_URL` is pointed at it for the test environment; (b) the same pattern for the **Azure DI fixture server** serving `/info`, `:analyze`, `Operation-Location`, `Retry-After` and 5xx variants. Both fixture servers are managed by `apps/studio/playwright.config.ts`'s `globalSetup` / `globalTeardown` hooks. Workflow-engine, search-AI, Mongo, and BullMQ Redis are **real**.

### E2E-1: Docling happy-path — public PDF extraction returns normalized envelope

- **Preconditions**: tenant + project seeded via `loginAndSetup()`; feature flag `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED=true`; `DOCLING_SERVICE_URL` points at the Docling fixture server (Playwright globalSetup); fixture serves a canned 3-page PDF response.
- **Steps**:
  1. `POST /api/projects/:projectId/integrations/docling/enable` → 200; assert `ConnectorConnection` is discoverable in `GET /api/projects/:projectId/connections?connectorName=docling`.
  2. Create workflow with one Integration Node configured `{ connectorId: 'docling', actionName: 'extract_document', params: { fileUrl: <public PDF URL> } }` via `createWorkflowViaUI()`.
  3. `POST /api/v1/workflows/:id/run` → captures `executionId`.
  4. Poll `GET /api/v1/workflows/:id/executions/:executionId` until `status === 'completed'` (timeout 60 s).
  5. Read the step output via the execution API.
- **Expected Result**: step output matches `ExtractionEnvelopeSchema`; `provider === 'docling'`; `pages.length === 3`; at least one `pages[i].tables` entry; `metadata.pageCount === 3`; `metadata.processingTimeMs > 0`. `TraceEvent` returned by `GET /api/projects/:projectId/trace-events?executionId=...` includes one event with `provider === 'docling'` and no `EXTRACTION_*` error code.
- **Auth Context**: tenant T1 + project P1 + user with `workflow:execute` + `integrations:write`.
- **Isolation Check**: same request scoped to tenant T2 returns 404 on the `GET .../connections` poll (Docling toggle was set in T1 only).
- **Covers**: FR-1, FR-3 (`enable`), FR-5, FR-9, FR-11, FR-12, FR-15, FR-19, FR-21.

### E2E-2: Azure DI happy-path — XLSX extraction with `pages` parameter

- **Preconditions**: tenant + project seeded; Azure DI fixture server returning canned `analyzeResult` for an XLSX (3 sheets, 8 tables) and `/info` returns 200; AuthProfile `endpoint` points at the fixture server URL.
- **Steps**:
  1. `POST /api/auth-profiles` with `type: 'api_key'`, `config: { connectionConfig: { endpoint, apiVersion: '2024-11-30', defaultModel: 'prebuilt-layout' } }`, `secrets: { apiKey }`, scoped to project P1 → 201; assert returned `_id`.
  2. `POST /api/projects/:projectId/connections` binding the AuthProfile to `connectorName: 'azure-document-intelligence'` → 201.
  3. Create workflow with `extract_document` Azure DI action, `params: { fileUrl: <XLSX URL>, pages: '1-2', model: 'prebuilt-layout' }`.
  4. Run + poll to completion.
- **Expected Result**: envelope `provider === 'azure-document-intelligence'`; `pages.length === 2` (page filter applied); each page has non-empty `tables`; `metadata.pageCount === 3` (total in document, even though only 2 returned by filter); audit-log entry returned by `GET /api/audit-logs?executionId=...` has `connector === 'azure-document-intelligence'` and `sourceUrl` host-only.
- **Auth Context**: tenant T1 + project P1.
- **Isolation Check**: project P2 in same tenant cannot see this connection (`GET /api/projects/:p2/connections` → no entry); cross-tenant 404.
- **Covers**: FR-1, FR-4 (`pages`), FR-5, FR-13, FR-14, FR-16, FR-17, FR-20.

### E2E-3: Project toggle gating mid-flight

- **Preconditions**: Docling enabled in P1; a workflow with a Docling step exists; one execution has parked successfully and another is queued.
- **Steps**:
  1. Start `Execution-1` (will park).
  2. `POST .../docling/disable` → 200.
  3. Start `Execution-2`.
  4. Poll both to terminal state.
- **Expected Result**: Execution-1 completes normally (already-parked workflow is not affected by toggle change). Execution-2 fails fast with `status: 'failed'` and trace event `error.code === 'INTEGRATION_DISABLED'`. `POST .../docling/enable` again → Execution-3 succeeds.
- **Auth Context**: tenant T1 + project P1.
- **Isolation Check**: Project P2 toggle state is unaffected; cross-project routes return 404.
- **Covers**: FR-3, FR-15, FR-19.

### E2E-4: Cross-provider parity — identical envelope shape for same PDF

- **Preconditions**: Docling toggle on; Azure DI AuthProfile bound; both fixture servers return realistic envelope data for the SAME 10-page PDF (text + 2 tables + 1 image).
- **Steps**:
  1. Run workflow A: Docling `extract_document` on the PDF.
  2. Run workflow B: Azure DI `extract_document` on the same PDF.
  3. Compare envelopes structurally.
- **Expected Result**: Both envelopes pass `ExtractionEnvelopeSchema.safeParse`. `metadata.pageCount` matches. `pages.length` matches. Sum of `markdown.length` across all pages within ±10 % between providers. Both have non-empty `tables[]` and `images[]` arrays. `provider` field is the only divergent top-level value.
- **Auth Context**: tenant T1 + project P1.
- **Isolation Check**: N/A (parity test).
- **Covers**: FR-5, FR-9, FR-13.

### E2E-5: SSRF rejection — workflow run with private/metadata URL

- **Preconditions**: Docling toggle on.
- **Steps**:
  1. Run workflow with `fileUrl: 'http://169.254.169.254/latest/meta-data/'`.
  2. Poll execution.
- **Expected Result**: execution `status: 'failed'`; trace event `error.code === 'SSRF_BLOCKED'`; no BullMQ job ever processed (assert via the worker's metric counter `bullmq_queue_depth{queue='workflow-docling-extraction'}` stayed flat — accessed via `GET /metrics`, not by introspecting Redis).
- **Auth Context**: tenant T1 + project P1.
- **Isolation Check**: same URL pattern rejected for all tenants — no leakage.
- **Covers**: FR-9, FR-11, FR-19 (and US-5).

### E2E-6: Restate replay safety — engine pod restart between enqueue and callback

- **Preconditions**: Docling toggle on; workflow run started; pod-restart hook accessible via `POST /test/restart-workflow-engine` (test-only endpoint, gated by `NODE_ENV !== 'production'`); Docling fixture server configured with a 5-second pre-response delay.
- **Steps**:
  1. Start workflow; wait until the step parks (observable via execution API showing `status === 'waiting_callback'`).
  2. Trigger workflow-engine pod restart via `POST /test/restart-workflow-engine`.
  3. Wait for restart healthcheck → 200.
  4. Worker completes (the pre-restart fixture response unblocks); callback POST arrives.
  5. Poll execution.
- **Expected Result**: execution completes successfully (single envelope returned); exactly **one** Docling fixture-server call recorded (assert via the fixture server's `GET /test/call-count` endpoint); exactly **one** callback POST consumed by the engine (verified via the engine's structured logs query API).
- **Auth Context**: tenant T1 + project P1.
- **Covers**: FR-11, FR-12 + R9 mitigation.

### E2E-7: Two-queue isolation under saturation load

- **Preconditions**: Docling toggle on; both queues empty; feature flag on.
- **Steps**:
  1. Concurrently enqueue 20 ingestion jobs (via search-AI's existing API at `POST /api/v1/search-ai/index/:indexId/upload`) and 10 workflow extraction jobs (via Studio API workflow runs).
  2. Sample `GET /metrics` every 2 seconds for 60 seconds.
- **Expected Result**: `worker_active_jobs{queue='search-docling-extraction'}` never exceeds 3 per pod; `worker_active_jobs{queue='workflow-docling-extraction'}` never exceeds 2 per pod; workflow extractions complete at their own pace (median time-to-complete < 1.5× their average isolated completion time).
- **Auth Context**: tenant T1 + project P1.
- **Covers**: FR-8.

### E2E-8: Wiring verification (MANDATORY) — Studio UI → Docling → callback → workflow output

- **Preconditions**: feature flag on; Docling toggle off initially.
- **Steps** (Playwright, exercising real UI through to backend):
  1. `loginAndSetup()` → land on `/projects/:projectId/settings/integrations`.
  2. Click `data-testid="docling-toggle"` → wait for HTTP 200 from `POST .../docling/enable` (intercepted by Playwright's `page.waitForResponse`).
  3. Assert info line displays `"Rate limit: 10 extractions per minute (workspace-wide)"`.
  4. Navigate to workflow designer; click `data-testid="add-node-handle"` → `data-testid="integration-node-tile"`.
  5. In the Integration Picker, search `"Docling"` → assert tile is visible (proves Picker → catalog wiring); click → action list shows `Extract Document`.
  6. Fill `data-testid="param-fileUrl"` with a public PDF URL (or fixture-served URL); set `data-testid="param-timeout"` to `120`; click `data-testid="save-node"`.
  7. Click `data-testid="run-workflow"`.
  8. Wait for `data-testid="debug-panel-step-output"` to render the envelope.
- **Expected Result**: envelope rendered in debug panel has `provider === 'docling'`; trace events panel (`data-testid="trace-events"`) shows the step's TraceEvent; audit-log API query returns one entry for this execution.
- **Auth Context**: tenant T1 + project P1 + admin user.
- **Isolation Check**: re-running steps 1-3 against tenant T2 from a different browser context shows the toggle remains off in T2 (independent state).
- **Covers**: WIRING-1 mandate; FR-1, FR-2, FR-3, FR-9, FR-11, FR-12, FR-19, FR-20, FR-21.

### E2E-ERR-1 (FORM-ERR-1): Docling toggle — viewer role → DOM error + toggle reverts

- **Preconditions**: tenant T1 + project P1; user has `viewer` role only (no `integrations:write`).
- **Steps**:
  1. Navigate to `/projects/:projectId/settings/integrations`.
  2. Click `data-testid="docling-toggle"`.
  3. Assert `page.waitForResponse('**/integrations/docling/enable')` returns 403.
  4. Assert toggle DOM state is back to off (`aria-checked="false"`).
  5. Assert error message visible: `getByRole('alert')` contains `/permission denied|insufficient role|integrations:write/i`.
- **Expected Result**: form does not navigate away; user sees the server's 403 message; toggle reflects the actual server state.
- **Auth Context**: tenant T1 + project P1 + viewer user.
- **Covers**: FORM-ERR-1, AUTHZ-1.

### E2E-ERR-2 (FORM-ERR-2): Azure DI AuthProfile — invalid endpoint URL → field-level error

- **Preconditions**: tenant T1 + project P1 + admin user.
- **Steps**:
  1. Navigate to Auth Profiles → New Profile → `Azure Document Intelligence` tile.
  2. Fill `endpoint` with `"not-a-url"`.
  3. Fill `apiKey` with `"fake-key"`.
  4. Click Save.
  5. Assert field-level error appears next to the `endpoint` input: `data-testid="endpoint-error"` contains `/must be a URL|invalid endpoint|https/i`.
  6. Fix `endpoint` to `"https://example.cognitiveservices.azure.com/"`.
  7. Re-click Save.
- **Expected Result**: first submit does NOT navigate away from form; error visible in DOM; second submit succeeds (mocked Azure `/info` returns 200).
- **Auth Context**: tenant T1 + project P1 + admin.
- **Covers**: FORM-ERR-2, FR-13 (`validate` callback path).

### E2E-ERR-3 (FORM-ERR-3): Azure DI Test Connection — upstream 401 surfaced to UI

- **Preconditions**: tenant T1 + project P1 + admin; Azure DI fixture configured to return 401 from `/info`.
- **Steps**:
  1. Fill the Azure DI AuthProfile form with valid-looking values.
  2. Click `data-testid="test-connection"`.
  3. Assert `page.waitForResponse('**/auth-profiles/test-connection')` returns 502 (or whatever the platform wraps an upstream-401 as).
- **Expected Result**: DOM displays the upstream Azure error code/message (sanitized — no apiKey in the message); save remains disabled.
- **Auth Context**: tenant T1 + project P1 + admin.
- **Covers**: FORM-ERR-3, FR-13, FR-19 (no-leak invariant).

### E2E-ERR-4 (FORM-ERR-4): DynamicActionForm — out-of-range timeout → submit blocked

- **Preconditions**: Docling toggle on; workflow has an Integration Node selected.
- **Steps**:
  1. Open the Docling action config.
  2. Set `data-testid="param-timeout"` to `2`.
  3. Click `data-testid="save-node"`.
  4. Assert `data-testid="param-timeout-error"` contains `/must be at least 5|minimum 5|out of range/i`.
  5. Fix `timeout` to `60`.
  6. Click save → success.
- **Expected Result**: client-side Zod validation rejects `2`; server-side schema validation rejects it again if client check were bypassed. Save success on `60`.
- **Auth Context**: tenant T1 + project P1.
- **Covers**: FORM-ERR-4, FR-6, FR-4.

### E2E-9: Rate-limit rejection — trace event renders static configured value

_(Note: not a form error scenario — workflow execution failure path. Listed in the E2E section because it exercises the full extraction pipeline and the trace-event UI.)_

- **Preconditions**: tenant T1 burst capacity 5, sustained 10/min; 15 prior extractions in the past minute.
- **Steps**:
  1. Trigger workflow extraction #16.
  2. Poll execution.
- **Expected Result**: execution `status: 'failed'`; trace event `error.code === 'RATE_LIMITED'`; trace event `error.message` equals the configured static string `"Workspace rate limit: 10 extractions/min — try again shortly."` (verified char-for-char — no live counter, no template interpolation).
- **Auth Context**: tenant T1 + project P1 + user with `workflow:execute` + `integrations:read`.
- **Covers**: FR-11 step 4, FR-19 (static rendering invariant).

---

## 3. Integration Test Scenarios (MANDATORY — minimum 5; 18 listed)

Integration tests run with real BullMQ Redis, real `MongoMemoryServer` (via the existing `apps/workflow-engine/src/__tests__/helpers/setup-mongo.ts` and `apps/search-ai/src/__tests__/helpers/setup-mongo.ts`), real Express on `{ port: 0 }`, **DI-stubbed Restate client** (via `makeRestateStub` pattern from `system-callback.test.ts`), and `nock` against the Docling service URL. Azure DI is mocked via DI inside the AP piece's `run()` (the piece accepts an HTTP client argument; production wires the real one).

### INT-1: Worker → engine callback round-trip with HMAC

- **Boundary**: search-AI worker → workflow-engine callback route.
- **Setup**: spawn workflow-engine Express on random port mounting `createCallbackRouter(deps)` from `apps/workflow-engine/src/routes/workflow-callbacks.ts`; deps inject real `executionModel` (MongoMemoryServer-backed), `restateClient` stubbed, `decryptSecret` passthrough; seed a parked execution with stepId `step-1` and HMAC secret `S`; build job payload with `callbackUrl = http://localhost:<port>/api/v1/workflows/callbacks/<execId>/step-1` and `callbackSecret = S`.
- **Steps**: instantiate the worker's `callback-poster` helper; invoke it with `{ callbackId, status: 'success', envelope }`; assert it builds the HMAC headers using `buildSignatureHeaders` from `@agent-platform/shared-kernel/security`; assert the POST returns 200.
- **Expected Result**: `restateClient.resolveCallback` called exactly once with `{ executionId, stepId: 'step-1', payload: { envelope } }`; execution status updated to `running` (callback resolved).
- **Failure Mode**: invalid signature → 401; expired timestamp (>5 min skew) → 401; missing parked step → 404 (worker treats as terminal, does not retry).
- **Covers**: FR-9, FR-12.

### INT-2: Worker `full-ingestion` branch is byte-for-byte unchanged

- **Boundary**: search-AI worker processor function — branch fall-through.
- **Setup**: real worker processor with both Worker subscriptions running; enqueue a job to `search-docling-extraction` queue without any of the new optional fields (`mode`, `options`, `callbackId`, `callbackUrl`, `callbackSecret` all omitted); `nock` stub the Docling `/extract` to return the existing-shape full-ingestion response.
- **Steps**: enqueue; await job completion via BullMQ `QueueEvents`.
- **Expected Result**: `SearchDocument` written to Mongo; `DocumentPage` rows written; downstream-stage queue jobs enqueued (assert via `bullmq` API on each downstream queue). No callback POST attempted (verified via the callback-poster helper's mock).
- **Failure Mode**: any divergence from existing behavior fails the test — this is a regression gate.
- **Covers**: FR-9 (negative branch), FR-10.

### INT-3: Restate replay — parked promise survives engine restart simulation

- **Boundary**: workflow-engine `async_webhook` step body → Restate journal → callback resume.
- **Setup**: workflow-engine Express on random port; real Mongo; **stubbed** Restate client implementing `ctx.promise(...).get()` that records pending resolves and supports a "replay" command to re-invoke the parked workflow function from a journal-like map. Seed a workflow with one Docling step.
- **Steps**: 1) invoke step body — assert it parks (returns to caller via promise hook). 2) Simulate restart: discard the in-memory parked promise but keep the journal map. 3) Re-invoke the parked workflow function — assert it re-enters the `ctx.run` lambda only ONCE (verified by counting calls to `restateContext.run` mock); the parked promise re-attaches; no second BullMQ enqueue.
- **Expected Result**: enqueue happens exactly once across the simulated restart; parked promise re-attaches; subsequent callback POST resolves the workflow.
- **Failure Mode**: double enqueue on replay → test fails (this is R9).
- **Covers**: FR-11, replay-safety invariant.

### INT-4: Azure DI 429 with `Retry-After` honored

- **Boundary**: AP piece `run()` → Azure DI REST (DI-mocked).
- **Setup**: AP piece run with a mock HTTP client that returns 202 for `:analyze`, then on poll #1 returns 429 with `Retry-After: 2`, then on poll #2 returns 200 with `analyzeResult`.
- **Steps**: invoke `run()`; record timestamps of all HTTP calls.
- **Expected Result**: gap between poll #1 and poll #2 ≥ 2 seconds; final envelope returned successfully; `ctx.store` key cleaned up.
- **Failure Mode**: if action ignores `Retry-After` and bursts → test asserts via timestamp gap.
- **Covers**: FR-17 (d), FR-16.

### INT-5: Azure DI replay safety via `ctx.store`

- **Boundary**: AP piece `run()` → DI-mocked `ctx.store`.
- **Setup**: an in-memory KV store implementing `ctx.store` interface; mock Azure HTTP client tracks call counts; first invocation populates the store key after 202; second invocation (simulating replay) finds the key and skips `:analyze`.
- **Steps**: 1) first `run()` — call counter: 1× `:analyze`, N× poll. 2) Reset HTTP client mock, re-invoke `run()` with same `(executionId, stepId)`. 3) Assert second invocation: 0× `:analyze`, only poll calls, final envelope returned.
- **Expected Result**: exactly one `:analyze` call across both invocations; replay resumes polling same `Operation-Location`.
- **Failure Mode**: missing `ctx.store` read → second `:analyze` call → double billing.
- **Covers**: FR-16, R2a mitigation.

### INT-6: Azure DI `ctx.store` cleanup on success and terminal failure

- **Boundary**: AP piece `run()` → DI-mocked `ctx.store`.
- **Setup**: in-memory KV store with deletion tracking; mock HTTP client returns success in test A and terminal 400 in test B.
- **Steps**: invoke `run()`; assert `ctx.store.delete(key)` called exactly once at the end of both flows.
- **Expected Result**: no orphan keys remain; cleanup is symmetric on success and failure.
- **Failure Mode**: orphan key accumulation → would surface only as Redis-bloat over time; this test is the only enforcement.
- **Covers**: FR-16 (cleanup invariant).

### INT-7: ConnectionResolver short-circuit for `auth.type === 'none'`

- **Boundary**: `packages/connectors/src/auth/connection-resolver.ts` → `auth-profile-resolver-factory.ts`.
- **Setup**: in-memory connection model with a Docling connection bound to a synthetic AuthProfile (`type: 'none'`); ConnectionResolver instantiated with both real services.
- **Steps**: `resolveAuth({ connectorName: 'docling', tenantId, projectId })`.
- **Expected Result**: returns `{ auth: {}, scope: 'tenant' }` without invoking the secrets-decryption path; total elapsed < 5 ms; no Mongo read on the secrets collection (verified by an instrumentation counter on the AuthProfile model's `findOne` calls).
- **Failure Mode**: regression that re-introduces a secrets read → measurable latency spike + assertion failure.
- **Covers**: FR-15.

### INT-8: System AuthProfile auto-bind idempotency under concurrency

- **Boundary**: `ConnectionService.enableNoAuthConnector(...)`.
- **Setup**: real Mongo via `MongoMemoryServer`; freshly seeded tenant + project; no Docling connection.
- **Steps**: fire 10 concurrent `POST .../docling/enable` requests via `Promise.all`.
- **Expected Result**: exactly one `ConnectorConnection` document exists at the end; all 10 responses return 200 with the same `_id`; no duplicate-key errors leaked to the caller.
- **Failure Mode**: race window between `findOne` and `insertOne` → duplicate documents OR 11000 error surfaced.
- **Covers**: FR-3 (idempotency), FR-15.

### INT-9: Per-tenant rate-limit token bucket — burst then refill

- **Boundary**: workflow-engine step body → `RateLimiterRedis` (real Redis, isolated test prefix).
- **Setup**: real Redis test instance with key prefix `test:workflow:docling:`; rate-limit config `points: 10, burst: 5, duration: 60s`; tenant T1.
- **Steps**: fire 30 sequential enqueue requests (simulated by direct calls to the rate-limit consume function — the test does not go through the full HTTP path).
- **Expected Result**: first 15 (10 sustained + 5 burst) succeed; remainder fail with `RATE_LIMITED`. Wait 6 seconds (≥10 % of window) → next request succeeds (refilled tokens).
- **Failure Mode**: regression to a fixed-window limiter → bursts inside one window all allowed; sliding-window behavior is the contract.
- **Covers**: FR-11 step 4, US-6 metric `workflow_docling_rate_limited_total`.

### INT-10: Per-project Azure DI cost-cap — atomic `$inc` + CAS monthly reset

- **Boundary**: AP piece → MongoDB `ConnectorConnection` document.
- **Setup**: real Mongo via `MongoMemoryServer`; seeded `ConnectorConnection` with `usageCount: 0`, `usagePeriodStart: <current month>`, `usageSoftCap: 5`, `usageHardCap: 10`.
- **Steps**: 1) fire 20 concurrent `extract_document` invocations; collect responses. 2) Manually backdate `usagePeriodStart` to last month via direct Mongo write (test-only). 3) Fire one more invocation.
- **Expected Result**: first 10 of 20 succeed with `usageCount` increments 1..10; next 10 return `QUOTA_EXCEEDED`; `usageCount === 10` (atomic `$inc`, no lost updates). After backdating, the 21st call succeeds AND resets the counter to 1 via CAS `findOneAndUpdate` (`usagePeriodStart: { $lt: currentMonthStart }`).
- **Failure Mode**: non-atomic counter → some increments lost OR concurrent month-boundary resets → multiple resets → `usageCount` undercounted.
- **Covers**: FR-18.

### INT-11: HMAC callback — invalid signature returns 401, replay-tolerance window

- **Boundary**: workflow-engine callback route → `verifyWebhookSignature()`.
- **Setup**: real callback router mounted on supertest Express; seeded execution with HMAC secret `S`; payload signed with secret `S'` (≠ S).
- **Steps**: POST callback with `x-callback-signature` computed from wrong key; POST with stale `x-callback-timestamp` (now − 600 s, outside 300 s tolerance); POST with valid signature and fresh timestamp.
- **Expected Result**: wrong key → 401 + `{ code: 'INVALID_SIGNATURE' }`; stale timestamp → 401 + `{ code: 'TIMESTAMP_OUT_OF_RANGE' }`; valid → 200; replay attack (re-send valid POST after first success) → 200 (idempotent resolve via `handleResolveCallback`, but no second `restateClient.resolveCallback` mutation).
- **Failure Mode**: signature constant-time-compare regression → timing attack possible.
- **Covers**: FR-12, AUTH-2.

### INT-12: Cross-tenant AND cross-project 404 on every new project-scoped route

- **Boundary**: workflow-engine routes → tenant + project context middleware.
- **Setup**: tenant T_A creates a Docling toggle ON in project P_A and an Azure DI usage record in P_A. Tenant T_A also has project P_B (different project, same tenant) with empty state. Tenant T_B has empty state.
- **Steps**:
  1. **Cross-tenant case** — from T_B context (different tenant), hit each of the 5 new routes targeting T_A's project P_A's path.
  2. **Cross-project case** — from T_A context with P_B in the URL (a different project in the same tenant), hit each of the 5 new routes for P_A's data.
- **Expected Result**: every route in both cases returns 404 with `{ success: false, error: { code: 'NOT_FOUND' | 'INTEGRATION_NOT_FOUND' | 'PROJECT_NOT_FOUND' } }`. No "this exists in another tenant/project" hints in the response body. Note: cross-tenant returns 404 because the foreign tenant cannot reach P_A's data at all; cross-project returns 404 because the integration data is project-scoped and P_B has no entry.
- **Failure Mode**: 403 instead of 404 (information leak) → test fails.
- **Covers**: ISO-1, ISO-2.

### INT-13: Worker streaming RSS profile — 100 MB PDF stays bounded

- **Boundary**: search-AI worker streaming helper → Docling `/extract` multipart.
- **Setup**: in-memory 100 MB synthetic PDF buffer (Buffer.alloc with random fill); `nock` stub on Docling `/extract` that drains the streamed body and returns a fixed response; baseline RSS captured with `process.memoryUsage().rss` after warmup + `global.gc()` (test runner with `--expose-gc`).
- **Steps**: invoke the streaming helper end-to-end; sample RSS every 100 ms for the duration.
- **Expected Result**: peak RSS during call − baseline RSS < 10 MB.
- **Failure Mode**: regression to buffering (e.g., using the old `downloadDocument()`) → RSS delta ≈ 100 MB → test fails.
- **Covers**: PERF-2, FR-9 (streaming requirement).

### INT-14: Engine-side parked-promise memory invariant — 1000 concurrent parks

- **Boundary**: workflow-engine handler → `restateCtx.promise(...).get()` (stubbed Restate that holds the parked promises in a Map).
- **Setup**: stubbed Restate that does not auto-resolve.
- **Steps**: start 1000 parked workflow executions in rapid succession; capture RSS baseline before; let them park; capture RSS after; `global.gc()`; capture RSS again.
- **Expected Result**: post-park RSS delta − pre-park RSS < 50 MB (parked promises live in the stub's Map, not in held async stacks).
- **Failure Mode**: if the implementation uses `job.waitUntilFinished()` instead of `restateCtx.promise().get()` → held awaits balloon RSS proportional to N.
- **Covers**: PERF-1, FR-11 invariant.

### INT-15 (build verification, not service-boundary integration): Connector catalog regeneration includes both connectors

- **Boundary**: build-time script `pnpm connectors:generate-catalog` → `packages/connectors/src/generated/connector-catalog.json`. _(Not a runtime service boundary; this is a build artifact verification.)_
- **Setup**: clean checkout state; run the generator.
- **Steps**: invoke `pnpm connectors:generate-catalog`; parse the resulting JSON.
- **Expected Result**: catalog contains entries for `docling` and `azure-document-intelligence`; each has `actions: [{ name: 'extract_document', params: [...] }]` with the parameter schema visible (validates against `ExtractionEnvelopeSchema`-adjacent meta-schema).
- **Failure Mode**: catalog drift (loader registers connectors but generator misses them) → test fails the build.
- **Covers**: FR-21.

### INT-16: Audit log emission for both providers

- **Boundary**: workflow-engine step completion → audit-log service.
- **Setup**: real Mongo with `AuditLog` model; spy on the audit emit point (instrumented via DI).
- **Steps**: complete one Docling extraction; complete one Azure DI extraction (both with stubbed external HTTP); query `AuditLog.find({ tenantId, projectId })`.
- **Expected Result**: exactly 2 entries — one per provider — with envelope `{ actor, tenantId, projectId, connector, action: 'extract_document', sourceUrl: <host-only>, sizeBytes, durationMs, status: 'success' }`. SourceUrl host-only invariant verified by regex `^https?://[a-zA-Z0-9.-]+/?$` (no path).
- **Failure Mode**: full URL leaked into audit log → privacy/compliance regression.
- **Covers**: FR-20.

### INT-17: Oversized envelope rejection — worker emits failure callback without payload

- **Boundary**: search-AI worker → callback-poster.
- **Setup**: workflow-engine on random port (real Mongo, stubbed Restate); seeded parked execution; Docling fixture stub configured to return a response whose normalized envelope serializes to ≈ 60 MB (synthetic large `pages[].images[].base64` content); inline cap configured at 50 MB via `DOCLING_WORKFLOW_INLINE_CAP_BYTES`.
- **Steps**: enqueue extraction-only job → worker dequeues, calls Docling stub, normalizes, computes serialized size, detects > cap.
- **Expected Result**: worker invokes callback-poster with `{ callbackId, status: 'failed', error: { code: 'EXTRACTION_TOO_LARGE', sizeBytes: ~62914560, limitBytes: 52428800 } }`. The callback POST body does NOT contain the oversized envelope payload (verified by asserting POST body size < 1 KB). Engine's parked promise resolves to the failure record. `workflow_extraction_too_large_total{provider:'docling', tenantId}` counter increments by 1.
- **Failure Mode**: regression that propagates the oversized envelope through the callback → engine OOM or Restate journal bloat.
- **Covers**: FR-9 (size cap check), FR-19, R10/R13 mitigation.

### INT-18: Worker stall / crash mid-job → workflow step `EXTRACTION_TIMEOUT` via `raceTimeout`

- **Boundary**: workflow-engine step body → `raceCancel(raceTimeout(...))` → step status update.
- **Setup**: workflow-engine on random port (real Mongo, stubbed Restate); seeded parked execution with `callbackTimeoutMs: 5000` (5 s, test-only override); BullMQ job enqueued to `workflow-docling-extraction`; the BullMQ worker is intentionally NOT booted (or is paused mid-dequeue) so no callback ever fires.
- **Steps**: invoke the workflow-engine step body; wait 6 seconds.
- **Expected Result**: parked promise's `raceTimeout` fires → step status transitions to `failed` with `error: { code: 'EXTRACTION_TIMEOUT', message }`. Engine's per-node retry policy is invoked (test asserts `restateClient.workflowStep.retry` was called with the configured retry config). `workflow_docling_callback_post_failures_total` does NOT increment (the worker never reached the POST stage — this is a stall, not a delivery failure).
- **Failure Mode**: missing `raceTimeout` wrapper → engine hangs indefinitely on the parked promise → cluster-wide latency regression.
- **Covers**: FR-11 step 7, reliability table "Worker pod crash mid-job" row.

---

## 4. Unit / Pure-Function Test Scenarios

### UT-1: `ExtractionEnvelopeSchema` validates both providers' envelopes

- **Module**: `packages/connectors/src/native/extraction-envelope.ts`.
- **Input**: two captured fixture envelopes (one Docling, one Azure DI) covering all content types.
- **Expected Output**: both pass `safeParse` with `success: true`; intentionally-malformed envelopes (missing `provider`, `schemaVersion: 2`, `pages: null`) return `success: false` with structured Zod issues.

### UT-2: Docling-native → envelope adapter — PDF / DOCX / image coverage

- **Module**: `packages/connectors/src/native/docling/normalize.ts`.
- **Input**: three captured fixture Docling responses (PDF with tables, DOCX with headings, image with OCR text).
- **Expected Output**: each maps to a valid envelope; `provider === 'docling'`; `pages[].images[].base64` populated when source contains images; `metadata.hasOCR === true` when OCR ran.

### UT-3: Azure DI `analyzeResult` → envelope adapter

- **Module**: `packages/connectors/piece-azure-document-intelligence/src/normalize.ts`.
- **Input**: captured `analyzeResult` for `prebuilt-layout` on an XLSX (3 sheets, 8 tables) and a PDF.
- **Expected Output**: envelope with correct `pages.length`, `tables[].rows`, `tables[].markdown`. XLSX-specific test: each sheet becomes a "page" with `metadata.title` set to the sheet name.

### UT-4: Auth-profile `connectionConfig` malformed-endpoint rejection

- **Module**: `packages/connectors/piece-azure-document-intelligence/src/auth.ts` (`PieceAuth.CustomAuth.validate` callback).
- **Input**: `{ endpoint: 'not-a-url' }`, `{ endpoint: 'http://insecure.example.com' }` (non-https), `{ endpoint: 'https://valid.cognitiveservices.azure.com/' }`.
- **Expected Output**: first two return `{ valid: false, error: 'Invalid endpoint URL' }` / `'Endpoint must be HTTPS'`; third returns `{ valid: true }` (mocked `/info` returns 200).

### UT-5: Worker timeout calculator boundary values

- **Module**: streaming-URL helper's per-job timeout calculation (size-scaled `60 s base + 10 s/MB`, capped 1800 s).
- **Input**: file sizes 1 MB, 10 MB, 50 MB, 100 MB, 200 MB.
- **Expected Output**: 70 s, 160 s, 560 s, 1060 s, 1800 s (capped).

### UT-6: SSRF guard rejects metadata + private hostnames

- **Module**: `assertUrlSafeForSSRF` from `@agent-platform/shared-kernel/security`.
- **Input**: `http://169.254.169.254/`, `http://metadata.google.internal`, `http://127.0.0.1`, `http://10.0.0.5`, `http://192.168.1.1`, plus a benign `https://example.com/file.pdf`.
- **Expected Output**: first 5 throw; last one resolves.

### UT-7: `IntegrationNodeConfigSchema.timeout` accepts new range

- **Module**: `packages/shared/src/types/workflow-schemas.ts` `IntegrationNodeConfigSchema`.
- **Input**: timeouts `4` (below min), `5`, `60` (default), `300` (old max), `1800` (new max), `1801` (above max).
- **Expected Output**: 5/60/300/1800 valid; 4 and 1801 produce Zod issues.

### UT-8: Azure DI `model` dropdown enum

- **Module**: `packages/connectors/piece-azure-document-intelligence/src/actions/extract-document.ts` (`StaticDropdown` definition).
- **Input**: `'prebuilt-read'`, `'prebuilt-layout'`, `'prebuilt-document'`, `'prebuilt-custom-invoice'`.
- **Expected Output**: first 3 accepted; 4th rejected.

### UT-9: Worker callback POST exponential-backoff helper

- **Module**: `apps/search-ai/src/workers/callback-poster.ts`.
- **Input**: HTTP client returns 502 four times, then 200 on attempt 5.
- **Expected Output**: 5 attempts total; delays observed: ~1 s, ~2 s, ~4 s, ~8 s (with jitter tolerance ±30 %); final return is the 200 body. 404 on any attempt → terminal, no further retries (test variant: 404 on attempt 2 → only 2 attempts total).

### UT-10: HMAC signature builder — symmetric with `verifyWebhookSignature`

- **Module**: `apps/search-ai/src/workers/callback-poster.ts` signing path + `apps/workflow-engine/src/routes/workflow-callbacks.ts` verify path.
- **Input**: same payload + same secret on both sides.
- **Expected Output**: builder output `{ signature, timestamp }` passes `verifyWebhookSignature()` 100 % of the time; tampered payload (one byte flipped) fails verification.

---

## 5. Security & Isolation Tests

The matrix below mirrors the **AUTH** / **AUTHZ** / **ISO** rows in §1 and expands each into a concrete test.

| #      | Boundary                                 | Scenario                                                                                                                                           | Expected                                                                                                      |
| ------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| SEC-1  | All 5 new project-scoped routes          | Request without `Authorization` header → 401                                                                                                       | `{ success: false, error: { code: 'UNAUTHENTICATED' } }`; no DB query made.                                   |
| SEC-2  | All 5 routes                             | Request with valid auth but cross-tenant `projectId` → 404                                                                                         | `{ success: false, error: { code: 'NOT_FOUND' \| 'INTEGRATION_NOT_FOUND' } }`; no leak of resource existence. |
| SEC-3  | All 5 routes                             | Request with valid tenant context but cross-project `projectId` → 404                                                                              | Same as SEC-2.                                                                                                |
| SEC-4  | `POST .../docling/enable`                | Viewer role (lacks `integrations:write`) → 403                                                                                                     | `{ success: false, error: { code: 'PERMISSION_DENIED' } }`; idempotent `ConnectorConnection` NOT created.     |
| SEC-5  | `PATCH .../usage-caps`                   | Reader role → 403                                                                                                                                  | Same as SEC-4.                                                                                                |
| SEC-6  | `POST /api/v1/workflows/callbacks/:e/:s` | Missing `x-callback-signature` header → 401                                                                                                        | `{ success: false, error: { code: 'MISSING_SIGNATURE' } }`; parked promise NOT resolved.                      |
| SEC-7  | Callback route                           | Valid signature but stale `x-callback-timestamp` (> 5 min) → 401                                                                                   | `{ success: false, error: { code: 'TIMESTAMP_OUT_OF_RANGE' } }`.                                              |
| SEC-8  | Callback route                           | Replay of valid POST after step already resolved → 200 (idempotent), but `restateClient.resolveCallback` is NOT invoked twice                      | Test asserts call count.                                                                                      |
| SEC-9  | Azure DI piece                           | `extract_document` with `fileUrl: 'http://169.254.169.254/'` → action returns `SSRF_BLOCKED`                                                       | No Azure call made; `ctx.store` not touched.                                                                  |
| SEC-10 | Docling worker branch                    | Same SSRF rejection at the worker layer (defense in depth) — re-validates URL after dequeue                                                        | Worker emits failure callback with `SSRF_BLOCKED`; no Docling HTTP call.                                      |
| SEC-11 | Trace events                             | Trace event for a failed Azure DI extraction does NOT include `Ocp-Apim-Subscription-Key` value or full Azure URL with subscription path           | Body matches a sanitized regex; secret-redaction test passes.                                                 |
| SEC-12 | Audit log                                | Audit log entry's `sourceUrl` is host-only (no path, no query string)                                                                              | `^https?://[a-zA-Z0-9.-]+/?$` regex match.                                                                    |
| SEC-13 | AuthProfile secrets                      | Azure DI `apiKey` is never returned by `GET /api/auth-profiles/:id` (decrypted view); only metadata visible                                        | Secret-redaction unit test + integration test asserting masked response.                                      |
| SEC-14 | DynamicActionForm input validation       | Submitting `params: { timeout: 'NaN' }` returns 422 from server (defense beyond client check)                                                      | `{ success: false, error: { code: 'INVALID_PARAMS' } }`.                                                      |
| SEC-15 | User isolation                           | Workflow run inherits the executing user's principal; an end-user-public workflow cannot access another tenant's Docling toggle via path traversal | Manual + integration test using a tenant-mismatched JWT.                                                      |

---

## 6. Performance & Load Tests

Already enumerated in §1 as PERF-1..4 and §3 as INT-13/INT-14. The two extra elements:

- **PERF-3 (E2E-7)**: covered in §2.
- **PERF-4 (capacity ramp)** — **manual / k6 only**:
  - Tool: `load-test-analysis` skill (k6 + Coroot).
  - Ramp: 5 → 50 concurrent extractions over 10 minutes; 80/20 Docling/Azure DI split.
  - Metrics: p50 / p95 / p99 wait + extraction latency; per-queue depth; per-pod active jobs; Coroot saturation per service.
  - Pass criteria: p95 within feature-spec SLO; no Coroot service > 80 % CPU; no `EXTRACTION_TIMEOUT` errors.
  - Log: `docs/sdlc-logs/document-extraction-integrations/load-test-results-<date>.md`.

---

## 7. Test Infrastructure

### Required services / harnesses

| Service / Harness             | Source                                                                                                                | Used by                    | Notes                                                                                                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MongoMemoryServer             | `apps/workflow-engine/src/__tests__/helpers/setup-mongo.ts`, `apps/search-ai/src/__tests__/helpers/setup-mongo.ts`    | Most integration tests     | `requireMongo(skip)` guard; calls `mongoose.connect`; `syncIndexes()` after model load                                                                                                                                               |
| Real BullMQ Redis             | Existing dev stack (`docker-compose.yml`)                                                                             | INT-2, INT-9, E2E-7        | Use a unique key prefix per test run to isolate                                                                                                                                                                                      |
| `nock`                        | Existing dep                                                                                                          | All Docling stubs          | Pattern from `apps/search-ai/src/__tests__/text-extraction-integration.test.ts`                                                                                                                                                      |
| Fake BullMQ Queue (DI)        | `apps/search-ai/src/workers/shared.ts` (`setQueueFactory` / `resetQueueFactory`)                                      | Most search-AI tests       | Captures enqueued jobs to `capturedJobs[]`; reset in `afterEach`                                                                                                                                                                     |
| `supertest` + Express         | Existing dep                                                                                                          | All HTTP integration tests | Random port (`{ port: 0 }`); full middleware chain                                                                                                                                                                                   |
| Restate stub                  | New helper in `apps/workflow-engine/src/__tests__/helpers/restate-stub.ts` (extracted from `system-callback.test.ts`) | All parking / replay tests | `{ resolveCallback: vi.fn(), startWorkflow: vi.fn(), cancelWorkflow: vi.fn() }`                                                                                                                                                      |
| Playwright                    | `apps/studio/playwright.config.ts`                                                                                    | All E2E                    | `reuseExistingServer: true`; assumes dev stack running                                                                                                                                                                               |
| Azure DI fixture (INT use)    | New `packages/connectors/piece-azure-document-intelligence/src/__tests__/fixtures/`                                   | INT-4/5/6                  | Captured `analyzeResult` JSON consumed by DI-injected HTTP client inside the AP piece tests                                                                                                                                          |
| Docling fixture (INT use)     | New `apps/search-ai/src/__tests__/fixtures/docling/`                                                                  | INT-13, INT-17, INT-2      | Captured Docling response JSON used via `nock` in-process inside worker integration tests                                                                                                                                            |
| Docling fixture server (E2E)  | New `apps/studio/e2e/workflows/fixtures/docling-fixture-server.ts`                                                    | E2E-1/4/5/6/7/8/E2E-9      | Express server started by Playwright `globalSetup`; `DOCLING_SERVICE_URL` overridden to its port; supports configurable response delay, call-count introspection (`GET /test/call-count`), and canned 3-page / 10-page PDF responses |
| Azure DI fixture server (E2E) | New `apps/studio/e2e/workflows/fixtures/azure-di-fixture-server.ts`                                                   | E2E-2/4/ERR-2/ERR-3        | Express server serving `/info`, `:analyze`, `Operation-Location` polling, `Retry-After` 429, malformed body, and 5xx variants; AuthProfile `endpoint` is set to its URL during E2E setup                                             |

### Data seeding

- `loginAndSetup()` from `apps/studio/e2e/workflows/helpers.ts` provisions a tenant + project + dev user, returns `{ projectId, token }`.
- Connector connections seeded via real `POST /api/projects/:projectId/connections` (not direct DB writes).
- AuthProfile seeded via real `POST /api/auth-profiles` (Azure DI tests).
- `ConnectorConnection.usageCount` fields seeded via the production code path (the actual extraction flow during test warmup) where possible, and direct Mongo writes only in test-only setup steps that simulate "month boundary".

### Environment variables (test-only)

| Variable                                       | Test value                                                                         | Why                                                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED` | `true` (default-off in prod)                                                       | Enable feature in CI / Playwright runs                                                                                         |
| `DOCLING_SERVICE_URL`                          | `http://localhost:8080` (INT) / `http://localhost:8088` (E2E, fixture server port) | Existing; INT tests use `nock` against this URL, E2E overrides to the Docling fixture-server port (see §7 fixture-server rows) |
| `DOCLING_INGESTION_CONCURRENCY`                | `3`                                                                                | Make slot-split deterministic                                                                                                  |
| `DOCLING_WORKFLOW_CONCURRENCY`                 | `2`                                                                                | "                                                                                                                              |
| `DOCLING_WORKFLOW_RATE_LIMIT_PER_MIN`          | `10`                                                                               | Match INT-9 expectations                                                                                                       |
| `DOCLING_WORKFLOW_RATE_LIMIT_BURST`            | `5`                                                                                | "                                                                                                                              |
| `AZURE_DI_USAGE_SOFT_CAP_DEFAULT`              | `5`                                                                                | Shorter cap so INT-10 stays fast                                                                                               |
| `AZURE_DI_OPERATION_STORE_TTL_SECONDS`         | `60`                                                                               | Test-only short TTL                                                                                                            |
| `NODE_ENV`                                     | `test`                                                                             | Enables the `POST /test/restart-workflow-engine` test-only endpoint used by E2E-6                                              |

### CI configuration

- **Unit + integration**: every PR via `pnpm test:report --filter @abl/connectors --filter @abl/piece-azure-document-intelligence --filter @agent-platform/workflow-engine --filter @agent-platform/search-ai`. Output: `test-reports/SUMMARY.md`.
- **E2E**: every PR to `develop` / `main`; nightly on the feature branch during beta. Uses Playwright sharding (4 shards) to keep wall time < 10 min.
- **Capacity / k6**: weekly during beta; on-demand for perf-impacting PRs. Triggered via `gh workflow run`.

### Pre-merge gates

1. All §3 INT scenarios + all §5 SEC scenarios PASS.
2. Coverage matrix shows ✅ for every FR + ISO/AUTH/AUTHZ/FORM-ERR/WIRING row.
3. HMAC callback signature tests pass (SEC-6 / SEC-7 / SEC-8).
4. `pnpm build` clean for affected packages.
5. `./tools/run-semgrep.sh` clean.
6. `phase-auditor` PASS, `pr-reviewer` 5 rounds PASS, `data-flow-audit` 2 rounds PASS.

---

## 8. Test File Mapping

Maps every FR + cross-cutting category to the test file that will own it (paths are planned; files do not exist yet).

| FR / Category                        | Test File                                                                                                                                                                                                                                                                               | Type                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| FR-1                                 | `packages/connectors/src/__tests__/loader-doc-extraction.test.ts`                                                                                                                                                                                                                       | integration                                |
| FR-2                                 | `apps/studio/e2e/workflows/document-extraction-picker.spec.ts`                                                                                                                                                                                                                          | e2e                                        |
| FR-2                                 | `apps/workflow-engine/src/__tests__/integrations-routes.integration.test.ts`                                                                                                                                                                                                            | integration                                |
| FR-3                                 | `apps/workflow-engine/src/__tests__/docling-toggle-routes.test.ts`                                                                                                                                                                                                                      | integration                                |
| FR-3                                 | `apps/studio/e2e/workflows/docling-toggle.spec.ts`                                                                                                                                                                                                                                      | e2e                                        |
| FR-4                                 | `packages/connectors/src/__tests__/extract-document-params.test.ts`                                                                                                                                                                                                                     | unit                                       |
| FR-4                                 | `apps/workflow-engine/src/__tests__/integration-node-config-schema.test.ts`                                                                                                                                                                                                             | integration                                |
| FR-5                                 | `packages/connectors/src/__tests__/extraction-envelope.test.ts`                                                                                                                                                                                                                         | unit                                       |
| FR-5                                 | (covered by all E2E happy-paths)                                                                                                                                                                                                                                                        | e2e                                        |
| FR-6                                 | `packages/shared/src/__tests__/integration-node-config-schema.test.ts`                                                                                                                                                                                                                  | unit                                       |
| FR-6                                 | `apps/workflow-engine/src/__tests__/docling-step-body.integration.test.ts` (asserts `raceTimeout` receives 1800000 ms when step config sets `timeout: 1800`)                                                                                                                            | integration                                |
| FR-7                                 | `apps/search-ai/src/__tests__/queue-factory-workflow.test.ts`                                                                                                                                                                                                                           | integration                                |
| FR-7                                 | `packages/shared-encryption/src/__tests__/encryption-manifest.test.ts`                                                                                                                                                                                                                  | unit                                       |
| FR-8                                 | `apps/search-ai/src/__tests__/two-queue-isolation.test.ts`                                                                                                                                                                                                                              | integration                                |
| FR-8                                 | `apps/studio/e2e/workflows/two-queue-isolation-under-load.spec.ts`                                                                                                                                                                                                                      | e2e                                        |
| FR-9                                 | `apps/search-ai/src/__tests__/workflow-docling-extraction-worker.test.ts`                                                                                                                                                                                                               | integration                                |
| FR-9                                 | (covered by E2E-1, E2E-2, E2E-7, E2E-8)                                                                                                                                                                                                                                                 | e2e                                        |
| FR-10                                | `apps/search-ai/src/__tests__/workflow-docling-extraction-worker.test.ts` (regression)                                                                                                                                                                                                  | integration                                |
| FR-11                                | `apps/workflow-engine/src/__tests__/docling-step-body.integration.test.ts`                                                                                                                                                                                                              | integration                                |
| FR-12                                | `apps/workflow-engine/src/__tests__/callback-hmac-docling.test.ts`                                                                                                                                                                                                                      | integration                                |
| FR-13                                | `packages/connectors/piece-azure-document-intelligence/src/__tests__/extract-document.test.ts`                                                                                                                                                                                          | integration                                |
| FR-13                                | `packages/connectors/piece-azure-document-intelligence/src/__tests__/auth.test.ts`                                                                                                                                                                                                      | unit                                       |
| FR-13                                | `apps/studio/e2e/auth-profiles/azure-document-intelligence-create.spec.ts`                                                                                                                                                                                                              | e2e                                        |
| FR-14                                | `packages/connectors/src/__tests__/azure-doc-intelligence-auth-adapter.test.ts`                                                                                                                                                                                                         | unit                                       |
| FR-15                                | `packages/connectors/src/__tests__/connection-resolver-none.test.ts`                                                                                                                                                                                                                    | integration                                |
| FR-16                                | `packages/connectors/piece-azure-document-intelligence/src/__tests__/replay-safety.test.ts`                                                                                                                                                                                             | integration                                |
| FR-17                                | `packages/connectors/piece-azure-document-intelligence/src/__tests__/guards.test.ts`                                                                                                                                                                                                    | integration                                |
| FR-18                                | `apps/workflow-engine/src/__tests__/azure-di-usage-routes.integration.test.ts`                                                                                                                                                                                                          | integration                                |
| FR-19                                | `apps/workflow-engine/src/__tests__/trace-event-redaction.test.ts`                                                                                                                                                                                                                      | integration                                |
| FR-20                                | `apps/workflow-engine/src/__tests__/audit-log-extraction.integration.test.ts`                                                                                                                                                                                                           | integration                                |
| FR-21                                | `packages/connectors/src/__tests__/catalog-generation.test.ts`                                                                                                                                                                                                                          | integration                                |
| FR-22                                | `apps/workflow-engine/src/__tests__/feature-flag-gating.test.ts`                                                                                                                                                                                                                        | integration                                |
| FR-22                                | `apps/studio/e2e/workflows/feature-flag-off-hides-connectors.spec.ts`                                                                                                                                                                                                                   | e2e                                        |
| INT-17 oversized envelope            | `apps/search-ai/src/__tests__/workflow-docling-extraction-worker.test.ts` (oversized-envelope case)                                                                                                                                                                                     | integration                                |
| INT-18 timeout / stall               | `apps/workflow-engine/src/__tests__/docling-step-body.integration.test.ts` (raceTimeout case)                                                                                                                                                                                           | integration                                |
| ISO-1/2/3                            | `apps/workflow-engine/src/__tests__/doc-extraction-routes-isolation.integration.test.ts`                                                                                                                                                                                                | integration                                |
| AUTH-1/2                             | `apps/workflow-engine/src/__tests__/callback-hmac-docling.test.ts` + `doc-extraction-routes-isolation.integration.test.ts`                                                                                                                                                              | integration                                |
| AUTHZ-1/2                            | `apps/workflow-engine/src/__tests__/doc-extraction-routes-authz.integration.test.ts`                                                                                                                                                                                                    | integration                                |
| FORM-ERR-1                           | `apps/studio/e2e/workflows/docling-toggle-403.spec.ts`                                                                                                                                                                                                                                  | e2e                                        |
| FORM-ERR-2/3                         | `apps/studio/e2e/auth-profiles/azure-document-intelligence-form-errors.spec.ts`                                                                                                                                                                                                         | e2e                                        |
| FORM-ERR-4                           | `apps/studio/e2e/workflows/extract-document-form-validation.spec.ts`                                                                                                                                                                                                                    | e2e                                        |
| WIRING-1                             | `apps/studio/e2e/workflows/document-extraction-end-to-end-wiring.spec.ts`                                                                                                                                                                                                               | e2e                                        |
| PERF-1                               | `apps/workflow-engine/src/__tests__/parked-promise-memory.integration.test.ts`                                                                                                                                                                                                          | integration                                |
| PERF-2                               | `apps/search-ai/src/__tests__/streaming-rss.integration.test.ts`                                                                                                                                                                                                                        | integration                                |
| PERF-3                               | `apps/studio/e2e/workflows/two-queue-isolation-under-load.spec.ts`                                                                                                                                                                                                                      | e2e                                        |
| PERF-4                               | `docs/sdlc-logs/document-extraction-integrations/load-test-runbook.md` (manual + k6)                                                                                                                                                                                                    | manual                                     |
| **Relay-race execution**             | `apps/workflow-engine/src/__tests__/restate-client.test.ts` — `startWorkflow` (relay-race: `/workflow-executor/{id}/runWorkflow/send`), `cancelWorkflow` (relay-race: `/workflow-executor/{id}/cancelWorkflow/send`), `startLegacyWorkflow` / `cancelLegacyWorkflow` URL contract tests | unit (COVERED)                             |
| **Relay-race execution**             | `apps/workflow-engine/src/__tests__/execution-store.test.ts` — `updateExecutionStatus` per-field `$set` pattern, `runCounter` initialization                                                                                                                                            | unit (COVERED)                             |
| **Callback HMAC rejection**          | `apps/workflow-engine/src/__tests__/workflow-callbacks.test.ts:144` — invalid HMAC signature returns 401                                                                                                                                                                                | integration (COVERED)                      |
| **findBySource projectId**           | `apps/workflow-engine/src/__tests__/human-task-resolution-routes.test.ts:109` — `findBySource` includes `projectId` in filter                                                                                                                                                           | integration (COVERED)                      |
| **findBySource projectId**           | `apps/workflow-engine/src/__tests__/workflow-approvals.test.ts:203` — approval resolution passes `projectId` to `findBySource`                                                                                                                                                          | integration (COVERED)                      |
| **Connector async parking**          | `apps/workflow-engine/src/__tests__/connector-async-parking.test.ts` — connector action parking + callback resolution flow                                                                                                                                                              | integration (COVERED)                      |
| **Rate limiter 429**                 | `createCallbackRateLimit` in `workflow-callbacks.ts` — rate limiter 429 behavior                                                                                                                                                                                                        | integration (MISSING ❌)                   |
| **STEP_SENSITIVE_FIELDS**            | Step-level stripping of `callbackSecret`, `parkPoint`, `awakeableId` from GET /executions responses                                                                                                                                                                                     | integration (MISSING ❌)                   |
| **inputSnapshot stripping**          | `inputSnapshot` absent from GET /executions response                                                                                                                                                                                                                                    | integration (MISSING ❌)                   |
| **Stale: findBySource sig**          | `apps/workflow-engine/src/__tests__/system-human-task-store.test.ts:275,303,331,358` — uses old 3-arg `findBySource` signature, needs `projectId` as 2nd arg                                                                                                                            | unit (NEEDS_FIX ⚠️)                        |
| **Stale: private IP test**           | `apps/workflow-engine/src/__tests__/workflow-callbacks.test.ts:162` — expects 403 for private IP but route has no IP blocking                                                                                                                                                           | integration (NEEDS_FIX ⚠️)                 |
| **callbackUrl encryption**           | callbackUrl at-rest encryption: `unwrapJobDataForDecrypt` decrypts BullMQ job payload before use; `wrapJobDataForEncrypt` encrypts at enqueue                                                                                                                                           | integration (COVERED — Round 2 fix + test) |
| **Strip set parity F-WS-1**          | All 3 strip sets (`STEP_SENSITIVE_FIELDS`, `PUBLISH_SENSITIVE_STEP_FIELDS`, `SNAPSHOT_STEP_SENSITIVE_FIELDS`) contain the same 11 fields                                                                                                                                                | integration (COVERED — Round 3 fix)        |
| **rejectStepIds stripping**          | `rejectStepIds` field stripped from REST API GET /executions responses (included in `STEP_SENSITIVE_FIELDS`)                                                                                                                                                                            | integration (MISSING ❌)                   |
| **hasHumanWait persistence**         | `parkStep` sets `hasHumanWait: true` for approval/human_task; `resolveParkedStep` clears it; StuckExecutionSweeper excludes `hasHumanWait` executions                                                                                                                                   | integration (MISSING ❌)                   |
| **computeExecutionEdges data_entry** | `data_entry` canvas node returns `on_success`/`on_failure` handles (not `on_approve`/`on_reject`); `canvasNodeType` fallback distinguishes from `human`                                                                                                                                 | unit (MISSING ❌)                          |
| **Relay-race /execute route**        | `apps/workflow-engine/src/__tests__/workflow-executions-routes.test.ts` — relay-race assertions: createExecution called, lean startWorkflow payload, cancelWorkflow with tenantId                                                                                                       | integration (COVERED — 2026-05-21)         |
| **Terminal status persistence**      | `apps/workflow-engine/src/__tests__/execution-store.session.test.ts` — 3 findOneAndUpdate calls verify terminal status transitions (completed, failed, rejected)                                                                                                                        | integration (COVERED — 2026-05-21)         |

---

## 9. Production Wiring Verification (manual checklist, pre-BETA)

Per CLAUDE.md, feature-spec API tables must distinguish "implemented" from "wired and reachable". Run this checklist on staging before promoting from ALPHA to BETA.

- [ ] `apps/workflow-engine/src/index.ts` mounts the 5 new project-integration routes under `/api/projects/...` (confirm via `GET /api/_routes` or pod startup logs).
- [ ] `apps/search-ai/src/server.ts` boots the new `workflow-docling-extraction` Worker subscription on startup (visible in pod logs as a Worker init line; `worker_active_jobs{queue='workflow-docling-extraction'}` metric appears in Prometheus).
- [ ] `packages/connectors/src/loader.ts` registers the Docling native connector eagerly and the Azure DI piece lazily; `pnpm connectors:generate-catalog` produces a catalog that includes both.
- [ ] Studio's Integration Picker shows both connectors when their gating conditions are met (toggle on / AuthProfile bound) and hides them when not — verified by the WIRING-1 E2E + manual smoke.
- [ ] The HMAC callback secret is propagated end-to-end: workflow step body → BullMQ job payload → worker callback POST → `verifyWebhookSignature()` in the callback route. Spot-check via a traced extraction.
- [ ] `connector-catalog.json` regeneration committed in the implementation PR; CI catalog-drift check is green.
- [ ] `WORKFLOW_ENGINE_URL` env var is correctly set on every search-AI pod; the worker's outgoing HTTPS to Azure DI is allowed by egress policy.
- [ ] Per-tenant rate-limiter Redis keys (`workflow:docling:*`) appear in Redis under the expected prefix during a smoke run.
- [ ] `encryption-manifest.ts` carries `'workflow-docling-extraction': { fieldsToEncrypt: [] }`.

---

## 10. Open Testing Questions

1. **Capacity baseline portability.** The capacity report `docling-extraction-capacity-report-2026-05-10.pdf` is desktop-local; copy the relevant numbers into `docs/sdlc-logs/document-extraction-integrations/capacity-baseline.md` before PERF-4 runs.
2. **Azure DI nightly canary against real subscription.** Should we add a nightly Playwright canary against a real Azure DI test subscription (cost-bounded) to catch upstream contract drift? Recommend yes during beta; deferred to GA budget approval.
3. **Production memory invariant alerting.** INT-14 measures parked-promise memory in a controlled test; do we also wire a Prometheus alert on `workflow_engine_pod_rss / workflow_docling_parked_promises_gauge` to catch regressions in production? Recommend yes — add to operator runbook.
4. **Cross-provider parity bound ±10 %.** May be too tight for documents with heavy figure/table differences (Azure DI sometimes emits more empty rows than Docling). Revisit with real samples during beta; loosen to ±15 % if signal-to-noise is poor.
5. **`POST /test/restart-workflow-engine` test-only endpoint.** Required by E2E-6; should this be in the workflow-engine code (gated by `NODE_ENV !== 'production'`) or in a separate test harness? Decide before LLD.
6. **Test-only Restate stub vs Restate testing helper.** Repo currently uses DI-stubbed Restate clients everywhere; should we invest in a thin shared `apps/workflow-engine/src/__tests__/helpers/restate-stub.ts` extracted from `system-callback.test.ts` to standardize? Recommended — file a follow-up task.
7. **AP piece test pattern is new to this repo.** `@abl/piece-azure-document-intelligence` will be the first AP piece with dedicated action tests; the pattern will become a template for future pieces. The piece's `run()` should accept an HTTP client via DI to enable testability without `vi.mock`.

---

## 11. References

- Feature spec: [`../features/document-extraction-integrations.md`](../features/document-extraction-integrations.md)
- Oracle log (feature-spec phase): `../sdlc-logs/document-extraction-integrations/feature-spec.log.md`
- Oracle log (test-spec phase): `../sdlc-logs/document-extraction-integrations/test-spec.log.md`
- Source plan: `/Desktop/docling-azure-di-integration-plan.md` (will be copied to `docs/plans/document-extraction-integrations.source-plan.md` before LLD)
- Related testing guides:
  - [`connectors`](connectors.md)
  - [`auth-profiles`](auth-profiles.md)
  - [`multimodal-processing`](multimodal-processing.md)
  - [`workflow-integration-node-troubleshooting`](workflow-integration-node-troubleshooting.md)
- Test architecture rules: `CLAUDE.md` § Test Architecture
- Workflow E2E rules: `apps/studio/e2e/workflows/agents.md` (read before adding scenarios; update folder layout, coverage tables, testid registry after each addition)
- Reusable test patterns (from grounded exploration on 2026-05-15):
  - HMAC + real-Mongo + supertest: `apps/workflow-engine/src/__tests__/system-callback.test.ts`
  - Cross-tenant 404: `apps/workflow-engine/src/__tests__/executions-isolation.integration.test.ts`
  - Fake BullMQ queue DI: `apps/search-ai/src/workers/shared.ts` (`setQueueFactory`) + `apps/search-ai/src/__tests__/helpers/search-ai-api-harness.ts`
  - Nock-based Docling stub: `apps/search-ai/src/__tests__/text-extraction-integration.test.ts`
  - Settings-tab E2E: `apps/studio/e2e/pii-protection-settings-e2e.spec.ts`
  - Integration Picker E2E: `apps/studio/e2e/workflows/workflow-integration-node.spec.ts`
  - Connector tenant isolation: `packages/connectors/src/__tests__/integration/tenant-isolation.integration.test.ts`
  - Auth adapter test pattern: `packages/connectors/src/__tests__/context-translator.test.ts` (`normalizeAuthForAP`)
