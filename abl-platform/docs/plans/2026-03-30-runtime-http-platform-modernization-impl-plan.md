# Runtime HTTP Platform Modernization — Implementation Plan

**Date:** 2026-03-30  
**Status:** In Progress  
**Scope:** Runtime-first modernization of the current Express HTTP platform:

- finish the OpenAPI router migration
- centralize error handling
- standardize explicit DI/composition roots
- add lifecycle management
- enforce Zod-only request validation at the HTTP boundary

**Working note:** there is no dedicated feature spec or HLD for this cross-cutting refactor yet. This document is the execution tracker and slice-by-slice checklist until a formal feature/HLD pair is authored.

---

## Goals

1. Make route behavior easier to reason about without changing envelopes or auth semantics.
2. Add regression-heavy coverage before each risky refactor slice.
3. Keep each slice independently deployable and reversible.
4. Finish the runtime-first rollout before any Express 5 evaluation.

## Non-Goals

1. Fastify migration.
2. NestJS migration.
3. Express 5 migration during the main runtime refactor.
4. Response-envelope normalization across apps.

---

## Progress Tracker

- [x] Rebase current branch onto `origin/develop` without losing unrelated local edits.
- [x] Create implementation plan and regression test manifest documents.
- [x] Slice 1: Regression foundation + OpenAPI helper async wrapper.
- [x] Slice 2: Shared Express error-handling primitive.
- [x] Slice 3: Opt-in OpenAPI request-validation plumbing.
- [x] Slice 4: Pilot route migrations (`projects`, `auth`, `nl-analytics`, `agents`, `evaluation-tags`, `sdk`).
- [x] Slice 5: Manual-router Wave 1.
- [ ] Slice 6: Runtime composition root and service wiring cleanup.
- [ ] Slice 7: Lifecycle registry and graceful shutdown consolidation.
- [ ] Slice 8: Remaining manual-router waves and final parity sweep.
- [ ] Post-runtime decision gate: evaluate Express 5 on `workflow-engine`, not `runtime`.

---

## Design Decisions

| #   | Decision                                                   | Rationale                                                              | Alternatives Rejected                                    |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| D-1 | Keep the main refactor inside Express.                     | Lowest regression risk for the current repo shape.                     | Fastify/NestJS during the same delivery stream.          |
| D-2 | Add regression coverage before broad route conversion.     | Route/helper refactors are easy to regress silently.                   | Converting routes first and backfilling tests later.     |
| D-3 | Make helper changes opt-in first.                          | Lets us prove behavior on pilot routes before broad adoption.          | Global helper behavior flips across all existing routes. |
| D-4 | Prefer explicit composition roots over a container for v1. | Matches the stated “explicit, testable wiring” goal.                   | Introducing Awilix as part of the first migration wave.  |
| D-5 | Treat Express 5 as a later compatibility pass.             | Keeps the main refactor focused on platform debt, not framework churn. | Mixing Express 5 with OpenAPI/error/DI/lifecycle work.   |

---

## File-Level Map

### Slice 1 Confirmed Files

| File                                                                     | Purpose                                 | Risk   |
| ------------------------------------------------------------------------ | --------------------------------------- | ------ |
| `docs/plans/2026-03-30-runtime-http-platform-modernization-impl-plan.md` | Slice tracker and execution plan        | Low    |
| `docs/testing/runtime-http-platform-modernization.md`                    | Regression test manifest by slice       | Low    |
| `packages/openapi/src/express/create-router.ts`                          | Add opt-in async-handler wrapping       | Medium |
| `apps/runtime/src/__tests__/openapi-router-helper.test.ts`               | Regression coverage for helper behavior | Low    |
| `tools/agents/e2e-smoke/__tests__/manifest-generator.test.ts`            | Route-surface regression guardrails     | Low    |

### Expected Future Files

| File                                   | Planned Change                                                      | Risk   |
| -------------------------------------- | ------------------------------------------------------------------- | ------ |
| `packages/shared-kernel/src/errors.ts` | Reuse existing error taxonomy from one shared Express error adapter | Medium |
| `apps/runtime/src/server.ts`           | Wire shared error middleware and lifecycle registry over time       | High   |
| `apps/runtime/src/openapi/registry.ts` | Keep runtime registry stable while helper evolves                   | Low    |
| `apps/runtime/src/routes/*.ts`         | Pilot and wave-based route migration to OpenAPI helper patterns     | High   |
| `apps/runtime/src/services/**`         | Convert singleton/lazy state to explicit service wiring             | High   |

