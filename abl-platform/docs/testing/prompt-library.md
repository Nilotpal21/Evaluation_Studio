# Test Specification: Prompt Library

**Feature Spec:** [`../features/prompt-library.md`](../features/prompt-library.md)
**HLD:** `../specs/prompt-library.hld.md`
**LLD:** `../plans/2026-04-27-prompt-library-impl-plan.md`
**Status:** ALPHA
**Last Updated:** 2026-04-28

---

## 1. Current State

Implementation is complete (all 6 LLD phases). All 20 test files (8 unit, 8 integration, 4 E2E/Playwright) plus the shared helper and perf bench are committed. Feature status is **ALPHA** — core paths implemented and tested; deferred items (E2E-1 agent deploy+session, E2E-6 per-role provisioning, INT-10 HTTP 500 partial failure, trace events) tracked for post-ALPHA coverage ramp.

| Phase                       | Required Coverage                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| ALPHA (post-implementation) | Happy-path E2E-1 passing; UT for schema and `sourceHash`; INT-1 (atomic promote) passing                                                      |
| BETA (post-coverage)        | ≥5 E2E scenarios passing, ≥7 integration scenarios passing, all CRITICAL gaps resolved, isolation 404 tests passing                           |
| STABLE                      | All 7 E2E + 12 integration scenarios in this guide passing; perf targets met; production wiring verified; reverse-reference query benchmarked |

---

## 2. Coverage Matrix

Status legend: `PASS` / `FAIL` / `NOT` (not yet implemented) / `n/a` (tier not applicable).

| FR    | Description                                                                           | Unit | Integration    | E2E                 | Manual | Status                                                                              |
| ----- | ------------------------------------------------------------------------------------- | ---- | -------------- | ------------------- | ------ | ----------------------------------------------------------------------------------- |
| FR-1  | CRUD endpoints for `PromptLibraryItem` scoped by tenant + project                     | UT-1 | INT-12 (proxy) | E2E-1, E2E-5        | NOT    | PASS                                                                                |
| FR-2  | `PromptLibraryVersion` with template, variables, sourceHash                           | UT-2 | INT-2          | E2E-1               | NOT    | PASS                                                                                |
| FR-3  | 3-state lifecycle with at most one active version per prompt                          | UT-3 | INT-1, INT-4   | E2E-1               | NOT    | PASS                                                                                |
| FR-4  | Single-turn test endpoint via `ModelResolutionService.resolve()`                      | UT-4 | INT-5          | E2E-2, E2E-3        | NOT    | PASS                                                                                |
| FR-5  | Compare mode A (prompt × N models) and B (N versions × model); cross-product rejected | n/a  | INT-10         | E2E-2, E2E-3, E2E-4 | NOT    | PARTIAL (INT-10 sanitization covered; HTTP 500 sub-scenario deferred to post-ALPHA) |
| FR-6  | `SystemPromptConfig.libraryRef` extension; compile-time resolution                    | UT-5 | INT-3, INT-8   | E2E-1               | NOT    | PARTIAL                                                                             |
| FR-7  | RBAC `prompt:*` permissions and role assignments                                      | UT-6 | n/a            | E2E-6               | NOT    | PARTIAL                                                                             |
| FR-8  | Studio resource page reachable via `resourceNavDefs`                                  | n/a  | WIRING-2       | E2E-7               | NOT    | PASS                                                                                |
| FR-9  | Prompt picker in IdentityEditor                                                       | n/a  | n/a            | E2E-7               | NOT    | PASS                                                                                |
| FR-10 | Reverse-reference query                                                               | n/a  | INT-3, INT-11  | n/a                 | NOT    | PASS                                                                                |
| FR-11 | Audit log emissions for lifecycle events and tests                                    | n/a  | INT-7          | E2E-1               | NOT    | PARTIAL                                                                             |
| FR-12 | Boundary validation (template size, variable count, value length, version cap)        | UT-7 | INT-6          | n/a                 | NOT    | PASS                                                                                |
| FR-13 | Variable value sanitization (strip `{{`, `}}`)                                        | UT-8 | INT-5          | n/a                 | NOT    | PASS                                                                                |
| FR-14 | Cross-tenant + cross-project access returns 404                                       | n/a  | INT-12         | E2E-5               | NOT    | PASS                                                                                |
| FR-15 | Missing/archived `libraryRef` at runtime → sanitized configuration error              | n/a  | INT-9          | n/a                 | NOT    | PASS                                                                                |

---

## 3. E2E Test Scenarios (MANDATORY)

> CRITICAL: E2E tests MUST exercise the real system through HTTP API only. No `vi.mock` / `jest.mock`. No direct DB access (no Mongoose model imports in test files). Real Express on random ports via `startRuntimeServerHarness()` from `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`. LLM provider stubbed by registering a tenant model whose `endpointUrl` points at a local mock HTTP server (per `provisionTenantModel()` pattern at `apps/runtime/src/__tests__/helpers/channel-e2e-bootstrap.ts:710-747`). No `vi.mock` of `ModelResolutionService`, `PromptLibraryService`, or any platform package.

### E2E-1: Create → version → promote → reference from agent → execute session

