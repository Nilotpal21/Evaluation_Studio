# Oracle Answers: document-extraction-integrations (Test Spec Phase)

**Date**: 2026-05-15
**Feature**: `document-extraction-integrations`
**Phase**: Test Spec
**Oracle**: Product Oracle (Opus 4.6)

---

## Context Consulted

- `docs/features/document-extraction-integrations.md` (full feature spec, 690 lines)
- `docs/testing/document-extraction-integrations.md` (placeholder test guide, 184 lines)
- `docs/testing/README.md` (testing index)
- `CLAUDE.md` (core invariants, test architecture)
- `apps/studio/CLAUDE.md` (Studio route handler rules)
- `apps/studio/e2e/workflows/CLAUDE.md` (workflow E2E rules)
- `apps/studio/e2e/workflows/agents.md` (folder layout, tiers, helpers)
- `apps/studio/e2e/workflows/helpers.ts` (Playwright helpers)
- `apps/studio/e2e/workflows/workflow-integration-node.spec.ts` (existing integration node E2E)
- `apps/studio/e2e-playwright.config.ts` (Playwright config)
- `apps/studio/package.json` (Playwright + Vitest deps)
- `apps/workflow-engine/src/__tests__/system-callback.test.ts` (callback route pattern)
- `apps/workflow-engine/src/__tests__/route-integration.test.ts` (route integration patterns)
- `apps/workflow-engine/src/__tests__/connections-routes.test.ts` (connection route pattern)
- `apps/workflow-engine/src/__tests__/connectors-routes.test.ts` (connector route pattern)
- `apps/workflow-engine/src/__tests__/execution-lifecycle.e2e.test.ts` (E2E gate pattern)
- `apps/workflow-engine/src/__tests__/system-human-task-store.test.ts` (MongoMemoryServer pattern)
- `apps/workflow-engine/src/__tests__/helpers/setup-mongo.ts` (MongoMemoryServer helper)
- `apps/workflow-engine/src/__tests__/async-webhook-executor.test.ts` (async webhook pattern)
- `apps/search-ai/src/workers/docling-extraction-worker.ts` (existing worker)
- `packages/connectors/src/__tests__/` (20+ connector test files)
- `packages/connectors/piece-jira-cloud/`, `piece-shopify/` (existing AP piece layout)
- `docker-compose.yml` (service definitions: docling-service, restate, workflow-engine)

---

## Answers

### TS1: Highest-risk FRs

**Classification**: DECIDED
**Answer**: Ranked by failure-mode blast radius:

1. **FR-12 (HMAC callback verification)** — Blast radius: CRITICAL. If HMAC verification fails silently or is bypassable, any actor with network access to the callback route can inject arbitrary workflow step outputs. This is the only new security boundary in the feature. A bug here means arbitrary data injection into all Docling-powered workflows.

2. **FR-9 (worker branch + HMAC POST + streaming)** — Blast radius: HIGH. This is the most complex new code path: SSRF re-check, streaming (not buffered), envelope normalization, size cap, and HMAC-signed callback POST. A bug in the branch condition (`job.queueName` check) could route ingestion jobs through the workflow path or vice versa, corrupting both pipelines. The streaming memory invariant is a new pattern with no precedent in the worker.

3. **FR-16 (Azure DI ctx.store replay safety)** — Blast radius: HIGH (financial). A replay that misses the `ctx.store` key causes a duplicate `:analyze` POST to Azure, resulting in double-billing. Unlike Docling (where duplicate extraction is cost-free), Azure DI charges per page per call. Under Restate replay storms, this could cause significant unexpected cost.

4. **FR-11 (step body parking + rate-limit)** — Blast radius: MEDIUM-HIGH. The step body orchestrates SSRF, HEAD probe, rate limiting, HMAC secret generation, BullMQ enqueue, and Restate park -- all inside `ctx.run`. A bug in the park pattern (wrong promise key, timeout race) causes workflow hangs. Rate-limit misconfiguration creates a noisy-neighbor vector that the feature was specifically designed to close (AF-105).

5. **FR-18 (cost-cap atomicity)** — Blast radius: MEDIUM. The atomic `$inc` + month-boundary CAS reset is a concurrency-sensitive MongoDB operation. A bug causes either usage counter drift (under-counting allows budget overrun) or false `QUOTA_EXCEEDED` rejections (over-counting blocks legitimate usage).

**Source**: Feature spec sections FR-9, FR-11, FR-12, FR-16, FR-18; reliability/failure-mode table in section 12; GAP-006 (ctx.store TTL double-bill risk).
**Confidence**: HIGH

