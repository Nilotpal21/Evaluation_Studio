# LLD Oracle Log: Workflow First-Class Memory, Agent Session, and Context

**Phase**: LLD (Phase 4 of SDLC pipeline)
**Skill**: `/lld workflow-first-class-memory-and-context`
**Date**: 2026-04-27
**Owner**: Pattabhi
**Inputs**: Feature spec (FR-1..FR-23), HLD (12 concerns + prerequisite), Test spec (5 E2E + 16 INT + 7 UT), prior oracle logs (`feature-spec.log.md`, `hld.log.md`, `test-spec.log.md`).

---

## 1. Oracle Decisions (17 questions, 0 escalations)

All questions answered autonomously by `product-oracle` against feature spec, HLD, test spec, and source code. No AMBIGUOUS items — no user escalations required.

### Implementation Strategy

| #   | Question                                                               | Classification | Source                                                                                          |
| --- | ---------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| S1  | Phasing order (prereq → fact-store → route → reads → writes → erasure) | DECIDED        | HLD Concern #1 + §8.1, oracle D-8, feature spec §13, CLAUDE.md commit discipline                |
| S2  | Feature flag strategy (un-flagged, additive)                           | ANSWERED       | `hld.log.md` D-7, HLD Concern #10, #11; `apps/workflow-engine/src/diagnose/flag-catalog.ts`     |
| S3  | Phase 1 scope (`requireServiceAuth` standalone Phase 0)                | DECIDED        | HLD §8.1 ("separate first commit"), CLAUDE.md commit discipline                                 |
| S4  | Ralph-loop cadence (commit-per-phase, ~7 commits)                      | DECIDED        | CLAUDE.md "Commit Discipline" 40-file/3-package max, `docs/sdlc/pipeline.md` Commit Conventions |
| S5  | Test-first vs. test-after per phase                                    | DECIDED        | Oracle D-9 (prototype `applySyncPromise` first), test spec §3, CLAUDE.md "Test Architecture"    |

### Technical Details

| #   | Question                                                                                  | Classification | Source                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| T1  | Exact file paths to create / modify                                                       | INFERRED       | HLD §10, test spec §8, codebase structure                                                                               |
| T2  | `__originAdapter` mechanism (protected internal method on `MongoDBFactStore`)             | DECIDED        | `apps/runtime/src/services/stores/mongodb-fact-store.ts:122`, `packages/compiler/src/platform/stores/fact-store.ts:133` |
| T3  | Audit log destination (stdout via `createLogger('workflow-memory')`, no Mongo collection) | ANSWERED       | `hld.log.md` I3/D-6, HLD §5.3 + §7, HLD Open Q #1                                                                       |
| T4  | `Fact` model: both `deletedAt` and `isDeleted` fields                                     | DECIDED        | `packages/database/src/models/fact.model.ts:63` compound unique index, HLD §5.1                                         |
| T5  | `applySyncPromise` perf budget: `UV_THREADPOOL_SIZE=8`, no isolate pool today             | DECIDED        | `apps/workflow-engine/src/executors/function-executor.ts:88,293-295` (per-call isolate, no pool), HLD Concern #9        |
| T6  | TTL ceiling: introduce `MAX_FACT_TTL_MS = 365d` at runtime memory route layer             | INFERRED       | `apps/runtime/src/services/stores/mongodb-fact-store.ts:39` (DEFAULT_FACT_TTL_MS only), feature spec FR-13, GAP-011     |
| T7  | Erasure cascade entry points: v1 ships contact-only with explicit GAP                     | DECIDED        | `apps/runtime/src/contexts/contact/use-cases/cascade-delete-contact.ts:49-121`, HLD Open Q #4                           |

### Risk & Dependencies