- **Preconditions:** Authenticated developer in tenant `T` / project `P` (set up via `bootstrapProject()`). One tenant model registered via `provisionTenantModel()` with `endpointUrl` pointing at a local mock LLM server returning a deterministic completion (e.g., echoes `userMessage` back).
- **Auth Context:** JWT developer (full `prompt:*` + `agent:update`).
- **Steps:**
  1. `POST /api/projects/P/prompt-library/prompts` body `{ name: 'helpdesk-greeting', description, tags: ['support'], initialVersion: { template: 'Hello {{name}}, how can I help?', variables: ['name'], description: 'v1' } }` — assert `201` with `{ id: 'pl_…', name, status: 'active' }` (item) and version `{ id: 'plv_…', versionNumber: 1, status: 'draft' }`.
  2. `POST .../prompts/:promptId/versions/:versionId/promote` — assert `200` with `{ status: 'active', publishedAt, publishedBy }`.
  3. `POST /api/projects/P/agents/import` with a DSL bundle defining agent `helpdesk-greeter` (per `importProjectFiles()`); assert agent created.
  4. `PATCH /api/projects/P/agents/helpdesk-greeter/working-copy/system-prompt` body `{ libraryRef: { promptId, versionId } }` — assert `200` and recompile triggered. Working IR now contains `system_prompt.libraryRef` plus resolved `template` plus `custom: true`.
  5. `POST /api/projects/P/agents/helpdesk-greeter/deployments` to publish a deployable version; assert `201`.
  6. `POST /api/sessions` with `{ projectId: P, agentId, source: 'studio_debug' }` then `POST /api/sessions/:id/messages` body `{ content: 'hi there', context: { name: 'Sam' } }`. Assert `200`. Capture trace events.
  7. Trace assertion: trace event `system-prompt-rendered` carries `Hello Sam, how can I help?`.
  8. `GET /api/projects/P/audit-logs?action=prompt.created,prompt.version_created,prompt.version_promoted` — assert all three events present, timestamps strictly increasing, `metadata.promptId` matches.
- **Expected Result:** All HTTP responses 2xx; session executes; trace events present; audit log entries present and ordered correctly.
- **Isolation Check:** Prefix with project-scoped path; project not in scope returns 404 (covered explicitly in E2E-5).
- **Test File:** `apps/runtime/src/__tests__/prompt-library-flow.e2e.test.ts`

### E2E-2: Compare Mode A — same prompt × 3 models in parallel

- **Preconditions:** Three tenant models `m1`, `m2`, `m3` registered via `provisionTenantModel()`, each pointing at a local mock HTTP server that introduces a 200ms artificial delay before responding.
- **Auth Context:** JWT developer.
- **Steps:**
  1. Create prompt + active version (template `Summarize: {{text}}`, variables `[text]`).
  2. `POST /api/projects/P/prompt-library/test` body `{ panes: [{ promptVersionId, tenantModelId: m1 }, { promptVersionId, tenantModelId: m2 }, { promptVersionId, tenantModelId: m3 }], variables: { text: 'hello' }, userMessage: 'go' }`.
  3. Capture wall-clock latency.
  4. Assert response `200` with `{ panes: [3 panes], failedPanes: [] }` where each pane has `{ tenantModelId, output, usage: { input, output, total }, latencyMs, model, provider }`.
  5. Assert wall-clock < 700ms (3 panes serialised would be ≥600ms each + overhead — parallel keeps it under (max latency + 1s) per perf target).
- **Expected Result:** 3 panes returned, all with content; wall-clock proves parallel execution.
- **Isolation Check:** Cross-project tenant model id rejected with 400 (validation runs inside project scope).
- **Test File:** `apps/runtime/src/__tests__/prompt-library-compare.e2e.test.ts`

### E2E-3: Compare Mode B — 3 versions × 1 model in parallel

- **Preconditions:** One tenant model `m1` registered. Prompt with 3 versions: `v1` active, `v2` draft, `v3` draft (all created via API).
- **Auth Context:** JWT developer.
- **Steps:**
  1. `POST .../test` body `{ panes: [{ promptVersionId: v1, tenantModelId: m1 }, { promptVersionId: v2, tenantModelId: m1 }, { promptVersionId: v3, tenantModelId: m1 }], variables: {}, userMessage: 'ping' }`.
  2. Assert `200` with `{ panes: [3 panes], failedPanes: [] }`.
  3. Assert each pane has `promptVersionId` matching one of `[v1, v2, v3]` and `output` non-empty.
- **Expected Result:** 3 panes, each tagged with the corresponding `promptVersionId`.
- **Isolation Check:** Submitting `promptVersionId` from a different project returns 400 with code `PROMPT_LIBRARY_VERSION_NOT_FOUND`.
- **Test File:** `apps/runtime/src/__tests__/prompt-library-compare.e2e.test.ts`

### E2E-4: Cross-product compare is rejected with 400

- **Preconditions:** Prompt with 2 versions, 2 tenant models registered.
- **Auth Context:** JWT developer.
- **Steps:**
  1. `POST .../test` body with empty `panes: []` → assert `400`.
  2. `POST .../test` body with `panes: [6 entries]` → assert `400 PROMPT_LIBRARY_TOO_MANY_PANES`.
  3. Unauthenticated `POST .../test` → assert `401`.
  4. `POST .../test` body containing prompt version from a different project → assert `400 PROMPT_LIBRARY_VERSION_NOT_FOUND`.
     _Note: The original spec described a `mode`/`tenantModelIds`/`promptVersionIds` API. The implementation uses `panes: [{ promptVersionId, tenantModelId }]` instead — a flat array approach that eliminates cross-product combinations entirely. E2E-4 tests the pane-array validation boundaries._
- **Expected Result:** HTTP 400 with structured error envelope.
- **Test File:** `apps/runtime/src/__tests__/prompt-library-compare.e2e.test.ts`

### E2E-5: Tenant + project isolation returns 404 across the entire route surface

- **Preconditions:** Prompt `pl_1` created in tenant `T1` / project `A` by user `U1`. Second user `U2` with developer role in tenant `T1` / project `B`. Third user `U3` with developer role in tenant `T2` / project `X`.
- **Auth Context:** `U2` (cross-project) and `U3` (cross-tenant).
- **Steps (run for each route in the matrix below, both as `U2` and `U3`):**