---

## Slice Plan

### Slice 1: Regression Foundation + OpenAPI Helper Async Wrapper

**Goal:** add guardrails and land the first no-default-change helper improvement.

**Tasks**

- [x] Create the implementation/progress plan.
- [x] Create the regression test manifest.
- [x] Tighten runtime route-manifest regression checks around critical routes and route-count floor.
- [x] Add `wrapAsyncHandlers` to `createOpenAPIRouter`, defaulting to `false`.
- [x] Add dedicated regression tests for helper registration behavior and async-error forwarding.

**Files Touched**

- `docs/plans/2026-03-30-runtime-http-platform-modernization-impl-plan.md`
- `docs/testing/runtime-http-platform-modernization.md`
- `packages/openapi/src/express/create-router.ts`
- `apps/runtime/src/__tests__/openapi-router-helper.test.ts`
- `tools/agents/e2e-smoke/__tests__/manifest-generator.test.ts`

**Exit Criteria**

- [x] Manifest regression tests lock critical runtime routes.
- [x] Helper async-wrapping behavior is opt-in and covered by dedicated tests.
- [x] `pnpm build --filter=@agent-platform/openapi --filter=@agent-platform/runtime` succeeds.
- [x] Targeted tests for Slice 1 pass.

**Test Strategy**

- Unit: helper behavior and route-registry assertions.
- Integration: Express app + error middleware proving async rejection forwarding.
- Regression: route-manifest test hardening for critical runtime paths.

**Rollback**

- Revert helper option and tests together.
- Keep the docs; update the slice as deferred instead of deleting history.

---

### Slice 2: Shared Express Error-Handling Primitive

**Goal:** introduce one shared Express error adapter without changing app response envelopes.

**Tasks**

- [x] Add a reusable Express error-middleware helper around shared-kernel error mapping.
- [x] Map `AppError`, `ValidationError`, and `ZodError`.
- [x] Add tests for unknown errors, known errors, and envelope preservation.
- [x] Wire the helper into runtime behind the current envelope shape.

**Exit Criteria**

- [x] Known error families map to stable HTTP status codes.
- [x] Runtime envelope shape remains unchanged for existing routes.
- [x] New shared error-middleware tests pass.

**Rollback**

- Restore current runtime-local error handler and keep the shared helper unused.

---

### Slice 3: Opt-In OpenAPI Request-Validation Plumbing

**Goal:** let OpenAPI routes opt into shared request parsing without mutating existing request semantics.

**Tasks**

- [x] Add helper-level Zod parsing for `params`, `query`, and `body`.
- [x] Attach validated values to a safe location (`res.locals` or equivalent).
- [x] Return shared validation errors through the centralized error middleware.
- [x] Add helper tests for happy-path and validation-failure cases.

**Exit Criteria**

- [x] Validation is opt-in, not global.
- [x] Validation failures reach the centralized error path.
- [x] Existing non-opted-in routes remain unchanged.

**Rollback**

- Disable the opt-in path while keeping test coverage in place.

---

### Slice 4: Pilot Route Migrations

**Goal:** prove the new helper path on low-blast-radius OpenAPI routes.

**Pilot Routes**

- `apps/runtime/src/routes/projects.ts`
- `apps/runtime/src/routes/auth.ts`
- `apps/runtime/src/routes/nl-analytics.ts`
- `apps/runtime/src/routes/agents.ts`
- `apps/runtime/src/routes/evaluation-tags.ts`
- `apps/runtime/src/routes/sdk.ts`

**Pilot Route Progress**

- [x] `apps/runtime/src/routes/projects.ts`
- [x] `apps/runtime/src/routes/auth.ts`
- [x] `apps/runtime/src/routes/nl-analytics.ts`
- [x] `apps/runtime/src/routes/agents.ts`
- [x] `apps/runtime/src/routes/evaluation-tags.ts`
- [x] `apps/runtime/src/routes/sdk.ts`

