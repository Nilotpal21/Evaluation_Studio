# Cross-Phase Consistency Audit: Batch 1

**Modules**: auth-profiles, model-hub, oauth-tooling
**Auditor**: phase-auditor
**Date**: 2026-03-25
**Scope**: All SDLC artifacts (feature spec, test spec, HLD, LLD) per module, verified against actual codebase

---

## Module: auth-profiles

### Status: STABLE

### Spec Issues

**[CRITICAL] SP-AP-1: E2E test files referenced in specs DO NOT EXIST**

The feature spec (Section 10), test spec (Existing Test Inventory), and LLD (Phase 3) all reference 3 E2E test files:

- `apps/runtime/src/__tests__/e2e/auth-profile-connector-setup.test.ts`
- `apps/runtime/src/__tests__/e2e/auth-profile-oauth-flow.test.ts`
- `apps/runtime/src/__tests__/e2e/auth-profile-token-refresh.test.ts`

**Codebase verification**: The directory `apps/runtime/src/__tests__/e2e/` does not exist at all. There is no `e2e` subdirectory under `apps/runtime/src/__tests__/`. All 3 files are phantom references.

The test spec marks these as "EXISTS (UNVERIFIED)" but they do not exist. The feature spec lists them in its test inventory as verified. This is a cross-phase factual error across all 3 documents.

**Fix**: Remove the 3 phantom E2E file references from all specs. The test spec should instead note that zero E2E tests exist and document this as a CRITICAL gap. The LLD Phase 3 (E2E Test Verification and Fix) needs to be rewritten to "create E2E tests" not "verify existing E2E tests run."

---

**[HIGH] SP-AP-2: LLD Phase 1 partially completed but not tracked**

The LLD lists Phase 1 tasks to create `apply-auth.test.ts`, `dual-read.test.ts`, and `redact.test.ts`. Codebase check shows:

- `packages/shared/src/__tests__/auth-profile/apply-auth.test.ts` -- EXISTS (plus phase2 and phase3 variants)
- `packages/shared/src/__tests__/auth-profile/dual-read.test.ts` -- EXISTS
- `packages/shared/src/__tests__/auth-profile/redact.test.ts` -- DOES NOT EXIST

The LLD exit criteria checkboxes are all unchecked (`[ ]`), even though 2 of 3 Phase 1 deliverables have been implemented. The `redact.test.ts` is still genuinely missing.

**Fix**: Check the Phase 1 exit criteria boxes for apply-auth and dual-read. Leave redact unchecked. Update the "Phase 1: Critical Test Gap Closure" section to reflect partial completion.

---

**[HIGH] SP-AP-3: LLD Phase 2 test files not tracked**

The LLD Phase 2 lists creation of `feature-flag.test.ts`, `apply-signing.test.ts`, `verify-webhook.test.ts`, `apply-proxy.test.ts`. None of these files exist in the codebase. All exit criteria checkboxes remain unchecked.

**Fix**: Either implement Phase 2 tests or document them as deferred with rationale.

---

**[HIGH] SP-AP-4: Test spec lists 13 "missing test files" from prior docs without resolution**

The test spec identifies 13 test files that were referenced in prior documentation but do not exist. The test spec correctly flags them but offers no resolution status. The LLD Phase 4 references 7 missing source files but does not address the 13 missing test files.

**Fix**: Each of the 13 missing test files should be classified as (a) needs creation, (b) covered by another test, or (c) no longer relevant. Currently they are in documentation limbo.

---

**[MEDIUM] SP-AP-5: HLD references `credential-age-monitor.ts` evidence without test coverage**

The HLD (Section 3.11) references `apps/runtime/src/services/credential-age-monitor.ts` as evidence for monitoring. Neither the test spec nor the LLD address testing this component.

**Fix**: Add credential-age-monitor to the test gap inventory in the test spec.

---

### Testing Issues

**[CRITICAL] TS-AP-1: Zero verified E2E tests for a STABLE feature**

For a feature marked STABLE, having zero actual E2E tests is a critical gap. The test spec defines 7 E2E scenarios (E2E-1 through E2E-7) and 7 integration scenarios (INT-1 through INT-7), but:

- E2E: Zero test files exist (the 3 referenced files are phantoms)
- Integration: Only 1 actual integration test exists (`auth-profile-integration.test.ts` in database package)