| Route                                                                         | Method | Expected |
| ----------------------------------------------------------------------------- | ------ | -------- |
| `/api/projects/B/prompt-library/prompts/pl_1` (cross-project — same tenant)   | GET    | 404      |
| `/api/projects/B/prompt-library/prompts/pl_1`                                 | PATCH  | 404      |
| `/api/projects/B/prompt-library/prompts/pl_1`                                 | DELETE | 404      |
| `/api/projects/B/prompt-library/prompts/pl_1/versions`                        | GET    | 404      |
| `/api/projects/B/prompt-library/prompts/pl_1/versions/plv_1`                  | GET    | 404      |
| `/api/projects/B/prompt-library/prompts/pl_1/versions/plv_1/promote`          | POST   | 404      |
| `/api/projects/B/prompt-library/prompts/pl_1/versions/plv_1/archive`          | POST   | 404      |
| `/api/projects/B/prompt-library/prompts/pl_1/references`                      | GET    | 404      |
| `/api/projects/B/prompt-library/test` (with `promptVersionId: plv_1` in body) | POST   | 404      |
| Same routes with `U3` (tenant `T2`)                                           | All    | 404      |

- **Expected Result:** Every route returns `404` (NEVER `403`) for both cross-project and cross-tenant access. Response body uses sanitised error envelope.
- **Test File:** `apps/runtime/src/__tests__/prompt-library-isolation.e2e.test.ts`

### E2E-6: RBAC — tester can test but not promote; viewer can only read

- **Preconditions:** Prompt + draft version created by developer. Three users in project `P`: `U_dev` (developer), `U_test` (tester role: `prompt:read`+`prompt:test`), `U_view` (viewer role: `prompt:read`).
- **Auth Context:** Per step.
- **Steps:**
  1. As `U_dev`: GET list → 200; GET prompt → 200; POST `/test` → 200; POST `/promote` → 200.
  2. As `U_test`: GET list → 200; GET prompt → 200; POST `/test` → 200; POST `/promote` → 403; POST `/archive` → 403; POST new version → 403; PATCH prompt → 403; DELETE prompt → 403.
  3. As `U_view`: GET list → 200; GET prompt → 200; POST `/test` → 403; POST `/promote` → 403; PATCH → 403.
- **Expected Result:** Permission denied returns `403` with structured envelope; permitted operations return 2xx. Confirm RBAC matches role definitions in `packages/shared-auth/src/rbac/role-permissions.ts`.
- **Test File:** `apps/runtime/src/__tests__/prompt-library-rbac.e2e.test.ts`

### E2E-7: Studio UI flow — create → compare → use in agent (Playwright)

- **Preconditions:** Studio dev server running (`apps/studio`). Real MongoDB at `TEST_MONGODB_URI`. Two tenant models pre-provisioned via test-db helper. Authenticate via `loginViaDevApi(page)` from `apps/studio/e2e/helpers/auth.ts`.
- **Auth Context:** Studio developer session (JWT cookie).
- **Steps:**
  1. Navigate to `/projects/:projectId/resources/prompt-library`. Assert nav slot "Prompt Library" present in resource sidebar (4th entry).
  2. Click "Create"; fill template `Hello {{name}}!`, variables `[name]`, description "Greeting". Assert list refreshes and new prompt is visible.
  3. Open prompt detail. Assert version list shows `v1 (draft)`. Click "Promote". Assert badge changes to `active`.
  4. Click "Compare". Choose Mode A, select 2 models, set variable `name=Sam`, user message `Say hi`. Click Run. Assert 2 panes render with content within 30s.
  5. Navigate to an existing agent's edit page → IdentityEditor. Click "Use Library Prompt". Modal opens with project-scoped prompt list. Pick the new prompt + active version. Save agent.
  6. Open agent → Chat tab. Send "hi". Assert response received with no console errors and no failed network calls.
- **Expected Result:** Full UI flow works without errors; created assets are queryable via API after the test.
- **Test File:** `apps/studio/e2e/prompt-library/full-flow.spec.ts`

---

## 4. Integration Test Scenarios (MANDATORY)

> Integration tests use real service boundaries — real MongoDB (via `setupTestMongo()`), real `PromptLibraryService`, real `ModelResolutionService`. Only the LLM provider transport may be injected via DI at the Vercel AI SDK boundary. No `vi.mock` of any `@agent-platform/*` or `@abl/*` package, no relative-import mocks of platform code.

### INT-1: Atomic promote under concurrency

- **Boundary:** `PromptLibraryService.promoteVersion()` ↔ MongoDB.
- **Setup:** Prompt `pl_1` with two draft versions `plv_a`, `plv_b`. No active version yet. Pattern mirrors `version-service.ts:618-631` (`findOneAndUpdate` with `{_id, promptId, status: 'draft'}` guard plus a second update demoting any prior active version, both within a transaction).
- **Steps:**
  1. Spawn `Promise.all([service.promoteVersion(plv_a), service.promoteVersion(plv_b)])` from the same Mongoose connection.
  2. Inspect outcomes — exactly one promise resolves with `{ status: 'active' }`, the other rejects with `UNPROCESSABLE_ENTITY` ("Concurrent modification").
  3. Query DB — exactly one version has `status: 'active'`.
- **Expected Result:** No state where both versions are active; loser receives a 409-equivalent error.
- **Failure Mode:** If guard is missing, both updates succeed and DB is in an inconsistent state — test catches this.
- **Test File:** `apps/runtime/src/services/prompt-library/__tests__/prompt-library-service.test.ts`

### INT-2: sourceHash determinism

- **Boundary:** `computeSourceHash()` pure function ↔ caller (no MongoDB needed).
- **Setup:** None.
- **Steps:**
  1. `computeSourceHash({ template: 'Hello {{a}} {{b}}', variables: ['a', 'b'] })` →`H1`.
  2. `computeSourceHash({ template: 'Hello {{a}} {{b}}', variables: ['b', 'a'] })` → `H2`.
  3. `computeSourceHash({ template: 'Hello {{a}} {{b}} ', variables: ['a', 'b'] })` (trailing space) → `H3`.
  4. Assert `H1 === H2` (variable order normalised) and `H1 !== H3` (template byte-for-byte).
- **Expected Result:** Hash is deterministic across variable reorderings and sensitive to template changes (any byte difference, including whitespace).
- **Failure Mode:** Non-determinism would mean dedup detection breaks and version equality is wrong.
- **Test File:** `packages/database/src/__tests__/model-prompt-library-version.test.ts`