| #   | Question                                                                                                           | Classification | Source                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| R1  | No conflicting in-flight changes; `triggerMetadata` already exists on `WorkflowExecution`                          | ANSWERED       | `git log`, `git branch -r`, `packages/database/src/models/workflow-execution.model.ts:120,244` (stale agents.md entry) |
| R2  | Biggest risk: `applySyncPromise` thread starvation                                                                 | DECIDED        | `function-executor.ts:88,104,118,217`, oracle D-9, HLD Concern #9                                                      |
| R3  | Definition of done: 7 phases merged + INT-1..16 + E2E-1..5 + UT-1..7 + status → ALPHA                              | DECIDED        | Feature spec §14, test spec §6 + §10, `docs/sdlc/pipeline.md` Feature Status Lifecycle                                 |
| R4  | Monitoring (6 metrics): op duration p95, error rate, projection latency, key count, audit volume, quota near-limit | DECIDED        | HLD Concern #8 + #9, feature spec §12                                                                                  |
| R5  | Pattabhi-owned end-to-end (no CODEOWNERS)                                                                          | INFERRED       | Feature spec header, no `.github/CODEOWNERS`, single-team git history                                                  |

---

## 2. Decisions Made (D-1 .. D-11)

| #    | Decision                                                                                                                        | Rationale                                                                                                 | Risk |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---- |
| D-1  | 7-phase order: prereq → fact-store → route → context reads → isolate writes → erasure → tests                                   | Stable foundation per phase; reads-before-writes per oracle D-8; minimum blast radius                     | Low  |
| D-2  | `requireServiceAuth` tenantId cross-check ships as standalone Phase 0 commit (`fix(runtime):` type)                             | Benefits all internal routes; one-concern-per-commit; independently revertible                            | Low  |
| D-3  | Commit-per-phase (~7 commits in one PR; possibly 2 PRs if Phase 0 lands separately)                                             | Stays within 40-file/3-package limits; bisectable                                                         | Low  |
| D-4  | Test-first for pure functions and gap assertions; prototype-first for `applySyncPromise`                                        | Risk-gradient match; avoids TDD thrashing on unproven isolate pattern                                     | Low  |
| D-5  | `__originAdapter` enforced via `protected _setInternal()` on `MongoDBFactStore`; `FactStoreWorkflowAdapter` extends             | Minimum coupling; no break to `FactStore` abstract class or existing callers                              | Low  |
| D-6  | `Fact` model gets BOTH `deletedAt: Date \| undefined` AND `isDeleted: boolean \| undefined`                                     | Index-friendly read filter (`isDeleted: {$ne: true}`) + audit-reconstructible deletion timestamp          | Low  |
| D-7  | Introduce `MAX_FACT_TTL_MS = 365d` constant; clamping enforced at runtime memory route layer (NOT fact-store)                   | Aligns with attachment retention (`MAX_RETENTION_DAYS = 365`); fact-store stays ceiling-unaware           | Low  |
| D-8  | v1 ships contact-only erasure cascade; `customerId` / `anonymousId` / channel-artifact deferred to v1.1                         | No existing cascade entry points; separate design effort; documented as updated GAP-007                   | Med  |
| D-9  | Prototype `applySyncPromise` in Phase 4 BEFORE writing INT-3 / INT-12; verify timeout, error propagation, libuv saturation      | Novel pattern, highest implementation risk; oracle D-9 reaffirmed                                         | Med  |
| D-10 | 6 metrics minimum before rollout — op duration p95 / error rate / projection load / key count / audit volume / quota near-limit | Observable v1 without new monitoring infrastructure; thresholds tunable post-launch                       | Low  |
| D-11 | `UV_THREADPOOL_SIZE=8` as workflow-engine v1 default (env var on process)                                                       | Doubles libuv default of 4; accommodates concurrent `applySyncPromise` without starving DNS/fs operations | Med  |

---

## 3. Source-Code Findings (from explorer)

Verified file paths, function signatures, and structural facts. Key surprises that shaped the LLD:

