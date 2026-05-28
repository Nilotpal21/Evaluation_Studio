# SDLC Log: Auth Profiles -- LLD UPDATE Oracle (Phase 1)

**Date**: 2026-05-01
**Phase**: LLD -- Oracle clarifying questions for r2 gap-closure implementation plan
**Feature**: auth-profiles (BETA, r2 gap-closure scope)
**Branch**: `fixes/AuthProfiles`
**LLD target**: `docs/plans/2026-05-01-auth-profiles-impl-plan.md` (new file)

---

## Context Consulted

- `docs/features/auth-profiles.md` (1050 lines, BETA, FR-1..FR-17, 6 normative contracts, GAP-7..GAP-26)
- `docs/specs/auth-profiles.hld.md` (947 lines, BETA, 12 concerns + error registry + contract compliance)
- `docs/testing/auth-profiles.md` (627 lines, PARTIAL, 15 E2E + 14 INT)
- `docs/plans/auth-profiles.lld.md` (337 lines, DONE, historical hardening only)
- `docs/sdlc-logs/auth-profiles/hld-update-2026-05-01.log.md` (300 lines, 12 oracle decisions)
- `docs/sdlc-logs/auth-profiles/feature-spec-update-2026-04-30.log.md`
- `docs/sdlc-logs/auth-profiles/test-spec-update-2026-04-30.log.md`
- `docs/sdlc-logs/agents.md` (cross-cutting learnings)
- `apps/runtime/src/routes/internal-tools.ts:170-177` (FR-9 wiring site)
- `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts` (confirmed EXISTS)
- `packages/shared/src/services/mcp-auth-resolver.ts` (137 lines, in-memory Map cache, 5 auth types)
- `packages/shared-auth-profile/src/apply-auth.ts` (327 lines, canonical)
- `packages/shared/src/services/auth-profile/apply-auth.ts` (327 lines, duplicate)
- `packages/database/src/models/auth-profile.model.ts` (267 lines, `profileVersion` field NOT YET ADDED)
- `packages/database/src/models/mcp-server-config.model.ts` (`envProfileId` NOT YET ADDED)
- `packages/shared/src/services/auth-profile/client-credentials-service.ts` (Redis-backed, key `auth-profile:cc-token:`)
- `packages/shared/src/services/auth-profile.service.ts` (lock prefix `auth-profile:op-lock:`)
- `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts` (state key `auth-profile:oauth-state:{tenantId}:{state}`)
- `CLAUDE.md` (invariants, commit discipline, test architecture, Studio route handler gotchas)
- `docs/plans/*.md` (naming convention: `YYYY-MM-DD-<slug>-impl-plan.md` or `YYYY-MM-DD-<slug>-plan.md`)

---

## Section A -- Implementation Strategy

| #   | Question (short)         | Classification | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Evidence                                                                                                                                                                                                        |
| --- | ------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | LLD file path convention | **DECIDED**    | **New file at `docs/plans/2026-05-01-auth-profiles-impl-plan.md`.** Do NOT replace `docs/plans/auth-profiles.lld.md`. Rationale: (a) the old LLD is marked DONE and covers historical hardening (FR-1..FR-8 gap closure from 2026-03-22 to 2026-04-03) -- its content is still valid as historical context; (b) the LLD skill canonical naming is `docs/plans/<date>-<slug>-impl-plan.md` per the SDLC pipeline table (CLAUDE.md "SDLC Pipeline -- Required Artifacts"); (c) 40+ existing plan files in `docs/plans/` follow the `YYYY-MM-DD-<slug>` convention; (d) the feature spec and HLD can be updated to reference both LLDs (old for FR-1..FR-8, new for FR-9..FR-17) with a one-line annotation. Risk: LOW -- the old LLD's cross-references from feature spec/HLD can be updated in the same commit that creates the new LLD.                                                                                                                                                                           | `docs/plans/auth-profiles.lld.md:4` ("Status: DONE"), `CLAUDE.md` SDLC table row 4: "docs/plans/<date>-<slug>-impl-plan.md", `docs/plans/` directory listing shows 40+ files using `YYYY-MM-DD-<slug>` pattern. |
| A2  | Phase order              | **DECIDED**    | **Preserve the feature spec P8 phasing (Phase 0 -> 1 -> 2-4 parallel -> 5) but decompose Phase 1 into sub-phases per FR.** Rationale: (a) the dependency chain is well-established: Phase 0 consolidation gates FR-9/FR-11/FR-15 (HLD SS2.1 "Why this gates FR-9, FR-11, FR-15"); (b) the feature spec already splits FR-11 into 3 sub-commits (2.3a/b/c) with package-level boundaries; (c) the LLD should enumerate these as LLD sub-phases (Phase 1.1 = FR-9, Phase 1.2 = FR-10, Phase 1.3a/b/c = FR-11) because each has different exit criteria and test requirements; (d) merging sub-commits into a single LLD phase would violate CLAUDE.md commit-scope guard (max 3 packages, max 40 files). The LLD phases should be: Phase 0 (0.1-0.4), Phase 1 (1.1-1.5 where 1.3 = FR-11 split into a/b/c), Phase 2 (2.1-2.2), Phase 3 (3.1-3.6), Phase 4 (4.1-4.7), Phase 5 (5.1-5.2).                                                                                                                             | Feature spec P8 lines 835-883 (phasing), HLD SS2.1 lines 159-165 ("Why this gates FR-9, FR-11, FR-15"), CLAUDE.md commit-scope guard ("Max 3 packages per commit").                                             |
| A3  | FR-15 phase grain        | **DECIDED**    | **One LLD phase (Phase 4) with 7 sub-phases (one per protocol + `ws_security` regression).** Rationale: (a) each protocol handler is independently testable and independently feature-flagged (FF-1); (b) each maps to a distinct file in `packages/shared-auth-profile/src/protocol-handlers/`; (c) the feature spec already enumerates them as P8 items 5.1-5.7 with independent effort estimates (1.5-3 days each); (d) they share the same exit criteria pattern (unit test + matrix cell + FF-1 kill-switch test) but have different external dependencies (`@aws-sdk/signature-v4` for 5.2, `@hapi/hawk` for 5.4, `kerberos` for 5.6); (e) CLAUDE.md commit discipline requires one concern per commit. However, all 7 are logically within a single "Phase 4: Runtime Protocol Handlers" section -- the sub-phase numbering keeps the outline manageable.                                                                                                                                                  | Feature spec P8 items 5.1-5.7 (lines 872-878), HLD SS2.4 protocol dispatch table (lines 312-331), FF-1 per-protocol flag pattern.                                                                               |
| A4  | Test-first vs test-after | **DECIDED**    | **Unit tests within the same phase as implementation; integration and E2E tests in Phase 5.** Rationale: (a) CLAUDE.md "Test Architecture" mandates that code must be testable without mocks -- pure function extraction naturally produces unit-testable protocol handlers in the same commit; (b) integration tests (INT-9..INT-14) and E2E tests (E2E-6..E2E-10) require multi-service infrastructure (runtime + workflow-engine + Studio + Redis + Mongo) that spans multiple packages; bundling them into each FR's commit would violate the 3-package commit limit; (c) the test spec already groups FR-17 matrix E2E and kill-switch fidelity tests into Phase 5 (P8 item 6.2); (d) precedent: the historical LLD (Phase 1-3) had implementation phases and a separate Phase 3 for E2E verification. The LLD should require each FR phase to ship with its unit tests (same commit) and document the integration/E2E tests as Phase 5 deliverables with explicit dependency on all FR phases being merged. | CLAUDE.md "Test Architecture" and "Commit Discipline" (max 3 packages), test spec SS8 file mapping (planned files), feature spec P8 item 6.2 (Phase 5: tests).                                                  |
| A5  | Sub-commit discipline    | **DECIDED**    | **LLD enumerates sub-commits for complex phases only (FR-11, FR-13, Phase 0); leaves single-FR phases to the implement skill.** Rationale: (a) FR-11 and FR-13 are the two FRs that span >3 packages (FR-11: database + shared + shared-auth-profile + runtime; FR-13: 6 sub-phases across studio + shared + shared-auth-profile); the feature spec already prescribes the split for FR-11 (2.3a/b/c at lines 850-854) and FR-13 (Phases A-F at lines 863-868); (b) simple FRs like FR-9 (1 package: runtime, effort S) or FR-10 (1 package: runtime + lint, effort XS) can be single commits -- the implement skill can determine granularity; (c) over-specifying sub-commits for trivial phases creates unnecessary LLD maintenance burden; (d) the LLD should document the commit boundaries for multi-package phases and note "implement skill determines commit granularity" for single-package phases.                                                                                                     | CLAUDE.md commit-scope guard ("Max 3 packages per commit"), feature spec P8 FR-11 sub-commit split (lines 850-854), FR-13 Phases A-F (lines 863-868).                                                           |

---

## Section B -- Technical Details

| #   | Question (short)                      | Classification | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Evidence                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Migration script ordering             | **INFERRED**   | **Scripts can run in any order; all three are independent.** Dependency analysis: (a) `mcp_server_configs` field split (script a) only touches `mcp_server_configs` collection -- it copies env-var-referencing rows from `authProfileId` to new `envProfileId` and clears `authProfileId` for those rows; it does NOT read or write `auth_profiles`; (b) `migrate-auth-aliases.ts` (script b) rewrites inline tool configs in `ToolDefinition` documents -- it does NOT touch `auth_profiles` or `mcp_server_configs`; (c) `profileVersion=1` backfill (script c) updates `auth_profiles` rows only -- it sets `profileVersion=1` where the field is null/missing; it does NOT touch tool configs or MCP configs. No script reads the output of another. However, **all three should run before Phase 1 code deploys**: (a) must run before FR-11 code that reads `envProfileId`; (b) must run before alias sunset enforcement; (c) must run before CK-1 cache keys that include `profileVersion`. The LLD should document them as Phase 0 pre-deployment steps with a "run in any order, all before Phase 1" note.                       | Feature spec SS7 r2 Technical Considerations line 192 ("Three migration scripts: (a), (b), (c)"); script (a) touches `mcp_server_configs`, script (b) touches tool configs, script (c) touches `auth_profiles` -- no cross-collection dependency. HLD SS3.8 lines 494-498 confirms all three are idempotent with dry-run+rollback. |
| B2  | `profileVersion` hook placement       | **DECIDED**    | **Inline pre-save hook in `packages/database/src/models/auth-profile.model.ts`, NOT a reusable plugin.** Rationale: (a) existing plugins (`tenantIsolationPlugin`, `encryptionPlugin`, `auditTrailPlugin`) solve cross-model concerns -- `profileVersion` is auth-profile-specific and has no reuse case outside this model; (b) the hook logic is ~5 lines (check if `config` or `encryptedSecrets` is modified, increment `profileVersion`); creating a plugin for this adds abstraction overhead for zero reuse benefit; (c) the feature spec explicitly says "mongoose pre-save hook" (line 844: "Add `auth_profiles.profileVersion` field with mongoose pre-save hook"), not "plugin"; (d) precedent: `_v` schema-version increment at `auth-profile.model.ts:192` (`_v: { type: Number, default: 1 }`) is a simple schema default, not a plugin. The hook should be placed after the plugin applications (after line 205) and before the index definitions (before line 207).                                                                                                                                                        | Feature spec P8 Phase 0.4 (line 844), `auth-profile.model.ts:192-205` (current plugin section), `auth-profile.model.ts:113` (`_v` field -- simple default, not a plugin). No other model in the codebase needs `profileVersion`.                                                                                                   |
| B3  | `signRequest` TypeScript signature    | **DECIDED**    | **Pin the signature in the LLD now.** The HLD SS2.4 (line 310) and GAP-23 resolution (line 332) are explicit enough to pin. Signature: `signRequest?: (assembled: { method: string; url: string; headers: Headers; body?: string }) => Promise<Headers>`. Rationale: (a) the HLD confirms `signRequest` is headers-only (GAP-23: "body-mutating protocols use separate code paths"); (b) the input shape must include `method`, `url`, `headers`, and optional `body` because `@aws-sdk/signature-v4` needs all four to compute the SigV4 signature, and `@hapi/hawk` needs `method`, `url`, and `headers` for MAC computation; (c) pinning now prevents FR-15 sub-phases (4.1-4.4) from independently inventing incompatible signatures; (d) the return type is `Headers` (not `Record<string, string>`) to match the existing `ApplyAuthResult.headers` convention in `apply-auth.ts`. The LLD should document this as the canonical `signRequest` type in `packages/shared-auth-profile/src/apply-auth.ts` and note that `HttpToolExecutor` invokes it after request assembly.                                                          | HLD SS2.4 lines 308-332 (protocol dispatch table + GAP-23 resolution), feature spec FR-15 line 129 ("`ApplyAuthResult` must gain an optional `signRequest` callback"), `@aws-sdk/signature-v4` API requires method/url/headers/body for signing.                                                                                   |
| B4  | Sanitizer implementation shape        | **DECIDED**    | **Single pure function `sanitizeAuthProfileError(err: unknown): SafeError` returning `{ code: string; userMessage: string }`.** Rationale: (a) the TE-1 contract is a mapping from internal error codes to user-safe messages -- this is a pure lookup table, not stateful behavior requiring a class; (b) CLAUDE.md "Test Architecture" mandates pure function tests -- a single function is trivially testable with zero mocks; (c) the HLD SS3.12 (line 557) says "maps internal error codes to user-safe messages" -- this is a map, not a class with methods; (d) the 28-code error registry in HLD SS7 already provides the mapping table; the function implements it; (e) precedent: existing sanitization helpers in the codebase (`packages/shared-kernel/src/security/sanitize.ts`) are standalone functions, not classes. The function should accept `unknown` (to handle non-Error throws), extract the error code if it's an `AuthProfileError`, and return the sanitized pair. Consumers (`tool-test-service.ts`, OAuth handlers, `resolve-tool-auth.ts`) call it at the point where errors cross the user-visible boundary. | HLD SS3.12 lines 555-559 (sanitization approach), HLD SS7 error registry (28 codes with HTTP status), TE-1 contract (feature spec line 675), CLAUDE.md "Test Architecture" (prefer pure function tests).                                                                                                                           |
| B5  | MCP CC token cache migration strategy | **ANSWERED**   | **Redis primary with Map fallback for dev only.** This is explicitly stated in the HLD and feature spec. HLD SS3.3 line 416: "Post-FR-11 it is Redis-backed (mandatory in production; optional `Map` fallback only when Redis is not configured in dev)." Feature spec SS12 line 732: identical statement. The LLD should implement: (i) check if Redis client is available; (ii) if yes, use Redis with CK-1 cache key; (iii) if no (dev/test without Redis), fall back to the existing bounded `Map` at `mcp-auth-resolver.ts:34` with the same CK-1 key structure (string key in Map instead of Redis key); (iv) log a warning on Map fallback ("Redis unavailable -- using in-memory token cache; not suitable for production"). The hot-swap (delete Map, add Redis) approach is NOT used because it would break local dev without Redis.                                                                                                                                                                                                                                                                                             | HLD SS3.3 line 416 ("mandatory in production; optional Map fallback only when Redis is not configured in dev"), feature spec SS12 line 732 (identical), `mcp-auth-resolver.ts:34-131` (current Map-based implementation).                                                                                                          |

---

## Section C -- Risk & Dependencies

| #   | Question (short)                                    | Classification | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Evidence                                                                                                                                                                                                                                                                                                                                        |
| --- | --------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Phase 0 consolidation test strategy                 | **INFERRED**   | **Parity testing via existing `apply-auth.test.ts` (17-type dispatch) run against both paths before and after consolidation.** Strategy: (a) today both files are 327 lines and byte-identical (`wc -l` confirmed identical line counts); the Phase 0 consolidation is a move + re-export, not a rewrite; (b) `packages/shared/src/__tests__/auth-profile/apply-auth.test.ts` already tests the dispatch for all 17 auth types; (c) `packages/shared-auth-profile/src/__tests__/apply-auth.test.ts` also exists and tests the same dispatch; (d) Phase 0 consolidation should: (i) verify both test suites pass pre-merge; (ii) make `packages/shared/src/services/auth-profile/apply-auth.ts` a thin re-export (`export { applyAuth } from '@agent-platform/shared-auth-profile'`); (iii) run both test suites again post-merge -- both should still pass via the re-export; (iv) any consumer importing from `packages/shared` continues to work via re-export. The risk is LOW because the files are currently identical and the operation is a move + re-export, not a behavioral change. The LLD should document "Phase 0.1 exit criteria: both `apply-auth.test.ts` suites pass; diff between old canonical and new canonical is zero behavioral changes."                                                                                                                                                                                                                                                                                                                                        | `packages/shared-auth-profile/src/apply-auth.ts` (327 lines), `packages/shared/src/services/auth-profile/apply-auth.ts` (327 lines -- confirmed identical line count), `packages/shared/src/__tests__/auth-profile/apply-auth.test.ts` (exists, unit coverage for FR-2), `packages/shared-auth-profile/src/__tests__/` (test directory exists). |
| C2  | FR-11 sub-commit deployment ordering                | **DECIDED**    | **Schema-first (2.3a), then code (2.3b), then runtime (2.3c). 2.3b MUST NOT deploy before 2.3a's migration runs.** Rationale: (a) 2.3b (MCP auth resolver rewrite) reads from `mcp_server_configs.envProfileId` -- if the field does not exist in the DB yet (migration not run), the code will read `undefined` and silently break env-var resolution for MCP servers; (b) the migration script in 2.3a is idempotent and has dry-run + rollback, so it is safe to run early; (c) 2.3c (runtime transport refresh) depends on 2.3b's Redis-backed resolver being deployed -- it adds MCP transport refresh hooks that call the new resolver API; (d) the safe ordering is: merge 2.3a -> run migration -> merge 2.3b -> merge 2.3c. All three can be merged to the same branch before the migration runs in production (the code is behind `MCP_AUTH_PROFILE_ENABLED=false` by default), but the migration MUST run before the flag is flipped to `true`. The LLD should document: "Deploy sequence: 2.3a merge + migration -> 2.3b merge -> 2.3c merge -> set `MCP_AUTH_PROFILE_ENABLED=true`."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Feature spec P8 items 2.3a/b/c (lines 850-854): 2.3a is `packages/database` only, 2.3b reads `envProfileId`, 2.3c adds transport hooks. Feature spec SS11 `MCP_AUTH_PROFILE_ENABLED` default `false -> true` (line 638). HLD SS2.5 field split table (lines 339-345).                                                                           |
| C3  | Workspace/project OAuth init lock key collision     | **DECIDED**    | **No collision possible. Lock keys are unique by design.** Analysis: (a) the init-lock key pattern is `auth-profile:oauth-init-lock:{tenantId}:{authProfileId}` (feature spec line 716, HLD SS3.6 line 464); (b) `authProfileId` is a UUID v7 (model `_id: { type: String, default: uuidv7 }` at `auth-profile.model.ts:123`) -- globally unique; (c) the lock prevents concurrent OAuth flows on the **same profile** regardless of scope -- if profile X is workspace-scoped, two workspace admins trying to OAuth the same profile X within 600s will hit the same lock (correct behavior: only one flow at a time per profile); (d) a workspace profile and a project profile cannot share the same `authProfileId` because UUIDs are unique; (e) the `name` field could collide (same name in different scopes), but the lock key uses `authProfileId` not `name`, so name collisions are irrelevant to lock collision. The op-lock for refresh (`auth-profile:op-lock:{tenantId}:{resourceId}` at `auth-profile.service.ts:132`) uses a different prefix and is also scoped to a specific profile ID. No cross-key collision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `auth-profile.model.ts:123` (`_id: uuidv7`), feature spec line 716 (init-lock key pattern), `auth-profile.service.ts:132` (op-lock prefix is different: `auth-profile:op-lock:`), HLD SS3.6 line 464 (init-lock TTL 600s).                                                                                                                      |
| C4  | Dedicated Redis test DB for matrix E2E              | **ANSWERED**   | **Yes, use `Redis SELECT` to switch to a dedicated DB index.** This is already specified in the test spec SS7 (line 554): "matrix E2E uses `Redis SELECT` to switch to a dedicated DB index (e.g., DB 2) and `FLUSHDB` only against that index; primary DB (DB 0) untouched." The test spec SS7 also lists `REDIS_TEST_DB_INDEX` as a test env var (line 544). The LLD should document: (a) use env var `REDIS_TEST_DB_INDEX` (default `2`) for the matrix E2E test runner; (b) `beforeAll` issues `SELECT <index>`; (c) `beforeEach` issues `FLUSHDB` (scoped to that DB index only); (d) `afterAll` issues `FLUSHDB` + `SELECT 0` to clean up. This avoids interfering with dev/staging Redis data during test runs. No new infrastructure is needed -- Redis supports 16 DB indexes (0-15) by default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Test spec SS7 line 554 ("Redis SELECT to switch to a dedicated DB index (e.g., DB 2)"), test spec SS7 line 544 (`REDIS_TEST_DB_INDEX` env var), Redis documentation (16 DBs by default, SELECT command).                                                                                                                                        |
| C5  | Regression test for service-token auth preservation | **INFERRED**   | **The existing `InternalServiceRequest` auth flow in `internal-tools.ts` is unchanged by FR-9 -- the regression test is an existing-path assertion within INT-9.** Strategy: (a) FR-9 injects `createAuthProfileToolMiddleware` as a **tool-level middleware** option into the `ToolBindingExecutor` constructor (feature spec FR-9 line 117: "tool-level middleware in the ToolBindingExecutor constructor options (NOT as an Express route middleware)") -- it does NOT modify the Express middleware chain; (b) the route's service-token auth (`InternalServiceRequest` type at `internal-tools.ts:20,35`) remains in the Express middleware chain, completely untouched; (c) INT-9 scenario (test spec lines 337-349) already includes step 1: "Service token authenticates workflow-engine to runtime (`InternalServiceRequest` chain)" and step 7: "Toggle `WORKFLOW_AUTH_PROFILE_ENABLED=false` -> re-run step 2 -> assert legacy unauthenticated behavior is fully restored (no Authorization header)"; (d) the kill-switch test (step 7) proves that when the flag is off, the full original behavior is restored -- including service-token auth working and no auth-profile middleware running; (e) additionally, INT-9 step 5 tests a tool with `connectionMode='per_user'` which should produce a structured error but the service-token auth should still succeed (proving the auth chain is separate from the tool-level middleware). The LLD should note: "INT-9 steps 1+7 serve as the regression test for service-token auth preservation. No separate regression test file needed." | `internal-tools.ts:20,35` (InternalServiceRequest import and usage -- Express middleware level), feature spec FR-9 line 117 ("tool-level middleware in the ToolBindingExecutor constructor options (NOT as an Express route middleware)"), test spec INT-9 steps 1+7 (lines 341, 347).                                                          |