### INT-3: usageCount denormalization on agent compile

- **Boundary:** `VersionService` (or compile route handler) ↔ `PromptLibraryItem` model. Per oracle: the compiler itself remains pure (DSL → IR with no DB writes); usageCount is updated by the **service layer** that calls `compileABLtoIR()` and detects `libraryRef` in the resulting IR.
- **Setup:** Active prompt `pl_1` with active version `plv_1`. Two agents `A1`, `A2`.
- **Steps:**
  1. Compile and persist agent `A1` with `libraryRef: { promptId: pl_1, versionId: plv_1 }`. Read `pl_1.usageCount` → 1.
  2. Compile and persist agent `A2` with the same libraryRef. `usageCount` → 2.
  3. Recompile `A1` with libraryRef removed. `usageCount` → 1.
  4. Delete `A2`. `usageCount` → 0.
- **Expected Result:** `usageCount` reflects the live count of agents pointing at this prompt within ±1 (eventual consistency permitted but not in v1).
- **Failure Mode:** If hook is missing or wrong, `usageCount` drifts and operators see incorrect "Used by N agents" indicator.
- **Test File:** `apps/runtime/src/services/prompt-library/__tests__/usage-count-denormalization.test.ts`

### INT-4: Archived version is unreferencable but resolved pins continue to execute

- **Boundary:** `PromptLibraryService.archiveVersion()` ↔ agent compile path ↔ runtime `buildSystemPrompt()`.
- **Setup:** Prompt `pl_1` with active `plv_1`. Promote new version `plv_2` (auto-demotes `plv_1`). Then archive `plv_1`.
- **Steps:**
  1. Attempt to compile a new agent with `libraryRef.versionId = plv_1` → assert error `PROMPT_LIBRARY_VERSION_ARCHIVED` (HTTP 400 at API layer).
  2. Read an existing pre-existing agent `A_old` (compiled before archiving — its IR already contains the resolved template) — `buildSystemPrompt()` runs successfully and returns the resolved template. The runtime never reads the library; only the compile-time pin matters.
- **Expected Result:** New references rejected, existing pins still work.
- **Failure Mode:** If runtime accidentally re-reads from library, archived versions would silently break running agents.
- **Test File:** `apps/runtime/src/services/prompt-library/__tests__/prompt-library-service.test.ts`

### INT-5: Variable value sanitization at test endpoint

- **Boundary:** `PromptLibraryTestService.execute()` ↔ `renderTemplate()`.
- **Setup:** Active prompt `pl_1` with template `Greeting: {{name}}` and variable `[name]`. One tenant model whose `endpointUrl` echoes the rendered prompt back.
- **Steps:**
  1. Call test endpoint with `variables: { name: '{{leak}}' }`.
  2. Inspect the rendered system prompt sent to the model: must be `Greeting: leak` (delimiters stripped) — NOT `Greeting: {{leak}}` (would re-render) and NOT `Greeting: ` (over-stripped).
  3. Repeat with `variables: { name: 'foo {{}}{{nested}} bar' }` → assert rendered is `Greeting: foo nested bar`.
- **Expected Result:** Handlebars `{{` / `}}` delimiters stripped from every variable value before substitution; the literal payload reaches the model.
- **Failure Mode:** Without sanitisation, user-supplied variables could trigger nested-template lookups (FR-13).
- **Test File:** `apps/runtime/src/services/prompt-library/__tests__/prompt-library-test-service.test.ts`

### INT-6: Boundary rejections

- **Boundary:** Route validators ↔ Zod schemas.
- **Setup:** Project with active prompt.
- **Steps:**
  1. POST version with `template` of length 32769 → `400 PROMPT_LIBRARY_TEMPLATE_TOO_LARGE`.
  2. POST version with 21 variables → `400 PROMPT_LIBRARY_TOO_MANY_VARIABLES`.
  3. POST `/test` with one variable value of length 4097 → `400 PROMPT_LIBRARY_VARIABLE_VALUE_TOO_LARGE`.
  4. POST 201st version on a single prompt (after seeding 200 versions via direct service calls) → `400 PROMPT_LIBRARY_VERSION_LIMIT_EXCEEDED`.
  5. POST `/test` with 6 entries in `panes` → `400 PROMPT_LIBRARY_TOO_MANY_PANES` (limit 5).
- **Expected Result:** All five rejections fire with structured error envelope; payloads at exactly the limit succeed.
- **Failure Mode:** Off-by-one in validator allows oversized inputs to reach DB or LLM provider.
- **Test File:** `apps/runtime/src/services/prompt-library/__tests__/prompt-library-service.test.ts`

### INT-7: Audit log emission post-commit

- **Boundary:** `PromptLibraryService` ↔ `MongoAuditStore` (mirrors pattern in `apps/runtime/src/__tests__/mongo-audit-store.test.ts:28-46`).
- **Setup:** Real MongoMemoryServer, real audit store.
- **Steps:**
  1. Create prompt → `MongoAuditStore.query({ resourceType: 'prompt-library', action: 'prompt.created' })` returns the entry; entry timestamp ≥ `PromptLibraryItem.createdAt`.
  2. Promote version → assert `prompt.version_promoted` entry; entry timestamp ≥ DB `publishedAt`.
  3. Archive version → assert `prompt.version_archived` entry.
  4. Run test endpoint → assert no `prompt.tested` audit entry is recorded; prompt tests remain execution telemetry.
  5. Inject a DB write failure (force a transaction rollback). Assert NO audit entry is recorded for the failed operation (post-commit ordering).
- **Expected Result:** Audit entries present after success, absent after rollback. Sequencing matches contract: audit emit happens after commit, never before.
- **Failure Mode:** Audit-before-commit creates non-events; missing audit hides operations from compliance.
- **Test File:** `apps/runtime/src/services/prompt-library/__tests__/audit-emission.test.ts`