1. **No `applySyncPromise` pattern exists today.** `function-executor.ts` only uses `ivm.Callback` (sync, fire-and-forget). `applySyncPromise` is genuinely new — Phase 4 must prototype it first (D-4, D-9).
2. **`triggerMetadata` field IS declared** on `WorkflowExecution.model.ts` L120/L244 as `{ type: Schema.Types.Mixed, default: {} }`. The `apps/workflow-engine/agents.md` 2026-03-24 entry warning that the field is missing is stale — closed by R1.
3. **`tool-memory-bridge.ts` is `MemoryConfig`-gated.** Its `pathMap` rejects keys not declared in the agent's MEMORY section. It cannot target `wf:` keys via its public API today — INT-7 step 5 verifies this structurally rather than via reader-time guard.
4. **`MongoDBFactStore.set()` signature is `set(params: SetFactParams): Promise<Fact>`** (L122) and follows the abstract `FactStore` class contract. Adding `__originAdapter` to `SetFactParams` would break every implementer (e.g., `InMemoryFactStore`). D-5 confirms protected internal method is the right shape.
5. **`Fact` model has TTL index on `expiresAt`** (L64) and unique compound index on `{tenantId, userId, projectId, scope, key}` (L63). Tombstones don't conflict — same compound key, just `isDeleted=true`. TTL index auto-expires tombstones via `expiresAt`.
6. **`CascadeDeleteContact` uses DI ports pattern** — adding a new optional `factErasure?` port follows existing `scrubMessages`/`clickhouseCleanup` precedent. No new design needed.
7. **`packages/database/src/cascade/cascade-delete.ts` has NO extension hooks** — `deleteTenant`, `deleteProject` use direct `Fact.deleteMany(filter)` calls. Tenant/project-level cascade is unaffected by v1 (those still hard-delete; tombstone semantics are workflow-memory-route-only).
8. **Studio E2E pattern reference**: `apps/studio/e2e/workflows/workflow-function-node.spec.ts` uses Playwright + Zustand store injection. Three new specs follow this exact pattern.

---

## 4. Audit Rounds (5 mandatory, lld-reviewer + phase-auditor)

To be appended after each round.

### Round 1 — lld-reviewer (architecture compliance) — NEEDS_REVISION → RESOLVED

**Critical (1):** C-1 Stateless violation — Section 7 Open Q #1 contradicted Phase 2 task 2.4 by allowing in-process Map fallback for the per-run write counter. Resolved: locked Redis-only, throw `STORAGE_UNAVAILABLE` if Redis is down. In-process state would break Invariant 3 (two pods → 200 writes total).

**High (4):**

- H-1 `createServiceToken` API signature mismatch — fixed to show 2-arg call `createServiceToken(secret, opts)` per `packages/shared-auth/src/middleware/jwt-verify.ts:163`. Updated `RuntimeMemoryClientOptions` doc-comment.
- H-2 Non-existent factory path for `CascadeDeleteContact` — replaced with verified composition site `apps/runtime/src/contexts/contact/index.ts:130` (single production composition).
- H-3 `executeFunctionStep` is standalone function with no DI — locked the new signature `executeFunctionStep(step, ctx, deps?)` with optional third param `FunctionExecutorDeps`; backward-compatible.
- H-4 Failure-path trace events underspecified — clarified §5.5 trace event table: every `memory_op` request emits exactly one trace (success OR error with `errorCode`); added `applysync_timeout` event; clarified audit log only fires for successful `set`/`delete`.

**Medium (resolved during round 1):**

- M-2 Tombstone behavior change for `tool-memory-bridge.ts` callers — added downstream-effect note in Phase 1 task 1.3.
- M-1 `applySyncPromise` per-pod concurrency cap — acknowledged via D-11 + Open Q #6; deadlock regression test in Phase 4 covers the worst case. Tracked.
- M-3 Audit log doesn't capture `get` ops — explicitly v1 scope per FR-22; v1.1 if compliance demands.
- M-4 Phase 3 at 2-package limit — within bounds.

**Strengths preserved:** Tenant isolation (dual-layer guard at Phase 0 + fact-store), centralized auth (`createServiceToken` + `requireServiceAuth`), reserved-prefix two-layer guard, E2E compliance, commit discipline (Phase 1 split feat + refactor), TTL clamp + trace, audit log excludes value, tombstone auto-expiry.

### Round 2 — lld-reviewer (pattern consistency) — NEEDS_REVISION → RESOLVED

**Critical (2):**