The test spec's coverage matrix shows "E2E" column as mostly empty or "UNVERIFIED" -- it should be corrected to "MISSING."

**Fix**: The STABLE status is questionable without E2E coverage. Either create E2E tests or downgrade to BETA with an explicit note that E2E testing gates promotion to STABLE.

---

**[HIGH] TS-AP-2: Test spec FR-5 (Secret redaction) shows GAP with no test file**

The coverage matrix shows FR-5 (Secret redaction) as "GAP" with "NO dedicated test." The LLD Phase 1.3 planned `redact.test.ts` but it was never created. This is a security-critical path -- leaking encrypted secrets in API responses.

**Fix**: Create `packages/shared/src/__tests__/auth-profile/redact.test.ts` as specified in LLD Phase 1.3.

---

**[HIGH] TS-AP-3: Multiple test files categorized as "unit" use vi.mock extensively**

The test spec categorizes many files as "unit" tests, but per CLAUDE.md E2E standards, the distinction matters. For example, `apps/studio/src/__tests__/auth-profiles/auth-profile-api.test.ts` is listed as "unit" but tests API behavior. This is not an E2E violation (these are not E2E tests), but the test spec should be clear about which tests use mocks vs real infrastructure.

**Fix**: Add a column to the test inventory indicating mock usage per test file for clarity.

---

### LLD Gaps

**[HIGH] LLD-AP-1: All wiring checklist items marked "YES" but LLD is a gap-closure plan**

The LLD wiring checklist (Section 3) has all 21 items marked "YES" as verified. But this is misleading -- the LLD describes gap closure work (creating tests, investigating missing files). The wiring checklist reflects the existing implementation, not the gap closure work. There should be a separate checklist for the LLD's own deliverables.

**Fix**: Add a "Gap Closure Deliverables" checklist with items for each Phase's exit criteria, separate from the existing wiring checklist.

---

**[MEDIUM] LLD-AP-2: Phase 4 (Missing Source File Investigation) has no exit criteria checkboxes**

Phase 4 describes investigating 7 missing source files but provides no checkable exit criteria. The format is inconsistent with Phases 1-3.

**Fix**: Add exit criteria checkboxes for Phase 4.

---

### Cross-Phase Inconsistencies

- **XP-1 Backward traceability**: Feature spec FRs trace correctly to code files. HLD references feature spec correctly. LLD references HLD and feature spec. PASS (except for phantom E2E file references).
- **XP-2 Forward compatibility**: Feature spec enables test spec. HLD enables LLD. PASS.
- **XP-3 Scope lock**: No scope creep across documents. PASS.
- **XP-4 Terminology consistency**: "Auth Profiles" used consistently. "dual-read" terminology consistent. PASS.
- **XP-5 Package agents.md**: Not checked in this audit.

---

## Module: model-hub

### Status: STABLE

### Spec Issues

**[CRITICAL] SP-MH-1: Zero E2E tests exist for a STABLE feature**

The test spec defines 7 E2E scenarios (E2E-1 through E2E-7). The LLD Phase 4 plans to create E2E test files:

- `apps/runtime/src/__tests__/e2e/model-hub-provisioning.e2e.test.ts`
- `apps/runtime/src/__tests__/e2e/model-hub-isolation.e2e.test.ts`
- `apps/runtime/src/__tests__/e2e/model-hub-overrides.e2e.test.ts`

**Codebase verification**: The `apps/runtime/src/__tests__/e2e/` directory does not exist. Zero E2E test files exist for model-hub. All LLD Phase 4 exit criteria are unchecked.

The test spec coverage matrix correctly shows "N" for E2E across all FRs, but the overall status says "STABLE" which is inconsistent with zero E2E coverage.

**Fix**: Either create E2E tests per the LLD Phase 4 plan, or downgrade status to BETA with E2E as a gating criterion for STABLE.

---

**[CRITICAL] SP-MH-2: LLD gap-closure features (Phases 1-3) do not exist in codebase**

The LLD plans 3 phases of new implementation work:

- Phase 1: LLM Policy enforcement middleware (`apps/runtime/src/middleware/llm-policy-middleware.ts`), policy routes (`apps/runtime/src/routes/llm-policy.ts`), usage routes (`apps/runtime/src/routes/llm-usage.ts`)
- Phase 2: Cache invalidation service (`apps/runtime/src/services/llm/cache-invalidation.ts`)
- Phase 3: Health check worker (`apps/runtime/src/workers/health-check-worker.ts`)