### INT-8: Compiler library-ref resolution into IR

- **Boundary:** Agent-compile service ↔ `PromptLibraryService.getActiveVersion()` ↔ resulting `AgentIR.identity.system_prompt`. Per oracle (C-5): the compiler itself is pure; the **resolution hook** lives in the compile-orchestration service that calls `compileABLtoIR()` and post-processes its IR.
- **Setup:** Active prompt with template `Hello {{name}}` and version `plv_1`.
- **Steps:**
  1. Compile an agent whose working copy has `system_prompt.libraryRef = { promptId, versionId: plv_1 }`. Inspect resulting IR:
     - `system_prompt.template` === `'Hello {{name}}'`
     - `system_prompt.custom === true`
     - `system_prompt.libraryRef.resolvedHash` === `sha256(template)` of `plv_1`.
  2. Mutate `plv_1.template` directly in DB to `Hi {{name}}` (simulating drift). Recompile. Assert new `resolvedHash` differs and IR carries the new template.
  3. Compile with `libraryRef.versionId` of an archived version → reject with `PROMPT_LIBRARY_VERSION_ARCHIVED`.
- **Expected Result:** Resolution copies template + sets `custom: true` + records `resolvedHash`. Drift detected via hash change.
- **Failure Mode:** If compiler reads template at runtime instead of compile time, every session would do a DB lookup; if hash isn't recorded, cache invalidation fails.
- **Test File:** `apps/runtime/src/services/agent-compile/__tests__/library-ref-resolution.test.ts`

### INT-9: Runtime configuration error on missing reference

- **Boundary:** `RuntimeExecutor.buildSystemPrompt()` ↔ session.agentIR. Mirrors in-process pattern at `apps/runtime/src/__tests__/profile-integration.test.ts:311-378` (`(executor as any).buildSystemPrompt(session)`).
- **Setup:** Construct an agent IR in-process (no DB) where `system_prompt.libraryRef.promptId` points at a non-existent prompt and `system_prompt.template` is empty (simulating "compile-time resolution dropped"). Use real `RuntimeExecutor` instance.
- **Steps:**
  1. Call `(executor as any).buildSystemPrompt(session)`.
  2. Assert it throws an error of shape `ModelResolutionConfigurationError` (or sibling) with sanitised user-facing message (no tenant id, no prompt id).
  3. Capture log output — raw `promptId` and `versionId` MUST be present in server logs (operator visibility) but NOT in the thrown error's `message`.
- **Expected Result:** Sanitised configuration error thrown to caller; raw context retained in logs.
- **Failure Mode:** Silent fallback to empty system prompt would let agents execute with no system instruction — worst-case silent regression.
- **Test File:** `apps/runtime/src/services/execution/__tests__/build-system-prompt-library-ref.test.ts`

### INT-10: Test endpoint partial failure (4-of-5 panes succeed)

- **Boundary:** `PromptLibraryTestService.executeCompare()` ↔ Vercel AI SDK invocation per pane.
- **Setup:** 5 tenant models registered. Pane #3's mock `endpointUrl` returns HTTP 500. Other 4 succeed with 200ms.
- **Steps:**
  1. Call test endpoint with 5 panes (`panes: [{ promptVersionId, tenantModelId: m1..m5 }]`).
  2. Assert response `200` with `{ panes: [4 succeeded], failedPanes: [{ tenantModelId: m3, error: { code, message } }] }`.
  3. Assert `failedPanes[0].error.message` is sanitised (no tenant id, no provider details).
  4. Assert trace events include `prompt-library.test.pane.complete` for the failed pane with status `failed`.
- **Expected Result:** Whole request stays `200`; partial-success contract holds.
- **Failure Mode:** Whole-request failure on one bad model defeats the comparison value proposition.
- **Test File:** `apps/runtime/src/services/prompt-library/__tests__/prompt-library-test-service.test.ts`

### INT-11: Reverse-reference query response shape (FR-10)

- **Boundary:** `GET /api/projects/:p/prompt-library/prompts/:promptId/references` ↔ `agent_versions` collection scan.
- **Setup:** Active prompt `pl_1` with versions `plv_1` and `plv_2`. Three compiled agents:
  - `A1` references `plv_1` (active)
  - `A2` references `plv_2` (active)
  - `A3` no library reference
- **Steps:**
  1. `GET /api/projects/P/prompt-library/prompts/pl_1/references` → assert response `200` with shape:
     ```json
     {
       "promptId": "pl_1",
       "totalAgents": 2,
       "byVersion": [
         {
           "versionId": "plv_1",
           "versionNumber": 1,
           "agentCount": 1,
           "agents": [{ "agentId": "A1", "agentName": "...", "deploymentStatus": "..." }]
         },
         {
           "versionId": "plv_2",
           "versionNumber": 2,
           "agentCount": 1,
           "agents": [{ "agentId": "A2", "agentName": "...", "deploymentStatus": "..." }]
         }
       ]
     }
     ```
  2. `GET ...?versionId=plv_1` → assert filtered response with only the `plv_1` entry.
  3. Compile a 4th agent `A4` referencing `plv_1`. Re-query. Assert `byVersion[0].agentCount === 2` and `agents` contains both `A1` and `A4`.
  4. Decompile `A1`. Re-query. Assert `agentCount === 1`.
- **Expected Result:** Counts match live agent compile state; agent-list response carries `agentName` and `deploymentStatus` for operator visibility.
- **Failure Mode:** Wrong shape blocks operator UI from rendering "Used by N agents" detail panel; stale counts mislead archive decisions.
- **Test File:** `apps/runtime/src/routes/__tests__/prompt-library-references.test.ts`

### INT-12: Studio proxy auth context forwarding and error envelope passthrough