- C-1 `MongoDBFactStore` has `private` fields — `extends`-based `FactStoreWorkflowAdapter` is structurally impossible. **Switched to composition** (verified via grep: 4 private fields + 1 private method on the parent class). Adapter holds an inner project-scope `MongoDBFactStore` and uses a friend-class cast `(this.inner as unknown as { _setInternal: ... })._setInternal(...)` for the reserved-prefix bypass. D-5 updated.
- C-2 Adapter constructor missing `userId` — fixed by hardcoding `'__project__'` (PROJECT_SCOPE_USER_ID sentinel) inside the adapter when constructing `inner`.

**High (5):**

- H-1 No Zod validation specified — added `z.string().min(1)` schemas for all 4 endpoints in Phase 2 task 2.1 per CLAUDE.md zod-id-lint rule (no .cuid/.uuid).
- H-2 No try/catch envelope — added explicit error envelope handler block to Phase 2 task 2.1 with code-to-status mapping.
- H-3 `ContactContextDeps` interface update missing — added new sub-task 5.2a: update `apps/runtime/src/contexts/contact/index.ts:80-97` interface and factory call at line 130-136.
- H-4 Path inconsistency `factories/fact-erasure.ts` — task 5.3 path corrected to `apps/runtime/src/contexts/contact/fact-erasure.ts` (matches Files Touched table).
- H-5 `applySyncPromise` vs existing `_contextWrite` — Phase 4 task 4.5 explicitly calls out additive coexistence with `_contextWrite` (line 118), console-capture (104-109), and Proxy wrapper (139-213).

**Medium (3):**

- M-1 Trace emission mechanism unspecified — clarified in §5.5: structured logs via `createLogger('workflow-memory').info('trace:<event>', ...)`; new GAP-017 for v1.1 TraceStore integration.
- M-2 `memoryProjection` was required — changed to optional with default `{ workflow: {}, project: {}, user: undefined }` in `buildWorkflowContext`.
- M-3 Non-JSON-serializable values — Phase 2 task 2.4 catches `JSON.stringify` throws and returns 400 `INVALID_VALUE`.

**Strengths preserved:** Zero `vi.mock` in test plan; error envelope consistency with `internal-tools.ts`/`internal-chat.ts`; one-concern-per-commit phasing; round 1 stateless fallback fully resolved.

### Round 3 — lld-reviewer (completeness; file paths verified) — NEEDS_REVISION → RESOLVED

**Critical (2):**

- C-1 Wiring chain wrong — `executeFunctionStep` is called by `step-dispatcher.ts:279`, NOT `workflow-handler.ts`. Verified via `grep`. Updated Phase 4 §4.5 with the full 4-hop chain (`index.ts` → `RestateEndpointDeps` → `WorkflowHandlerDeps` → `StepDispatcherDeps` → `executeFunctionStep`). Added `step-dispatcher.ts`, `restate-endpoint.ts`, `index.ts` to §2.2 Modified Files. Updated wiring checklist Phase 4 item.
- C-2 Workflow-engine entry point is `index.ts`, NOT `server.ts` (verified `apps/workflow-engine/src/server.ts` does not exist). Phase 6 §6.7 + Files Touched corrected. Wiring checklist corrected.

**High (5):**

- H-1 New file count `(15)` mismatched 19 rows + 2 missing entries — corrected to `(21)` and added `agent-projection.ts` + `fact-erasure.ts` to §2.1.
- H-2 UT-2 (TTL clamping pure fn) had no file assignment — co-located in `internal-memory-route.integration.test.ts` per Phase 2 §2.7 update.
- H-3 INT-10 was implicit — explicit assignment to `expression-resolver.test.ts` (extending UT-7) per Phase 4 exit criteria update.
- H-4 `apps/workflow-engine/src/clients/` is a NEW directory — flagged in §2.1 + Phase 4 Files Touched.
- H-5 Error code mismatch — locked at `code: 'FORBIDDEN'` for tenantId mismatch (matches existing projectId pattern). INT-2 expectations to be updated during Phase 0 implementation, NOT this LLD pass.