---

## Decisions Summary

| #    | Decision                                                                                                                   | Rationale                                                                                              | Risk                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| D-A1 | New LLD at `docs/plans/2026-05-01-auth-profiles-impl-plan.md`; preserve old LLD as historical context                      | Canonical naming convention; old LLD is DONE and covers different scope (FR-1..FR-8)                   | Low                                                                                      |
| D-A2 | Preserve P8 phasing; decompose Phase 1 into sub-phases per FR; FR-11 keeps its 3 sub-commits                               | Dependency chain is well-established; aligns with commit-scope guard                                   | Low                                                                                      |
| D-A3 | One Phase 4 with 7 sub-phases for FR-15 (one per protocol)                                                                 | Independent feature flags, independent files, independent external deps                                | Low                                                                                      |
| D-A4 | Unit tests within FR phases; integration + E2E tests in Phase 5                                                            | Commit-scope guard prevents multi-package test commits; test spec already groups E2E into Phase 5      | Low -- risk of Phase 5 being delayed is mitigated by unit tests providing early coverage |
| D-A5 | Enumerate sub-commits for FR-11, FR-13, Phase 0 only; single-FR phases delegate to implement skill                         | Avoids over-specification for trivial phases; respects CLAUDE.md commit-scope guard for complex phases | Low                                                                                      |
| D-B1 | Three migration scripts are order-independent; all run before Phase 1 code                                                 | No cross-collection dependency; CK-1/FR-11/FR-16 code depends on migrations having run                 | Low                                                                                      |
| D-B2 | Inline pre-save hook in auth-profile model, not a plugin                                                                   | Auth-profile-specific concern; ~5 lines; zero reuse case                                               | Low                                                                                      |
| D-B3 | Pin `signRequest` signature now: `(assembled) => Promise<Headers>`                                                         | Prevents FR-15 sub-phases from inventing incompatible signatures; HLD + GAP-23 provide enough detail   | Low                                                                                      |
| D-B4 | Single pure function `sanitizeAuthProfileError`, not a class                                                               | TE-1 is a mapping table; pure function is trivially testable                                           | Low                                                                                      |
| D-C1 | Both `apply-auth.ts` files are byte-level identical today; Phase 0 is move + re-export; existing test suites verify parity | Verified both files are 327 lines; move + re-export has zero behavioral change                         | Low                                                                                      |
| D-C2 | Deploy ordering: 2.3a merge + migration -> 2.3b merge -> 2.3c merge -> flag flip                                           | 2.3b reads `envProfileId` which doesn't exist until 2.3a migration runs                                | Medium -- migration must be coordinated with code deployment                             |
| D-C3 | Init-lock keys cannot collide: keyed on UUID `authProfileId`, not `name`                                                   | UUID v7 is globally unique; different lock prefixes for different lock types                           | Low                                                                                      |

---

## Open Items Escalated

No items classified as AMBIGUOUS. All 15 questions were resolvable from the existing feature spec, HLD, test spec, code inspection, and CLAUDE.md invariants without user input.

---

## OQs Carried Forward to LLD (from HLD SS9)

The HLD flags 8 open questions (SS9) for the LLD. These are NOT oracle questions but are design items the LLD must address:

1. **OQ-1**: Matrix runtime budget (total duration + per-cell SLO) -- deferred from test spec perf section
2. **OQ-2**: Kerberos CI lane configuration -- separate native-dep lane or env-gated default lane
3. **OQ-3**: MCP SSE refresh reconnect timing window -- explicit assertion or post-refresh-only check
4. **OQ-5**: Personal-visibility unique index confirmation -- already implemented (4 partial indexes, `auth-profile.model.ts:248-261`)
5. **OQ-9**: Error code registry -- SATISFIED by HLD SS7 (28 codes)
6. **OQ-10**: `usageMode='user_token'` workspace disposition -- LLD must explicitly add to rejection list or document why excluded
7. **OQ-12**: `oauth4webapi` library evaluation -- deferred from HLD to LLD
8. **OQ-14**: Refresh retry policy -- 2-3 attempts with exponential backoff + jitter (design confirmed in HLD SS3.3 line 414)

The LLD should resolve OQ-1, OQ-2, OQ-3, OQ-10, and OQ-12 during generation. OQ-5 and OQ-9 are already resolved. OQ-14 is confirmed.

---

## Phase 4b -- Round 1 (lld-reviewer): Architecture Compliance

**Date**: 2026-05-01
**Reviewer**: lld-reviewer (claude-opus-4-6)
**Focus**: TI-1, centralized auth, stateless distributed, traceability, CK-1, ST-1, RP-1, no-platform-mocking, encryption+audit
**Files verified**: 19 source files, full LLD (1122 lines), HLD (700+ lines), feature spec contracts, SDLC oracle log

### VERDICT: NEEDS_REVISION

---

### CRITICAL Findings

**R1-C1: ST-1 contract specifies CSRF cookie verification but existing project OAuth callback has no CSRF cookie check -- LLD Phase 3.C must document the gap closure on BOTH branches, not just the state contract**

The existing project callback (`apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts:169-176`) verifies `tenantId`, `projectId`, and `userId` from the state payload but does NOT verify a CSRF nonce cookie. The existing initiate route (`apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts`) does NOT set a CSRF nonce cookie at all.

LLD Phase 3.C (lines 674-694) correctly specifies that the CSRF cookie should be set on initiate and verified on callback for BOTH project + workspace flows. However, the Phase 3.C task list (3.C.1-3.C.5) does not explicitly enumerate the initiate-side changes needed on the project route. Task 3.C.1 says "New routes (workspace) and existing project routes both populate ST-1 state payload" but is ambiguous about whether the project initiate route also needs modification to SET the CSRF cookie.

**Fix**: In Phase 3.C task list, add an explicit sub-task: "3.C.1b: Modify existing project initiate route (`apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts`) to generate `csrfNonce`, set it as a same-origin cookie (HttpOnly, SameSite=Lax, Secure), and include it in the state payload. This is a behavioral change to the existing route."

Also add to Phase 3.C files touched: `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts` -- it is currently listed only in "Modified Files" table (line 246) but not in the Phase 3.C files-touched section.

---

**R1-C2: Existing project callback returns 404 (not 400) on tenant/project/user mismatch -- ST-1 specifies 400**

The existing callback at `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts:169-176` returns 404 on tenant/project/user mismatch:

```typescript
if (
  stateData.tenantId !== tenantId ||
  stateData.projectId !== params.id ||
  stateData.userId !== user.id
) {
  return errorJson('OAuth state not found', 404, ErrorCode.NOT_FOUND);
}
```

The ST-1 contract (feature spec line 674) mandates: "mismatch returns 400 + audit OAUTH_FAILED reason tenant_binding_mismatch, NEVER 403." The LLD Phase 3.C callback verification order (line 682) correctly specifies "returns 400" for tenant mismatch. But the LLD does not call out that the EXISTING project callback returns 404 (not 400) and must be CHANGED to 400. This is a semantic difference: 404 suggests "state not found" (ambiguous), while 400 with a structured audit reason is required by ST-1.

**Fix**: Add to Phase 3.C tasks: "3.C.6: Change existing project callback status code from 404 to 400 for tenant/project/user mismatch, with structured audit emission. The current 404 violates ST-1."

---

### HIGH Findings

**R1-H1: `WORKSPACE_PERMISSIONS` is an object (not an array) -- LLD Phase 0.2 says "add to WORKSPACE_PERMISSIONS array"**

LLD Phase 0.2 (line 303) says: "Add `'auth-profile:write'` to `WORKSPACE_PERMISSIONS` array at `apps/studio/src/lib/workspace-permission.ts:12-17`."

The actual code at `workspace-permission.ts:12-17` shows `WORKSPACE_PERMISSIONS` is an OBJECT:

```typescript
export const WORKSPACE_PERMISSIONS = {
  READ: 'tenant:read',
  UPDATE: 'tenant:update',
  MANAGE_SETTINGS: 'tenant:manage_settings',
  MANAGE_MEMBERS: 'tenant:manage_members',
} as const;
```

This is an `as const` object with string values, not an array. The implementer would need to add a new property like `AUTH_PROFILE_WRITE: 'auth-profile:write'` to this object, not push to an array.

**Fix**: Change LLD task 0.2.1 from "Add `'auth-profile:write'` to `WORKSPACE_PERMISSIONS` array" to "Add `AUTH_PROFILE_WRITE: 'auth-profile:write'` property to `WORKSPACE_PERMISSIONS` object." Also update the HLD reference at line 395 which says "WORKSPACE_PERMISSIONS" without specifying the shape.

---

**R1-H2: Traceability gap -- existing `emitAuthProfileTraceEvent()` uses structured logging as the trace sink, NOT canonical TraceStore**

The existing trace emitter at `packages/shared/src/services/auth-profile/trace-events.ts:25-33` emits via `log.info()` (structured logging):

```typescript
export function emitAuthProfileTraceEvent(event: AuthProfileTraceEvent): void {
  log.info(event.eventType, { profileId, tenantId, authType, timestamp, ...event.metadata });
}
```

The comment at line 24 explicitly says: "Uses structured logging as the trace sink (TraceStore integration deferred to Phase 2)."

LLD Phase 5.6 (lines 938-953) specifies wiring to canonical `TraceStore` and adding 3 new event types to the registry. However, the LLD does not specify:

1. Whether the EXISTING 16 trace events (`AUTH_PROFILE_TRACE_EVENTS` object at lines 36-67) should also be migrated from `log.info()` to `TraceStore`, or only the 3 new MCP/Studio-Test events.
2. How the new `mcp.auth_resolved` / `mcp.auth_refreshed` / `tool_test.auth_resolved` event types map to the `TraceEventType` union in the registry -- they use dot-notation (`mcp.auth_resolved`) but the existing registry uses underscores (`tool_auth_resolved`).

**Fix**:
(a) Phase 5.6 should clarify: "The 3 new event types (`mcp.auth_resolved`, `mcp.auth_refreshed`, `tool_test.auth_resolved`) are wired to canonical TraceStore. The existing 16 `auth_profile.*` events remain on structured logging in r2 scope; migration to TraceStore is a post-r2 item."
(b) Confirm the dot-notation naming convention is compatible with the `TraceEventType` union. The existing registry uses both (`tool.resolution.start` and `tool_auth_resolved`), so both forms are valid.

---

**R1-H3: CK-1 cache key composition not applied to the runtime `AuthProfileCache` (`auth-profile-cache.ts`)**

The LLD specifies CK-1 cache key adoption at three call sites (lines 231-232, 238-239, 992):

- `packages/shared/src/services/auth-profile/credential-cache.ts`
- `packages/shared/src/services/auth-profile/client-credentials-service.ts`
- `packages/shared/src/services/mcp-auth-resolver.ts`

However, the runtime `AuthProfileCache` at `apps/runtime/src/services/auth-profile/auth-profile-cache.ts` (line 44) uses a DIFFERENT key format: `${tenantId}:${profileId}:${environment ?? '_null_'}`. This cache does NOT include `authType`, `profileVersion`, or `scopeHash` -- it uses `updatedAt`-based freshness checks instead of version-based invalidation.

The LLD "Modified Files" table (line 239) lists `apps/runtime/src/services/auth-profile/auth-profile-cache.ts` as modified with "Update key composition to CK-1" but the Phase 1.2 task list (lines 446-447) only says "keep keying consistent (CK-1 in Phase 1.3)" -- there is no explicit task to rewrite the key format.

**Fix**: Add an explicit task under Phase 1.2 or Phase 1.3.b: "Update `AuthProfileCache.key()` method to use CK-1 format: `auth-token:{tenantId}:{authType}:{profileId}:{profileVersion}:{scopeHash}:{environment}`. This requires the `authType` and `profileVersion` to be passed into `get()` and `set()` methods, which currently only accept `tenantId`, `profileId`, and `environment`."

---

**R1-H4: RP-1 enforcement specified at user-creation but NOT at `EndUserOAuthToken` write paths**

The audit focus item (8) asks: "Is `assertNotReservedPrincipal()` called at user-creation paths AND at `EndUserOAuthToken` write paths (Phase 3.D)?"

Phase 0.3 (lines 328-356) correctly wires `assertNotReservedPrincipal()` at user-creation in `auth-service.ts`. Phase 3.D (lines 695-708) says "Reject any attempt to store with non-approved reserved principal" but does NOT explicitly call `assertNotReservedPrincipal()` -- it says the `__tenant__` value is "validated against RP-1" without specifying the code call.

The risk: if a future caller passes a different `__`-prefixed userId to the `EndUserOAuthToken` upsert (e.g., `__system__`), there is no RP-1 check at the write path. The user-creation guard only covers Studio user creation, not token storage.

**Fix**: Add to Phase 3.D task 3.D.3: "Call `assertNotReservedPrincipal(userId)` at the `EndUserOAuthToken` upsert site in the callback handler BEFORE persisting. This creates defense-in-depth: even if a caller bypasses user-creation validation, the token write path rejects unapproved `__`-prefixed principals."

---

### MEDIUM Findings

**R1-M1: Existing callback uses `.passthrough()` on `OAuthStateSchema` -- ST-1 state payload should be `.strict()`**

The existing callback at `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts:51` uses `.passthrough()` on `OAuthStateSchema`:

```typescript
.passthrough();
```

The ST-1 contract specifies a fixed set of fields in the state payload. Using `.passthrough()` allows arbitrary extra fields in the state, which could be a vector for state injection. LLD Phase 3.C should specify changing this to `.strict()` or at least removing `.passthrough()`.

**Fix**: Add to Phase 3.C tasks: "Change `OAuthStateSchema.passthrough()` to `.strict()` or remove `.passthrough()` -- ST-1 state payload has a fixed schema."

---

**R1-M2: `mcp-auth-resolver.ts` tokenCache has no `tenantId` in cache key**

The existing `mcp-auth-resolver.ts:38-39` cache key function is:

```typescript
function getCacheKey(tenantId: string, tokenEndpoint: string, clientId: string): string {
  return `${tenantId}:${tokenEndpoint}:${clientId}`;
}
```

While `tenantId` IS present here (good), the key does NOT follow CK-1 format. The LLD Phase 1.3.b (lines 497-498) correctly specifies replacing this with CK-1 keys. This finding confirms the LLD's specification is addressing a real gap -- no action needed beyond what the LLD already specifies.

**Status**: Already addressed by LLD Phase 1.3.b. Noting for verification during implementation.

---

**R1-M3: `resolveAuthHeaders` in `mcp-auth-resolver.ts` accepts `tenantId?: string` (optional) -- TI-1 requires mandatory `tenantId`**

At `mcp-auth-resolver.ts:46`:

```typescript
export async function resolveAuthHeaders(
  config: McpAuthConfig,
  tenantId?: string,
): Promise<Record<string, string>> {
```

`tenantId` is optional with a fallback to `'unknown'` at line 69. This violates TI-1 which mandates `tenantId` on every query and cache key. The LLD Phase 1.3.b rewrite should make `tenantId` a required parameter.

**Fix**: Phase 1.3.b should note: "Change `tenantId` from optional to required in the rewritten resolver signature. Remove the `'unknown'` fallback."

---

**R1-M4: Phase 4.1 `azure_ad` handler caches token in Redis but does not specify which cache service to use**

Phase 4.1 (line 756) says "Cache the token in Redis with CK-1 keying" but does not specify whether this uses the existing `client-credentials-service.ts` Redis cache or a new cache path. The `azure_ad` token exchange is functionally identical to `oauth2_client_credentials` (POST to token endpoint, get bearer token, cache with TTL).

**Fix**: Add to Phase 4.1: "Reuse `resolveClientCredentialsToken()` from `client-credentials-service.ts` (it already handles Redis caching with CK-1 keying post-Phase 1.2). The `azure_ad` handler should delegate to the CC service with the Azure AD-specific token endpoint and parameters."

---

**R1-M5: No explicit `tenantId` in `tool-test-service.ts` token lookup query filter**

Phase 2.1 (line 559) specifies: "findOne({ tenantId, provider: 'auth-profile:{appProfileId}', userId })". This correctly includes `tenantId` per TI-1. The existing code at `tool-test-service.ts:710-723` resolves auth profiles with `tenantId` and `projectId` from params. Good -- the LLD is correct here.

However, the LLD does not specify that the `EndUserOAuthToken` lookup must also include `tenantId`. The existing `upsertOAuthGrant` in the callback route (callback/route.ts:98-100) DOES include `tenantId` in the findOne filter. The LLD should explicitly state this for the FR-12 lookup in tool-test-service.

**Fix**: Phase 2.1 task 2.1.1 already specifies `findOne({ tenantId, ... })`. Mark as explicit requirement, not just example -- the implementer must not omit `tenantId`.

---

### LOW Findings

**R1-L1: LLD does not mention `Dockerfile COPY` lines for new dependencies**

`packages/shared-auth-profile/package.json` gains 3 new dependencies (`@aws-sdk/signature-v4`, `@aws-sdk/protocol-http`, `@hapi/hawk`) and 1 optional dependency (`kerberos`). Per CLAUDE.md: "When adding a new `packages/<name>/` workspace package, add its COPY line to every Dockerfile." The `packages/shared-auth-profile/` package already exists, so this is about dependency resolution, not COPY lines. No new package is being created -- this is a dependency addition to an existing package. No action needed.

**Status**: Not applicable -- no new packages created.

---

**R1-L2: LLD open question OQ-7 (line 1118) leaves 3 of 10 Studio forms potentially deferred**

OQ-7 allows deferring `kerberos`, `saml`, `ssh_key` Studio forms. This is acceptable per the oracle decision and feature spec, but the LLD should specify the "API-only" notice UI text as an i18n key, not hardcoded English.

**Fix**: Phase 2.2 should note: "If deferred, the 'API-only' notice text must be an i18n translation key in `studio.json`, not a hardcoded string."

---

### VERIFIED Checklist

- [x] **TI-1 tenant isolation**: Every new query (resolver rewrites, MCP cache, OAuth state, audit emissions) includes `tenantId`. Cross-scope returns 404 (except R1-C2 where existing callback returns 404 on tenant MISMATCH -- should be 400 per ST-1). OAuth state key includes `tenantId`. Migration scripts scope by collection, not tenant -- acceptable for bulk idempotent operations. The `tenantIsolationPlugin` is applied at the model level. Studio routes use explicit `tenantId: user.tenantId` (no ALS).

- [x] **Centralized auth**: `internal-tools.ts` FR-9 wiring preserves the existing `InternalServiceRequest` service-token auth (Express middleware level) and injects auth-profile middleware at the `ToolBindingExecutor` constructor level (NOT Express middleware). No custom `jwt.verify` introduced anywhere. Workspace OAuth routes use `withRouteHandler` which wraps `requireAuth`. RBAC uses `requirePermission` via `StudioPermission.AUTH_PROFILE_WRITE`.

- [x] **Stateless distributed**: The in-memory `Map` fallback in `mcp-auth-resolver.ts` is explicitly dev-only (when `REDIS_URL` is empty). Production uses Redis. All distributed locks use `SET NX PX` with TTL (30s for refresh, 600s for OAuth init). Pod-local LRU caches have max size (200) and TTL (5min). No pod-local state used as truth.

- [x] **CK-1 cache key**: Applied at credential-cache.ts, client-credentials-service.ts, and mcp-auth-resolver.ts. R1-H3 notes the runtime `AuthProfileCache` key migration is specified in the modified-files table but not in an explicit task.

- [x] **ST-1 callback ordering**: Phase 3.C (line 681) correctly specifies: GETDEL first (atomic) -> tenantId match -> CSRF cookie match -> redirectUri match. The order is logical-priority-labeled in the LLD with a note explaining GETDEL must execute first to retrieve the payload.

- [x] **RP-1 enforcement**: Called at user-creation (Phase 0.3). R1-H4 notes it should also be called at `EndUserOAuthToken` write paths.

- [x] **No platform mocking**: LLD Phase 5 E2E and INT tests specify "No platform mocks" (line 889). Unit tests for protocol handlers use DI for external HTTP (line 856). The LLD does not use `vi.mock` of `@agent-platform/*` anywhere. Exit criteria explicitly mention "No platform components mocked" (line 1103).

- [x] **Encryption + audit**: Workspace OAuth tokens use tenant-scoped DEK encryption (Phase 3.D, line 700). Audit emissions wired in Phase 3.F with 3 constants. `OAUTH_FAILED` constant addition specified at line 726.

---

### Implementation Notes (non-blocking)

1. The existing project initiate route stores `redirectUri` in state (line 228 of initiate/route.ts) and the callback verifies it (line 247 of callback/route.ts). ST-1 is partially satisfied on project routes today -- the gap is CSRF cookie and the 404-vs-400 status code.

2. The `trace-event-registry.ts` already has `tool_auth_resolved` (line 104). The 3 new event types (`mcp.auth_resolved`, `mcp.auth_refreshed`, `tool_test.auth_resolved`) should be added to a new `AUTH_PROFILE_TRACE_EVENT_TYPES` array in the registry, following the existing pattern of per-domain arrays.

3. The `audit-events.ts` already has `OAUTH_INITIATED` and `OAUTH_COMPLETED` (lines 15-16) but NOT `OAUTH_FAILED`. Phase 3.F correctly adds it.