**Tasks**

- [x] Remove local `safeParse` where helper validation covers the boundary.
- [ ] Remove route-local `try/catch` where centralized error mapping is sufficient.
- [x] Add or tighten route-level contract tests before each pilot migration.

**Exit Criteria**

- [x] Pilot routes preserve status codes and response envelopes.
- [x] No pilot route loses auth/isolation coverage.
- [x] Pilot tests pass before and after helper adoption.

**Rollback**

- Revert pilot routes independently; keep helper foundation intact.

---

### Slice 5: Manual-Router Wave 1

**Goal:** convert the smallest high-value manual routers while coverage is strongest.

**Wave 1 Targets**

- `validate`
- `diagnostics`
- `feedback`
- `tenant-usage`
- `platform-admin-usage`
- `memory-api`
- `attachment-config`
- `agent-transfer-settings`
- `voice-analytics`

**Wave 1 Progress**

- [x] `validate`
- [x] `diagnostics`
- [x] `feedback`
- [x] `tenant-usage`
- [x] `platform-admin-usage`
- [x] `memory-api`
- [x] `attachment-config`
- [x] `agent-transfer-settings`
- [x] `voice-analytics`

**Exit Criteria**

- [x] Each converted route has updated contract coverage.
- [x] Manual validation is removed where helper validation is authoritative.
- [x] Route order and mounted path surface remain stable.

---

### Slice 6: Runtime Composition Root

**Goal:** standardize service wiring with explicit composition roots.

**Tasks**

- [ ] Introduce `createRuntimeServices()`.
- [ ] Introduce `createRuntimeApp()`.
- [ ] Move lazy singleton access behind injected services.
- [ ] Preserve compatibility shims during migration.

**Exit Criteria**

- [ ] New route migrations use injected services instead of ad hoc module state.
- [ ] Startup wiring is explicit and testable.

---

### Slice 7: Lifecycle Registry

**Goal:** replace app-attached shutdown state with explicit service lifecycle orchestration.

**Tasks**

- [ ] Introduce `Lifecycle` and `LifecycleRegistry`.
- [ ] Register runtime-managed infrastructure in startup order.
- [ ] Stop resources in reverse order with idempotent shutdown behavior.
- [ ] Add shutdown regression tests for partial-start and partial-stop paths.

**Exit Criteria**

- [ ] Manual shutdown list shrinks substantially.
- [ ] Graceful shutdown is deterministic and testable.

---

### Slice 8: Remaining Router Waves + Final Parity Sweep

**Goal:** finish the runtime route migration and run a broad regression sweep.

**Tasks**

- [ ] Convert remaining manual routers in waves.
- [ ] Re-run manifest and pilot contract coverage after each wave.
- [ ] Leave callbacks/webhooks and other high-risk transport routes for the final wave.

**Exit Criteria**

- [ ] Runtime route surface stays stable.
- [ ] Remaining manual validation is removed from migrated routes.
- [ ] Broad targeted runtime test suites pass.

---

## Cross-Slice Guardrails

- [ ] No slice lands without new or tightened regression coverage.
- [ ] No route migration lands without route-surface verification.
- [ ] Build before tests.
- [ ] Run Prettier on changed files before commit.
- [ ] Preserve existing response envelopes unless a slice explicitly scopes an envelope change.
- [ ] Keep static-before-parameterized route behavior intact.

---

## Acceptance Criteria

- [ ] Runtime OpenAPI migration is complete for the targeted route surface.
- [ ] Centralized error handling is active for migrated routes.
- [ ] Explicit composition root is the default wiring path in runtime.
- [ ] Lifecycle registry handles startup/shutdown for managed runtime services.
- [ ] Every landed slice added regression coverage and updated this document.

---

## Next Step After This Turn

1. Commit the completed Slice 5 `voice-analytics` conversion after one final formatting pass.
2. Start Slice 6 with a runtime service inventory around `server.ts`, existing singleton getters, and app-attached resources that need to move behind `createRuntimeServices()`.
3. Land the first composition-root seam in runtime without mixing lifecycle orchestration into the same change.