**Codebase verification**:

- `apps/runtime/src/middleware/llm-policy-middleware.ts` -- DOES NOT EXIST
- `apps/runtime/src/routes/llm-policy.ts` -- DOES NOT EXIST (but `tenant-llm-policy.ts` exists with GET/PUT for basic CRUD)
- `apps/runtime/src/routes/llm-usage.ts` -- DOES NOT EXIST
- `apps/runtime/src/services/llm/cache-invalidation.ts` -- DOES NOT EXIST
- `apps/runtime/src/workers/health-check-worker.ts` -- DOES NOT EXIST

The tenant-llm-policy route exists but only provides basic CRUD -- not the enforcement middleware the LLD plans in Phase 1. All LLD Phase 1-3 exit criteria are unchecked.

This is not an error per se (the LLD is a plan), but the HLD and feature spec both describe these capabilities as if they exist or are near-complete. For example:

- Feature spec FR-7 says "The system must enforce tenant-level LLM policies including allowed provider lists, credential policies, monthly/daily token budgets, rate limits"
- HLD Section 4.4 says "Rate limiting: All model hub routes use `tenantRateLimit('request')` -- per-tenant rate limiting" and mentions policy enforcement as a gap
- The test spec marks FR-7 as "Not Tested"

**Fix**: The feature spec FR-7 should be marked as "Schema exists, enforcement not yet implemented" rather than implying it works. The HLD correctly identifies this as a gap (GAP-005). The LLD correctly plans the implementation. The disconnect is that the feature spec reads as if enforcement exists.

---

**[HIGH] SP-MH-3: Test spec integration tests use heavy mocking -- not true integration tests**

The test spec maps 17 test files to the coverage matrix. Codebase verification shows several of these heavily use `vi.mock`:

- `tenant-models.test.ts` -- mocks `llm-resolution-repo`
- `model-resolution-comprehensive.test.ts` -- mocks `llm-resolution-repo`, `@agent-platform/database/models`, `config/index`
- `llm-wiring.test.ts` -- mocks 20+ modules including `session-llm-client`, `model-resolution`, `secrets-provider`, `database/models`, `tool-oauth-service-singleton`, etc.
- `llm-services.test.ts` -- mocks `llm-resolution-repo`

The test spec categorizes these as "integration" tests, but they mock the very components they should be integrating with. Per CLAUDE.md, only external third-party services may be mocked via dependency injection. These files mock core codebase components.

Notable exception: `model-catalog.test.ts` and `llm-integration.test.ts` do NOT use vi.mock, making them genuine integration tests.

**Fix**: Reclassify the mock-heavy tests as "unit" tests in the test spec coverage matrix. This will reveal the true integration coverage gap. In particular, `llm-wiring.test.ts` with 20+ mocks should not count as integration coverage for FR-10.

---

**[HIGH] SP-MH-4: HLD references new API endpoints that don't exist yet**

The HLD Section 6 "New endpoints for gap closure" lists:

- `POST /api/tenants/:tenantId/models/:id/health-check`
- `GET /api/tenants/:tenantId/llm-policy`
- `PUT /api/tenants/:tenantId/llm-policy`
- `GET /api/tenants/:tenantId/llm-usage/summary`

**Codebase verification**:

- Health check trigger endpoint: DOES NOT EXIST
- LLM policy GET/PUT: EXISTS (via `tenant-llm-policy.ts`)
- Usage summary: DOES NOT EXIST

The HLD should clearly mark which endpoints exist today vs which are planned for gap closure.

**Fix**: Add an "Exists" column to the API endpoint tables in the HLD, distinguishing implemented from planned.

---

**[MEDIUM] SP-MH-5: Feature spec auth-profile integration status is "Reserved, not wired"**

The integration matrix says Auth Profiles relationship is "Reserved, not wired" with key touchpoint `tenant_models.connections[].authProfileId`. However, the `tenant_models` data model actually has `authProfileId` in the connection subdocument schema, and `model_configs` has `authProfileId: string | null` marked as "reserved -- not yet wired."

This is correctly documented but creates a disconnect with auth-profiles feature spec which says "Active integration" for models. The auth-profiles spec should say "Reserved" for model-hub integration, not "Active."

**Fix**: Verify both feature specs agree on the wiring status of auth-profiles <-> model-hub integration.