- **Boundary:** Studio Next.js Route Handler at `apps/studio/src/app/api/projects/[id]/prompt-library/...` ↔ runtime route at `apps/runtime/src/routes/prompt-library.ts`.
- **Setup:** Studio harness with the route handler in isolation (no full Next.js dev server needed — use `apps/studio/src/__tests__/route-handler-harness.ts` style). Inject a stub HTTP transport (via DI) for the outbound call to runtime (only the transport layer — NOT the route handler logic). The runtime is "real" in the sense that the test can inspect what the handler forwards: headers, body, error envelopes.
- **Steps:**
  1. Authenticated developer calls Studio proxy `POST /api/projects/P/prompt-library/prompts` with body. Inspect outgoing HTTP request — assert `Authorization` header carries the user JWT (or platform key plus user-context header per inter-service auth pattern), and `tenantId` is on the resolved request, never reused from a different request.
  2. Stub runtime to return `400 { success: false, error: { code: 'PROMPT_LIBRARY_TEMPLATE_TOO_LARGE', message } }`. Assert Studio response is `400` with the same envelope.
  3. Stub runtime to return `404`. Assert Studio response is `404` (cross-tenant isolation propagates).
  4. Send Studio call without auth → assert `401` returned by Studio middleware before any runtime call.
  5. Send Studio call with developer auth but `projectId` the user lacks access to → assert `403` from Studio middleware (or `404` if isolation rules apply).
  6. Validate the body parser uses Zod `.strict()` (CLAUDE.md "Studio Route Handler Gotchas") — extra fields in the body must be rejected with `400` rather than silently passed through.
- **Expected Result:** Studio proxy forwards auth context correctly, never reuses tenant context across requests, and passes runtime error envelopes through verbatim.
- **Failure Mode:** Auth context bleed between requests (CLAUDE.md "Studio Route Handler Gotchas"); error envelope swallow loses error codes.
- **Test File:** `apps/studio/src/app/api/projects/[id]/prompt-library/__tests__/proxy.test.ts`

---

## 5. Unit Test Scenarios

| ID   | Module / File                                                         | Subject                                 | Asserts                                                                                                                                 |
| ---- | --------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| UT-1 | `packages/database/src/models/prompt-library-item.model.ts`           | Mongoose schema for `PromptLibraryItem` | Required fields, indexes (unique `tenantId+projectId+name`), `tenantIsolationPlugin` applied                                            |
| UT-2 | `packages/database/src/models/prompt-library-version.model.ts`        | Schema for `PromptLibraryVersion`       | Required fields, status enum, `versionNumber` monotonic, indexes                                                                        |
| UT-3 | `apps/runtime/src/services/prompt-library/prompt-library-service.ts`  | Lifecycle helpers (validateTransition)  | Allowed: `draft→active`, `active→archived`, `draft→archived`. Disallowed: any other.                                                    |
| UT-4 | `apps/runtime/src/services/prompt-library/extract-variables.ts`       | `extractVariables(template)`            | `'Hello {{name}}, count {{count}}'` → `['name', 'count']`; deduplicates; `'Hi'` → `[]`                                                  |
| UT-5 | `packages/compiler/src/platform/ir/schema.ts`                         | `SystemPromptConfig` extended type      | TypeScript type test: `libraryRef` optional; missing → existing IR unchanged                                                            |
| UT-6 | `packages/shared-auth/src/rbac/role-permissions.ts`                   | `PERMISSION_REGISTRY` and role maps     | All 6 `prompt:*` permissions registered; developer has all 6, tester has read+test, viewer has read                                     |
| UT-7 | `apps/runtime/src/services/prompt-library/validators.ts`              | Boundary validators                     | `validateTemplateSize(32768)` ok, `(32769)` throws; `validateVariableCount(20)` ok, `(21)` throws; `validateVariableValueSize(4096)` ok |
| UT-8 | `apps/runtime/src/services/prompt-library/sanitize-variable-value.ts` | `sanitizeVariableValue('{{leak}}')`     | `'leak'`; `'{{a}}{{b}}'` → `'ab'`; `'no delim'` → `'no delim'`; preserves whitespace inside                                             |

---

## 6. Security & Isolation Tests

These are not optional. Every item below is a test case.

- [ ] Cross-tenant access to any prompt-library route returns **404** (E2E-5)
- [ ] Cross-project access to any prompt-library route returns **404** (E2E-5)
- [ ] Missing/invalid auth returns **401** (covered by `requireAuth` middleware suite; spot-checked in E2E-6)
- [ ] Insufficient permissions returns **403** with sanitised envelope (E2E-6)
- [ ] Input validation rejects oversized template / too many variables / oversized variable value (INT-6)
- [ ] Variable value sanitiser strips `{{` / `}}` (INT-5, UT-8)
- [ ] Sanitised user-facing errors never include tenant id, model id, or credential hints (E2E-4, INT-9, INT-10)
- [ ] Audit log captures state-changing prompt lifecycle rows (`prompt.created`, `prompt.version_created`, `prompt.version_promoted`, `prompt.version_archived`) post-commit, and prompt test runs remain telemetry-only (INT-7)
- [ ] Studio Route Handler does not reuse tenant context between requests; explicit `tenantId: user.tenantId` scope in every query (INT-12, plus CLAUDE.md "Studio Route Handler Gotchas")
- [ ] No `eval` / `new Function`: `renderTemplate()` is regex-based — confirmed by static inspection in PR review (no automated test)

---

## 7. Performance & Load Tests

| Target                                                                                      | Threshold                                         | Measurement                                                                          |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Test endpoint p95 platform overhead (excluding LLM provider latency)                        | ≤ 500 ms                                          | `pnpm test:report` perf bench against local mock LLM                                 |
| Compare mode 5-pane wall-clock                                                              | ≤ (max single-pane latency + 1 s)                 | Same bench, 5 stub providers each fixed at 200 ms                                    |
| Reverse-reference query (`GET .../references`) against a project with 1000 simulated agents | ≤ 200 ms                                          | Seed via service call; query at p95 over 50 invocations                              |
| List endpoint `GET .../prompts` with 200 prompts                                            | ≤ 100 ms                                          | Seed via service call; query with default pagination (50) at p95 over 50 invocations |
| Atomic promote contention                                                                   | No deadlocks; 100 concurrent promote calls finish | Stress test with `Promise.all` of 100; assert exactly one wins, others receive 409   |