---

### TS2: External dependencies -- mock vs real

**Classification**: DECIDED
**Answer**: **Stub Docling with a tiny HTTP fixture, not the real service.**

Reasoning:

- The real `docling-service` is a GPU-optional Python container (`services/docling-service/Dockerfile`) that takes 30-60s to start, requires model downloads, and consumes significant resources. It is not suitable for CI-speed integration tests.
- The feature spec explicitly states: "No changes to the Docling Python service" (non-goal #6). The interface is a single `POST /extract` multipart endpoint returning a fixed JSON shape. A 20-line Express/Fastify fixture returning canned responses covers all test scenarios.
- The existing `text-extraction-integration.test.ts` in search-AI is the closest reference; it tests against a real Docling service but is designed for integration environments, not PR CI.
- The stub should support: (a) normal PDF response, (b) delayed response (for timeout tests), (c) 5xx responses (for error path tests), (d) large response (for envelope cap tests).

**Mock strategy summary:**
| Dependency | Strategy | Why |
|---|---|---|
| BullMQ Redis | REAL | Lightweight, starts in <1s, tests queue topology |
| MongoDB | REAL (MongoMemoryServer) | Existing pattern in workflow-engine tests |
| Restate context | STUB (same as system-callback.test.ts) | Real Restate requires the full gRPC server + registration; stub the `resolveCallback` client |
| Docling Python service | STUB (tiny HTTP fixture) | GPU-heavy, slow start, fixed interface |
| Azure DI REST | MOCK via DI in piece `run()` | External SaaS, per CLAUDE.md only external third-party may be mocked |
| workflow-engine Express | REAL (supertest on port 0) | Existing pattern |
| search-AI Express | REAL (supertest on port 0) for worker tests | Tests need real BullMQ worker subscription |

**Source**: Feature spec non-goal #6; CLAUDE.md test architecture rules; `system-callback.test.ts` Restate stub pattern; `setup-mongo.ts` MongoMemoryServer pattern.
**Confidence**: HIGH

---

### TS3: Test environment setup -- canonical pattern

**Classification**: ANSWERED
**Answer**: There is **no** single `docker-compose` test profile or `vitest --globalSetup` script for spinning up workflow-engine + search-AI together. The repo uses several distinct patterns:

1. **Workflow-engine integration tests** (`apps/workflow-engine/src/__tests__/`): Use `MongoMemoryServer` via `helpers/setup-mongo.ts` for real MongoDB + `supertest` against Express apps built inline (no server boot). Restate client is stubbed. No Redis needed for most tests. Pattern: `beforeAll(setupTestMongo) → build Express app with injected deps → supertest(app)`.

2. **Workflow-engine E2E tests** (`execution-lifecycle.e2e.test.ts`): Use an **externally-provisioned stack** (full `docker compose up`). Tests are gated via `helpers/e2e-gate.ts` which probes live services and skips if unavailable. Requires manual env setup (`E2E_AUTH_TOKEN`, `E2E_TENANT_ID`, etc.).

3. **Studio Playwright E2E tests** (`apps/studio/e2e/`): Assume all services are running externally (Studio at `:5173`, Runtime at `:3112`, Workflow Engine). Playwright config optionally starts web servers. No programmatic service boot.

4. **Search-AI integration tests** (`apps/search-ai/src/__tests__/`): Test against in-process logic with real fixtures. No shared setup with workflow-engine.

**For this feature's integration tests**: Follow pattern #1 (MongoMemoryServer + supertest + stubbed Restate). For the worker-specific tests in search-AI, add a `setup-bullmq.ts` helper that creates a real BullMQ queue/worker pair against a local Redis (same pattern as existing BullMQ usage in `apps/search-ai/src/queues/`). For E2E, follow the Playwright + externally-provisioned-services pattern (pattern #3).

**Source**: `apps/workflow-engine/src/__tests__/helpers/setup-mongo.ts`, `apps/workflow-engine/src/__tests__/helpers/e2e-gate.ts`, `apps/workflow-engine/src/__tests__/system-callback.test.ts`, `apps/studio/e2e-playwright.config.ts`.
**Confidence**: HIGH

---

### TS4: Current test coverage baseline

**Classification**: ANSWERED
**Answer**: One-line baseline per area:

- **docling-extraction-worker**: NO existing tests (no `*.test.*` files match `docling-extraction-worker` or `extraction-only`; the worker file exists at `apps/search-ai/src/workers/docling-extraction-worker.ts` but has zero test coverage).
- **async_webhook callbacks**: YES -- `apps/workflow-engine/src/__tests__/system-callback.test.ts` covers the callback route with real MongoMemoryServer + HMAC verification + Restate stub; `async-webhook-executor.test.ts` covers the request builder (unit level).
- **Integration Picker**: NO dedicated test -- `workflow-integration-node.spec.ts` is a Playwright E2E that tests the picker modal with a real Gmail connector, but no programmatic/unit test exists for the picker component itself.
- **AuthProfile form**: NO direct component test for the DynamicActionForm rendering AP CustomAuth props; the `auth-profiles` feature has 180+ targeted tests but those cover the platform AuthProfile CRUD, not the AP-specific form rendering.
- **Connector loader / AP runtime adapter**: YES partially -- `packages/connectors/src/__tests__/context-translator.test.ts` and 20+ other connector test files cover the loader, registry, connection resolver, and AP runtime adapter paths. The `connection-resolver.test.ts` exists but does NOT test the `auth.type === 'none'` short-circuit (that is new code).

**Source**: `find` results for `*.test.*` files across the relevant directories; grep for `docling-extraction-worker`, `IntegrationPicker`, `DynamicActionForm`, `auth-adapters` in test files.
**Confidence**: HIGH

---

### TS5: Studio UI test infra

**Classification**: ANSWERED
**Answer**:

- **E2E**: **Playwright** (`@playwright/test ^1.58.2`). Config at `apps/studio/e2e-playwright.config.ts`. All E2E specs are `*.spec.ts` files under `apps/studio/e2e/`. Workflow-specific E2E tests live at `apps/studio/e2e/workflows/` and ARE Playwright. They import from `./helpers` (Playwright `Page`-based helpers: `loginAndSetup`, `navigateToWorkflows`, `createWorkflowViaUI`, etc.).

- **Component/unit tests**: **Vitest** (`vitest ^4.1.4` with `@vitest/coverage-v8`). Config at `apps/studio/vitest.config.ts` (full) + `vitest.light.config.ts` (lighter) + `vitest.node.config.ts` (server-side). Component tests live at `apps/studio/src/components/**/__tests__/` and are Vitest files using `describe/it/expect` from `vitest`.

- **`apps/studio/e2e/workflows/`**: YES, Playwright. The `helpers.ts` file imports `{ type Page, expect } from '@playwright/test'`. All `.spec.ts` files use `import { test, expect } from '@playwright/test'`.

- **`apps/studio/src/components/**/**tests**/`**: Vitest runner. Directories found include `navigation/**tests**/`, `settings/**tests**/`, `connections/**tests**/`, `workflows/canvas/hooks/**tests**/`, etc.

**Source**: `apps/studio/package.json` (test scripts + deps), `apps/studio/e2e/workflows/helpers.ts` line 5, `apps/studio/e2e-playwright.config.ts`, component test directories listing.
**Confidence**: HIGH

---

### E1: Critical user journeys for v1 GA (Studio-UI-driven)

**Classification**: DECIDED
**Answer**: The minimum set covering the three forms:

**Docling toggle card** (`IntegrationsCard.tsx` at `/projects/:projectId/settings/integrations`):

1. Navigate to Settings > Integrations > toggle ON > verify `POST enable` fires + success toast > toggle OFF > verify `POST disable` fires + Docling disappears from Integration Picker on next canvas load.
2. Verify the static rate-limit info line renders from `GET quota` response.

**Azure DI AuthProfile form** (via Auth Profiles > New Profile): 3. Navigate to Auth Profiles > New > select Azure Document Intelligence > fill `endpoint` + `apiKey` > click Test Connection > verify success/failure feedback > Save > verify `ConnectorConnection` created (Azure DI appears in Integration Picker). 4. Edit existing Azure DI AuthProfile > change `apiVersion` > Save > verify persistence.

**DynamicActionForm for `extract_document`** (via Integration Node config panel): 5. Add Integration node > open picker > select Docling > select `extract_document` > fill `fileUrl` > toggle `extractImages` off > set `timeout` to 120 > save workflow > re-open > verify all values persisted. 6. Same flow for Azure DI: select Azure DI > select `extract_document` > fill `fileUrl` + select `model: prebuilt-document` > save > verify.

The placeholder already has 10 E2E scenarios. These 6 additional UI-driven flows cover the form interactions. The Playwright `workflow-integration-node.spec.ts` provides the template for picker + form + save + re-open verification.

**Source**: Feature spec section 8 (How to Consume), US-1 through US-3, `workflow-integration-node.spec.ts` pattern.
**Confidence**: HIGH

---

### E2: Form error-path E2E scenarios (MANDATORY)

**Classification**: DECIDED
**Answer**: One realistic invalid-input scenario per form:

1. **Docling toggle card**: User with `viewer` role (no `integrations:write` permission) attempts to toggle ON. Expected: 403 response, toggle does not flip, error toast "Insufficient permissions". (Note: per GAP-011, if v1 ships without `requireProjectPermission` in workflow-engine and uses tenant+project scoping only, this test becomes: user from a different project attempts to enable Docling for a project they don't belong to -- 404.)

2. **Azure DI AuthProfile form**: Submit with `endpoint` set to `not-a-url` (fails URL validation in `PieceAuth.CustomAuth.validate`). Expected: inline field error "Invalid endpoint URL" (or "Endpoint must be a valid HTTPS URL"). Also: submit with a valid-looking endpoint but wrong `apiKey` > click Test Connection > Azure returns 401 > display "Authentication failed: invalid API key".

3. **DynamicActionForm for `extract_document`**: Set `timeout` to `2` (below `min(5)` per FR-6). Expected: Zod validation rejects with inline error "Timeout must be between 5 and 1800 seconds". Also: leave `fileUrl` empty and attempt save > field-level required error.

**Source**: CLAUDE.md mandates form-error-path scenarios for any form; FR-6 (`IntegrationNodeConfigSchema.timeout min(5) max(1800)`); FR-13 (`PieceAuth.CustomAuth validate`); feature spec section 12 (security).
**Confidence**: HIGH

---

### E3: Auth/permission E2E combinations

**Classification**: DECIDED
**Answer**: Must-have auth combinations for v1 (6 scenarios covering the 5 new endpoints):

| #   | Scenario                                                                                                     | Expected                                   | Priority |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | -------- |
| 1   | Unauthenticated request to `POST .../docling/enable`                                                         | 401                                        | Must     |
| 2   | Authenticated user, wrong tenant (cross-tenant) to `POST .../docling/enable`                                 | 404                                        | Must     |
| 3   | Authenticated user, wrong project (cross-project) to `GET .../azure-document-intelligence/usage`             | 404                                        | Must     |
| 4   | Viewer role (no `integrations:write`) to `POST .../docling/enable`                                           | 403 (or 404 per GAP-011 if RBAC not wired) | Must     |
| 5   | Viewer role to `GET .../docling/quota` with `integrations:read`                                              | 200 (should succeed)                       | Must     |
| 6   | HMAC callback: `POST /api/v1/workflows/callbacks/:executionId/:stepId` without `x-callback-signature` header | 401                                        | Must     |

Rationale for representative sample: The 5 project-scoped endpoints share the same middleware chain. Cross-tenant and cross-project isolation use the same `{ tenantId, projectId }` scoping pattern, so one of each is sufficient to prove the middleware works. The HMAC callback auth is a distinct mechanism and must be tested separately. Total: 6 cases, not 20+ (the full 4x5=20 matrix would be redundant given shared middleware).

**Source**: CLAUDE.md core invariants #1 (resource isolation, cross-scope = 404), #2 (centralized auth); feature spec section 12 (isolation & multitenancy table); GAP-011.
**Confidence**: HIGH

---

### E4: Cross-feature interactions

**Classification**: DECIDED
**Answer**: Three cross-feature E2E flows for v1:

1. **Extraction -> Trace Event Display**: Run workflow with `extract_document` (Docling) -> navigate to workflow execution detail -> verify trace event panel shows extraction trace with `provider: 'docling'`, `pageCount`, `processingTimeMs`, and no internal URLs or secrets in the error/info payload. (Exercises: `tracing-observability` feature integration.)

2. **Extraction -> Audit Log**: Run workflow with `extract_document` -> query `GET /api/audit-logs` filtered by `connector: 'docling'` -> verify audit event has `sourceUrl` (host-only), `sizeBytes`, `durationMs`, `status: 'success'`. (Exercises: `audit-logging` feature integration.)

3. **Extraction -> Downstream LLM Node**: Build a 3-node workflow: Start -> `extract_document` (Docling, PDF) -> LLM Summarize (references `{{ steps.extract_document.output.markdown }}`) -> End. Run and assert the LLM node received non-empty markdown and produced a summary. (Exercises: the core user story US-3 where output feeds downstream nodes.)

Deliberately deferred: PII redaction E2E (integration-level test is more appropriate since it requires controlled PII fixtures). Audit log UI verification (audit-logging feature covers its own UI; we only need the API query).

**Source**: Feature spec US-3, US-4; FR-19, FR-20; related feature integration matrix.
**Confidence**: MEDIUM (cross-feature flows are expensive and may be deferred to beta if the standalone flows pass first)

---

### E5: Wiring verification scenario (MANDATORY)

**Classification**: DECIDED
**Answer**: The single E2E that proves end-to-end reachability:

**Scenario: "Docling Full-Chain Wiring Verification"**

Pre-conditions: All services running (Studio, Runtime, Workflow Engine, Search-AI, Docling service, Redis, MongoDB, Restate). Feature flag `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED=true`.

Steps:

1. `POST /api/auth/dev-login` -> get auth token (Playwright `loginAndSetup`).
2. `POST /api/projects/:projectId/integrations/docling/enable` -> 200 (creates ConnectorConnection).
3. `GET /api/projects/:projectId/connectors` -> assert `docling` connector is in the list.
4. Create a workflow via `POST /api/projects/:projectId/workflows` with a single `connector_action` step: `connectorId: 'docling'`, `actionName: 'extract_document'`, `params: { fileUrl: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf' }`.
5. `POST /api/v1/workflows/:workflowId/run` -> 202 (execution created).
6. Poll `GET /api/v1/workflows/:workflowId/executions/:executionId` until `status !== 'running'` (timeout 120s).
7. Assert:
   - `status === 'completed'`
   - Step output matches `ExtractionEnvelopeSchema`: `provider === 'docling'`, `markdown.length > 0`, `metadata.pageCount > 0`
   - A `TraceEvent` exists with `provider: 'docling'` (via `GET /api/trace-events?executionId=...`)
   - No internal URLs (e.g., `localhost:8080`) appear in any user-facing response field

**What this proves**: Studio API route mount -> workflow-engine route -> connector registry resolution -> connection resolver (no-auth short-circuit) -> step body (SSRF check + rate limit + BullMQ enqueue + Restate park) -> search-AI BullMQ worker subscription -> Docling HTTP call -> worker callback POST (HMAC signed) -> workflow-engine callback route (HMAC verified) -> Restate promise resolution -> step output -> trace event.

**Test fixture**: The W3C `dummy.pdf` is a 13KB public PDF. Alternatively use a fixture hosted in the repo's test data at `./test_data/docling/` (visible in `docker-compose.yml` volume mount).

**Source**: Feature spec section 10 (Key Implementation Files), section 12 (Reliability, failure-mode table), CLAUDE.md (wiring verification E2E mandatory).
**Confidence**: HIGH

---

### I1: Service boundaries to cover

**Classification**: DECIDED
**Answer**: Priority-ranked boundary list:

| #   | Boundary                                          | Producer             | Consumer                       | Priority | Rationale                                                                 |
| --- | ------------------------------------------------- | -------------------- | ------------------------------ | -------- | ------------------------------------------------------------------------- |
| a   | Workflow step -> BullMQ (Redis)                   | workflow-engine      | search-AI worker               | **P0**   | New queue topology; job payload schema; if broken, no extractions work    |
| c   | Search-AI worker -> workflow-engine callback HTTP | search-AI worker     | workflow-engine callback route | **P0**   | New HMAC-signed POST; if broken, parked workflows hang forever            |
| b   | Search-AI worker -> Docling HTTP                  | search-AI worker     | docling-service                | **P0**   | New streaming branch; if broken, envelope is empty/malformed              |
| d   | Workflow-engine -> Restate (park/resume)          | workflow-engine step | Restate journal                | **P1**   | Existing pattern (async_webhook) but first use from connector_action step |
| g   | AP piece -> Azure DI REST                         | piece run()          | Azure DI API                   | **P1**   | External SaaS; mock via DI; ctx.store replay safety is the risk           |
| e   | Workflow-engine -> Mongo (ConnectorConnection)    | toggle routes        | MongoDB                        | **P1**   | Idempotent upsert + usage $inc; concurrency-sensitive                     |
| f   | Workflow-engine -> Mongo (TraceEvent / AuditLog)  | trace/audit emitters | MongoDB                        | **P2**   | Existing patterns; low risk for new bugs                                  |

The top 3 (a, c, b) form the Docling data plane. If any one fails, the entire Docling path is broken. These must have dedicated integration tests with real BullMQ + real HTTP (stubbed Docling).

**Source**: Feature spec section 10, section 12 (reliability table), section 7 (technical considerations).
**Confidence**: HIGH

---

### I2: Webhook / event-driven flows beyond callback round-trip

**Classification**: DECIDED
**Answer**: Yes, two additional event-driven flows need integration coverage:

1. **Restate journal replay after engine restart**: The parked promise `sys:callback:${stepId}` must survive engine pod restart. This is tested at integration level by: (a) seeding a workflow execution with a `waiting_callback` step, (b) simulating the Restate client stub being re-created (as would happen on pod restart), (c) POSTing the callback, (d) asserting the promise resolves. The existing `system-callback.test.ts` partially covers this (it tests callback POST against a real Mongo execution) but does NOT test the Restate journal re-attach. A dedicated test should verify the callback route can still resolve a promise for a step that was parked before the "restart."

2. **BullMQ job stall/failure -> no retry -> timeout**: When the worker crashes mid-job (`attempts: 1`), no callback is POSTed. The workflow step should time out via `raceTimeout`. Integration test: enqueue a job, do NOT process it (or process and throw), wait for the step timeout, assert `EXTRACTION_TIMEOUT` or `EXTRACTION_FAILED` is surfaced.

The Restate journal behavior under real pod restart is more of an E2E concern (E2E-10 in the placeholder). At integration level, testing the callback round-trip with the Restate stub is sufficient.

**Source**: Feature spec section 12 (failure-mode table: "Engine pod restart during park", "Worker pod crash mid-job"), FR-11 (raceTimeout pattern).
**Confidence**: HIGH

---

### I3: Tenant/project isolation -- minimum integration coverage

**Classification**: DECIDED
**Answer**: **Representative sample of 8 cases, not all 20.**

Rationale: The 5 project-scoped routes share the same tenant+project scoping middleware. Once you prove one route correctly returns 404 for cross-tenant and one for cross-project, the middleware coverage applies to all routes. The HMAC callback route has a different auth mechanism (signature-based, not JWT-based), so it needs separate coverage.

Minimum set:

| #   | Route (representative)                             | Scenario                                                                      | Expected |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------- | -------- |
| 1   | `POST .../docling/enable`                          | Cross-tenant (tenant B's token, tenant A's projectId)                         | 404      |
| 2   | `POST .../docling/enable`                          | Cross-project (tenant A's token, project from tenant A but different project) | 404      |
| 3   | `POST .../docling/enable`                          | Missing auth                                                                  | 401      |
| 4   | `GET .../docling/quota`                            | Valid auth, correct tenant+project                                            | 200      |
| 5   | `GET .../azure-document-intelligence/usage`        | Cross-tenant                                                                  | 404      |
| 6   | `PATCH .../azure-document-intelligence/usage-caps` | Missing auth                                                                  | 401      |
| 7   | `POST /api/v1/workflows/callbacks/:eid/:sid`       | Missing HMAC signature                                                        | 401      |
| 8   | `POST /api/v1/workflows/callbacks/:eid/:sid`       | Invalid HMAC signature                                                        | 401      |

This gives: 2 cross-tenant, 1 cross-project, 2 missing-auth, 1 happy-path, 2 HMAC-auth across 3 different route groups. The existing `system-callback.test.ts` already covers cases 7-8, so we need 6 new integration tests.

**Source**: CLAUDE.md invariant #1 (resource isolation, cross-scope = 404); feature spec section 12 (isolation table); existing `system-callback.test.ts` HMAC coverage.
**Confidence**: HIGH

---

### I4: Race conditions / concurrency beyond what's drafted

**Classification**: DECIDED
**Answer**: Two additional concurrency scenarios:

1. **Concurrent toggle-enable + workflow-run race**: Tenant disables Docling while a workflow step is in-flight (between SSRF check and BullMQ enqueue). The step body should check the toggle inside `ctx.run` (journaled), so a concurrent disable does not retroactively fail an already-enqueued job, but a new run after disable should fail with `INTEGRATION_DISABLED`. Integration test: (a) enable, (b) start a slow workflow extraction (use a delayed Docling stub), (c) disable during extraction, (d) assert the in-flight extraction completes (callback POST succeeds), (e) assert the next workflow run fails with `INTEGRATION_DISABLED`.

2. **Concurrent month-boundary reset under load**: FR-18 uses a conditional `findOneAndUpdate` CAS for month-boundary reset. Under 20 concurrent extractions at the month boundary, exactly one should perform the reset and the others should increment normally. This is already covered by INT-13 in the placeholder. No additional scenario needed.

The two-queue dequeue race (whether BullMQ correctly honors per-queue concurrency limits under saturation) is already covered by INT-8 / E2E-8 in the placeholder. No additional scenario needed.

**Source**: Feature spec FR-11 (step body inside ctx.run), FR-18 (atomic CAS), FR-8 (two-queue concurrency).
**Confidence**: MEDIUM

---

### I5: Error/failure paths benefiting more from integration than E2E

**Classification**: DECIDED
**Answer**: Five error paths that should be integration-tested (faster feedback, more deterministic than E2E):

1. **Docling 5xx -> worker callback -> engine retry policy**: Worker calls Docling, gets 502. Worker POSTs `{ status: 'failed', error: { code: 'EXTRACTION_FAILED', message: '...' } }` via callback. Engine receives the failure, marks step as failed, applies per-node retry policy. Integration test with stubbed Docling returning 502.

2. **Azure DI 429 -> poll backoff -> eventual success**: Azure returns 429 with `Retry-After: 5` during polling. Action sleeps 5s, retries, gets 200. Integration test with DI-injected mock that returns 429 once then 200. Verifies `Retry-After` is honored (timer-based, hard to test in E2E).

3. **ctx.store key collision (Azure DI replay)**: Force a replay by calling `run()` twice with the same `(executionId, stepId)` -- second call reads the stashed `Operation-Location` from `ctx.store` and resumes polling instead of re-POSTing. Integration test with DI-injected mock that asserts `:analyze` was called exactly once.

4. **HMAC signature mismatch**: Callback POST with wrong signature -> 401. Already partially covered by `system-callback.test.ts` but needs to verify the specific Docling worker callback shape (`{ callbackId, status, envelope }`).

5. **Envelope too large**: Worker produces a >50MB serialized envelope. Worker should NOT POST it; instead POST `{ status: 'failed', error: { code: 'EXTRACTION_TOO_LARGE', sizeBytes, limitBytes } }`. Integration test with stubbed Docling returning a huge response.

These are all deterministic at integration level but would require complex fixture orchestration at E2E level (timing, large files, Azure rate limits).

**Source**: Feature spec section 12 (failure-mode table), FR-9 (size cap), FR-16 (ctx.store), FR-17 (429 + Retry-After).
**Confidence**: HIGH

---

## Decisions Made (for DECIDED items)

| #     | Decision                                                                                | Rationale                                                                                                                                      | Risk                                      |
| ----- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| D-TS1 | FR-12 > FR-9 > FR-16 > FR-11 > FR-18 risk ranking                                       | Ranked by security impact (HMAC) then data-integrity (streaming) then financial (double-bill) then availability (hang) then accuracy (counter) | Low                                       |
| D-TS2 | Stub Docling with tiny HTTP fixture, not real service                                   | Real Docling is GPU-heavy, slow, and unchanged by this feature; fixed interface is easily stubbed                                              | Low                                       |
| D-E1  | 6 additional UI-driven scenarios for the 3 forms                                        | Covers toggle, auth-profile creation, and DynamicActionForm value persistence round-trip                                                       | Low                                       |
| D-E2  | Invalid URL + wrong API key + out-of-range timeout as form error scenarios              | Exercises Zod validation (timeout), AP CustomAuth validate (endpoint), and backend auth check (apiKey)                                         | Low                                       |
| D-E3  | 6 representative auth cases (not 20+)                                                   | Shared middleware means one test per isolation dimension is sufficient                                                                         | Low                                       |
| D-E4  | 3 cross-feature flows (trace, audit, LLM downstream)                                    | Covers the primary integration surfaces without duplicating what related features test                                                         | Medium -- cross-feature tests are brittle |
| D-E5  | Full-chain wiring via public PDF + polling for completion                               | Proves every boundary hop is reachable with a single test                                                                                      | Low                                       |
| D-I1  | P0: worker->BullMQ, worker->callback, worker->Docling; P1: Restate, Azure, Mongo        | Data-plane boundaries are highest-blast-radius                                                                                                 | Low                                       |
| D-I2  | Add Restate re-attach + BullMQ stall timeout integration tests                          | These are event-driven failure modes not covered by callback round-trip alone                                                                  | Medium                                    |
| D-I3  | 8 representative isolation cases, not 20                                                | Shared middleware reduces to 1 per dimension per route group                                                                                   | Low                                       |
| D-I4  | Add concurrent toggle-disable-during-extraction scenario                                | Race between control plane (disable) and data plane (in-flight extraction)                                                                     | Medium                                    |
| D-I5  | 5 error paths at integration level: 5xx, 429, replay, HMAC mismatch, oversized envelope | Deterministic at integration level; timing-dependent at E2E                                                                                    | Low                                       |

---

## Escalations (for AMBIGUOUS items -- requires user input)

None. All 15 questions were answerable from the feature spec, existing codebase patterns, and CLAUDE.md principles.

---

## Audit Suite Results (phase-auditor, 2 rounds)

### Round 1 — NEEDS_REVISION (1 CRITICAL + 4 HIGH + 5 MEDIUM, all resolved)

| Severity | Finding                                                                                                           | Resolution                                                                                                                                                                                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | `nock` in E2E is in-process and cannot intercept Playwright's out-of-process workflow-engine / search-AI traffic. | Replaced with two out-of-process Express fixture servers (`docling-fixture-server.ts`, `azure-di-fixture-server.ts`) under `apps/studio/e2e/workflows/fixtures/`, managed by Playwright `globalSetup` / `globalTeardown`. `DOCLING_SERVICE_URL` overridden to fixture-server port. `nock` now only referenced in integration tests. |
| HIGH     | E2E file paths under non-existent `apps/studio/e2e/integrations/`.                                                | Consolidated all workflow E2E under `apps/studio/e2e/workflows/`; auth-profile E2E stays under `apps/studio/e2e/auth-profiles/` (existing convention).                                                                                                                                                                              |
| HIGH     | Playwright config filename allegedly wrong.                                                                       | False positive — `apps/studio/playwright.config.ts` IS the workflow E2E config (`testDir: './e2e'`, `reuseExistingServer: true`); `e2e-playwright.config.ts` is the specialized SDK-browser isolated-stack config. No change made.                                                                                                  |
| HIGH     | Missing INT for oversized envelope + worker-crash timeout.                                                        | Added INT-17 (oversized envelope → callback with no payload, `EXTRACTION_TOO_LARGE`) and INT-18 (worker stall → `raceTimeout` → `EXTRACTION_TIMEOUT`).                                                                                                                                                                              |
| HIGH     | FR-6 lacked integration coverage.                                                                                 | Added integration row + §8 mapping in `apps/workflow-engine/src/__tests__/docling-step-body.integration.test.ts` asserting `raceTimeout` receives 1800000 ms.                                                                                                                                                                       |
| MEDIUM   | E2E-ERR-5 misclassified as form-error.                                                                            | Renamed to E2E-9 with clarifying note.                                                                                                                                                                                                                                                                                              |
| MEDIUM   | ISO-2 cross-project under-specified at integration level.                                                         | INT-12 expanded to cover both cross-tenant + cross-project (T_A/P_A vs T_A/P_B vs T_B seed).                                                                                                                                                                                                                                        |
| MEDIUM   | INT-15 labeled "integration" but is build verification.                                                           | Relabeled "build verification, not service-boundary integration".                                                                                                                                                                                                                                                                   |
| MEDIUM   | E2E-2 audit-log verification ambiguous.                                                                           | Now references `GET /api/audit-logs?executionId=...` (HTTP-only) matching E2E-8.                                                                                                                                                                                                                                                    |
| MEDIUM   | E2E-9 auth context missing user role.                                                                             | Added `user with workflow:execute + integrations:read`.                                                                                                                                                                                                                                                                             |

### Round 2 — APPROVED (0 CRITICAL, 0 HIGH, 4 MEDIUM editorial — all resolved)

| Severity | Finding                                                                                                    | Resolution                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| MEDIUM   | Test integrity invariants line said "Docling stubbed via nock" without "integration tests only" qualifier. | Qualifier appended.                                                                                   |
| MEDIUM   | `DOCLING_SERVICE_URL` env var row in §7 didn't note the E2E override.                                      | Row now lists both INT (`localhost:8080`) and E2E (`localhost:8088` fixture port) values.             |
| MEDIUM   | §2 header claimed "all under workflows/" but two specs live under `auth-profiles/`.                        | Softened to mention the two auth-profile specs explicitly.                                            |
| MEDIUM   | Filename mismatch between feature-spec §10 Tests table and test-spec §8 for Azure DI usage-routes test.    | Aligned to `azure-di-usage-routes.integration.test.ts` in both docs (via `sed -i` across both files). |

### Final state

- 13 E2E + 18 integration + 10 unit + 15 security-and-isolation rows = 56 total scenarios.
- All 22 FRs covered in the matrix; 4 FORM-ERR scenarios + WIRING-1 mandate satisfied.
- HMAC callback coverage (INT-1, INT-11, SEC-6/7/8, UT-10) is thorough; replay-safety coverage for both Docling (INT-3, E2E-6) and Azure DI (INT-5, INT-6) explicit.
- Test spec is APPROVED and is the canonical contract going into HLD / LLD.