---

### Testing Issues

**[CRITICAL] TS-MH-1: Coverage matrix shows no E2E tests for any FR**

All 10 FRs show "N" in the E2E column. For a STABLE feature, this violates the SDLC pipeline minimum of 5 E2E scenarios per feature (from `docs/sdlc/pipeline.md`).

**Fix**: Implement E2E tests per the test spec's 7 E2E scenarios and LLD Phase 4.

---

**[HIGH] TS-MH-2: FR-7 (Policy enforcement) has zero test coverage of any kind**

The coverage matrix shows "N" across all test types for FR-7. The security and isolation section shows "Tenant LLM policy enforcement blocks disallowed providers (GAP-005: not yet implemented)."

**Fix**: Since enforcement is not implemented, this is consistent. But the feature spec FR-7 should acknowledge the implementation gap.

---

**[MEDIUM] TS-MH-3: No browser E2E tests for Studio UI components**

The feature spec references Studio UI components:

- `ModelConfigTab.tsx`
- `AgentModelTab.tsx`
- `ModelResolutionInspector.tsx`

The test spec has `model-management.test.tsx` for Studio but it is categorized as "unit/UI" -- no browser E2E. The feature has STABLE status but no browser-level verification.

**Fix**: Add at least 1 browser E2E scenario for Studio model management (provisioning + configuration flow).

---

### LLD Gaps

**[HIGH] LLD-MH-1: All LLD phase exit criteria are unchecked**

All Phase 1, 2, 3, and 4 exit criteria checkboxes are `[ ]` (unchecked). The wiring checklist (Section 4) also has all items unchecked. The acceptance criteria (Section 6) are all unchecked.

This indicates the LLD is purely a plan with zero implementation progress. The feature spec and HLD say STABLE, but the LLD reveals significant planned work that hasn't started.

**Fix**: Either implement the planned work, or reconcile the STABLE status with the fact that GAP-005 (policy enforcement), GAP-007 (health check automation), and GAP-011 (cache invalidation) are unresolved.

---

**[MEDIUM] LLD-MH-2: LLD Open Question 5 about E2E provider mocking is unresolved**

The LLD asks: "Should E2E tests use a real LLM provider for the execution step, or mock only the final HTTP call to the provider while testing the full resolution chain?" This is critical because the E2E test scenarios (E2E-1, E2E-4, E2E-5) involve "Execute agent session" steps that require LLM calls.

**Fix**: Resolve this before implementing E2E tests. Recommended approach: mock only the external LLM provider HTTP endpoint (a test HTTP server returning canned responses), while exercising the full resolution chain, credential decryption, and middleware stack.

---

### Cross-Phase Inconsistencies

- **XP-1 Backward traceability**: FRs trace to code files with source references. PASS.
- **XP-2 Forward compatibility**: Feature spec enables test spec and HLD. HLD enables LLD. PASS.
- **XP-3 Scope lock**: HLD introduces "new endpoints for gap closure" beyond the original feature spec scope. The feature spec FR-7 implies enforcement exists but HLD/LLD reveal it doesn't. PARTIAL FAIL -- the feature spec overpromises relative to implementation.
- **XP-4 Terminology consistency**: "Model Hub", "5-level resolution chain", "tenant model" used consistently. PASS.
- **XP-5 Package agents.md**: Not checked in this audit.

---

## Module: oauth-tooling

### Status: PLANNED

### Spec Issues

**[CRITICAL] SP-OT-1: Two separate LLD files exist with contradictory designs**

Two LLD files exist for oauth-tooling:

1. `docs/plans/2026-03-23-oauth-tooling-impl-plan.md` -- 5-phase plan focused on Auth Profile integration, Studio UI, consent flow, token health, connector migration
2. `docs/plans/oauth-tooling.lld.md` -- Task-based design focused on ToolOAuthService internals, state stores, MongoDB token store, REST routes, JIT flow

These two documents describe fundamentally different architectures:

- The impl-plan routes Studio OAuth through `POST /api/oauth/tool-auth/initiate` and `GET /api/oauth/tool-auth/callback` (new Studio Next.js routes)
- The older LLD routes through `POST /api/v1/oauth/authorize/:provider` and `GET /api/v1/oauth/callback/:provider` (existing runtime Express routes)