These benchmarks live in `apps/runtime/src/__tests__/prompt-library.perf.test.ts` (excluded from default `pnpm test`; run via `pnpm test --filter=runtime -- --tier=perf`). Production validation: Coroot / Grafana dashboards for `prompt-library.test.*` trace event histograms.

---

## 8. Test Infrastructure

### Required Services

| Service                       | Source                                                                                                         | Notes                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| MongoDB (in-memory)           | `apps/runtime/src/__tests__/helpers/setup-mongo.ts` (`MongoMemoryServer 7.0.20`)                               | Per-test-file isolation (`vitest.config.ts: pool: 'forks'`)                                                 |
| Express runtime               | `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts` (`startRuntimeServerHarness()`)                    | Random port via `port: 0`; full middleware chain                                                            |
| Auth + project + tenant model | `apps/runtime/src/__tests__/helpers/channel-e2e-bootstrap.ts` (`bootstrapProject()`, `provisionTenantModel()`) | Returns headers, project IDs, tenant model IDs                                                              |
| Mock LLM HTTP server          | New helper: `apps/runtime/src/__tests__/helpers/mock-llm-server.ts`                                            | Local Express server returning canned completions; URL plugged into `provisionTenantModel({ endpointUrl })` |
| Studio Playwright             | `apps/studio/e2e/helpers/auth.ts` (`loginViaDevApi`), real MongoDB at `TEST_MONGODB_URI`                       | Used only by E2E-7                                                                                          |

### New Test Fixtures Required

| Fixture                                   | Purpose                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `createPrompt({ httpClient, projectId })` | POST helper that returns `{ promptId, initialVersionId }`                                       |
| `createPromptVersion(...)`                | POST helper that creates a draft version                                                        |
| `promoteVersion(...)`                     | POST helper that promotes draft → active                                                        |
| `archiveVersion(...)`                     | POST helper that archives a version                                                             |
| `seedAgentReferencingPrompt(...)`         | Imports a minimal agent DSL bundle and PATCHes its working copy to set `libraryRef`             |
| `mockLLMServer({ responses })`            | Spawns a local HTTP server returning per-tenant-model canned completions; returns `endpointUrl` |

These helpers live in `apps/runtime/src/__tests__/helpers/prompt-library-helpers.ts` (new file).

### Environment Variables

| Variable                                  | Used by                                | Notes                                                |
| ----------------------------------------- | -------------------------------------- | ---------------------------------------------------- |
| `TEST_MONGODB_URI`                        | Studio Playwright (`apps/studio/e2e/`) | Default `mongodb://localhost:27017/abl-studio-test`  |
| `PROMPT_LIBRARY_TEST_TIMEOUT_MS`          | Test endpoint                          | Default 60000; set to 5000 in tests for fast failure |
| `PROMPT_LIBRARY_TEST_MAX_PARALLEL`        | Test endpoint                          | Default 5; tested at exactly the boundary in INT-6   |
| `PROMPT_LIBRARY_TEMPLATE_MAX_BYTES`       | Validators                             | Default 32768; INT-6 boundary tests                  |
| `PROMPT_LIBRARY_VARIABLE_VALUE_MAX_BYTES` | Validators                             | Default 4096                                         |
| `PROMPT_LIBRARY_MAX_VERSIONS_PER_PROMPT`  | Service                                | Default 200                                          |

### CI Configuration

- E2E + integration scenarios run in `pnpm test:report --filter=runtime` (Vitest forked pool).
- Compiler integration `INT-8` runs in `pnpm test:report --filter=compiler`.
- Studio Playwright E2E-7 runs in `pnpm test:e2e --filter=studio` (requires real MongoDB; gated by `TEST_MONGODB_URI` env var).
- Perf bench (§7) is excluded from PR CI — run on demand or in nightly.

---

## 9. Production Wiring Verification

> Required at every release. These checks confirm the feature is reachable in deployed builds, not just in tests. Distinct from E2E.

| ID       | Check                                                                                                                                                                          | Verification                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| WIRING-1 | `apps/runtime/src/server.ts` mounts `apps/runtime/src/routes/prompt-library.ts` under `/api/projects/:projectId/prompt-library`                                                | `rg "prompt-library" apps/runtime/src/server.ts` returns the import + `app.use(...)` line; smoke E2E hits route returns 200 |
| WIRING-2 | `apps/studio/src/config/navigation.ts` `resourceNavDefs` contains the prompt-library entry; sidebar renders it                                                                 | `rg "prompt-library" apps/studio/src/config/navigation.ts`; visual smoke in E2E-7 step 1                                    |
| WIRING-3 | `PERMISSION_REGISTRY` in `packages/shared-auth/src/rbac/role-permissions.ts` lists all 6 `prompt:*` permissions and they appear in `developer` / `tester` / `viewer` role maps | `rg "prompt:" packages/shared-auth/src/rbac/role-permissions.ts`; UT-6 covers role assignments                              |
| WIRING-4 | The IdentityEditor change is reachable from the agent editor route (Studio build surface)                                                                                      | Storybook snapshot present + E2E-7 step 5 reaches it                                                                        |
| WIRING-5 | Runtime route registers audit emitter wiring                                                                                                                                   | `rg "prompt.created" apps/runtime/src/routes/prompt-library.ts` returns the emit call; INT-7 covers behaviour               |
| WIRING-6 | Studio API proxy routes exist for every runtime endpoint                                                                                                                       | `find apps/studio/src/app/api/projects -path '*prompt-library*'` enumerates the proxies; INT-12 covers behaviour            |

---

## 10. Test File Mapping