4. The existing `client-credentials-service.ts` cache key at line 120 (`${CACHE_PREFIX}${tenantId}:${profileId}`) does NOT include `authType`, `profileVersion`, or `scopeHash` -- confirming the CK-1 migration is a real change.

---

### Summary

| Severity | Count | Must Fix Before Implementation? |
| -------- | ----- | ------------------------------- |
| CRITICAL | 2     | Yes                             |
| HIGH     | 4     | Yes (recommended)               |
| MEDIUM   | 5     | Recommended                     |
| LOW      | 2     | No                              |

**Verdict: NEEDS_REVISION** -- 2 CRITICAL findings (ST-1 CSRF gap on project initiate route not explicitly tasked; existing callback 404-vs-400 mismatch with ST-1) and 4 HIGH findings (WORKSPACE_PERMISSIONS shape, traceability migration scope, AuthProfileCache CK-1 task gap, RP-1 at EndUserOAuthToken write) require LLD edits before implementation.

---

## Phase 4b -- Round 2 (lld-reviewer): Pattern Consistency

**Date**: 2026-05-01
**Reviewer**: lld-reviewer (claude-opus-4-6)
**Focus**: Existing platform patterns, reinvention check, Studio route conventions, test conventions, commit-scope discipline, type safety, abstraction necessity
**Files verified**: 25+ source files across `packages/compiler`, `packages/shared-auth-profile`, `packages/shared`, `packages/shared-auth`, `packages/shared-kernel`, `apps/runtime`, `apps/studio`

### VERDICT: NEEDS_REVISION

---

### HIGH Findings

**R2-H1: SSRF blocklist reinvention -- Phase 1.3.b.6 does not reference the canonical SSRF validator**

LLD Phase 1.3.b.6 (line 500) says: "SSRF blocklist (GAP-19) on `tokenEndpoint` before fetch (RFC 1918, link-local, loopback, cloud metadata IPs)."

The platform already has a canonical SSRF validator at `packages/shared-kernel/src/security/ssrf-validator.ts` (exported as `assertUrlSafeForSSRF` and `validateUrlForSSRF` from `@agent-platform/shared-kernel/security`). This is ALREADY used by:

- `packages/shared/src/services/auth-profile/client-credentials-service.ts:8,36` -- `assertUrlSafeForSSRF` on the CC token URL
- `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts:135-137` -- `validateUrlForSSRF` on the authorization URL
- `apps/studio/src/app/api/auth-profiles/route.ts:225` -- `validateUrlForSSRF` on config URL fields

The LLD describes the SSRF check as if it needs to be implemented ("RFC 1918, link-local, loopback, cloud metadata IPs") rather than referencing the existing utility. The canonical SSRF validator already covers all of these plus octal/decimal encoding bypasses, userinfo bypasses, and cloud metadata endpoints.

**Location**: LLD Phase 1.3.b.6 (line 500)
**Fix**: Change "SSRF blocklist (GAP-19) on `tokenEndpoint` before fetch (RFC 1918, link-local, loopback, cloud metadata IPs)" to "Call `assertUrlSafeForSSRF(tokenEndpoint)` from `@agent-platform/shared-kernel/security` (the canonical SSRF validator, already used by `client-credentials-service.ts:36`). Dev mode: use `getDevSSRFOptions()` for localhost allowance."
**Pattern reference**: `packages/shared/src/services/auth-profile/client-credentials-service.ts:8,36`

---

**R2-H2: Token-bucket rate limiter (Phase 1.3.b.8) introduces a new abstraction without specifying its implementation pattern or data structure**

LLD Phase 1.3.b.8 (line 502) says: "Per-`{tenantId, profileId}` token-bucket rate limiter on outbound token-exchange (GAP-22 mitigation)." This is a new rate limiter for outbound HTTP requests to identity providers.

No shared outbound-request rate limiter exists in the platform today:

- `apps/studio/src/lib/rate-limiter.ts` -- in-memory `SlidingWindowRateLimiter` for inbound API rate limiting (per-route), NOT outbound
- `apps/runtime` -- no shared rate limiter for outbound HTTP

The LLD does not specify:

1. Whether this is Redis-backed (required for multi-pod) or in-memory (acceptable only for single-pod dev)
2. The data structure (`Map` vs Redis sorted set)
3. Max size / TTL / eviction policy if using an in-memory Map (CLAUDE.md invariant: "Every in-memory `Map` needs max size, TTL, and eviction")
4. Token refill rate and bucket size
5. Error behavior when throttled (what error code? what HTTP status?)
6. Whether it should be a reusable utility in `packages/shared` or inline in `mcp-auth-resolver.ts`

**Location**: LLD Phase 1.3.b.8 (line 502), Phase 1.3.b.9 exit criteria (line 503)
**Fix**: Expand Phase 1.3.b.8 to specify: (a) Redis-backed `SET NX PX` sliding window (multi-pod safe) with in-memory fallback for dev; (b) key pattern `auth-profile:rl:{tenantId}:{profileId}` with window size and max count from config/constants; (c) when throttled, throw `AuthProfileError('AUTH_TOKEN_RATE_LIMITED', 'Too many token exchange attempts', 429)` -- add to HLD error registry; (d) inline in `mcp-auth-resolver.ts` (not a shared utility -- single use case today). If using an in-memory fallback Map, specify max size, TTL, and eviction per CLAUDE.md.

---

**R2-H3: `ToolBindingExecutor` file path is wrong -- it lives in `packages/compiler`, not `apps/runtime/src/tools/`**

LLD Phase 1.1.1 (line 399) says: "Locate `ToolBindingExecutor` constructor in `apps/runtime/src/tools/tool-binding-executor.ts`."

The actual location is `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts`, exported from `@abl/compiler` (confirmed at `packages/compiler/src/index.ts:476-478`). The import in `internal-tools.ts:16` is `import { ToolBindingExecutor } from '@abl/compiler'`.

The constructor config interface (`ToolBindingExecutorConfig`, lines 77-113 of the source) already supports `middleware?: ToolMiddleware[]` at line 88. The FR-9 wiring should inject `createAuthProfileToolMiddleware()` as an element of this `middleware` array. This is the correct approach (confirmed by reading the source), but the LLD must reference the right file path.

**Location**: LLD Phase 1.1.1 (line 399), files-touched list (line 411)
**Fix**: (a) Change Phase 1.1.1 from "Locate `ToolBindingExecutor` constructor in `apps/runtime/src/tools/tool-binding-executor.ts`" to "Verify `ToolBindingExecutor` constructor config from `@abl/compiler` (source: `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts`); confirm `middleware?: ToolMiddleware[]` option exists at `ToolBindingExecutorConfig.middleware`." (b) Remove `apps/runtime/src/tools/tool-binding-executor.ts` from the files-touched list (line 411) -- this file does not exist; the constructor options are in `packages/compiler` and do NOT need modification since the `middleware` field already exists.

---

### MEDIUM Findings

**R2-M1: Exit criteria for Phase 0.2 still says "array" -- inconsistent with R1-H1 fix**

LLD Phase 0.2 exit criteria (line 316) says: "`WORKSPACE_PERMISSIONS` array contains `'auth-profile:write'`"

This contradicts the R1-H1 fix applied to task 0.2.1 (line 303), which correctly says "Add `AUTH_PROFILE_WRITE: 'auth-profile:write'` and `AUTH_PROFILE_READ: 'auth-profile:read'` properties to the `WORKSPACE_PERMISSIONS` `as const` object."

The exit criteria should match the task description.

**Location**: LLD Phase 0.2 exit criteria, line 316
**Fix**: Change "`WORKSPACE_PERMISSIONS` array contains `'auth-profile:write'`" to "`WORKSPACE_PERMISSIONS` object contains `AUTH_PROFILE_WRITE: 'auth-profile:write'` and `AUTH_PROFILE_READ: 'auth-profile:read'` properties"

---

**R2-M2: `WORKSPACE_PERMISSIONS` object is cosmetic -- adding properties there does NOT grant ADMIN role the permission**

The `WORKSPACE_PERMISSIONS` object at `apps/studio/src/lib/workspace-permission.ts:12-17` is a reference constant. It is NOT consumed by `withRouteHandler` or the RBAC system. The actual permission grant comes from `TENANT_ROLE_PERMISSIONS` at `packages/shared-auth/src/rbac/role-permissions.ts:34`.

Today, `TENANT_ROLE_PERMISSIONS.ADMIN` includes `credential:*` but NOT `auth-profile:*` or `auth-profile:write`. Only `TENANT_ROLE_PERMISSIONS.OWNER` (which has `*:*`) can access workspace auth-profile routes.

The existing workspace `GET`/`POST` routes at `apps/studio/src/app/api/auth-profiles/route.ts` already use `StudioPermission.AUTH_PROFILE_WRITE` and `StudioPermission.AUTH_PROFILE_READ`. These work for OWNER via `*:*` wildcard.

However, the LLD Phase 0.2 does NOT specify adding `'auth-profile:read'` or `'auth-profile:write'` to `TENANT_ROLE_PERMISSIONS.ADMIN` (or any other role). If the intent is that ADMIN should be able to initiate workspace OAuth, the LLD must explicitly add `'auth-profile:read'` and `'auth-profile:write'` to the ADMIN role's permission array in `TENANT_ROLE_PERMISSIONS`. If the intent is OWNER-only, the LLD should document this explicitly.

The `workspace-auditor` role (Phase 0.2 task 0.2.2) needs to be added to `TENANT_ROLE_PERMISSIONS` (not just the role-permissions categories table). The LLD correctly references `packages/shared-auth/src/rbac/role-permissions.ts:34-112` but does not specify whether `workspace-auditor` is added as a new key in `TENANT_ROLE_PERMISSIONS` or as a role in the categories table only.

**Location**: LLD Phase 0.2 tasks 0.2.1-0.2.2 (lines 303-305)
**Fix**: Clarify: (a) Does ADMIN gain `auth-profile:write`? If yes, add `'auth-profile:read', 'auth-profile:write'` to `TENANT_ROLE_PERMISSIONS.ADMIN`. If no, document "workspace OAuth initiate is OWNER-only." (b) Specify that `workspace-auditor` must be a new key in `TENANT_ROLE_PERMISSIONS` with `['auth-profile:read']`, not just a category entry. The category table at `role-permissions.ts:356-365` already lists `auth-profile:read/write/delete/decrypt` under `auth_profiles` -- but the category table is for UI display, not RBAC enforcement.

---

**R2-M3: Phase 3.A `_oauth-state-service.ts` extraction -- no service interface specified**

LLD Phase 3.A (lines 642-655) proposes extracting OAuth state logic into `apps/studio/src/app/api/auth-profiles/oauth/_oauth-state-service.ts`. The tasks say "Extract OAuth state logic" and "Extract callback verification logic" but do not specify the function signatures.

The existing inline OAuth state management in the project routes is:

- **Initiate**: `redis.set(stateKey, JSON.stringify(payload), 'EX', 600)` -- returns state token (hex string)
- **Callback**: `redis.getdel(stateKey)` -- returns raw JSON or null; caller parses with `OAuthStateSchema.parse()`

The extraction should produce two pure functions:

```
async function createOAuthState(redis, tenantId, payload) => stateToken: string
async function consumeOAuthState(redis, tenantId, stateToken) => OAuthStateParsed | null
```