The impl-plan focuses on Auth Profile as the single source of truth; the older LLD maintains `EndUserOAuthToken` as the primary token store with Auth Profile as an optional resolver.

The impl-plan's Phase 5 (connector migration) plans to eliminate `connector-oauth.ts` in-memory state; the older LLD doesn't address connector OAuth at all.

**Fix**: Consolidate into a single authoritative LLD. The older `oauth-tooling.lld.md` appears to document the existing ToolOAuthService implementation, while `2026-03-23-oauth-tooling-impl-plan.md` is the forward-looking plan. The older LLD should be archived or clearly marked as "existing implementation reference" to avoid confusion.

---

**[CRITICAL] SP-OT-2: LLD impl-plan references Studio components and routes that don't exist**

The implementation plan (2026-03-23) references these new files to create:

- `apps/studio/src/components/tools/OAuthConfigPanel.tsx` -- DOES NOT EXIST
- `apps/studio/src/components/tools/AuthProfileSelector.tsx` -- DOES NOT EXIST
- `apps/studio/src/components/tools/OAuthScopeEditor.tsx` -- DOES NOT EXIST
- `apps/studio/src/components/tools/ConnectAccountButton.tsx` -- DOES NOT EXIST
- `apps/studio/src/components/tools/TokenStatusBadge.tsx` -- DOES NOT EXIST
- `apps/studio/src/app/api/oauth/tool-auth/route.ts` -- DOES NOT EXIST
- `apps/studio/src/app/api/oauth/tool-auth/callback/route.ts` -- DOES NOT EXIST
- `apps/studio/src/lib/oauth-state-store.ts` -- DOES NOT EXIST
- `packages/shared/src/services/auth-profile/token-health.ts` -- DOES NOT EXIST
- `apps/studio/src/services/migration/connector-oauth-migration.ts` -- DOES NOT EXIST

This is expected for a PLANNED feature. However, the LLD also references existing files to modify:

- `packages/shared/src/validation/project-tool-schemas.ts` -- EXISTS but does NOT have `authProfileId` field
- `packages/database/src/models/project-tool.model.ts` -- EXISTS but does NOT have `authProfileId` field
- `packages/database/src/models/connector-connection.model.ts` -- EXISTS and DOES have `authProfileId` field

The LLD Phase 5 claims `ConnectorConnection` needs a new `authProfileId` field, but this field already exists in the codebase. The LLD should note this.

**Fix**: Update LLD Phase 5.1 to note that `authProfileId` already exists on `ConnectorConnection`. Only `ProjectTool` needs the new field.

---

**[HIGH] SP-OT-3: Feature spec claims `connector-oauth.ts` uses in-memory state -- CONFIRMED**

The feature spec problem statement claims `connector-oauth.ts` uses in-memory state (`pendingStates`). Codebase verification confirms this: `apps/studio/src/lib/connector-oauth.ts` uses `const pendingStates = new Map<string, PendingOAuthState>()` with LRU eviction at 100 entries. This is a genuine stateless-distributed violation for multi-pod Studio deployments.

The runtime `ToolOAuthService` has both `InMemoryOAuthStateStore` and `RedisOAuthStateStore` -- the Redis variant exists and is production-ready (`apps/runtime/src/services/oauth-state-store-factory.ts`). The connector OAuth in Studio does not use it.

**Status**: Problem correctly identified. Fix is in LLD Phase 5.

---

**[HIGH] SP-OT-4: Test spec E2E scenarios mix Studio and Runtime API paths inconsistently**

The test spec E2E scenarios reference different API paths:

- E2E-2 step 3: `POST /api/v1/oauth/authorize/:provider` (runtime route -- EXISTS at `apps/runtime/src/routes/oauth.ts`)
- E2E-3 step 5: `GET /api/v1/oauth/callback?code=test_code&state=<state>` (runtime route -- EXISTS)
- HLD Section 2.2: `POST /api/oauth/tool-auth/initiate` (Studio route -- DOES NOT EXIST)
- HLD Section 2.2: `GET /api/oauth/tool-auth/callback` (Studio route -- DOES NOT EXIST)

The test spec scenarios use the existing runtime OAuth routes, but the HLD and LLD design new Studio-side routes. These are different systems:

- Runtime routes: Express at `apps/runtime/src/routes/oauth.ts`, handle ToolOAuthService flows
- Studio routes: Next.js at `apps/studio/src/app/api/oauth/tool-auth/`, planned for Auth Profile-based flows