| Test File                                                                                | Type        | Covers                                              |
| ---------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------- |
| `apps/runtime/src/__tests__/prompt-library-flow.e2e.test.ts`                             | e2e         | E2E-1                                               |
| `apps/runtime/src/__tests__/prompt-library-compare.e2e.test.ts`                          | e2e         | E2E-2, E2E-3, E2E-4                                 |
| `apps/runtime/src/__tests__/prompt-library-isolation.e2e.test.ts`                        | e2e         | E2E-5                                               |
| `apps/runtime/src/__tests__/prompt-library-rbac.e2e.test.ts`                             | e2e         | E2E-6                                               |
| `apps/studio/e2e/prompt-library/full-flow.spec.ts`                                       | e2e         | E2E-7                                               |
| `apps/runtime/src/services/prompt-library/__tests__/prompt-library-service.test.ts`      | integration | INT-1, INT-4, INT-6                                 |
| `apps/runtime/src/services/prompt-library/__tests__/usage-count-denormalization.test.ts` | integration | INT-3                                               |
| `apps/runtime/src/services/prompt-library/__tests__/prompt-library-test-service.test.ts` | integration | INT-5, INT-10                                       |
| `apps/runtime/src/services/prompt-library/__tests__/audit-emission.test.ts`              | integration | INT-7                                               |
| `apps/runtime/src/services/agent-compile/__tests__/library-ref-resolution.test.ts`       | integration | INT-8                                               |
| `apps/runtime/src/services/execution/__tests__/build-system-prompt-library-ref.test.ts`  | integration | INT-9                                               |
| `apps/runtime/src/routes/__tests__/prompt-library-references.test.ts`                    | integration | INT-11                                              |
| `apps/studio/src/app/api/projects/[id]/prompt-library/__tests__/proxy.test.ts`           | integration | INT-12                                              |
| `packages/database/src/__tests__/model-prompt-library-item.test.ts`                      | unit        | UT-1                                                |
| `packages/database/src/__tests__/model-prompt-library-version.test.ts`                   | unit        | UT-2, INT-2 (sourceHash determinism)                |
| `apps/runtime/src/services/prompt-library/__tests__/lifecycle.test.ts`                   | unit        | UT-3                                                |
| `apps/runtime/src/services/prompt-library/__tests__/extract-variables.test.ts`           | unit        | UT-4                                                |
| `packages/compiler/src/__tests__/system-prompt-config-types.test.ts`                     | unit (type) | UT-5                                                |
| `packages/shared-auth/src/__tests__/role-permissions-prompt-library.test.ts`             | unit        | UT-6                                                |
| `apps/runtime/src/services/prompt-library/__tests__/validators.test.ts`                  | unit        | UT-7                                                |
| `apps/runtime/src/services/prompt-library/__tests__/sanitize-variable-value.test.ts`     | unit        | UT-8                                                |
| `apps/runtime/src/__tests__/helpers/prompt-library-helpers.ts`                           | helper      | shared fixtures (createPrompt, mockLLMServer, etc.) |
| `apps/runtime/src/__tests__/prompt-library.perf.test.ts`                                 | perf        | §7 perf bench                                       |

---

## 11. Open Testing Questions

1. **Reverse-reference index strategy** — INT-11 verifies correctness against ~3 agents. Once GAP-003 is resolved (denormalised index for projects with >1000 agents), do we need a perf regression test that gates the index choice? Defer to LLD.
2. **Streaming responses in compare mode** — feature spec §15 open question 4. If streaming is added in v2, this test spec needs new scenarios; for now, bulk responses only.
3. **Idempotency-Key header** — feature spec mentions optional `Idempotency-Key` on create endpoints. Should this get its own scenario, or is the existing platform-wide idempotency suite sufficient? Likely the latter — confirm during LLD.
4. **Cost estimation** — if added in v1.5, will need new pane assertions for `estimatedCostUsd`. Out of scope for v1 test spec.
5. **Per-pane timeout granularity** — INT-10 covers 1-of-5 fail; should we also cover the case where pane #3 takes longer than `PROMPT_LIBRARY_TEST_TIMEOUT_MS` (timeout, not error)? Add to INT-10 step 5 during implementation.

---

## 12. Known Gaps Tracking

Mirrors feature spec §16 — tests are not required for non-goals (multi-turn, scoring, A/B, marketplace).

| Gap     | Test plan                                                                                                                                      |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| GAP-001 | No multi-turn — tests only single-turn; multi-turn is `agent-testing-evals` territory                                                          |
| GAP-002 | No scoring — tests assert structural shape, not output quality                                                                                 |
| GAP-003 | Reverse-reference perf — §7 includes the 1000-agent benchmark; if it regresses, INT-11 retains correctness coverage during the index migration |
| GAP-004 | No DSL surface — no DSL parser tests; covered by UT-5 type test only                                                                           |
| GAP-005 | LLM-level prompt injection in template content — out of scope; INT-5 covers only the variable-value delimiter strip                            |
| GAP-006 | No "restore archived to draft" — no test                                                                                                       |
| GAP-007 | No A/B traffic split — no test                                                                                                                 |

---

## 13. References

- Feature spec: [`../features/prompt-library.md`](../features/prompt-library.md)
- HLD: `../specs/prompt-library.hld.md`
- LLD: `../plans/2026-04-27-prompt-library-impl-plan.md`
- SDLC log: `../sdlc-logs/prompt-library/test-spec.log.md`
- Test architecture rules: `CLAUDE.md` "Test Architecture" + "E2E Test Standards" sections
- Canonical patterns referenced:
  - `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts` (E2E harness)
  - `apps/runtime/src/__tests__/helpers/channel-e2e-bootstrap.ts` (auth + tenant model)
  - `apps/runtime/src/services/version-service.ts:618-631` (atomic promote pattern)
  - `apps/runtime/src/__tests__/mongo-audit-store.test.ts:28-46` (audit-query pattern)
  - `apps/runtime/src/__tests__/profile-integration.test.ts:311-378` (in-process `buildSystemPrompt` test)
  - `apps/studio/e2e/helpers/auth.ts` (Studio Playwright auth)