Without specifying this interface, the implementer might create a class with constructor-injected Redis (over-engineered for what's essentially two stateless helper functions).

**Location**: LLD Phase 3.A tasks 3.A.1-3.A.2 (lines 646-648)
**Fix**: Add to Phase 3.A tasks: "Service exposes two pure functions: `createOAuthState(redis: RedisClient, tenantId: string, payload: OAuthStatePayload): Promise<string>` (returns hex state token) and `consumeOAuthState(redis: RedisClient, tenantId: string, stateToken: string): Promise<z.infer<typeof OAuthStateSchema> | null>` (atomic GETDEL + parse). Both accept Redis as a parameter (DI), no class needed."

---

**R2-M4: `profileVersion` pre-save hook placement uses the right pattern but should specify `Schema.pre('save', ...)` not plugin**

LLD Phase 0.4 task 0.4.2 (line 363) says: "Add inline pre-save hook (after plugins block, line ~205, before indexes block)." This is the correct placement. However, the LLD does not explicitly say `AuthProfileSchema.pre('save', function(next) { ... })`.

The codebase has no inline pre-save hooks in any model outside of plugins. The existing pattern for model-specific behavior is either:

1. Plugin application (lines 199-205 of `auth-profile.model.ts`) -- for cross-cutting concerns
2. Schema defaults (like `_v: { type: Number, default: 1 }` at line 192) -- for simple values

The `profileVersion` increment on `config`/`encryptedSecrets` modification requires a pre-save hook, which is different from both patterns. Decision D-7 correctly rejects a plugin (no reuse case), but the LLD should confirm the exact Mongoose API call.

**Location**: LLD Phase 0.4 task 0.4.2 (line 363)
**Fix**: Change "Add inline pre-save hook" to "Add `AuthProfileSchema.pre('save', function(next) { if (this.isModified('config') || this.isModified('encryptedSecrets')) { this.profileVersion = (this.profileVersion ?? 0) + 1; } next(); })` after the plugins block (after line 205) and before the indexes block (before line 207)." This makes the exact Mongoose API call explicit and prevents implementer confusion about whether to use `.pre()` or `.plugin()`.

---

**R2-M5: Phase 5.7 drift lint hook references `AUTH_PROFILE_AUTH_TYPES` but Phase 2.2 uses `SUPPORTED_AUTH_TYPES` -- naming inconsistency**

LLD Phase 5.7 task 5.7.1 (line 962) says: "fails if any entry in `AUTH_PROFILE_AUTH_TYPES` is missing UI metadata, runtime handler, or matrix test row."

LLD Phase 2.2 task 2.2.2 (line 598) says: "Export new `SUPPORTED_AUTH_TYPES` constant covering Phase 1 + Phase 2/3 types."

These appear to reference the same constant under different names. Additionally, the existing codebase already has `AUTH_TYPE_USAGE_MODES` (at `auth-type-metadata.ts:66`) which maps all 17 auth types -- this could serve as the source of truth for the drift lint.

**Location**: LLD Phase 5.7 (line 962), Phase 2.2 (line 598)
**Fix**: Align naming. Use `SUPPORTED_AUTH_TYPES` consistently across Phase 2.2 and Phase 5.7. Update Phase 5.7.1 to: "fails if any entry in `SUPPORTED_AUTH_TYPES` (from Phase 2.2) is missing a corresponding entry in: (a) `AUTH_TYPE_METADATA` (UI metadata), (b) `applyAuth` dispatch table (runtime handler), and (c) matrix E2E test parameterization."

---

### LOW Findings

**R2-L1: Migration script `--restore` consistency -- `migrate-profile-version-backfill.ts` has only `--dry-run`**

LLD Phase 0.4 (lines 365-366) specifies `--dry-run` for the backfill migration but NOT `--restore`. The other two migration scripts (`migrate-mcp-auth-profile-split.ts` and `migrate-auth-aliases.ts`) have both `--dry-run` and `--restore`.

The backfill sets `profileVersion=1` where the field is missing. A `--restore` would mean removing the field, which is equivalent to schema rollback (handled by dropping the field from the schema). This is a valid reason to omit `--restore`.

**Location**: LLD Phase 0.4 tasks 0.4.4-0.4.5 (lines 364-366)
**Fix**: No code change needed. Add a note to Phase 0.4: "No `--restore` flag: backfill sets `profileVersion=1` on existing docs; rollback is handled by reverting the schema change (which removes the field definition). The backfill is idempotent and safe to re-run."

---

**R2-L2: i18n gap on Phase 2.2 auth-type forms -- hardcoded English strings**

The existing `auth-type-metadata.ts` (lines 92-200+) uses hardcoded English strings for `label`, `shortLabel`, `description`, `placeholder`, and `helpText` in the `AUTH_TYPE_METADATA` entries. The LLD Phase 2.2 adds 10 new entries following this same pattern.

Per the review checklist, "LLD specifies i18n namespace for each new component" and "All user-visible strings planned as translation keys." The LLD does not mention i18n for Phase 2.2 at all.

However, this is an existing pattern violation -- the 7 current auth types already use hardcoded strings. Requiring the 10 new types to use i18n keys while the existing 7 don't would create inconsistency. The correct fix is a separate i18n migration task, not blocking r2 scope.

**Location**: LLD Phase 2.2 (lines 593-633)
**Fix**: Add a note to Phase 2.2: "i18n: The existing `AUTH_TYPE_METADATA` entries use hardcoded English strings. New entries follow the same pattern for consistency. A separate post-r2 task should migrate all 17 entries to i18n translation keys in `studio.json`." This is not blocking because the existing pattern is already hardcoded.

---

### VERIFIED Checklist

- [x] **Existing Mongoose patterns**: LLD Phase 0.4 pre-save hook placement (after plugins, before indexes) matches the model structure at `auth-profile.model.ts:197-207`. Decision D-7 correctly rejects a plugin (zero reuse case). The hook content (increment on `isModified`) follows Mongoose conventions.

- [x] **Distributed Redis locks**: Phase 1.3.c.2 and Phase 3.B.3 correctly use `SET NX PX` pattern with TTL (30s for refresh, 600s for OAuth init). Lock key prefixes are distinct (`auth-profile:op-lock:` vs `auth-profile:oauth-init-lock:`). Decision D-13 confirms UUID-based keys prevent collision.

- [x] **Trace event emission**: Phase 5.6 correctly scopes new trace events to canonical TraceStore while leaving existing 16 events on structured logging (per R1-H2 fix). The 3 new event types follow dot-notation naming already used in the trace registry.

- [x] **Error class extension**: LLD correctly uses `AuthProfileError` from `packages/shared-auth-profile/src/errors.ts` (confirmed constructor signature: `(code, message, statusCode)`). Phase 5.6 sanitizer (`sanitizeAuthProfileError`) correctly checks for `AuthProfileError` instances.

- [x] **Migration script conventions**: All 3 scripts specify `--dry-run`. The two reversible scripts have `--restore`. Idempotency is specified as an exit criteria for all 3. The `--limit N` flag for batched runs is specified for the MCP split migration (Phase 1.3.a.4).

- [x] **withRouteHandler pattern for workspace routes**: The new workspace OAuth routes (Phase 3.B) correctly follow the existing workspace auth-profiles pattern: `withRouteHandler({ permissions: StudioPermission.AUTH_PROFILE_WRITE, ... })` without `requireProject`. This matches `apps/studio/src/app/api/auth-profiles/route.ts:201-205`.

- [x] **Zod `.strict()` vs `.passthrough()`**: Phase 3.C.7 (R1-M1 fix) correctly replaces `.passthrough()` with `.strict()` on `OAuthStateSchema`. The existing `CallbackSchema` at `callback/route.ts:26-30` does NOT use `.passthrough()` -- only the state schema did.

- [x] **`signRequest` callback design**: Phase 4.2 adds `signRequest` to `ApplyAuthResult` (currently NOT present on the interface). The callback signature `(assembled: { method, url, headers, body? }) => Promise<Headers>` is pinned per Decision D-8. The existing `ApplyAuthResult` already has typed credential fields (`awsCredentials`, `digestCredentials`, etc.) that the runtime reads -- `signRequest` follows the same pattern of "dispatcher attaches, runtime consumes."

- [x] **No reinvention of OAuth state management**: Phase 3.A correctly extracts the inline Redis state logic into a shared `_oauth-state-service.ts` rather than introducing a new framework. The existing pattern (Redis `SET` with TTL on initiate, `GETDEL` on callback) is preserved.

- [x] **Commit-scope discipline**: Every phase respects 3-package limit. Phase 0 has 4 sub-commits (0.1: 2 packages, 0.2: 2 packages, 0.3: 2 packages, 0.4: 2 packages). Phase 1.3 has 3 sub-commits (1.3.a: 1 package, 1.3.b: 2 packages, 1.3.c: 1 package). Phase 3 has 6 sub-phases, each 1-2 packages. Phase 4 sub-phases are all 1 package. Phase 5 sub-phases are 1-2 packages.

- [x] **No unnecessary abstractions**: Decision D-7 rejects a `profileVersionPlugin` (zero reuse case). Decision D-9 rejects a sanitizer class (pure function suffices). Decision D-11 confirms Phase 0.1 is move + re-export, not rewrite. Phase 3.A extraction is two functions, not a class. All decisions follow CLAUDE.md's "no abstractions beyond what the task requires."

- [x] **Type safety -- "Read Before You Write"**: Phase 1.1.1 says "confirm it accepts a middleware-injection option (or extend the constructor options)." This follows the CLAUDE.md rule. However, the file path is wrong (R2-H3). The actual `ToolBindingExecutorConfig.middleware` already exists at line 88 of the source.

- [x] **Test file placement**: Unit tests under `__tests__/` within the same package (e.g., `packages/shared-auth-profile/src/__tests__/reserved-principals.test.ts`). Integration tests at `apps/runtime/src/__tests__/integration/*.test.ts`. E2E tests at `apps/runtime/src/__tests__/auth-profile-matrix.e2e.test.ts` and `apps/studio/e2e/*.spec.ts`. All follow existing conventions.

- [x] **Studio route conventions**: New workspace OAuth routes use `withRouteHandler` with `permissions`, `bodySchema`, and `rateLimit` -- matching the existing project OAuth routes at `initiate/route.ts:50-56` and `callback/route.ts:133-138`. Error responses use `errorJson()` with `ErrorCode` constants.

---

### Implementation Notes (non-blocking)

1. The `ToolBindingExecutorConfig` interface (at `packages/compiler/.../tool-binding-executor.ts:77-113`) supports `middleware?: ToolMiddleware[]`. The existing `ToolMiddleware` type is imported from `./tool-middleware.ts`. The `createAuthProfileToolMiddleware` function at `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts` already returns a `ToolMiddleware`. FR-9 wiring should be: `middleware: [createAuthProfileToolMiddleware({ tenantId, projectId, environment })]` in the `ToolBindingExecutor` constructor call at `internal-tools.ts:170`.

2. The existing `client-credentials-service.ts` already calls `assertUrlSafeForSSRF` (line 36) and accepts a `deps` parameter for Redis injection (DI pattern). The Phase 1.3.b MCP resolver rewrite should follow this same DI pattern for Redis.

3. The existing `resolveAuthHeaders` function in `mcp-auth-resolver.ts` is a standalone function (not a class method). The Phase 1.3.b rewrite should maintain this pattern -- standalone async function with DI parameters.

4. The existing `AUTH_TYPE_METADATA` object already has entries for 7 types with hardcoded English strings. Phase 2.2 should follow the same structure (not introduce i18n keys for only the new types).

5. The `TENANT_ROLE_PERMISSIONS` at `packages/shared-auth/src/rbac/role-permissions.ts` has a sync test mentioned in the comments (line 31: "A sync test verifies these stay in sync"). When adding a `workspace-auditor` role, the implementer must update the sync test.

---

### Summary

| Severity | Count | Must Fix Before Implementation? |
| -------- | ----- | ------------------------------- |
| CRITICAL | 0     | --                              |
| HIGH     | 3     | Yes                             |
| MEDIUM   | 5     | Recommended                     |
| LOW      | 2     | No                              |

**Verdict: NEEDS_REVISION** -- 3 HIGH findings require LLD edits before implementation: (R2-H1) SSRF reinvention -- must reference canonical `assertUrlSafeForSSRF`; (R2-H2) token-bucket rate limiter missing implementation specification; (R2-H3) `ToolBindingExecutor` file path is wrong -- lives in `packages/compiler`, not `apps/runtime`.

---

## Phase 4b -- Round 3 (lld-reviewer): Completeness

**Date**: 2026-05-01
**Reviewer**: lld-reviewer (claude-opus-4-6)
**Focus**: FR coverage, file path verification, signature accuracy, migration script completeness, acceptance criteria coverage, exit criteria measurability, test mapping completeness
**Files verified**: 22 source files, full LLD (1140 lines), feature spec FR-1..FR-17 (134 lines), test spec E2E-1..WIRE-2 + INT-1..INT-14 (619 lines)

### VERDICT: NEEDS_REVISION

---

### CRITICAL Findings

**R3-C1: `apps/runtime/src/tools/http-tool-executor.ts` does not exist -- LLD references wrong path in 3 places**

The LLD references `apps/runtime/src/tools/http-tool-executor.ts` in the Modified Files table (line 242), Phase 4.2.5 (line 793), and Phase 4.3.2 (line 809). This file does not exist anywhere in the repository.

The actual `HttpToolExecutor` lives at `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` and is exported from `@abl/compiler`. This is the same package that houses `ToolBindingExecutor` (which was correctly fixed in R2-H3 to reference `packages/compiler/`), but the `HttpToolExecutor` path was not corrected.

This is CRITICAL because:

1. Phase 4.2.5 tasks the implementer to modify this file to invoke `result.signRequest(assembled)` -- they would create a new file at the wrong path instead of modifying the correct one
2. Phase 4.3.2 tasks digest retry-on-401 logic in the same wrong path
3. Phase 5.1.3 also references `apps/runtime/src/tools/http-tool-executor.ts` for `normalizeAuthType()` on the read path
4. The Modified Files table entry for FR-15 and FR-16 both use the wrong path

**Location**: LLD Modified Files table (line 242), Phase 4.2.5 (line 793), Phase 4.3.2 (line 809), Phase 5.1.3 (line 890)
**Fix**: Change ALL references to `apps/runtime/src/tools/http-tool-executor.ts` to `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`. Update the Modified Files table entry to: "`packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` -- FR-15: invoke `result.signRequest(assembled)` when present; FR-16: call `normalizeAuthType()` on read path." Note: this file is in `packages/compiler` (1 of 3 packages), which affects commit-scope counting for any phase that also touches runtime or shared packages.

---

### HIGH Findings

**R3-H1: `resolveClientCredentialsToken()` signature does not accept CK-1 fields (`authType`, `profileVersion`, `scopeHash`) -- no explicit task to expand it**

The Modified Files table (line 231) says `client-credentials-service.ts` adopts CK-1 cache key `auth-token:{tenantId}:oauth2_client_credentials:{profileId}:{profileVersion}:{scopeHash}`. The current signature is:

```typescript
export async function resolveClientCredentialsToken(
  profileId: string,
  tenantId: string,
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  scopes: string[],
  deps: ClientCredentialsDeps,
): Promise<ClientCredentialsResult>;
```

The cache key at line 120 is `${CACHE_PREFIX}${tenantId}:${profileId}` -- composing the CK-1 key requires `authType` (hardcoded to `'oauth2_client_credentials'` here, but needed for the CK-1 template), `profileVersion` (not available without querying the profile doc), and `scopeHash` (can be computed from `scopes`).

No LLD phase has an explicit task to add `profileVersion` to the `resolveClientCredentialsToken` signature. Phase 1.2.2b handles `AuthProfileCache.key()` expansion but that is a different cache (pod-local LRU vs Redis). Phase 1.3.b.4 handles the MCP resolver's cache key. The `client-credentials-service.ts` CK-1 adoption is listed in Modified Files but has NO corresponding task in any phase.

Phase 4.1.3 says "Reuse `resolveClientCredentialsToken()` from `client-credentials-service.ts`" for Azure AD -- but if the function signature hasn't been expanded for CK-1 by that point, the reuse will either use a stale cache key or require an ad-hoc workaround.

**Location**: Modified Files table (line 231), no corresponding task in Phase 1.2 or 1.3
**Fix**: Add an explicit task under Phase 1.2 (or as a new Phase 1.2c): "Expand `resolveClientCredentialsToken()` signature to accept `profileVersion: number` and compute `scopeHash` from `scopes`. Update the cache key to CK-1 format: `auth-token:{tenantId}:oauth2_client_credentials:{profileId}:{profileVersion}:{scopeHash}`. Update all 2 existing call sites (`tool-test-service.ts` CC branch, `token-refresh-service.ts` CC path) to pass `profileVersion`. This MUST land before Phase 4.1.3 (Azure AD reuse)."

---

**R3-H2: Phase 5.6.2 references wrong file for trace event type registration**

Phase 5.6.2 (line 961) says: "Add 3 new event types: `mcp.auth_resolved`, `mcp.auth_refreshed`, `tool_test.auth_resolved` to a new `AUTH_PROFILE_TRACE_EVENT_TYPES` array in `packages/shared-kernel/src/types/trace-event.ts`."

The trace event TYPE CONSTANTS are defined in `packages/shared-kernel/src/constants/trace-event-registry.ts`, not `packages/shared-kernel/src/types/trace-event.ts`. The `trace-event.ts` file re-exports the `TraceEventType` union from the registry but does NOT define the per-domain constant arrays. All existing per-domain arrays (`CORE_TRACE_EVENT_TYPES`, `TOOL_TRACE_EVENT_TYPES`, `SESSION_TRACE_EVENT_TYPES`, etc.) live in `trace-event-registry.ts`.

Adding the new array to `trace-event.ts` would break the existing pattern where all event type constants are in the registry module. The `TraceEventType` union is derived from the registry; adding constants to the wrong file would either miss them in the union or create a circular dependency.

The Modified Files table (line 252) also says "`packages/shared-kernel/src/types/trace-event.ts` -- FR-17 -- add 3 new event types" -- same wrong file.

**Location**: Phase 5.6.2 (line 961), Modified Files table (line 252)
**Fix**: Change Phase 5.6.2 to: "Add `AUTH_PROFILE_TRACE_EVENT_TYPES = ['mcp.auth_resolved', 'mcp.auth_refreshed', 'tool_test.auth_resolved'] as const` to `packages/shared-kernel/src/constants/trace-event-registry.ts` (following the existing per-domain array pattern: `TOOL_TRACE_EVENT_TYPES`, `SESSION_TRACE_EVENT_TYPES`, etc.). Include the new type in the `ExtendedTraceEventType` union." Update Modified Files table path to `packages/shared-kernel/src/constants/trace-event-registry.ts`.

---

**R3-H3: Phase 1.2 Files Touched internal contradiction -- task 1.2.2b rewrites `AuthProfileCache.key()` to CK-1, but files-touched note says "CK-1 in Phase 1.3"**

Phase 1.2.2b (line 439) explicitly says: "CK-1 requires `(tenantId, authType, profileId, profileVersion, scopeHash, principalKind?, principalId?)`. Rewrite the signature, update every call site (resolver + cache invalidation hooks), and add a unit test for the new key format."

The files-touched section for Phase 1.2 (line 448) says: "`apps/runtime/src/services/auth-profile/auth-profile-cache.ts` -- keep keying consistent (CK-1 in Phase 1.3)."

These contradict. Either:
(a) Phase 1.2 rewrites the key fully (task 1.2.2b is the source of truth, the files-touched note is stale from pre-R1-H3), OR
(b) Phase 1.3 does the CK-1 rewrite and 1.2.2b is over-specified.

This matters because the `AuthProfileCache.key()` currently takes `(tenantId, profileId, environment)` but the CK-1 format includes `authType` and `profileVersion` which are NOT available at the current `resolveAuthProfileCredentials()` call site (lines 106, 132 of `auth-profile-resolver.ts`). Adding them to the cache call requires threading `authType` and `profileVersion` through the resolver, which is a non-trivial change. The implementer needs clarity on which phase does this work.

**Location**: Phase 1.2.2b (line 439) vs Phase 1.2 files-touched (line 448)
**Fix**: Resolve the contradiction. Recommended: Phase 1.2.2b is the source of truth (added by R1-H3 fix). Change the files-touched note at line 448 to: "`apps/runtime/src/services/auth-profile/auth-profile-cache.ts` -- rewrite `key()` to CK-1 format per task 1.2.2b." Remove the "(CK-1 in Phase 1.3)" note.

---

### MEDIUM Findings

**R3-M1: Phase 1.2 touches 4 packages (runtime + search-ai + project-io + hooks) but is sized as "1 package + hooks" -- exceeds CLAUDE.md 3-package commit limit**

Phase 1.2 files-touched (lines 447-453) lists:

1. `apps/runtime/src/services/auth-profile-resolver.ts`
2. `apps/runtime/src/services/auth-profile/auth-profile-cache.ts`
3. `apps/search-ai/src/services/auth-profile-resolver.ts`
4. `packages/project-io/src/import/auth-profile-resolver.ts`
5. `.claude/hooks/auth-profile-query-shape-lint.sh`
6. `.claude/settings.json`
7. CI mirror

That is 3 distinct npm packages (`apps/runtime`, `apps/search-ai`, `packages/project-io`) plus hooks. The CLAUDE.md commit-scope guard limits commits to max 3 packages -- but the task header says "1 package + hooks" which is incorrect.

**Location**: Phase 1.2 header (line 433)
**Fix**: Either (a) split Phase 1.2 into two sub-commits: 1.2a (runtime resolver + cache, 1 package) and 1.2b (search-ai + project-io adopters + hooks, 2 packages); or (b) correct the header to "3 packages + hooks" and verify this passes the commit-scope guard (3 packages is the limit, not exceeded). Option (b) is acceptable since 3 packages is the maximum, not over. But the header must be accurate.

---

**R3-M2: `resolveAuthProfileCredentials()` by-ID function uses `{ _id, tenantId }` but NOT the FR-10 `$or` filter -- LLD does not distinguish ID-based vs name-based resolution sites for the `$or` filter**

The current `resolveAuthProfileCredentials(authProfileId, tenantId)` at `auth-profile-resolver.ts:82-93` queries by `{ _id: authProfileId, tenantId }` -- this is correct for ID-based lookup (ID is unique per tenant; `projectId` filtering is unnecessary).

The FR-10 `$or` filter `{ tenantId, $or: [{ projectId: null }, { projectId }] }` is only needed for NAME-based resolution where workspace and project profiles may overlap. The `getScopedLookupCandidates()` function at line 139 already handles this with separate scope/environment/visibility filters.

Phase 1.2 task 1.2.2 (line 438) says "Update each runtime call site to apply `{ tenantId, $or: [...] }` for resolution paths" without distinguishing ID-based vs name-based call sites. The implementer might incorrectly add the `$or` to the ID-based lookup (which would be a no-op but adds unnecessary query complexity).

**Location**: Phase 1.2 task 1.2.2 (line 438)
**Fix**: Clarify task 1.2.2: "Apply the canonical `$or` filter ONLY to name-based resolution paths (e.g., `resolveByName`). ID-based lookups (`resolveAuthProfileCredentials(id, tenantId)`) already scope correctly by `_id + tenantId` and do NOT need the `$or` -- they resolve exactly one profile. The `$or` filter is for name-based workspace+project shadowing only."

---

**R3-M3: Acceptance criteria (Section 6) missing explicit FR-14 Studio form outcome**

Section 6 (lines 1107-1127) has 16 acceptance criteria. None explicitly state "All 10 new auth-type Studio forms render and submit successfully." The closest is:

- "All 17 FRs (FR-1..FR-17) have at least one shipping implementation task that traces to a feature-spec FR ID" (line 1110)
- "All 15 E2E scenarios pass" (line 1113) -- which includes E2E-ERR-1 (form validation)

But there is no acceptance criterion for the round-trip create-read-verify of the 10 new form types. E2E-ERR-1 only tests `basic` and `mtls` types (2 of 10). The remaining 8 forms could be broken and the acceptance criteria would still pass.

**Location**: Section 6 (lines 1107-1127)
**Fix**: Add acceptance criterion: "All 10 new auth-type forms (basic, custom_header, mtls, aws_iam, ssh_key, digest, kerberos, saml, hawk, ws_security -- or 7 if kerberos/saml/ssh_key deferred per OQ-7) render in Studio, submit successfully, and round-trip through the API (create/read/verify). Verified by Phase 2.2 exit criteria + E2E-ERR-1 coverage."

---

**R3-M4: Phase 0.4 migration script `tools/migrate-profile-version-backfill.ts` does not specify connection-string handling or tenant-scoping**

All 3 migration scripts are specified with `--dry-run` and idempotency, which is good. However, none of the scripts specify:

1. How they connect to MongoDB (env var? CLI flag? `MONGODB_URI`?)
2. Whether they scope by tenant (run across all tenants) or accept `--tenant-id` for staged rollouts
3. Logging format (structured JSON for audit trail? plain text?)
4. Batch size for `updateMany` operations (backfilling profileVersion on a large `auth_profiles` collection without `--limit` could be problematic)

The `migrate-mcp-auth-profile-split.ts` (Phase 1.3.a) specifies `--limit N` (task 1.3.a.4), but the `migrate-profile-version-backfill.ts` (Phase 0.4) does NOT specify `--limit`. The `migrate-auth-aliases.ts` (Phase 5.1) also does not specify `--limit`.

**Location**: Phase 0.4 tasks 0.4.4-0.4.5 (lines 364-367), Phase 5.1.4 (line 891)
**Fix**: Add to all 3 migration scripts: (a) connection via `MONGODB_URI` env var (standard pattern in `tools/` scripts); (b) `--limit N` for batched execution (consistent across all 3); (c) structured logging to stdout. Tenant-scoping is not needed because all 3 operate on collection-wide conditions (`$exists: false` for backfill, specific field patterns for split/aliases).

---

**R3-M5: Phase 4.3 digest handler references wrong integration pattern -- says "NOT via `signRequest` hook" but does not specify where the retry-on-401 logic lives**

Phase 4.3.3 (line 810) says: "NOT via `signRequest` hook (digest is body-mutating per GAP-23)." Phase 4.3.2 says the retry-on-401 logic goes in "apps/runtime/src/tools/http-tool-executor.ts" (which is the wrong path per R3-C1). But even with the corrected path (`packages/compiler/.../http-tool-executor.ts`), the task does not specify WHERE in the executor the retry logic goes:

- Is it a new method on `HttpToolExecutor`?
- Is it a wrapper around the existing `execute()` method?
- Is it triggered by the `applyAuth` result (e.g., a `retryOn401?: true` field on `ApplyAuthResult`)?

The `digest` protocol is unique among the 6 handlers because it requires TWO HTTP round-trips (first 401, then retry with digest auth). The other 5 handlers produce headers/signing before the request. The LLD should specify the integration seam.

**Location**: Phase 4.3.2-4.3.3 (lines 809-810)
**Fix**: Add to Phase 4.3: "The digest handler returns `ApplyAuthResult` with `digestCredentials` populated (already in the interface at `apply-auth.ts:52-56`). `HttpToolExecutor` (at `packages/compiler/.../http-tool-executor.ts`) checks for `digestCredentials` and, on 401 with `WWW-Authenticate: Digest`, computes the response hash and retries with `Authorization: Digest ...`. The retry logic is a private method `retryWithDigestAuth(response, digestCreds, assembled)` added to `HttpToolExecutor`."

---

### LOW Findings

**R3-L1: OQ-6 defers MCP transport file paths to implementer -- but no verification step to confirm the paths exist**

LLD Open Question 6 (line 1137) says: "This LLD references `apps/runtime/src/mcp/*.ts` for transport refresh wiring (Phase 1.3.c). The exact file paths are not enumerated here -- implementer must read the existing MCP transport implementation first."

I verified: `apps/runtime/src/mcp/` does NOT exist as a directory. The MCP implementation may be elsewhere in the runtime app. The implementer will discover this, but having a bogus directory reference in the LLD and Modified Files table (line 240: "`apps/runtime/src/mcp/*.ts` (existing transport files)") could cause confusion.

**Location**: Modified Files table (line 240), Phase 1.3.c (lines 518-533), OQ-6 (line 1137)
**Fix**: Change the Modified Files table entry from "`apps/runtime/src/mcp/*.ts` (existing transport files)" to "`apps/runtime/src/**/mcp*.ts` or equivalent MCP transport files (exact paths deferred to OQ-6; implementer verifies)." Add a note to Phase 1.3.c exit criteria: "First task: locate existing MCP transport files and document their paths in the commit message."

---

**R3-L2: Phase 1.2 exit criteria use "INT-?" placeholder twice -- should reference specific INT scenario IDs**

Phase 1.2 exit criteria (lines 460-461) say:

- "Workspace profile resolves from project workflow (asserted in INT-? in Phase 5)"
- "Project profile shadows workspace profile of same name (asserted in INT-? in Phase 5)"

These should reference INT-9 (workflow tool_call) or INT-11 (cross-tenant isolation), depending on which integration test exercises the shadowing behavior. The "?" placeholders make the criteria unmeasurable.

**Location**: Phase 1.2 exit criteria (lines 460-461)
**Fix**: Change "INT-?" to the specific test: INT-9 step 2 (workspace profile resolves from project workflow) and INT-2 (resolver scope cascade -- pre-existing, covers project-over-workspace shadowing).

---

**R3-L3: Phase 2.2.7 workflow-compatible route is a NEW Studio API route but Phase 2.2 header says "1 package" -- this is correct (Studio only) but the route needs project-scoping verification**

Phase 2.2.7 creates `apps/studio/src/app/api/projects/[id]/tools/workflow-compatible/route.ts`. This is a project-scoped route (`/api/projects/:id/...`). Per CLAUDE.md "Project isolation in routes": "Every query in a project-scoped route MUST include `projectId` in the filter."

The LLD Phase 2.2.7 says "returning tools whose referenced auth profile has neither `usageMode: 'jit'` nor `connectionMode: 'per_user'`" but does not specify that the query MUST include `{ projectId: params.id, tenantId: user.tenantId }`. This is implicit from CLAUDE.md invariants, but given the number of project-isolation findings in past reviews, it should be explicit.

**Location**: Phase 2.2.7 (line 604)
**Fix**: Add to Phase 2.2.7: "Query MUST include `{ projectId: params.id, tenantId: user.tenantId }` per CLAUDE.md project isolation invariant."

---

### FR Coverage Table

| FR    | LLD Phase(s)                    | Status  | Notes                                        |
| ----- | ------------------------------- | ------- | -------------------------------------------- |
| FR-1  | Pre-existing (not r2 scope)     | N/A     | Already implemented and verified             |
| FR-2  | Pre-existing (not r2 scope)     | N/A     | Already implemented and verified             |
| FR-3  | Pre-existing (not r2 scope)     | N/A     | Already implemented and verified             |
| FR-4  | Pre-existing (not r2 scope)     | N/A     | Already implemented and verified             |
| FR-5  | Pre-existing (not r2 scope)     | N/A     | Already implemented and verified             |
| FR-6  | Pre-existing (not r2 scope)     | N/A     | Already implemented and verified             |
| FR-7  | Pre-existing (not r2 scope)     | N/A     | Already implemented and verified             |
| FR-8  | Pre-existing (not r2 scope)     | N/A     | Already implemented and verified             |
| FR-9  | Phase 1.1                       | COVERED | Workflow tool_call middleware wiring         |
| FR-10 | Phase 1.2                       | COVERED | Tenant-scope $or filter + lint hook          |
| FR-11 | Phase 1.3 (a/b/c)               | COVERED | MCP unified auth (3 sub-commits)             |
| FR-12 | Phase 2.1                       | COVERED | Studio Test OAuth grant resolution           |
| FR-13 | Phase 3 (A-F, 6 sub-phases)     | COVERED | Workspace OAuth with ST-1 retrofit           |
| FR-14 | Phase 2.2                       | COVERED | Studio UI forms + workflow-compatible filter |
| FR-15 | Phase 4 (4.1-4.7, 7 sub-phases) | COVERED | Runtime protocol handlers                    |
| FR-16 | Phase 5.1                       | COVERED | Vocabulary alignment + migration             |
| FR-17 | Phase 5 (5.2-5.7)               | COVERED | Matrix E2E + sanitizer + drift lint          |

**All 9 r2 FRs (FR-9..FR-17) have corresponding implementation tasks.** No FR-to-task gaps found.

---

### Test Mapping Table

| Test ID    | Type | FR/Contract    | LLD Phase Delivering Code | Phase Delivering Test | Status  |
| ---------- | ---- | -------------- | ------------------------- | --------------------- | ------- |
| E2E-1..5   | E2E  | FR-1..FR-8     | Pre-existing              | Pre-existing          | N/A     |
| E2E-6      | E2E  | FR-9           | Phase 1.1                 | Phase 5               | COVERED |
| E2E-7      | E2E  | FR-12/FR-13    | Phase 2.1 + Phase 3       | Phase 5               | COVERED |
| E2E-8      | E2E  | FR-11          | Phase 1.3                 | Phase 5               | COVERED |
| E2E-9      | E2E  | FR-16          | Phase 5.1                 | Phase 5               | COVERED |
| E2E-10     | E2E  | FR-17          | All phases                | Phase 5.2             | COVERED |
| E2E-ERR-1  | E2E  | FR-14          | Phase 2.2                 | Phase 5               | COVERED |
| E2E-ERR-2  | E2E  | FR-14          | Phase 2.2                 | Phase 5               | COVERED |
| E2E-ERR-3  | E2E  | FR-12/FR-13    | Phase 2.1 + Phase 3       | Phase 5               | COVERED |
| E2E-WIRE-1 | E2E  | FR-13          | Phase 3.B                 | Phase 5               | COVERED |
| E2E-WIRE-2 | E2E  | FR-14          | Phase 2.2                 | Phase 5               | COVERED |
| INT-1..8   | INT  | FR-1..FR-8     | Pre-existing              | Pre-existing          | N/A     |
| INT-9      | INT  | FR-9           | Phase 1.1                 | Phase 5               | COVERED |
| INT-10     | INT  | FR-13          | Phase 3.F                 | Phase 5               | COVERED |
| INT-11     | INT  | TI-1/CK-1      | All phases                | Phase 5.5             | COVERED |
| INT-12     | INT  | FR-11/CK-1     | Phase 0.4 + 1.3           | Phase 5               | COVERED |
| INT-13     | INT  | GAP-22/OQ-14   | Phase 1.3.b.8             | Phase 5               | COVERED |
| INT-14     | INT  | Redis degraded | Phase 1.3                 | Phase 5               | COVERED |

**All 15 E2E and 14 INT scenarios map to phases that deliver the code they exercise.** No test-to-phase gaps found.

---

### Signature Verification Summary

| Function/Method                   | LLD Reference           | Actual Signature                                                        | Match?  | Issue                                                |
| --------------------------------- | ----------------------- | ----------------------------------------------------------------------- | ------- | ---------------------------------------------------- |
| `AuthProfileCache.key()`          | Phase 1.2.2b (line 439) | `(tenantId, profileId, environment): string`                            | CORRECT | LLD correctly identifies CK-1 rewrite needed         |
| `resolveClientCredentialsToken()` | Phase 4.1.3 (line 774)  | `(profileId, tenantId, tokenUrl, clientId, clientSecret, scopes, deps)` | GAP     | Missing `profileVersion` for CK-1 (R3-H1)            |
| `applyAuth()`                     | Phase 0.1 (line 227)    | `(params: ApplyAuthParams): ApplyAuthResult`                            | CORRECT | `signRequest` not yet on result; Phase 4.2 adds it   |
| `resolveAuthHeaders()`            | Phase 1.3.b (line 496)  | `(config, tenantId?): Promise<Record<string,string>>`                   | CORRECT | LLD correctly mandates `tenantId` to required        |
| `tool-test-service.ts:719-723`    | Phase 2.1 (line 561)    | `throw new Error('does not yet support OAuth grant-backed...')`         | CORRECT | LLD correctly targets this throw                     |
| `resolveAuthProfileCredentials()` | Phase 1.2 (line 438)    | `(authProfileId, tenantId): Promise<AuthProfileCredentials \| null>`    | CORRECT | ID-based lookup with tenantId, no $or needed (R3-M2) |

---

### Migration Script Completeness

| Script                             | Idempotent | --dry-run | --restore   | --limit | Connection | Batch-safe | Verdict       |
| ---------------------------------- | ---------- | --------- | ----------- | ------- | ---------- | ---------- | ------------- |
| `migrate-profile-version-backfill` | Yes        | Yes       | N/A (R2-L1) | No      | Not spec'd | Concern    | R3-M4 applies |
| `migrate-mcp-auth-profile-split`   | Yes        | Yes       | Yes         | Yes     | Not spec'd | Yes        | R3-M4 applies |
| `migrate-auth-aliases`             | Yes        | Yes       | Yes         | No      | Not spec'd | Concern    | R3-M4 applies |

---

### Exit Criteria Measurability

All phase exit criteria are measurable (build commands, test passes, specific assertion outcomes) except:

- Phase 1.2 exit criteria use "INT-?" placeholder (R3-L2)
- Phase 1.3.c exit criteria use "INT-?" for trace verification (same pattern -- should reference INT-8 or INT-11)

---

### VERIFIED Checklist

- [x] **FR coverage**: All 9 r2 FRs (FR-9..FR-17) map to at least one LLD phase with shipping implementation tasks. No FR gaps.
- [x] **File paths (existing)**: 9 of 11 verified file paths are correct. 2 wrong paths found (R3-C1 + R3-H2).
- [x] **File paths (new)**: All 19 new files in the New Files table are correctly tagged as NEW with proper paths within existing package structures.
- [x] **Signature accuracy**: 5 of 6 verified signatures match actual code. 1 gap found (R3-H1: `resolveClientCredentialsToken` missing CK-1 params).
- [x] **Migration scripts**: Idempotency and --dry-run specified for all 3. Connection handling and batch sizing need specification (R3-M4).
- [x] **Acceptance criteria**: 15 of 16 criteria are measurable and complete. 1 gap: FR-14 Studio form round-trip (R3-M3).
- [x] **Exit criteria measurability**: All exit criteria are measurable except 2 "INT-?" placeholders (R3-L2).
- [x] **Test mapping**: All 15 E2E and 14 INT scenarios from the test spec map to LLD phases that deliver the tested functionality. No test-to-phase gaps.

---

### Summary

| Severity | Count | Must Fix Before Implementation? |
| -------- | ----- | ------------------------------- |
| CRITICAL | 1     | Yes                             |
| HIGH     | 3     | Yes                             |
| MEDIUM   | 5     | Recommended                     |
| LOW      | 3     | No                              |

**Verdict: NEEDS_REVISION** -- 1 CRITICAL finding (HttpToolExecutor path wrong in 4 LLD locations -- implementer would create code in nonexistent directory) and 3 HIGH findings (resolveClientCredentialsToken signature gap for CK-1, trace event registry wrong file, Phase 1.2 internal contradiction on CK-1 timing) require LLD edits before implementation.

---

## Phase 4b -- Round 4 (lld-reviewer): Test Spec Cross-References + Remaining Placeholders

**Date**: 2026-05-01
**Reviewer**: lld-reviewer (claude-opus-4-6)
**Focus**: Test spec section references, remaining INT-? placeholders, Phase 0.2 exit criteria self-containment, AUTH_PROFILE_AUTH_TYPES vs SUPPORTED_AUTH_TYPES bridge note

Note: Round 4 was a targeted follow-up on R3 clean-up items. 4 findings were applied:

1. Test spec section references corrected (SS4 to SS2, SS5 to SS3)
2. Remaining INT-? placeholders in Phase 1.3.c exit criteria replaced with INT-10/INT-12
3. Phase 0.2 exit criteria made self-contained (removed dependency on Phase 3 for verification wording)
4. AUTH_PROFILE_AUTH_TYPES vs SUPPORTED_AUTH_TYPES bridge note added to Phase 5.7 drift lint description

---

## Phase 4b -- Round 5 (lld-reviewer): Final Sweep

**Date**: 2026-05-01
**Reviewer**: lld-reviewer (claude-opus-4-6)
**Focus**: Task independence, wiring checklist verification, domain rule compliance, R1-R4 regression, acceptance-criteria-to-test mapping, open question hygiene, decision log integrity, sub-commit boundary review
**Files verified**: 28 source files, full LLD (1168 lines), test spec (424 lines), trace-event-registry.ts (310 lines), role-permissions.ts (200 lines), all R1-R4 log entries

### VERDICT: APPROVED

---

### R1-R4 Regression Check

| Round    | Finding ID                           | Status   | Notes                                                                   |
| -------- | ------------------------------------ | -------- | ----------------------------------------------------------------------- |
| R1-C1    | ST-1 CSRF cookie on project initiate | VERIFIED | Phase 3.C.1b explicitly adds the cookie-set task                        |
| R1-C2    | 404-to-400 status code change        | VERIFIED | Phase 3.C.6 documents the change                                        |
| R1-H1    | WORKSPACE_PERMISSIONS shape          | VERIFIED | Phase 0.2 task 0.2.1 says "as const object"                             |
| R1-H2    | TraceStore scope clarification       | VERIFIED | Phase 5.6.1 scope clarification present                                 |
| R1-H3    | AuthProfileCache CK-1 task           | VERIFIED | Phase 1.2.2b rewrites key()                                             |
| R1-H4    | RP-1 at EndUserOAuthToken write      | VERIFIED | Phase 3.D.3 calls assertNotReservedPrincipal                            |
| R1-M1    | OAuthStateSchema.strict()            | VERIFIED | Phase 3.C.7 specifies the change                                        |
| R1-M3    | tenantId required in MCP resolver    | VERIFIED | Phase 1.3.b.4 mandates required tenantId                                |
| R1-M4    | azure_ad cache reuse                 | VERIFIED | Phase 4.1.3 reuses resolveClientCredentialsToken                        |
| R2-H1    | SSRF assertUrlSafeForSSRF            | VERIFIED | Phase 1.3.b.6 references canonical validator                            |
| R2-H2    | Rate limiter specification           | VERIFIED | Phase 1.3.b.8 specifies Redis sliding window                            |
| R2-H3    | ToolBindingExecutor path             | VERIFIED | Phase 1.1.1 uses packages/compiler path                                 |
| R2-M2    | TENANT_ROLE_PERMISSIONS              | VERIFIED | Phase 0.2.2 specifies workspace-auditor key                             |
| R2-M3    | OAuth state service shape            | VERIFIED | Phase 3.A.1 specifies pure function signatures                          |
| R2-M4    | pre-save hook explicit API           | VERIFIED | Phase 0.4.2 has explicit .pre('save')                                   |
| R2-M5    | SUPPORTED_AUTH_TYPES naming          | VERIFIED | Phase 5.7.1 consistent naming + bridge note                             |
| R3-C1    | HttpToolExecutor path                | VERIFIED | All references use packages/compiler path                               |
| R3-H1    | resolveClientCredentialsToken CK-1   | VERIFIED | Phase 1.2.c expands signature                                           |
| R3-H2    | trace-event-registry.ts path         | PARTIAL  | Phase 5.6.2 correct; wiring checklist line 1031 still wrong (see R5-M1) |
| R3-H3    | Phase 1.2 CK-1 contradiction         | VERIFIED | Files-touched note corrected                                            |
| R3-M1    | Phase 1.2 package count              | VERIFIED | Header says "3 packages + hooks"                                        |
| R3-M2    | $or for name-based only              | VERIFIED | Phase 1.2.2 clarifies scope                                             |
| R3-M3    | FR-14 acceptance criteria            | VERIFIED | Section 6 includes FR-14 round-trip                                     |
| R3-M4    | Migration script specs               | VERIFIED | Section 5 specifies connection/logging                                  |
| R3-M5    | Digest integration seam              | VERIFIED | Phase 4.3.1-4.3.2 specifies seam                                        |
| R3-L1    | OQ-6 MCP path                        | PARTIAL  | See R5-L2                                                               |
| R3-L2    | INT-? placeholders                   | VERIFIED | All replaced                                                            |
| R4 fixes | All 4 items                          | VERIFIED | Applied correctly                                                       |

---

### MEDIUM Findings

**R5-M1: Wiring checklist line 1031 still references wrong trace event file (R3-H2 incomplete propagation)**

The R3-H2 fix correctly updated Phase 5.6.2 (line 983) and the Modified Files table (line 252) to reference `packages/shared-kernel/src/constants/trace-event-registry.ts`. However, the wiring checklist at line 1031 still says: "3 new TraceStore event types registered in packages/shared-kernel/src/types/trace-event.ts"

This should reference `trace-event-registry.ts`, consistent with the R3-H2 fix applied elsewhere.

**Location**: Section 4, Wiring Checklist, Backend wiring, line 1031
**Fix**: Change `packages/shared-kernel/src/types/trace-event.ts` to `packages/shared-kernel/src/constants/trace-event-registry.ts`

---

**R5-M2: Phase 5.6.2 does not specify updating TRACE_EVENT_GROUPS and ALL_TRACE_EVENT_TYPES -- new events will not be part of TraceEventType union**

Phase 5.6.2 says: "Add the new constant to the ExtendedTraceEventType union in the same file." But ExtendedTraceEventType is defined as a type alias for TraceEventType, which is derived from ALL_TRACE_EVENT_TYPES. ALL_TRACE_EVENT_TYPES is a spread of all per-domain arrays. To include the new AUTH_PROFILE_TRACE_EVENT_TYPES in the type, Phase 5.6.2 must also: (1) Add auth_profile key to TRACE_EVENT_GROUPS object (line 257-278), (2) Add spread to ALL_TRACE_EVENT_TYPES (lines 282-303). Without these two steps, the new event types will NOT be included in TraceEventType and TypeScript will reject them at trace emission sites.

**Location**: Phase 5.6.2 (line 983)
**Fix**: Expand Phase 5.6.2 to include: "Add auth_profile: AUTH_PROFILE_TRACE_EVENT_TYPES to the TRACE_EVENT_GROUPS object and ...AUTH_PROFILE_TRACE_EVENT_TYPES to the ALL_TRACE_EVENT_TYPES spread, following the existing per-domain pattern."

---

**R5-M3: Phase 5.1 header says "2 packages" but tasks touch 3 npm packages**

Phase 5.1 header (line 906) says "2 packages". Tasks touch: packages/shared, packages/compiler, apps/workflow-engine = 3 distinct npm packages. Still within the 3-package commit-scope guard limit, but the header is inaccurate.

**Location**: Phase 5.1 header (line 906)
**Fix**: Change "2 packages" to "3 packages"

---

**R5-M4: Phase 5.6 header says "2 packages" but tasks touch 4 npm packages -- exceeds 3-package commit-scope guard**

Phase 5.6 header (line 978) says "2 packages". Tasks touch: packages/shared-kernel (5.6.2), packages/shared-auth-profile (5.6.3), apps/studio (5.6.4 -- tool-test-service.ts, OAuth callbacks), apps/runtime (5.6.4 -- resolve-tool-auth.ts). That is 4 distinct npm packages, exceeding the CLAUDE.md 3-package commit-scope guard. The implementer will be blocked by `.claude/hooks/commit-scope-guard.sh`.

**Location**: Phase 5.6 header (line 978)
**Fix**: Split Phase 5.6 into two sub-commits: 5.6a (2 packages: trace-event-registry.ts + sanitize-error.ts creation + unit tests in shared-kernel + shared-auth-profile), 5.6b (2 packages: replace ad-hoc error strings with sanitizeAuthProfileError() in studio + runtime consumers).

---

**R5-M5: Phase 1.1 task 1.1.6 references nonexistent workflow-validator.ts**

Phase 1.1 task 1.1.6 (line 405) says: "Studio create-time block -- reject connectionMode per_user profile reference in workflow tool_call step at workflow validation (existing path in apps/studio/src/services/workflow-validator.ts if present)." The file apps/studio/src/services/workflow-validator.ts does not exist. The "if present" qualifier softens this but the implementer would waste time searching.

**Location**: Phase 1.1 task 1.1.6 (line 405)
**Fix**: Change to: "Studio create-time block -- reject connectionMode per_user profile reference in workflow tool_call step at the existing workflow validation point. Implementer must identify the Studio-side validation path (or document as deferred if no client-side validation layer exists for tool_call auth constraints today)."

---

### LOW Findings

**R5-L1: Phase 5.6.1 still references trace-event.ts in parenthetical**

Phase 5.6.1 (line 982) says: "Wire token-refresh and OAuth-lifecycle events to canonical TraceStore (packages/shared-kernel/src/types/trace-event.ts)." This parenthetical reference should be trace-event-registry.ts or removed. Third occurrence of pre-R3-H2 path not caught by the R3 fix.

**Location**: Phase 5.6.1 (line 982)
**Fix**: Change to "(via trace event types defined in packages/shared-kernel/src/constants/trace-event-registry.ts)."

---

**R5-L2: OQ-6 text still says apps/runtime/src/mcp/\*.ts but actual paths are apps/runtime/src/services/mcp/**

OQ-6 (line 1165) says: "This LLD references apps/runtime/src/mcp/\*.ts for transport refresh wiring." The actual MCP transport files are at apps/runtime/src/services/mcp/. The files-touched list in Phase 1.3.c (line 555) correctly references the right path, but OQ-6 text is stale from R3-L1 partial fix.

**Location**: OQ-6 (line 1165)
**Fix**: Change apps/runtime/src/mcp/_.ts to apps/runtime/src/services/mcp/_.

---

**R5-L3: Phase 2.2 does not include packages/i18n in files-touched for deferred-type API-only notice**

If i18n keys are added for the "API-only" notice text (per R1-L2), packages/i18n/locales/en/studio.json counts toward the package limit. R2-L2 clarified this is deferred (existing entries use hardcoded English). If the implementer adds the notice as hardcoded text (matching existing pattern), no additional package needed.

**Location**: Phase 2.2 files-touched (lines 632-641)
**Fix**: Add note: "If i18n keys are added for the API-only notice text, include packages/i18n in files-touched and update package count from 1 to 2."

---

### Task Independence

All phases are independently completable in a single session. Phase 2.2 (4-5 days, 10 forms) is the largest but decomposes into 10 independent form components. No hidden multi-day work. Dependency chain is: Phase 0 -> Phase 1 -> Phases 2/3/4 (parallel) -> Phase 5.

---

### Wiring Checklist

All 42 wiring checklist items have corresponding producer tasks, consumer tasks, and measurable verification methods. Exception: line 1031 references wrong file (R5-M1). No constructed-but-not-wired components found.

---

### Domain Rules

All CLAUDE.md domain rules verified: createLogger usage, no swallowed catches, no sync I/O, no any, z.string().min(1) for IDs, structured error responses, no Express route ordering issues, in-memory Maps have max size + TTL.

---

### Acceptance Criteria to Test Mapping

All 16 acceptance criteria in Section 6 map to at least one test. No unmapped criteria.

---

### Decision Log Integrity

All 15 decisions (D-1..D-15) are internally consistent with the post-fix LLD. No decision invalidated by any R1-R4 fix.

---

### Sub-Commit Boundary Review

| Phase | Header        | Actual Packages | Within limit?             |
| ----- | ------------- | --------------- | ------------------------- |
| 0.1   | 2 pkg         | 2               | Yes                       |
| 0.2   | 2 pkg         | 2               | Yes                       |
| 0.3   | 2 pkg         | 2               | Yes                       |
| 0.4   | 2 pkg         | 1 + tools/      | Yes                       |
| 1.2   | 3 pkg + hooks | 3 + hooks       | Yes (at limit)            |
| 1.3.b | 2 pkg         | 2               | Yes                       |
| 3.F   | 2 pkg         | 2               | Yes                       |
| 5.1   | 2 pkg         | 3               | Inaccurate header (R5-M3) |
| 5.6   | 2 pkg         | 4               | EXCEEDS (R5-M4)           |

---

### Summary

| Severity | Count | Must Fix Before Implementation?       |
| -------- | ----- | ------------------------------------- |
| CRITICAL | 0     | --                                    |
| HIGH     | 0     | --                                    |
| MEDIUM   | 5     | Recommended (R5-M4 will block commit) |
| LOW      | 3     | No                                    |

**Verdict: APPROVED** -- No CRITICAL or HIGH findings. R5-M4 (Phase 5.6 exceeding 3-package limit) is the most actionable -- the implementer will be blocked by the commit-scope guard hook. The other 4 MEDIUM findings are quality improvements. All R1-R4 fixes verified except one partial regression in wiring checklist path (R5-M1).

**Recommendation: Proceed to rounds 6-8 (platform / industry / OSS audit, parallel).**

**Implementation Notes:**

1. Phase 5.6 MUST be split before commit (4 packages exceeds 3-package guard).
2. Phase 5.1 header says "2 packages" but touches 3 -- at the limit. Header correction is cosmetic.
3. OQ-6 path is cosmetically wrong; Phase 1.3.c files-touched is correct.
4. Phase 5.6.2: follow the per-domain pattern (define array, add to TRACE_EVENT_GROUPS, add to ALL_TRACE_EVENT_TYPES spread) to ensure TraceEventType includes new events.
5. Phase 1.1 task 1.1.6: workflow-validator.ts does not exist -- implementer should locate or defer.

---

## Phase 4b -- Round 7 (industry research, training-grounded)

**Date**: 2026-05-01
**Reviewer**: industry-research auditor (claude-opus-4-6)
**Focus**: 10 areas -- token refresh at scale, MCP transport refresh, CK-1 cache key composition, OAuth state CSRF, SigV4 completeness, HAWK maintenance, phasing order, test strategy, migration idempotency, operational concerns
**Method**: Training-data-grounded research. No live web access. Confidence levels: HIGH = stable RFC/spec/standard; MEDIUM = well-documented engineering practice from training data; LOW = inferred from related patterns.

---

### Area 1: Token Refresh + Jitter at Scale

**[IMPROVEMENT] [MEDIUM confidence] Phase 1.3.c (task 1.3.c.1): 30s pre-expiry window is conservative but the 0-5s jitter range is narrower than industry norms for multi-tenant systems.**

HashiCorp Vault's lease renewal adds jitter of 0-10% of the remaining TTL to prevent thundering-herd on simultaneous lease expirations. AWS SDK v3 uses adaptive retry with exponential backoff plus a full-jitter randomization (`random(0, min(cap, base * 2^attempt))` per the AWS Architecture Blog "Exponential Backoff And Jitter"). The LLD's fixed 0-5s window works for small deployments but at scale (hundreds of profiles per tenant renewing near the same time), the 5s window could still cluster refresh bursts within the same window.

**Recommendation**: Scale the jitter proportionally to the token TTL: `jitter = random(0, min(5s, tokenTTL * 0.05))`. For a 3600s token, this gives up to 5s (capped); for a 300s token, this gives up to 15s proportional jitter but capped at 5s. This matches the Vault pattern of percentage-based jitter while preserving the LLD's hard cap.

The 2-3 attempt exponential backoff is well-aligned with standard practice. AWS SDK uses up to 5 retries with decorrelated jitter; Google Cloud client libraries use 3 retries with exponential backoff. 2-3 attempts is a reasonable middle ground given the 30s pre-expiry window constraint.

**Source**: RFC 7231 Section 7.1.3 (Retry-After); AWS Architecture Blog "Exponential Backoff And Jitter" (training data); HashiCorp Vault token renewal documentation (lease_duration jitter pattern); Google Cloud API Design Guide retry specification.

---

**[RISK] [MEDIUM confidence] Phase 1.3.b.8: Rate limiter spec (Redis sliding window, 30 req/min default per `{tenantId, profileId}`) may be too restrictive for Azure AD / Microsoft Entra ID workloads.**

Microsoft identity platform rate limits are documented at approximately 200 requests per second aggregate per tenant for the `/oauth2/v2.0/token` endpoint (though the exact numbers are subject to change and Microsoft's documentation notes per-app and per-tenant tiers). AWS STS has a documented default rate of approximately 100 `AssumeRole` requests per second per AWS account (can be raised via service quota increase).

The LLD's 30 req/min (0.5 req/sec) per `{tenantId, profileId}` is dramatically lower than either provider's limit. For a single MCP server profile making frequent tool calls that each require token resolution, 30/min could be hit under moderate load. However, because tokens are cached (CK-1 with TTL), the actual outbound token-exchange rate should be approximately 1 per token lifetime per profile, so the 30/min cap would only trigger during cache-miss storms or rapid profile-version bumps.

**Recommendation**: The 30/min default is safe for normal operation (cached tokens absorb load). Add a note to Phase 1.3.b.8 that the default can be raised per-tenant via configuration if a customer runs workloads with high cache-miss rates (e.g., many short-lived scoped tokens). Consider a `TOKEN_EXCHANGE_RATE_LIMIT` env var defaulting to 30 but overridable per deployment.

**Source**: Microsoft identity platform throttling documentation (training data); AWS STS API throttling documentation (training data, documented in AWS service quotas); Redis `ZRANGEBYSCORE` sliding-window rate limiter pattern.

---

### Area 2: MCP Token Refresh on Long-Lived Transports

**[IMPROVEMENT] [HIGH confidence] Phase 1.3.c (tasks 1.3.c.3-1.3.c.5): The LLD's HTTP hot-swap and SSE close-and-reconnect patterns are correct per MCP Authorization specification, but the LLD does not address in-flight tool call orphaning on SSE close.**

Per the MCP specification (2025-03-26 revision), authorization MUST be included in every HTTP request. For Streamable HTTP transport, each request carries its own `Authorization` header, making hot-swap straightforward. For SSE transport, the authorization is set at connection establishment time and cannot be changed mid-stream, so close-and-reconnect is the only viable pattern.

Known failure modes the LLD does not address:

1. **Orphaned in-flight tool calls on SSE close**: When the SSE connection is closed for token refresh (Phase 1.3.c.5), any tool call whose response has not yet been streamed back is lost. The MCP SDK does not automatically replay pending requests on reconnect. The LLD's "next tool call drives reconnect" (1.3.c.4) handles NEW calls, but what about the one that was in-flight when the stream closed? The caller receives a connection error, not a tool result.

2. **Session state preservation on reconnect**: The MCP Streamable HTTP transport uses session IDs (`Mcp-Session-Id` header). When reconnecting after SSE close, the new connection should reuse the session ID if the server supports session resumption. The LLD does not specify whether session ID is preserved across refresh-driven reconnects.

**Recommendation**: Add to Phase 1.3.c.5: "On SSE close for refresh, any in-flight tool call response is lost. The caller receives a transport error and must retry the tool call on the new connection. Document this in the error message: `AUTH_REFRESH_SSE_RECONNECT` (new error code) with user message 'Connection refreshed; please retry the operation.' Preserve `Mcp-Session-Id` across refresh-driven reconnects if the server advertises session support."

**Source**: MCP Specification 2025-03-26, Section "Authorization" (MUST include authorization in every HTTP request); MCP Streamable HTTP Transport specification (session ID semantics); general SSE reconnection patterns (EventSource `lastEventId` semantics per W3C Server-Sent Events specification).

---

### Area 3: CK-1 Cache Key Composition

**[IMPROVEMENT] [MEDIUM confidence] Phase 1.2.2b / Phase 1.3.b.4: CK-1 key `{tenantId}:{authType}:{profileId}:{profileVersion}:{scopeHash}[:{principalKind}:{principalId}]` is well-structured but may face cardinality pressure under per-user (`principalId`) scenarios.**

Industry patterns for tenant-scoped credential caches:

- **HashiCorp Vault**: Lease IDs are globally unique (UUID); cache lookup is by lease ID. The versioning dimension is handled by lease generation number, analogous to `profileVersion`. Vault does NOT hash composite keys; it uses atomic identifiers.
- **Google Cloud KMS**: Key-ring versioning uses `{projectId}/{location}/{keyRingId}/{cryptoKeyId}/{version}` -- a hierarchical path. Version is a monotonic integer, matching `profileVersion`.
- **AWS IAM**: STS session tokens are keyed by `{roleArn}:{sessionName}:{serialNumber}`. No composite hash; each dimension is a separate segment.

The LLD's colon-separated composite key follows the Redis key convention. The `scopeHash` (SHA-256 of sorted scopes) is a sound choice -- it avoids key explosion from scope permutations. The `profileVersion` dimension ensures stale credentials are never served after config mutation.

**Potential cardinality cliff**: For `per_user` profiles with `principalId`, each user gets a separate cache entry. In a tenant with 10,000 active users and 5 `per_user` profiles, that is 50,000 cache keys. Redis handles this easily (millions of keys are routine), but the in-memory `Map` fallback (dev-only) with a max size of 200 (per CLAUDE.md "every in-memory Map needs max size") would thrash constantly with LRU evictions.

**Recommendation**: No change needed for the key structure itself -- it is sound. Add a note to Phase 1.3.b.5 (Map fallback): "The Map fallback is adequate only for dev/test with limited users. For `per_user` profiles in dev, the Map will evict frequently due to max-size=200; this is acceptable as it only affects local development latency, not correctness."

**Source**: HashiCorp Vault Secrets Engine documentation (lease versioning); Google Cloud KMS key-version hierarchy; AWS STS `AssumeRole` session token caching pattern; Redis key-space best practices (redis.io documentation on key naming).

---

### Area 4: OAuth State Binding + CSRF + Atomic GETDEL

**[IMPROVEMENT] [HIGH confidence] Phase 3.C (tasks 3.C.1-3.C.7): The LLD's callback verification ordering is sound and aligns with RFC 6749, but the CSRF cookie cleanup is not specified.**

RFC 6749 Section 10.6 ("Authorization Code Redirection URI Manipulation") requires the authorization server to ensure the `redirect_uri` in the token request matches the one used during authorization. Section 10.12 ("Cross-Site Request Forgery") mandates the client bind the authorization request to the user agent's authenticated state (i.e., a CSRF token).

The LLD's ordering (Phase 3.C.3):

1. Atomic GETDEL (replay protection)
2. `tenantId` match
3. CSRF cookie match
4. `redirect_uri` match

This ordering is well-aligned with Auth0's Universal Login callback verification (state parameter first, then token exchange with redirect_uri). Okta's OAuth 2.0 implementation guide recommends: verify state parameter, verify nonce (for OIDC), then proceed to token exchange. Azure AD B2C follows the same pattern.

The atomic GETDEL-first approach is superior to read-then-delete because it prevents time-of-check-to-time-of-use (TOCTOU) races. Auth0 and Okta use database-level atomic operations for state consumption.

**One edge case**: If GETDEL succeeds but the subsequent verification fails (e.g., CSRF mismatch), the state is already consumed and the legitimate user cannot retry. The LLD correctly handles this by returning a structured error (400 + audit), and the user must re-initiate. This is the correct trade-off: consuming state on first use prevents replay attacks even at the cost of requiring re-initiation on CSRF mismatch. This matches Auth0's behavior.

**Minor improvement**: The LLD should explicitly state that the CSRF cookie is cleared (deleted) after verification regardless of outcome. If the callback fails, a stale CSRF cookie should not persist.

**Recommendation**: Add to Phase 3.C.3 after the verification steps: "After verification (pass or fail), delete the CSRF nonce cookie by setting it with `maxAge: 0`. This prevents stale cookies from persisting across flows."

**Source**: RFC 6749 Sections 10.6 and 10.12; RFC 6819 Section 4.4.1.8 (CSRF Countermeasures); Auth0 "State Parameter" documentation (training data); OWASP OAuth 2.0 Security Cheat Sheet.

---

### Area 5: SigV4 with `signRequest` Callback

**[GAP] [HIGH confidence] Phase 4.2 (tasks 4.2.1-4.2.5): The `signRequest` callback signature `(assembled: { method, url, headers, body? }) => Promise<Headers>` lacks the `region` and `service` parameters needed by AWS SigV4, and the closure-capture pattern is not documented.**

AWS Signature Version 4 requires the following inputs to produce a valid signature:

- HTTP method, URL, headers, and body (all present in `AssembledRequest`)
- AWS region (e.g., `us-east-1`)
- AWS service name (e.g., `s3`, `execute-api`, `bedrock`)
- AWS credentials (`accessKeyId`, `secretAccessKey`, optional `sessionToken`)

The `@aws-sdk/signature-v4` package's `SignatureV4.sign()` method requires a `SignableRequest` (method, hostname, path, headers, body) plus `region` and `service` configured at construction time or per-call.

The LLD's `signRequest` callback receives `AssembledRequest` (method, url, headers, body) but NOT region, service, or credentials. These are presumably captured in the closure when the protocol handler creates the callback:

```typescript
// Phase 4.2 handler would construct the callback like:
const signer = new SignatureV4({ credentials, region, service, sha256: Sha256 });
return {
  signRequest: async (assembled) => {
    const signed = await signer.sign(toSignableRequest(assembled));
    return signed.headers;
  },
};
```

This closure-capture pattern works, but the LLD should make it explicit. The risk is that an implementer might try to pass region/service/credentials through the `AssembledRequest` interface (which would break the interface contract for non-AWS protocols).

**Recommendation**: Add to Phase 4.2.2: "The `signRequest` callback for `aws_iam` captures `region`, `service`, and `credentials` in closure scope at callback construction time (inside the protocol handler). These are NOT passed through the `AssembledRequest` interface -- that interface is protocol-agnostic. The handler constructs an `@aws-sdk/signature-v4` `SignatureV4` instance with the profile's stored `region`, `service`, `accessKeyId`, `secretAccessKey`, and optional `sessionToken`, then returns a closure that calls `signer.sign()` with the assembled request."

**Source**: AWS Signature Version 4 specification (docs.aws.amazon.com/general/latest/gr/sigv4_signing.html, from training data); `@aws-sdk/signature-v4` package API (`sign(request, options?)` method signature); RFC 2104 (HMAC, underlying SigV4 MAC).

---

### Area 6: HAWK MAC Signing -- `@hapi/hawk` Maintenance Status

**[RISK] [MEDIUM confidence] Phase 4.4 (task 4.4.1): `@hapi/hawk` is the canonical implementation by the HAWK protocol's author (Eran Hammer) but has low maintenance activity.**

From training data (up to early 2025):

- `@hapi/hawk` is part of the hapi.js ecosystem maintained by the hapi project (initially Eran Hammer, later community-maintained under the `@hapi` npm scope).
- The HAWK protocol itself (draft-hammer-oauth-v2-mac-token) was an IETF Internet-Draft that expired and was never standardized as an RFC. It is a de facto standard used in Mozilla's ecosystem (Firefox Accounts, Firefox Sync) but has not seen broad adoption outside that ecosystem.
- The `@hapi/hawk` package on npm shows infrequent updates. The hapi ecosystem as a whole saw reduced maintenance activity after Eran Hammer stepped back from active development (around 2019-2020). The `@hapi` scope packages are now maintained by community contributors with varying levels of activity.
- No known critical CVEs in `@hapi/hawk` as of training data cutoff, but the package's dependency tree includes `@hapi/hoek`, `@hapi/boom`, `@hapi/cryptiles`, and `sntp` -- all from the hapi ecosystem.
- The HAWK specification is simple (HMAC-based MAC with timestamp and nonce) and unlikely to require protocol-level changes, so low maintenance is acceptable for a stable specification.

**Recommendation**: The adoption is reasonable given: (a) it is the only canonical implementation, (b) the protocol is stable and simple, (c) the LLD already uses `optionalDependencies` pattern for higher-risk native deps like `kerberos`. However, add to Phase 4.4.1: "CVE review of `@hapi/hawk` and its transitive dependencies (`@hapi/hoek`, `@hapi/boom`, `@hapi/cryptiles`, `sntp`) required before adoption. Document findings in commit message. If CVEs are found, evaluate `hawk` (non-scoped, npm) as an alternative or consider a lightweight in-house HMAC-MAC implementation (~100 lines, the protocol is simple)."

**Source**: IETF draft-hammer-oauth-v2-mac-token (expired Internet-Draft); `@hapi/hawk` npm package metadata (training data); hapi.js project maintenance history (training data).

---

### Area 7: Phasing Order Risk

**[IMPROVEMENT] [MEDIUM confidence] Overall phasing (Phase 0 -> 1 -> 2/3/4 parallel -> 5): Well-aligned with industry patterns for auth-method backend rollouts, with one observation about Phase 0 front-loading.**

Industry comparisons:

- **HashiCorp Vault auth method backends**: New auth methods (AppRole, JWT/OIDC, Azure) follow a pattern of: (1) register the auth method with the mount system, (2) implement the handler, (3) add CLI/API surface, (4) add tests. This matches the LLD's data-model-first approach. Vault always lands the mount registration (analogous to Phase 0's schema + consolidation) before the handler logic.

- **Auth0 Connections**: Auth0's connection pipeline is: (1) connection schema (database migration), (2) strategy implementation (protocol handler), (3) management API surface, (4) Universal Login UI integration. This closely mirrors the LLD's Phase 0 (schema) -> Phase 1 (resolver/middleware) -> Phase 2/3 (UI) -> Phase 4 (protocol handlers) ordering.

- **Stripe payment-method types**: Stripe adds payment methods with: (1) schema migration + API read-path support, (2) write-path + validation, (3) Connect platform support, (4) Dashboard UI. The read-before-write pattern ensures forward compatibility.

The LLD's ordering is sound. Phase 4 (protocol handlers) being parallel with Phase 2/3 (UI + OAuth) is the one area where Stripe and Auth0 would differ -- they typically land protocol handlers before UI exposure to avoid UI surfaces that reference unimplemented protocols. The LLD handles this with feature flags (FF-1 per protocol), which is the correct mitigation.

**One observation**: Phase 0 has 4 sub-commits totaling ~2.25 days. This is a significant upfront investment before any user-visible feature ships. In HashiCorp Vault's release process, they typically ship the auth method handler in the same release as the mount registration, not in separate phases. The LLD's separation is driven by CLAUDE.md commit-scope constraints (max 3 packages), which is a valid architectural constraint. No change needed.

**Source**: HashiCorp Vault auth method backend implementation pattern (training data, Vault source code structure); Auth0 Connections architecture (training data); Stripe payment-method type rollout pattern (Stripe engineering blog, training data).

---

### Area 8: Test Strategy Adequacy

**[RISK] [MEDIUM confidence] Phase 5.2: Matrix E2E (161 cells) with 0% flake budget over 50 runs is ambitious. Known flake patterns in matrix test suites suggest specific mitigations the LLD should address.**

Matrix test suites are common in auth/payment ecosystems:

- **HashiCorp Vault**: The acceptance test suite for auth methods runs a matrix of (auth method x backend x token type). Known flake sources: (a) token TTL races (token expires between issuance and assertion), (b) Redis connection pool exhaustion under parallel test execution, (c) DNS resolution flakiness for mock IdP endpoints.

- **Stripe payment-method matrix**: Stripe's test matrix (payment method x currency x country x 3DS/non-3DS) uses deterministic fixtures and time-frozen test clocks to avoid TTL-based flakes. Their `TestClock` API was purpose-built for this.

- **Auth0**: Their integration test suite for connections uses a combination of (a) deterministic mock IdP responses, (b) fixed timestamps for token generation, and (c) isolated Redis instances per test run.

Known flake patterns relevant to the LLD's 161-cell matrix:

1. **Token TTL races**: A token issued with a 60s TTL might expire between issuance and the assertion step if test execution is slow. The LLD's `beforeEach: FLUSHDB` (Phase 5.2.4) helps by resetting state, but token TTL-based assertions need frozen or mocked time.

2. **Redis `SELECT` + `FLUSHDB` ordering**: If `FLUSHDB` runs before `SELECT` completes (race in async Redis commands), it flushes the wrong database. The LLD should specify `await redis.select(DB)` then `await redis.flushdb()` with explicit sequencing.

3. **Port collision on random-port allocation**: 161 test cells, each potentially starting services on random ports. If cells run in parallel, port exhaustion or collision is possible. The LLD does not specify whether matrix cells run sequentially or in parallel.

4. **Cache cross-contamination between cells**: Phase 5.2.5 says "cell N's Redis state must not satisfy cell N+1's assertion." This is correct but relies solely on `FLUSHDB`. If any test cell writes to the in-memory Map fallback (which is process-local and NOT flushed by `FLUSHDB`), cross-contamination can occur.

**Recommendation**: Add to Phase 5.2: (a) "Use frozen/mocked time (`vi.useFakeTimers` or `Date.now` override) for token-TTL-sensitive assertions to prevent TTL races." (b) "Ensure `redis.select()` and `redis.flushdb()` are sequentially awaited." (c) "Specify whether matrix cells run sequentially or in parallel. If parallel, document port allocation strategy and Map fallback isolation." (d) "Disable the in-memory Map fallback during matrix E2E (require Redis) to prevent cache cross-contamination between cells."

**Source**: HashiCorp Vault acceptance test flake patterns (training data, Vault CI documentation); Stripe TestClock API (Stripe documentation, training data); general Redis test isolation patterns.

---

### Area 9: Migration Script Idempotency + Dry-Run

**[IMPROVEMENT] [MEDIUM confidence] Section 5 (Cross-Phase Concerns, Database Migrations): The LLD's migration spec is thorough but misses two patterns from industry migration tooling.**

Industry migration patterns:

- **Stripe's data migration tooling**: Stripe uses chunked progress logging with estimated completion time. Each batch emits `{ batchIndex, totalBatches, processedCount, estimatedRemainingSeconds }`. This is critical for migrations on large collections (millions of documents).

- **Square's migration framework**: Square wraps each batch in a MongoDB transaction (replica-set deployments). If a batch fails mid-way, the transaction rolls back that batch, preserving idempotency. Without transactions, a failed batch leaves partial writes that the idempotency check might skip on re-run (the already-migrated documents in the failed batch would be skipped, but the un-migrated ones in the same batch would be retried -- which IS idempotent if the script's `$exists: false` or similar condition is correct).

- **MongoDB's own migration tooling** (`mongomigrate`, `migrate-mongo`): These tools maintain a `migrations` collection tracking which migrations have run (name + timestamp + status). The LLD's scripts rely on idempotent conditions (`profileVersion: { $exists: false }`) rather than a migration-tracking collection. This is simpler and works for 3 scripts but does not scale to dozens of migrations.

The LLD's Section 5 already specifies: `MONGODB_URI`, `--dry-run`, `--restore` (where applicable), `--limit N`, structured NDJSON logging, and idempotency. This is comprehensive.

**Two missing patterns**:

1. **Chunked progress logging with ETA**: The LLD specifies `{ migration, action, count, durationMs, error? }` per batch but not `totalEstimate` or `estimatedRemainingSeconds`. For a backfill on a large `auth_profiles` collection, operators need to know estimated completion time.

2. **Pre-migration validation step**: Before running the actual migration, verify that the target schema changes have been applied (e.g., `profileVersion` field exists in the schema definition). If the migration script runs against an old schema (pre-Phase-0.4 code deployment), it should warn, not silently proceed.

**Recommendation**: Add to Section 5: (a) "Each script begins with a count query (`countDocuments(filter)`) and emits `{ totalEstimate }` before processing. During processing, each batch emits `{ batchIndex, processedSoFar, totalEstimate, estimatedRemainingMs }`." (b) "The `migrate-profile-version-backfill.ts` script validates that the `profileVersion` field is defined in the current model schema before proceeding. If not (code not deployed yet), exit with a clear error: 'Schema migration not yet deployed. Deploy Phase 0.4 code first.'"

**Source**: Stripe migration tooling patterns (training data, Stripe engineering blog on data migrations); MongoDB `updateMany` with bulk operations documentation; Square's migration framework patterns (training data).

---

### Area 10: Operational Concerns at Scale

**[IMPROVEMENT] [MEDIUM confidence] Deployment sequencing (Phase 1.3.a -> 1.3.b -> 1.3.c -> flag flip): The sequencing is correct but the LLD does not specify a canary strategy or progressive rollout for the flag flip.**

Industry deployment patterns for auth-system changes:

- **HashiCorp Vault**: Auth method enablement is per-mount. Operators enable the auth method on a staging Vault cluster, run integration tests, then enable on production. There is no percentage-based rollout for auth methods.

- **Auth0**: Connection enablement is per-tenant. Auth0 uses a staged rollout: enable for internal tenants -> enable for beta tenants -> enable for all tenants. This is analogous to the LLD's `MCP_AUTH_PROFILE_ENABLED` flag.

- **Stripe**: Payment-method type enablement uses a progressive rollout: 1% of accounts -> 10% -> 50% -> 100%, with automated rollback triggers (error rate > 1% triggers automatic revert). Each stage runs for 24-48 hours.

The LLD's flag-flip approach (`MCP_AUTH_PROFILE_ENABLED=false -> true`) is binary, not progressive. For a multi-tenant platform, a progressive rollout would be safer: enable for specific tenants first, then all tenants.

**[RISK] [MEDIUM confidence] Backward compatibility (alias sunset `v2026.07.x`): The LLD specifies a CI-enforced sunset deadline but does not specify the rollback plan if a customer is still using aliases after the deadline.**

The alias normalization (Phase 5.1) has two layers:

1. Read-path normalization: `normalizeAuthType()` on every read ensures aliases resolve correctly regardless of stored format.
2. Write-path migration: `migrate-auth-aliases.ts` rewrites stored configs.

The sunset at `v2026.07.x` means CI fails on alias use after that release. But if a customer's stored data still contains aliases (migration not run), the read-path normalization handles it. The CI failure only affects new code that tries to use alias names -- not stored data.

**Recommendation**: (a) Add to Phase 1.3 deployment notes: "For multi-tenant deployments, consider enabling `MCP_AUTH_PROFILE_ENABLED` per-tenant before global enablement. The flag implementation should support per-tenant override via a tenant-settings collection or environment variable template (e.g., `MCP_AUTH_PROFILE_ENABLED_{TENANT_ID}=true`)." If per-tenant flags are out of scope, document the risk: "Binary flag flip affects all tenants simultaneously. Rollback is `MCP_AUTH_PROFILE_ENABLED=false` which is instant." (b) Add to Phase 5.1: "The `v2026.07.x` alias sunset enforcement is CI-only. Runtime read-path normalization (`normalizeAuthType()`) continues to handle stored aliases indefinitely, ensuring backward compatibility for data written before the migration runs."

**Source**: Stripe progressive rollout pattern (training data, Stripe engineering blog); Auth0 connection enablement staged rollout; HashiCorp Vault auth method mount lifecycle; Feature flag best practices (LaunchDarkly documentation, training data).

---

**[IMPROVEMENT] [LOW confidence] Section 5 (Data migration risks): The 3 migration scripts are order-independent, but the LLD does not specify whether they can run concurrently (in parallel) or must be sequential.**

For large datasets, running all 3 scripts in parallel (against different collections) would reduce total migration time. Since each script targets a different collection (`auth_profiles`, `mcp_server_configs`, tool config storage), there are no cross-collection write conflicts.

**Recommendation**: Add to Section 5: "All 3 scripts may run concurrently (each targets a different collection with no cross-dependency). For large deployments, running in parallel reduces total migration window."

**Source**: MongoDB documentation on concurrent `updateMany` operations on different collections (no collection-level locking in WiredTiger for writes to different collections).

---

### Summary

| Severity    | Count | Areas                                                                                                                                                                    |
| ----------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GAP         | 1     | Area 5: SigV4 region/service/credentials closure-capture not documented                                                                                                  |
| RISK        | 3     | Area 1 (rate limiter vs provider limits), Area 6 (HAWK maintenance), Area 8 (matrix flakes)                                                                              |
| IMPROVEMENT | 8     | Areas 1, 2, 3, 4, 7, 9, 10 (jitter scaling, SSE orphaning, Map fallback note, CSRF cleanup, phasing validated, migration ETA, progressive rollout, concurrent migration) |

### Consolidated Findings Table

| ID     | Tag                    | Confidence | LLD Phase/Task | Description                                                                                                                                   |
| ------ | ---------------------- | ---------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| IR7-1  | [IMPROVEMENT] [MEDIUM] | MEDIUM     | 1.3.c.1        | Scale jitter proportionally to token TTL (`min(5s, tokenTTL * 0.05)`) to prevent thundering-herd at scale; fixed 0-5s is narrow               |
| IR7-2  | [RISK] [MEDIUM]        | MEDIUM     | 1.3.b.8        | 30 req/min rate limit is safe under caching but add configurable override env var for high-throughput tenants                                 |
| IR7-3  | [IMPROVEMENT] [HIGH]   | HIGH       | 1.3.c.5        | SSE close-for-refresh orphans in-flight tool calls; add `AUTH_REFRESH_SSE_RECONNECT` error code and session-ID preservation on reconnect      |
| IR7-4  | [IMPROVEMENT] [MEDIUM] | MEDIUM     | 1.3.b.5        | In-memory Map fallback (max 200) thrashes under `per_user` cardinality; add dev-only note about expected behavior                             |
| IR7-5  | [IMPROVEMENT] [HIGH]   | HIGH       | 3.C.3          | Clear CSRF nonce cookie after verification (pass or fail) with `maxAge: 0`; prevents stale cookie persistence                                 |
| IR7-6  | [GAP] [HIGH]           | HIGH       | 4.2.2          | `signRequest` callback must capture region/service/credentials in closure; LLD should document the closure-capture pattern explicitly         |
| IR7-7  | [RISK] [MEDIUM]        | MEDIUM     | 4.4.1          | `@hapi/hawk` has low maintenance activity; require CVE review before adoption; document fallback plan (in-house HMAC-MAC ~100 lines)          |
| IR7-8  | [RISK] [MEDIUM]        | MEDIUM     | 5.2            | 0% flake over 50 runs requires: frozen time for TTL assertions, sequential `redis.select()`/`flushdb()`, disabled Map fallback during E2E     |
| IR7-9  | [IMPROVEMENT] [MEDIUM] | MEDIUM     | Section 5      | Add chunked progress logging with ETA and pre-migration schema validation to all 3 migration scripts                                          |
| IR7-10 | [IMPROVEMENT] [MEDIUM] | MEDIUM     | 1.3 deployment | Binary flag flip is instant rollback-safe but consider documenting per-tenant override pattern for progressive rollout                        |
| IR7-11 | [IMPROVEMENT] [MEDIUM] | MEDIUM     | 5.1            | Document that runtime `normalizeAuthType()` read-path normalization persists indefinitely past `v2026.07.x` sunset (CI-only enforcement)      |
| IR7-12 | [IMPROVEMENT] [LOW]    | LOW        | Section 5      | All 3 migration scripts can run concurrently (different collections, no cross-dependency); document parallel-run option for large deployments |

---

**Overall Assessment**: The LLD is well-aligned with industry best practices across all 10 areas. The phasing order matches HashiCorp Vault, Auth0, and Stripe patterns. OAuth state binding correctly follows RFC 6749/6819. The one GAP (IR7-6, SigV4 closure-capture) is a documentation gap, not a design flaw -- the closure pattern is the correct approach. The three RISKs (rate limiter headroom, HAWK maintenance, matrix flakes) are manageable with the specified mitigations. No findings require architectural changes; all are additive improvements or documentation clarifications.

---

## Phase 4b -- Round 8 (OSS library audit)

**Date**: 2026-05-01
**Reviewer**: OSS library audit agent (claude-opus-4-6)
**Focus**: For each new utility, algorithm, or integration the LLD proposes implementing from scratch, evaluate existing OSS libraries that provide the same capability. Recommend adopt / vendor / reference-only / avoid.

### Methodology

- Lockfile analysis (`pnpm-lock.yaml`) to identify libraries already present in the monorepo
- Local codebase search to find existing implementations and consumers
- npm registry metadata (versions, licenses, deprecation status) from lockfile entries
- Knowledge-cutoff data for libraries not in the lockfile (npm download counts, GitHub stars, maintenance status as of May 2025)

**NOTE**: WebSearch and WebFetch were unavailable during this audit. npm download counts and GitHub stars are based on knowledge-cutoff data (May 2025). The implementer should verify current status before adding any new dependency.

---

### CRITICAL FINDING: `packages/auth-enterprise/` already exists

The LLD proposes creating new protocol handler files in `packages/shared-auth-profile/src/protocol-handlers/{digest,hawk,kerberos,saml,ws-security}.ts` (Phases 4.1-4.7). However, `packages/auth-enterprise/` already contains **tested, zero-dependency implementations** for all five of these protocols:

| File                                               | Function              | Dependencies                                                | Lines | Tests |
| -------------------------------------------------- | --------------------- | ----------------------------------------------------------- | ----- | ----- |
| `packages/auth-enterprise/src/digest-auth.ts`      | `applyDigestAuth()`   | `node:crypto` only                                          | 87    | Yes   |
| `packages/auth-enterprise/src/hawk-auth.ts`        | `applyHawkAuth()`     | `node:crypto` only                                          | 107   | Yes   |
| `packages/auth-enterprise/src/kerberos-auth.ts`    | `applyKerberosAuth()` | `kerberos` (lazy dynamic import, stub fallback)             | 99    | Yes   |
| `packages/auth-enterprise/src/saml-auth.ts`        | `applySamlAuth()`     | `@node-saml/node-saml` (lazy dynamic import, stub fallback) | 99    | Yes   |
| `packages/auth-enterprise/src/ws-security-auth.ts` | `applyWsSecurity()`   | `node:crypto` only                                          | 103   | Yes   |

**Consumers**: `packages/compiler` and `apps/studio` both depend on `@agent-platform/auth-enterprise` (verified in `package.json`).

**Impact on LLD**: The LLD's Phase 4 proposes adding `@hapi/hawk` (new dep), `kerberos` (new optional dep), and building custom digest/hawk/saml implementations from scratch -- but all five already exist in the monorepo with zero external dependencies (digest, hawk, ws-security) or lazy-loaded optional deps (kerberos, saml). The LLD should:

1. **Phase 4.3 (digest)**: Delegate to `applyDigestAuth()` from `@agent-platform/auth-enterprise`. Do NOT add `digest-fetch` or build a new implementation. The existing implementation covers RFC 2617/7616 with MD5 and SHA-256.
2. **Phase 4.4 (hawk)**: Delegate to `applyHawkAuth()` from `@agent-platform/auth-enterprise`. Do NOT add `@hapi/hawk`. The existing implementation uses only `node:crypto` and covers HMAC-based Hawk MAC signing with payload validation.
3. **Phase 4.5 (saml)**: The existing `applySamlAuth()` uses `@node-saml/node-saml` (already in lockfile via `apps/studio`). However, the LLD's Phase 4.5 is specifically about RFC 7522 SAML bearer-assertion **grant** (OAuth2 token exchange), which is distinct from SAML SSO assertion generation. The existing implementation generates SAML assertions, not OAuth2 bearer tokens from assertions. Phase 4.5 `saml-grant.ts` is still needed as new code, but should reuse `@node-saml/node-saml` for assertion generation and `jose` (already in lockfile) for JWT handling.
4. **Phase 4.6 (kerberos)**: Delegate to `applyKerberosAuth()` from `@agent-platform/auth-enterprise`. The existing implementation already has the lazy dynamic import + stub fallback pattern that the LLD specifies.
5. **Phase 4.7 (ws-security)**: Already confirmed working. The existing `applyWsSecurity()` is the implementation.

**Effort reduction**: Phases 4.3, 4.4, and 4.6 reduce from building new protocol handlers (~120, ~80, ~150 LOC estimated) to writing thin adapter wrappers (~20-30 LOC each) that bridge `auth-enterprise` functions to the `signRequest` / `ApplyAuthResult` interface. Total effort reduction: ~3-4 days across Phase 4.

---

### OSS Candidates Table

| #   | LLD Item                                     | Candidate Library                                                | License            | Stars/Downloads                         | Last Release              | Status                                                            | Recommendation                                                                                                                                                                                                                                                                                                                                        |
| --- | -------------------------------------------- | ---------------------------------------------------------------- | ------------------ | --------------------------------------- | ------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Azure AD plain fetch** (Phase 4.1)         | `@azure/msal-node`                                               | MIT                | ~3.8K stars (azure-sdk-for-js monorepo) | Active (monthly releases) | Actively maintained                                               | **(d) Avoid** -- ~1.5 MB bundle for a single `POST /oauth2/v2.0/token`. LLD correctly rejects it. Plain `fetch` is ~15 lines and reuses existing `resolveClientCredentialsToken()` cache.                                                                                                                                                             |
| 1b  |                                              | `@azure/identity`                                                | MIT                | Same monorepo                           | Active                    | Actively maintained                                               | **(d) Avoid** -- Even heavier; designed for Azure SDK clients, not standalone token exchange.                                                                                                                                                                                                                                                         |
| 1c  |                                              | Plain `fetch` (LLD choice)                                       | N/A                | N/A                                     | N/A                       | N/A                                                               | **(a) Adopt as-is** -- Correct decision. Azure AD CC grant is standard OAuth2 CC; the existing `client-credentials-service.ts` handles caching, rate limiting, and SSRF protection.                                                                                                                                                                   |
| 2   | **AWS IAM SigV4** (Phase 4.2)                | `@aws-sdk/signature-v4@3.374.0`                                  | Apache-2.0         | ~12K weekly DL                          | 2023-06                   | **DEPRECATED** -- thin re-export of `@smithy/signature-v4`        | **(c) Reference only** -- Do not add as direct dep.                                                                                                                                                                                                                                                                                                   |
| 2b  |                                              | `@smithy/signature-v4`                                           | Apache-2.0         | ~5M weekly DL                           | Active (monthly)          | Actively maintained                                               | **(a) Adopt** -- Already in lockfile (v1.1.0, v5.3.8-5.3.14) as transitive dep of AWS SDK. Use `@smithy/signature-v4` + `@smithy/protocol-http` directly instead of the deprecated `@aws-sdk/signature-v4` wrapper. The LLD's `package.json` change should reference `@smithy/signature-v4` and `@smithy/protocol-http`, NOT `@aws-sdk/signature-v4`. |
| 3   | **Digest auth** (Phase 4.3)                  | `digest-fetch`                                                   | MIT                | ~30K weekly DL                          | 2023-03                   | Low maintenance (last release 2+ years ago)                       | **(d) Avoid** -- Wraps `node-fetch`; incompatible with native `fetch`. Our `packages/auth-enterprise/src/digest-auth.ts` already implements RFC 2617/7616 with zero deps.                                                                                                                                                                             |
| 3b  |                                              | `http-digest-client`                                             | MIT                | ~2K weekly DL                           | 2018                      | Abandoned                                                         | **(d) Avoid** -- Abandoned; callback-based API.                                                                                                                                                                                                                                                                                                       |
| 3c  |                                              | `@agent-platform/auth-enterprise` `applyDigestAuth()` (EXISTING) | Private (monorepo) | N/A                                     | Current                   | Active                                                            | **(a) Adopt** -- Already in monorepo, tested, zero deps. Wire into `shared-auth-profile` dispatch table.                                                                                                                                                                                                                                              |
| 4   | **Hawk MAC signing** (Phase 4.4)             | `@hapi/hawk`                                                     | BSD-3              | ~150K weekly DL, ~1.9K stars            | 2024-01 (v12.0.1)         | Maintained by protocol author (Eran Hammer)                       | **(d) Avoid** -- Unnecessary new dep. Our `packages/auth-enterprise/src/hawk-auth.ts` already implements Hawk MAC signing with zero deps using `node:crypto`. Adding `@hapi/hawk` (~45 KB) for a ~100-line function that already exists is unjustified.                                                                                               |
| 4b  |                                              | `@agent-platform/auth-enterprise` `applyHawkAuth()` (EXISTING)   | Private (monorepo) | N/A                                     | Current                   | Active                                                            | **(a) Adopt** -- Already in monorepo, tested, zero deps.                                                                                                                                                                                                                                                                                              |
| 5   | **Kerberos SPNEGO** (Phase 4.6)              | `kerberos` (mongodb-js)                                          | Apache-2.0         | ~250K weekly DL, ~200 stars             | 2024                      | Maintained by MongoDB team                                        | **(a) Adopt via existing wrapper** -- Already used by `packages/auth-enterprise/src/kerberos-auth.ts` as a lazy dynamic import with stub fallback. The existing wrapper handles the native dep gracefully. Requires `krb5-dev` at build time when `ENABLE_KERBEROS=true`.                                                                             |
| 5b  |                                              | `kerberos-agent`                                                 | MIT                | ~1K weekly DL                           | 2022                      | Low maintenance                                                   | **(d) Avoid** -- Less maintained than mongodb-js `kerberos`; same native dep requirement.                                                                                                                                                                                                                                                             |
| 6   | **SAML bearer-assertion grant** (Phase 4.5)  | `@node-saml/node-saml@5.1.0`                                     | MIT                | ~80K weekly DL, ~800 stars              | 2024                      | Actively maintained                                               | **(c) Design reference** -- Already in lockfile (`apps/studio`). Useful for SAML assertion generation, but does NOT implement RFC 7522 bearer-assertion grant. The grant is an OAuth2 token exchange (POST with `grant_type=urn:ietf:params:oauth:grant-type:saml2-bearer`), not a SAML SSO flow.                                                     |
| 6b  |                                              | `samlify`                                                        | MIT                | ~20K weekly DL, ~600 stars              | 2024                      | Maintained                                                        | **(d) Avoid** -- Full SAML SSO/IdP framework. Massive overkill for a single OAuth2 grant type POST.                                                                                                                                                                                                                                                   |
| 6c  |                                              | `xml-crypto@6.1.2`                                               | MIT                | ~200K weekly DL                         | 2024                      | Maintained                                                        | **(c) Design reference** -- Already in lockfile. Useful if assertion needs XML signing, but the grant POST itself is a simple `application/x-www-form-urlencoded` request.                                                                                                                                                                            |
| 6d  |                                              | `jose` (v4/v5/v6)                                                | MIT                | ~10M weekly DL, ~6K stars               | Active                    | Actively maintained by @panva                                     | **(a) Adopt for assertion encoding** -- Already in lockfile (3 versions). If the SAML assertion needs base64url encoding or JWT wrapping for the bearer grant, `jose` is the right tool. Do NOT add a new SAML library.                                                                                                                               |
| 6e  |                                              | Custom `saml-grant.ts` (LLD choice)                              | N/A                | N/A                                     | N/A                       | N/A                                                               | **(a) Adopt** -- Correct decision. RFC 7522 grant is a single POST with base64-encoded assertion. ~150 LOC is appropriate. Use `jose` for encoding if needed; reuse existing `@node-saml/node-saml` via `auth-enterprise` for assertion generation if the assertion is not pre-provided.                                                              |
| 7   | **OAuth state contract** (ST-1, OQ-1)        | `oauth4webapi` (@panva)                                          | MIT                | ~200K weekly DL, ~1.2K stars            | Active (2024-2025)        | Actively maintained by @panva (author of `jose`, `openid-client`) | **(c) Design reference only** -- NOT recommended for adoption. Rationale below.                                                                                                                                                                                                                                                                       |
| 8   | **Rate limiter** (Phase 1.3.b.8)             | `rate-limiter-flexible@5.0.5`                                    | ISC                | ~500K weekly DL, ~3K stars              | 2024                      | Actively maintained                                               | **(a) Adopt** -- **Already in lockfile** (`apps/multimodal-service`). Supports Redis backend (`RateLimiterRedis`), sliding window, per-key limits. Exactly matches the LLD's spec (Redis-backed, per-`{tenantId, profileId}` key, 60s window, 30 req/min cap). Do NOT build custom.                                                                   |
| 9   | **`assertNotReservedPrincipal`** (Phase 0.3) | N/A                                                              | N/A                | N/A                                     | N/A                       | N/A                                                               | **(a) Custom** -- Trivial (~30 LOC). No OSS library needed.                                                                                                                                                                                                                                                                                           |
| 10  | **`sanitizeAuthProfileError`** (Phase 5.6a)  | N/A                                                              | N/A                | N/A                                     | N/A                       | N/A                                                               | **(a) Custom** -- Domain-specific error mapping (~120 LOC). No OSS library needed.                                                                                                                                                                                                                                                                    |
| 11  | **Mongo migration scripts**                  | `migrate-mongo`                                                  | MIT                | ~100K weekly DL, ~900 stars             | 2024                      | Maintained                                                        | **(d) Avoid** -- Adds a migration framework for 3 simple idempotent scripts. The monorepo already has a `tools/migrate-*.ts` pattern (found: `tools/migrate-test-files.ts`). Ad-hoc scripts with `--dry-run` and `--restore` flags are simpler and match existing repo conventions.                                                                   |
| 11b |                                              | `mongoose-migrate`                                               | MIT                | ~5K weekly DL                           | 2022                      | Low maintenance                                                   | **(d) Avoid** -- Unmaintained; overkill for 3 scripts.                                                                                                                                                                                                                                                                                                |
| 12  | **JSON-RPC MCP transport** (Phase 1.3.c)     | `@modelcontextprotocol/sdk@1.29.0`                               | MIT                | N/A                                     | 2025                      | Active                                                            | **(a) Already adopted** -- In lockfile. The LLD correctly reuses existing MCP transport; no additional JSON-RPC library needed.                                                                                                                                                                                                                       |

---

### Detailed Recommendations

#### Item 7: `oauth4webapi` for ST-1 OAuth state contract -- DESIGN REFERENCE ONLY

The LLD flags OQ-1 (deferred to Phase 3.B implementer): could `panva/oauth4webapi` replace the hand-rolled token-exchange POST in the OAuth callback route?

**Analysis**: `oauth4webapi` is a well-maintained, minimal (~15 KB) OAuth 2.0 client library by @panva (author of `jose`). It implements:

- Authorization Code flow with PKCE
- Client Credentials grant
- Token introspection and revocation
- DPoP support
- PAR (Pushed Authorization Requests)

**Why NOT adopt**:

1. **Scope mismatch**: Our OAuth callback is a single `POST` to exchange `code` for tokens, followed by custom storage to `EndUserOAuthToken` with tenant-scoped DEK encryption. `oauth4webapi` handles the HTTP POST but not the storage, encryption, audit emission, rate limiting, or init-lock -- which is 80% of the callback code.
2. **Tight coupling to our state contract**: ST-1 mandates atomic `GETDEL` + `tenantId`/CSRF/`redirectUri` verification. `oauth4webapi` has its own state management which would conflict with our Redis-based state service.
3. **Existing implementation is 3 lines of token exchange**: The actual `fetch` POST is trivial; the complexity is in the verification chain and storage, which no library replaces.
4. **Adding a dependency for 3 lines of fetch**: Not justified when the code is already written and the library would introduce a new API surface to learn and maintain compatibility with.

**Recommendation**: Use `oauth4webapi` as a design reference for RFC compliance (especially PKCE, DPoP if needed later), but do NOT adopt as a runtime dependency. The hand-rolled token-exchange POST in the callback route is correct and minimal.

#### Item 8: `rate-limiter-flexible` -- ADOPT (already in monorepo)

**This is the strongest adoption recommendation in this audit.** The library is already in `pnpm-lock.yaml` at v5.0.5, used by `apps/multimodal-service/src/security/upload-rate-limiter.ts` with both `RateLimiterRedis` and `RateLimiterMemory` backends. The existing usage pattern (Redis primary, Memory fallback) matches exactly what LLD Phase 1.3.b.8 specifies.

**Integration cost**: ~30 minutes. Import `RateLimiterRedis` from `rate-limiter-flexible`, configure with `storeClient: redisClient`, `points: 30`, `duration: 60`, `keyPrefix: 'auth-profile:rl'`. The library handles sliding window, per-key limiting, and Redis atomic operations. Copy the pattern from `apps/multimodal-service/src/security/upload-rate-limiter.ts`.

**Custom implementation cost** (LLD current): ~2-4 hours for a Redis-backed sliding window with atomic Lua scripts, error handling, and tests.

**Impact**: Removes ~50-80 LOC of custom Redis Lua scripting from Phase 1.3.b. Add `rate-limiter-flexible` to `packages/shared/package.json` (or whichever package owns `mcp-auth-resolver.ts`).

#### Item 2: AWS SDK -- use `@smithy/signature-v4`, NOT `@aws-sdk/signature-v4`

The LLD references `@aws-sdk/signature-v4` and `@aws-sdk/protocol-http` (Phase 4.2, line 811). The lockfile shows `@aws-sdk/signature-v4@3.374.0` is **deprecated** with the message: "This package has moved to @smithy/signature-v4". The lockfile already contains `@smithy/signature-v4` (v1.1.0, v5.3.8-5.3.14) and `@smithy/protocol-http` (v5.3.8-5.3.14) as transitive dependencies.

**Recommendation**: Update the LLD's `packages/shared-auth-profile/package.json` dependency list from `@aws-sdk/signature-v4` + `@aws-sdk/protocol-http` to `@smithy/signature-v4` + `@smithy/protocol-http`. This avoids adding a deprecated package as a direct dependency and reuses what is already resolved in the lockfile.

**Note**: `packages/shared/package.json` currently has `"@aws-sdk/signature-v4": "^3.374.0"` as a direct dependency. This should also be migrated to `@smithy/signature-v4` as a follow-up, but that is out of r2 scope.

---

### Summary of LLD Changes Required

| #     | LLD Section                     | Change                                                                                                                                                                                                                                       | Priority                                  |
| ----- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| OSS-1 | Phase 4.3 (digest)              | Delegate to `@agent-platform/auth-enterprise` `applyDigestAuth()` instead of building new. Wire as adapter to `signRequest`/`ApplyAuthResult`. Remove any reference to `digest-fetch`.                                                       | HIGH -- avoids duplicate implementation   |
| OSS-2 | Phase 4.4 (hawk)                | Delegate to `@agent-platform/auth-enterprise` `applyHawkAuth()` instead of adding `@hapi/hawk`. Remove `@hapi/hawk` from `packages/shared-auth-profile/package.json` deps.                                                                   | HIGH -- avoids unnecessary new dependency |
| OSS-3 | Phase 4.6 (kerberos)            | Delegate to `@agent-platform/auth-enterprise` `applyKerberosAuth()` which already has lazy dynamic import + stub fallback. Do not add `kerberos` as a new direct dep to `shared-auth-profile` -- it is already handled by `auth-enterprise`. | HIGH -- avoids duplicate implementation   |
| OSS-4 | Phase 4.2 (aws-iam)             | Change deps from `@aws-sdk/signature-v4` + `@aws-sdk/protocol-http` to `@smithy/signature-v4` + `@smithy/protocol-http`. The `@aws-sdk` packages are deprecated wrappers.                                                                    | MEDIUM -- correctness                     |
| OSS-5 | Phase 1.3.b.8 (rate limiter)    | Use `rate-limiter-flexible` (already in lockfile) with `RateLimiterRedis` instead of custom sliding-window implementation. Copy pattern from `apps/multimodal-service/src/security/upload-rate-limiter.ts`.                                  | MEDIUM -- reduces custom code             |
| OSS-6 | Phase 4.5 (saml)                | Reuse `jose` (already in lockfile) for assertion encoding. Reuse `@node-saml/node-saml` (already in lockfile) via `auth-enterprise` if assertion generation is needed. `saml-grant.ts` remains as new code for the RFC 7522 grant POST.      | LOW -- mostly confirmed                   |
| OSS-7 | OQ-1 (oauth4webapi)             | Explicitly resolve as "design reference only, do not adopt". The hand-rolled token exchange is correct and minimal (~3 lines of fetch); the library does not replace the verification chain, storage, or audit emission.                     | LOW -- closes open question               |
| OSS-8 | Phase 0.4, Phase 5 (migrations) | Confirm ad-hoc `tools/migrate-*.ts` pattern. Do not add `migrate-mongo`. Existing repo convention (`tools/migrate-test-files.ts`) validates the approach.                                                                                    | LOW -- confirms LLD choice                |

### Libraries Already in Monorepo That Cover LLD Use Cases

| Library                            | Current Location                                   | LLD Use Case                              | Action                                                                  |
| ---------------------------------- | -------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| `rate-limiter-flexible@5.0.5`      | `apps/multimodal-service/package.json`             | Phase 1.3.b.8 token-exchange rate limiter | Add to `packages/shared/package.json`; reuse `RateLimiterRedis` pattern |
| `@smithy/signature-v4` (v5.3.x)    | Transitive dep of AWS SDK                          | Phase 4.2 SigV4 signing                   | Use directly instead of deprecated `@aws-sdk/signature-v4`              |
| `@smithy/protocol-http` (v5.3.x)   | Transitive dep of AWS SDK                          | Phase 4.2 HTTP request model              | Use directly instead of `@aws-sdk/protocol-http`                        |
| `@node-saml/node-saml@5.1.0`       | `apps/studio/package.json`                         | Phase 4.5 SAML assertion generation       | Already consumed by `auth-enterprise`; reuse via that package           |
| `jose` (v4/v5/v6)                  | `apps/admin`, `apps/runtime`, `apps/docs-internal` | Phase 4.5 assertion encoding              | Use existing dep; no version addition needed                            |
| `xml-crypto@6.1.2`                 | Transitive dep of `@node-saml/node-saml`           | Phase 4.5 XML signing if needed           | Available; likely not needed for RFC 7522 grant POST                    |
| `@modelcontextprotocol/sdk@1.29.0` | Multiple packages                                  | Phase 1.3.c MCP transport                 | Already adopted; no change needed                                       |
| `@agent-platform/auth-enterprise`  | `packages/auth-enterprise/`                        | Phases 4.3, 4.4, 4.6, 4.7                 | **Critical reuse opportunity** -- 5 protocol handlers already exist     |

### Net Dependency Changes After This Audit

**Dependencies to ADD to `packages/shared-auth-profile/package.json`**:

- `@smithy/signature-v4: ^5.3.0` (replacing `@aws-sdk/signature-v4`)
- `@smithy/protocol-http: ^5.3.0` (replacing `@aws-sdk/protocol-http`)
- `@agent-platform/auth-enterprise: workspace:*` (existing monorepo package)

**Dependencies to ADD to `packages/shared/package.json`** (or `mcp-auth-resolver` owner):

- `rate-limiter-flexible: ^5.0.0` (already in lockfile)

**Dependencies to NOT ADD** (removed from LLD's original plan):

- ~~`@hapi/hawk`~~ -- replaced by existing `auth-enterprise` zero-dep implementation
- ~~`kerberos` (as optionalDep of `shared-auth-profile`)~~ -- already handled by `auth-enterprise` lazy import
- ~~`@aws-sdk/signature-v4`~~ -- deprecated; use `@smithy/signature-v4`
- ~~`@aws-sdk/protocol-http`~~ -- use `@smithy/protocol-http`

**Net new external dependencies added**: 0 (all resolved from existing lockfile or monorepo packages)

---

### Verdict

**No new external dependencies are needed.** Every LLD requirement can be satisfied by libraries already in the lockfile or by the existing `packages/auth-enterprise/` package that the LLD appears to have overlooked. The most impactful finding is OSS-1/2/3: the `auth-enterprise` package eliminates the need to build digest, hawk, and kerberos handlers from scratch, saving an estimated 3-4 days of Phase 4 effort and removing 2 planned external dependencies (`@hapi/hawk`, direct `kerberos` in `shared-auth-profile`).

---

## Phase 4b -- Round 6 (platform audit)

**Date**: 2026-05-01
**Reviewer**: platform audit agent (claude-opus-4-6)
**Focus**: Verify LLD against CLAUDE.md invariants, platform principles, file-level change map, wiring completeness, reinvention check, Dockerfile sync.
**Method**: Read-only investigation. All source files read via Read tool; grep/diff via Bash.

---

### 1. CLAUDE.md Invariant Verification (24 invariants)

| #   | Invariant                                                  | LLD Compliance | Notes                                                                                                                                         |
| --- | ---------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tenant isolation (tenantId in every query)                 | PASS           | TI-1 contract enforced throughout. Phase 1.3.b retrofits mcp-auth-resolver.ts to require tenantId (removing the unknown fallback at line 69). |
| 2   | Centralized auth (createUnifiedAuthMiddleware/requireAuth) | PASS           | No custom jwt.verify. All new routes use existing auth middleware.                                                                            |
| 3   | Stateless distributed (Redis/MongoDB)                      | PASS           | CK-1 cache uses Redis primary with in-memory Map as dev-only fallback. Distributed locks via acquireRefreshLock (Redis SET NX PX).            |
| 4   | Traceability (TraceEvent via TraceStore)                   | PASS           | TE-1 contract defines sanitized trace events. Phase 5.6.2 adds events to trace-event-registry.ts.                                             |
| 5   | Compliance (encryption at rest, TTLs)                      | PASS           | encryptionPlugin on auth-profile model (verified at model lines 199-205). TTLs on Redis cache keys.                                           |
| 6   | Performance (batch ops, caching)                           | PASS           | Batch operations in migration scripts. CK-1 cache with TTL.                                                                                   |
| 7   | No console.log in server code                              | PASS           | LLD specifies createLogger pattern.                                                                                                           |
| 8   | No swallowed catches                                       | PASS           | LLD error handling propagates via AuthProfileError.                                                                                           |
| 9   | err instanceof Error guard                                 | PASS           | Consistent with error handling patterns in LLD.                                                                                               |
| 10  | No sync I/O                                                | PASS           | No readFileSync/writeFileSync in any proposed code.                                                                                           |
| 11  | No any where structured types exist                        | PASS           | Discriminated unions for auth types. ApplyAuthResult is typed.                                                                                |
| 12  | No inline magic numbers                                    | PASS           | Named constants: MAX_CACHE_SIZE, TTL_MS, rate limit values.                                                                                   |
| 13  | Zod ID validation (z.string().min(1))                      | PASS           | LLD uses z.string().min(1) for ID fields.                                                                                                     |
| 14  | Provider-neutral LLM types                                 | N/A            | No LLM type changes in this feature.                                                                                                          |
| 15  | No domain-specific field names in engine code              | N/A            | Not applicable to auth-profile feature scope.                                                                                                 |
| 16  | Every in-memory Map needs max size, TTL, eviction          | PASS           | CK-1 specifies max size and TTL. Existing credential-cache.ts (MAX_SIZE=200, TTL_MS=5min) reused.                                             |
| 17  | Structured error responses                                 | PASS           | AuthProfileError with code, message, statusCode.                                                                                              |
| 18  | Project isolation in routes                                | PASS           | Project-scoped queries include projectId.                                                                                                     |
| 19  | User isolation                                             | PASS           | User-owned resources filtered by createdBy/ownerId. Session dispatch by Session.source.                                                       |
| 20  | Express route ordering                                     | PASS           | No new parameterized routes that conflict with static routes.                                                                                 |
| 21  | Versioned protocol compatibility                           | PASS           | profileVersion ensures cache invalidation on config mutation.                                                                                 |
| 22  | Boundary metadata normalization                            | PASS           | normalizeAuthType() normalizes aliases at entry points.                                                                                       |
| 23  | Dockerfile sync for new packages                           | PASS           | Verified all 4 Dockerfiles already COPY shared-auth-profile. No new packages introduced.                                                      |
| 24  | E2E test quality (no mocks, API-only)                      | PASS           | Phase 5.2 matrix E2E specifies real servers, API-only interaction, FLUSHDB isolation.                                                         |

**Result**: 22 PASS, 2 N/A (invariants 14 and 15 not applicable to auth-profile feature scope).

---

### 2. Platform Principles Alignment

| Principle                                           | LLD Compliance | Evidence                                                                                     |
| --------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------- |
| Resource Isolation (tenant, project, user, session) | PASS           | TI-1 contract. tenantId in all queries. Project-scoped lookup via getScopedLookupCandidates. |
| Centralized Auth                                    | PASS           | Reuses requireAuth, requirePermission. No custom token verification.                         |
| Stateless Distributed                               | PASS           | Redis for cache (CK-1), locks (acquireRefreshLock), rate limiting. MongoDB for persistence.  |
| Traceability                                        | PASS           | TE-1 sanitized trace events. Audit trail plugin on model.                                    |
| Compliance                                          | PASS           | Encryption plugin. Data minimization with TTLs. Audit logging.                               |
| Performance                                         | PASS           | Cache-first resolution. Batch migration.                                                     |

---

### 3. File-Level Change Map Verification

Verified 18 files referenced in the LLD against actual source code. All references accurate:

- `packages/database/src/models/auth-profile.model.ts` -- plugins lines 199-205, indexes lines 231-261 (confirmed)
- `packages/database/src/models/mcp-server-config.model.ts` -- transport enum line 57, authProfileId line 66 (confirmed)
- `packages/database/src/auth-profile/audit-events.ts` -- 13 constants, no OAUTH_FAILED (confirmed)
- `packages/shared/src/services/auth-profile/client-credentials-service.ts` -- signature lines 111-119, cache key line 120 lacks CK-1 dimensions (confirmed)
- `packages/shared/src/services/mcp-auth-resolver.ts` -- Map line 34, MAX_CACHE_SIZE=200, tenantId? line 46, unknown fallback line 69 (confirmed)
- `packages/shared-auth-profile/src/apply-auth.ts` -- 17-type dispatch table, byte-identical to shared copy (confirmed via manual comparison)
- `packages/shared-auth-profile/src/errors.ts` -- 17 error codes, AuthProfileError class (confirmed)
- `packages/shared-auth-profile/src/index.ts` -- barrel exports, 68 lines (confirmed)
- `packages/shared-kernel/src/security/ssrf-validator.ts` -- assertUrlSafeForSSRF exists (confirmed)
- `packages/shared-kernel/src/constants/trace-event-registry.ts` -- TRACE_EVENT_GROUPS lines 257-278, 19 domains, no auth_profile (confirmed)
- `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` -- middleware option at line 88 (confirmed)
- `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` -- full HTTP executor present (confirmed)
- `apps/studio/src/lib/workspace-permission.ts` -- WORKSPACE_PERMISSIONS as const object, 4 permissions (confirmed)
- `apps/studio/src/services/tool-test-service.ts` -- OAuth throw at lines 719-723 (confirmed)
- `apps/runtime/src/routes/internal-tools.ts` -- ToolBindingExecutor constructor at lines 170-177, no middleware option (confirmed)
- `apps/runtime/src/services/auth-profile-resolver.ts` -- resolveAuthProfileCredentials at line 82, resolveByName at line 268 (confirmed)
- `apps/runtime/src/services/auth-profile/auth-profile-cache.ts` -- key format line 44 lacks CK-1 dimensions (confirmed)
- `packages/shared-auth/src/rbac/role-permissions.ts` -- TENANT_ROLE_PERMISSIONS lines 34-112, ADMIN lacks auth-profile (confirmed)

**All 18 file references verified accurate.**

---

### 4. Wiring Completeness Check

The LLD's 42-item wiring checklist (Section 6) was verified against the phase-by-phase implementation plan. All new components have identified consumers:

- profileVersion field (Phase 0.4) -> consumed by CK-1 cache key (Phase 1.2) and migration script (Phase 0.4)
- assertNotReservedPrincipal (Phase 0.3) -> consumed by auth-profile create/update routes
- Merged apply-auth.ts (Phase 0.1) -> consumed by mcp-auth-resolver.ts (Phase 1.3.b) and auth-profile-resolver.ts (runtime)
- signRequest callback (Phase 4) -> consumed by ToolBindingExecutor middleware injection (Phase 1.1)
- sanitizeAuthProfileError (Phase 5.6a) -> consumed by trace event emission and error response formatting
- normalizeAuthType (Phase 5.1) -> consumed at all read boundaries
- RBAC additions (Phase 0.2) -> consumed by requirePermission in route handlers
- Rate limiter (Phase 1.3.b.8) -> consumed by mcp-auth-resolver.ts token exchange path
- Matrix E2E (Phase 5.2) -> validates all 17 auth types end-to-end

**No orphaned components found.**

---

### 5. Reinvention Check (Existing Infrastructure)

| Existing Infrastructure                                                         | LLD Reuses? | Evidence                                                           |
| ------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| CredentialCache (packages/shared/src/services/auth-profile/credential-cache.ts) | YES         | LLD extends with CK-1 key composition; does not replace the class  |
| acquireRefreshLock (packages/shared/src/services/auth-profile/refresh-lock.ts)  | YES         | LLD reuses existing Redis SET NX PX lock; no reimplementation      |
| assertUrlSafeForSSRF (packages/shared-kernel/src/security/ssrf-validator.ts)    | YES         | LLD specifies reuse for all outbound URLs                          |
| AuthProfileError (packages/shared-auth-profile/src/errors.ts)                   | YES         | LLD extends error codes; does not replace the class                |
| EncryptionService (via encryptionPlugin on model)                               | YES         | LLD relies on existing plugin at model lines 199-205               |
| Mongoose plugins (tenantIsolation, encryption, auditTrail)                      | YES         | Already applied to auth-profile model; LLD does not re-add         |
| rate-limiter-flexible (identified by Round 8 OSS audit)                         | NOTED       | Round 8 (OSS-5) recommends adoption over custom implementation     |
| auth-enterprise package (identified by Round 8 OSS audit)                       | NOTED       | Round 8 (OSS-1/2/3) recommends delegation for digest/hawk/kerberos |

**No reinvention of existing infrastructure detected in the LLD.**

---

### 6. Dockerfile Sync Verification

| Dockerfile                   | shared-auth-profile COPY line | Status |
| ---------------------------- | ----------------------------- | ------ |
| apps/runtime/Dockerfile:44   | Present                       | OK     |
| apps/studio/Dockerfile:48    | Present                       | OK     |
| apps/search-ai/Dockerfile:56 | Present                       | OK     |
| apps/admin/Dockerfile:38     | Present                       | OK     |

No new workspace packages are introduced by the LLD, so no additional Dockerfile COPY lines are needed.

---

### Findings

#### R6-M1 [MEDIUM] -- Misleading TENANT_ROLE_PERMISSIONS line citation

**Location**: LLD Phase 0.2.2, line ~311
**Issue**: The LLD states "line 361 already has the permission string in TENANT_ROLE_PERMISSIONS" but line 361 of role-permissions.ts is in PROJECT_PERMISSION_CATEGORIES (a UI display table for the Studio permissions panel), NOT in TENANT_ROLE_PERMISSIONS (the RBAC enforcement object at lines 34-112). The permission string auth-profile:read/write/delete/decrypt exists in the UI category table but is NOT present in the RBAC enforcement object for ADMIN role.
**Impact**: An implementer following this citation would believe the RBAC permission is already wired for enforcement, when in fact it only exists in the UI display layer. The actual RBAC addition to TENANT_ROLE_PERMISSIONS is the Phase 0.2 task itself.
**Recommendation**: Correct the citation to: "Line 361 shows auth-profile in PROJECT_PERMISSION_CATEGORIES (UI display only). The actual RBAC enforcement entries must be added to TENANT_ROLE_PERMISSIONS (lines 34-112)."

#### R6-M2 [MEDIUM] -- Kerberos optionalDependencies Docker build documentation gap

**Location**: LLD Phase 4.6
**Issue**: The LLD correctly specifies kerberos as an optionalDependency with lazy dynamic import and stub fallback (matching the existing auth-enterprise pattern). However, the LLD does not document the Docker build implication: when ENABLE_KERBEROS=true, the Dockerfile needs krb5-dev (Alpine) or libkrb5-dev (Debian) system package for the native kerberos module to compile.
**Impact**: Low -- kerberos is optional and the stub fallback works. But if a customer enables kerberos support, the Docker build will fail with a native module compilation error unless the system package is present.
**Recommendation**: Add a note to Phase 4.6: "When ENABLE_KERBEROS=true, the Dockerfile RUN stage must include apk add --no-cache krb5-dev (Alpine) or apt-get install -y libkrb5-dev (Debian) before pnpm install. Document in the auth-profiles deployment guide."

---

### Summary

| Severity | Count | Details                                                                 |
| -------- | ----- | ----------------------------------------------------------------------- |
| CRITICAL | 0     | --                                                                      |
| HIGH     | 0     | --                                                                      |
| MEDIUM   | 2     | R6-M1 (misleading RBAC line citation), R6-M2 (kerberos Docker docs gap) |
| LOW      | 0     | --                                                                      |

**Verdict: APPROVED** -- The LLD passes all 24 CLAUDE.md invariant checks, all 6 platform principle alignments, all 18 file-level references are accurate, the 42-item wiring checklist is complete with no orphaned components, no existing infrastructure is reinvented, and Dockerfiles are in sync. The 2 MEDIUM findings are documentation corrections that do not affect architectural soundness.

**Recommendation: Proceed to implementation (Phase 5).** R6-M1 should be corrected in the LLD to avoid implementer confusion. R6-M2 should be added to the deployment documentation.