The E2E scenarios should test the new Studio routes (per the HLD design), not the existing runtime routes.

**Fix**: Update E2E-2 and E2E-3 to use the planned Studio OAuth routes (`/api/oauth/tool-auth/initiate` and `/api/oauth/tool-auth/callback`), not the existing runtime routes (`/api/v1/oauth/authorize/:provider`). Or explicitly document which scenarios test existing vs new routes.

---

**[HIGH] SP-OT-5: HLD does not address the existing `oauth-tooling.lld.md` ToolOAuthService architecture**

The HLD's system context diagram shows Studio API -> Auth Profile Service -> MongoDB as the primary flow. But the existing `ToolOAuthService` (`apps/runtime/src/services/tool-oauth-service.ts`, ~550 LOC) is a full OAuth service in the runtime with its own token store, state stores, JIT flow, and auth profile resolver integration.

The HLD does not clearly address: Is the new Studio-based flow replacing the runtime `ToolOAuthService`, or do both coexist? The older LLD (`oauth-tooling.lld.md`) documents `ToolOAuthService` in detail. The feature spec's FR-8 says "Runtime tool execution MUST resolve OAuth credentials via Auth Profile chain" which suggests the runtime path changes.

**Fix**: Add a section to the HLD explicitly documenting the relationship between the new Studio OAuth flow and the existing runtime `ToolOAuthService`. Clarify the migration path: does `ToolOAuthService` become a consumer of Auth Profiles, or is it being replaced?

---

**[MEDIUM] SP-OT-6: Feature spec US-5 (Runtime consent flow) is deferred but test spec has no mention**

The feature spec marks US-5 (End-User Connects OAuth Account at Runtime) as "Deferred." However, the older LLD (`oauth-tooling.lld.md`) Task T-5 fully designs the JIT OAuth flow, and the runtime implementation includes JIT metadata handling.

The test spec has no scenarios for the JIT flow (consistent with deferral), but doesn't mention the deferral explicitly. This could lead to confusion about whether JIT should be tested.

**Fix**: Add a note to the test spec's "Out of Scope" or "Known Gaps" section explicitly stating US-5 JIT flow is deferred per the feature spec.

---

### Testing Issues

**[CRITICAL] TS-OT-1: Zero test files exist for any E2E or integration scenario**

All test scenarios in the test spec are status "Planned." Since the feature is PLANNED, this is expected. But note:

- 10 E2E scenarios defined
- 7 integration scenarios defined
- 22 unit test scenarios defined
- Zero actual test files exist

This is consistent with the PLANNED status. No action needed until implementation begins.

---

**[HIGH] TS-OT-2: E2E-3 mocks external IdP -- correct approach but needs test infrastructure**

E2E-3 step 4 says "Mock external IdP token endpoint (test-only HTTP server returning valid token response)." This is the correct approach (mock only external third-party, not codebase components). The test infrastructure section correctly specifies "Lightweight Express server on random port returning configurable token responses."

**Status**: Design is correct. Implementation needs to follow this pattern.

---

**[MEDIUM] TS-OT-3: No browser E2E scenarios for Studio OAuth UI**

The feature has significant Studio UI: OAuthConfigPanel, AuthProfileSelector, ConnectAccountButton, TokenStatusBadge, OAuthScopeEditor. The test spec has unit tests for UI components (UT-18 through UT-22) but no browser E2E scenarios testing the full popup-based OAuth consent flow.

**Fix**: Add at least 1 browser E2E scenario: "User configures OAuth tool in Studio, clicks Connect Account, completes popup flow, sees Connected status."

---

### LLD Gaps

**[CRITICAL] LLD-OT-1: Two LLDs with different architectures -- which is authoritative?**

See SP-OT-1. The `oauth-tooling.lld.md` documents existing ToolOAuthService internals. The `2026-03-23-oauth-tooling-impl-plan.md` plans the Auth Profile integration. They don't reference each other.

**Fix**: The 2026-03-23 impl-plan should reference the older LLD as "existing implementation that this plan extends/migrates from." The older LLD should link to the new plan.

---

**[HIGH] LLD-OT-2: Impl-plan Phase 1 assumes `authProfileId` not on ProjectTool but doesn't verify**