**Medium (5):**

- M-1 `StepDispatcherDeps` not in §2.2 — added.
- M-2 `restate-endpoint.ts` not in §2.2 — added.
- M-3 Feature spec scenario #19 (workflow-as-tool nesting) covered by E2E-5 only — acceptable; integration coverage of nesting is structural via the `agentSession` materialization in `workflow-tool-executor.ts` projecting through trigger metadata regardless of caller layer.
- M-4 GAP-017 (TraceStore) — Phase 5 §5.5 updated to add GAP-016 + GAP-017.
- M-5 Some exit criteria less measurable — Phase 4 prototype criterion clarified.
- M-6 Open questions — confirmed all 6 are post-launch tunables; no blockers.

**FR coverage:** Re-derived independently. ALL 23 FRs map to at least one phase task. No orphans.

**Signature verification:** All 17 LLD signature claims verified against actual source code. All correct.

**Strengths preserved:** Tenant isolation, centralized auth, reserved-prefix two-layer guard, E2E compliance, Zod validation specified.

### Round 4 — phase-auditor (cross-phase consistency) — APPROVED

**Verdict:** APPROVED with 2 HIGH (doc-level, non-blocking) + 1 MEDIUM (self-tracked).

**High (2):**

- Feature spec §17 row 2 references `workflow-integration.test.ts` (nonexistent in LLD/test spec mapping) — added to LLD §6 acceptance criteria as a `/post-impl-sync` reconciliation item.
- LLD §6 missing test spec status transition `PLANNED → STABLE` — added.

**Cross-phase consistency:** 23/23 FRs covered, 28/28 test scenarios mapped, 12/12 HLD concerns reflected, 4/4 HLD open questions closed/deferred, 15+2/17 GAPs closed/deferred, 4/4 keystone regression scenarios named with explicit test files.

### Round 5 — lld-reviewer (final sweep) — APPROVED

**Verdict:** APPROVED — commit-ready.

**High (1, doc-only):**

- H-1 `restate-endpoint.ts` path was missing `services/` prefix in 3 locations — corrected to `apps/workflow-engine/src/services/restate-endpoint.ts` via global replace.

**Medium (3, implementation notes — not design issues):**

- M-1 `buildRestateEndpoint` uses field-by-field enumeration (not spread) — implementer must add `memoryClient: deps.memoryClient` to the explicit object literal at `services/restate-endpoint.ts:141-153`. Noted.
- M-2 `apps/workflow-engine/src/context/index.ts` barrel doesn't exist — direct import (the parenthetical fallback in the wiring checklist) is correct; do NOT create a barrel for one module.
- M-3 Phase 1 rollback tombstone-linger edge case — HLD §11 already specifies the tombstone-cleanup script before code revert; LLD §3 Phase 1 rollback line refers to "Revert the commit" — covered by HLD reference.

**Phase Independence Matrix:** all 7 phases pass — Phase 5 depends only on Phase 1 (tombstone), not on Phases 2-4.

**Per-Phase Commit Size:** every commit ≤ 40 files, ≤ 3 packages. Phase 1 split into 1a (`feat`, 5 files / 2 packages) + 1b (`refactor`, 1 file / 1 package).

**Strengths preserved:** multi-layered tenant isolation, composition over inheritance (D-5), full 4-hop wiring chain traced with file:line references, Redis fail-closed, prototype-first for applySyncPromise, 22 measurable acceptance criteria, 6 post-launch-only open questions.

---

## Final Verdict

**APPROVED across all 5 rounds.** Commit-ready.

---

## 5. References

- Feature spec: `docs/features/sub-features/workflow-first-class-memory-and-context.md`
- HLD: `docs/specs/workflow-first-class-memory-and-context.hld.md`
- Test spec: `docs/testing/sub-features/workflow-first-class-memory-and-context.md`
- Prior oracle logs: `feature-spec.log.md`, `hld.log.md`, `test-spec.log.md`
- Pipeline: `docs/sdlc/pipeline.md`
- LLD playbook: `docs/sdlc/lld-playbook.md`