Phase 1.2 says "Add fields to the Mongoose schema: `authProfileId: { type: String, default: null, index: true }`" for `project-tool.model.ts`. Codebase verification confirms `authProfileId` does NOT exist on `ProjectTool`, so this is correct. But Phase 5.1 says the same for `ConnectorConnection`, where `authProfileId` ALREADY EXISTS. The LLD should verify what exists before planning changes.

**Fix**: Phase 5.1 should note that `authProfileId` already exists on `ConnectorConnection` and skip that step.

---

**[HIGH] LLD-OT-3: Impl-plan does not address the older LLD's JIT flow**

The older LLD (Task T-5) designs a full JIT OAuth flow with in-memory metadata store, popup rendering, and CAS rollback. The impl-plan does not mention JIT at all. The feature spec defers US-5 (runtime consent), but the JIT flow already exists in `tool-oauth-service.ts`.

**Fix**: The impl-plan should acknowledge the existing JIT flow and explicitly state whether it is preserved, deprecated, or migrated to Auth Profiles in a future phase.

---

**[HIGH] LLD-OT-4: Impl-plan wiring checklist items all unchecked -- expected for PLANNED**

All 12 wiring checklist items and all phase exit criteria are unchecked. This is expected since the feature is PLANNED. No action needed until implementation begins.

---

**[MEDIUM] LLD-OT-5: Impl-plan Phase 3 Redis dependency for Studio not verified**

Phase 3 requires Redis for OAuth state storage in Studio. The risk assessment notes "Studio Redis client not available" as medium severity. The impl-plan says "Phase 3 prerequisite: verify Studio has Redis access; add if missing."

**Fix**: Verify whether Studio has Redis access before starting Phase 3. If not, this is a blocking dependency that should be escalated.

---

### Cross-Phase Inconsistencies

- **XP-1 Backward traceability**: Feature spec FRs are well-defined and traced in test spec. HLD references feature spec. Impl-plan references HLD. PASS, except the older LLD doesn't reference the feature spec.
- **XP-2 Forward compatibility**: Feature spec enables test spec and HLD. HLD enables LLD. PASS.
- **XP-3 Scope lock**: The older LLD introduces JIT flow (T-5) which is explicitly deferred in the feature spec. The impl-plan correctly excludes it. PARTIAL FAIL on older LLD.
- **XP-4 Terminology consistency**: "OAuth Tooling" used consistently. But the two LLDs use different terminology: impl-plan says "Auth Profile Integration for Tools" while older LLD says "ToolOAuthService." This reflects the architectural split. PARTIAL FAIL.
- **XP-5 Package agents.md**: Not checked in this audit.

---

## Summary

| Module        | Status  | Critical Issues                 | High Issues | Medium Issues | Verdict        |
| ------------- | ------- | ------------------------------- | ----------- | ------------- | -------------- |
| auth-profiles | STABLE  | 1 (phantom E2E files)           | 4           | 2             | NEEDS_REVISION |
| model-hub     | STABLE  | 2 (no E2E, unimplemented FR-7)  | 4           | 3             | NEEDS_REVISION |
| oauth-tooling | PLANNED | 2 (dual LLD, phantom file refs) | 5           | 3             | NEEDS_REVISION |

### Top Priority Fixes (Cross-Module)

1. **The `apps/runtime/src/__tests__/e2e/` directory does not exist.** Both auth-profiles and model-hub reference E2E files in this directory. The auth-profiles specs claim 3 files "EXISTS (UNVERIFIED)" when they are phantoms. All E2E file references to this directory across all specs should be corrected to reflect reality.

2. **STABLE status without E2E tests.** Both auth-profiles and model-hub claim STABLE status but have zero E2E tests. This violates the SDLC pipeline minimum of 5 E2E scenarios per feature. Either create E2E tests or downgrade to BETA.

3. **oauth-tooling has two conflicting LLDs.** The older `oauth-tooling.lld.md` and the newer `2026-03-23-oauth-tooling-impl-plan.md` describe different architectures without cross-referencing. These must be consolidated or the older one archived.

4. **model-hub FR-7 (policy enforcement) reads as implemented in feature spec but is not.** The feature spec, HLD, and LLD have different levels of acknowledgment of this gap. The feature spec should clearly mark FR-7 as "schema exists, enforcement not implemented."

5. **Integration tests with heavy mocking should not be counted as integration coverage.** Model-hub `llm-wiring.test.ts` mocks 20+ modules and should be reclassified as a unit test.
