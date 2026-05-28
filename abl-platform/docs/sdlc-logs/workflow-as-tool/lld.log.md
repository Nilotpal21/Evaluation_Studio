# SDLC Log — workflow-as-tool — LLD phase

**Date**: 2026-04-13
**Skill**: /lld
**Inputs**: docs/features/workflow-as-tool.md, docs/specs/workflow-as-tool.hld.md, docs/testing/workflow-as-tool.md
**Output**: docs/plans/2026-04-13-workflow-as-tool-impl-plan.md

## Oracle decisions (Phase 2)

All clarifying questions resolved without user escalation. Key decisions:

| Area                               | Decision                                                                                                                            | Class    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Implementation order               | Layer-first across 6 phases: IR → DSL/shared+DB → runtime executor → validator+IR loader → wiring+E2E → Studio UI                   | DECIDED  |
| Pattern to follow                  | Mirror SearchAI KB-as-tool end-to-end (executor shape, wiring location, internal JWT pattern)                                       | ANSWERED |
| Feature flag                       | None — dispatcher branch isolated; kill-switch via DB archive                                                                       | DECIDED  |
| Phase 1 scope                      | IR + validator foundation only; no runtime behavior change                                                                          | DECIDED  |
| File creation vs modification      | 8 new files (executor + 7 test files), 22 modified files across 5 packages                                                          | ANSWERED |
| Test strategy                      | Test-first per phase; DI fakes for Restate + Mongoose ONLY; zero platform mocks                                                     | DECIDED  |
| Type changes                       | `WorkflowBindingIR.triggerId` optional at type level, validator-enforced; `ResolvedToolImpl` / `ToolDefinitionLocal` unions widened | DECIDED  |
| DB migration                       | None — Mongoose enum is write-time; existing docs unaffected                                                                        | ANSWERED |
| Performance path                   | Sync-poll exp backoff `[250, 500, 1000, 2000]` capped at 2s until timeout                                                           | DECIDED  |
| Conflicts with in-flight work      | None — HLD dispatcher slot pre-wired at `tool-binding-executor.ts:573-582` and `ToolBindingExecutor` config at line 92,226          | ANSWERED |
| Biggest implementation risk        | `llm-wiring.ts` wiring block (marked High risk) — ~50 LOC insertion adjacent to SearchAI block                                      | INFERRED |
| Monitoring required before rollout | Telemetry counter `workflowTools` in session-start log; 6 trace events `tool.workflow.execute.*`                                    | DECIDED  |
| Definition of done                 | All 6 phases complete + 7 E2E + 7 INT + 6 UT passing; 5 pr-reviewer rounds clear; Studio smoke test recorded                        | DECIDED  |

## Audit rounds (Phase 4b)

### Round 1 — NEEDS_CHANGES (lld-reviewer — architecture compliance)

5 findings resolved:

- CRITICAL: Missing Zod `CreateWorkflowToolSchema` — every `POST /api/projects/:id/tools` with `toolType:'workflow'` would be rejected at request validation. Added as task 2.8.
- CRITICAL: Missing i18n keys task — all user-facing strings must be keyed. Added as task 6.10 with `pnpm i18n:check` exit criterion.
- HIGH: Async DB validation inside sync validator path would break IR load + form preview. Split into sync structural arm + new async `validate-workflow-tool-binding.ts` (task 4.1).
- HIGH: `ResolvedToolImpl.toolType` union missing `'workflow'` — added as task 2.7.
- HIGH: `ToolExecutor.execute` is 3-arg not 4-arg — corrected signature; moved session context (sessionId, agentName) into constructor config.

### Round 2 — NEEDS_CHANGES (lld-reviewer — pattern consistency)

3 HIGH + 7 MEDIUM + 2 LOW findings resolved:

- HIGH: `toolCallId` forwarding — 3-arg contract has no slot; documented as v1 gap at task 3.3 with mitigation (LLMWiringService tool_call dedup).
- HIGH: Wiring guard missing `resolvedTenantId && resolvedProjectId` checks — added guard at task 5.1 (executor URL requires both).
- HIGH: Error code discrimination absent — added `TOOL_TIMEOUT` / `TOOL_EXECUTION_ERROR` / `TOOL_NETWORK_ERROR` mapping at task 3.3.
- MEDIUM: Latency hint `'high'` is invalid — changed to `'slow'` (enum: `fast | medium | slow`).
- MEDIUM: Validator is if/else chain, not switch — corrected task 1.3 wording; added stale error-message fix.
- MEDIUM: Map lifecycle undocumented — added session-scope justification at task 3.2.
- MEDIUM: Binding-miss error lacked parity with SearchAI — added template string at task 3.3.
- MEDIUM: Next.js route segment is `[id]`, not `[projectId]` — corrected at task 4.1.
- MEDIUM: i18n namespaces generic — corrected to actual Studio namespaces (`tools.type_badge`, `tools.create_dialog`, `tools.list`, `tools.config.workflow`, `tools.detail.workflow`).
- LOW: Telemetry parity note — added alongside task 5.2 (keep with other per-type counters).

### Round 3 — NEEDS_CHANGES (lld-reviewer — completeness)

3 HIGH + 3 MEDIUM + 2 LOW findings resolved:

- HIGH: Telemetry key `workflowToolsCount` contradicts existing naming (`httpTools`/`sandboxTools`/`mcpTools` — no suffix) — normalized to `workflowTools`.
- HIGH: Test file path for `tool-schema-validator.test.ts` wrong — corrected to `__tests__/constructs/tool-schema-validator.test.ts`.
- HIGH: Test file path for `llm-wiring-telemetry.test.ts` wrong — corrected to `apps/runtime/src/__tests__/llm-wiring-telemetry.test.ts` (no `services/execution/__tests__/` dir).
- MEDIUM: `tool-extractor.ts` parse arm is if/else chain with `else → sandbox` terminal fallback — clarified insertion point before terminal else.
- MEDIUM: `ToolConfigurationSection.tsx` has no `useTranslations` hook yet — task 6.4 now introduces `useTranslations('tools.config.workflow')` in the workflow sub-component.
- MEDIUM: `ToolsListPage.tsx` URL-param whitelist at line 117 must include `'workflow'` — called out explicitly in task 6.6.
- MEDIUM: `standalone-tool-adapter.ts` cast is literal union — widen call-out added to task 2.5.
- LOW: `ToolCreateDialog` option shape — task 6.3 now specifies `{ value: 'workflow', label, description }`.

### Round 4 — APPROVED (phase-auditor — cross-phase consistency)

All 10 FRs, 12 HLD concerns, and 20 test scenarios (6 UT + 7 INT + 7 E2E) traced. 1 HIGH + 2 MEDIUM non-blocking inconsistencies fixed:

- HIGH: Telemetry name inconsistency between tasks (line 165, 375, 480 said `workflowToolsCount` but task 5.2 reasoned `workflowTools`) — normalized via `replace_all`.
- MEDIUM: File-change-map latency hint still said `'high'` — corrected to `'slow'` with enum note.
- MEDIUM: UT-5 test path divergence between LLD and test spec — LLD is authoritative; test-spec will reconcile via post-impl-sync.

### Round 5 — APPROVED (lld-reviewer — final sweep)

3 MEDIUM + 1 LOW non-blocking findings resolved:

- MEDIUM: `ToolDefinitionLocal.tool_type` union + `workflow_binding?` field not explicitly called out — widened task 2.7 to include lines 109 and ~114.
- MEDIUM: `tool-store.ts workflowCount` missing — added to task 6.1 (state, reducer, initial state).
- MEDIUM: `ToolSnapshotEntry.toolType` union at line 123 — folded into task 2.7.
- LOW: `ToolTypeBadge.tsx` exact line numbers (13/20/27 not 17/24/31) — clarified with "verify fresh" note.

## Artifact state

- **6 implementation phases**, each independently deployable and revertable.
- **12 design decisions** logged (D-1..D-12) with rationale and rejected alternatives.
- **22 modified files** + **8 new files** across `@abl/compiler`, `@agent-platform/shared`, `@agent-platform/database`, `@abl/runtime`, `@abl/studio`, `@abl/workflow-engine`.
- **20 test scenarios** mapped: 6 UT, 7 INT, 7 E2E. All E2E scenarios use real Express servers + real JWT + full middleware chain (no platform mocks).
- **Wiring checklist**: 16 items covering IR extensions, executor instantiation, dispatcher plumbing, UI components, trace events, telemetry, serializers.
- **Commit discipline**: Each phase respects ≤3 packages per commit; test commits split from feature commits per CLAUDE.md.
- **Acceptance criteria**: 16 items including zero `vi.mock` of platform, zero direct DB access in E2E, design-token compliance, status transition to ALPHA.

## Phase 3 — Tech Debt

1. **JSONPath resolver**: `rg jsonpath packages/shared/src packages/core/src` returned no hits. Implemented a minimal inline `$.a.b.c` dot-notation resolver in `workflow-tool-executor.ts:resolveJsonPath()`. Does NOT support wildcards, slicing, or filters. If broader JSONPath syntax is needed later, extract to a shared utility or adopt a library.
2. **WorkflowBindingIR barrel export**: The type is defined in `packages/compiler/src/platform/ir/schema.ts` but not re-exported from the `@abl/compiler` barrel (`packages/compiler/src/index.ts`). Phase 3 executor uses a local re-declaration. Phase 4/5 should add `WorkflowBindingIR` to the barrel export and remove the local type.
3. **toolCallId v1 gap**: The 3-arg `ToolExecutor.execute` contract has no slot for `toolCallId`. Not forwarded to the engine in v1. Dedup relies on LLMWiringService. A follow-up should widen the contract once SearchAI also needs it.

## Open questions tracked forward

1. `paramMapping` JSONPath helper — RESOLVED in Phase 3: no shared helper exists; inline minimal resolver implemented.
2. `auth.type: 'user_level'` webhook triggers — v1 blocks at validator (task 4.1e). Confirm with INT-4 fixture.
3. Companion "wait-for-workflow-execution" tool — deferred to future iteration; tracked in feature spec gaps during post-impl-sync.

## Oracle decisions — UI E2E LLD (2026-04-14)

Clarifying questions for FR-8/FR-9 BETA-gap UI E2E tests. All resolved without user escalation.

| #    | Area               | Decision                                                                                                    | Class    | Confidence |
| ---- | ------------------ | ----------------------------------------------------------------------------------------------------------- | -------- | ---------- |
| IS-1 | Ship order         | Testids first (1 commit), then specs in 2 commits (UI-E2E-1+2, UI-E2E-3+4)                                  | ANSWERED | HIGH       |
| IS-2 | Seeding helper     | New `apiCreateWorkflowWithWebhook` in `e2e/helpers/workflow-seed.ts` using `apiPost`                        | DECIDED  | HIGH       |
| IS-3 | Project fixture    | Shared project (Weather App pattern), `beforeAll` seeding, `afterAll` cleanup                               | DECIDED  | HIGH       |
| IS-4 | Testid naming      | Kebab-case, use exact names from test spec lines 219-226                                                    | INFERRED | HIGH       |
| IS-5 | CI gating          | Unconditional — no feature flag; `testDir: './e2e'` picks up all specs                                      | INFERRED | HIGH       |
| TD-1 | Testid files       | 5 components from test spec are complete; `ToolConfigurationSection.tsx` is pass-through, no testids needed | ANSWERED | HIGH       |
| TD-2 | Server setup       | Runs against existing `pnpm dev` (PM2); `reuseExistingServer: true` in playwright.config                    | ANSWERED | HIGH       |
| TD-3 | Save button        | Detail page header (`ToolDetailPage.tsx:652-660`), not dialog; testid `save-tool-button` goes there         | ANSWERED | HIGH       |
| TD-4 | Cross-project      | Same user, navigate to second project URL; token is tenant-scoped                                           | INFERRED | MEDIUM     |
| TD-5 | No-flash           | No existing pattern; use `aria-selected` count assertion, skip console sentinel                             | DECIDED  | MEDIUM     |
| RD-1 | Concurrent work    | Low risk — recent tool-component commits are all on Workflow_Tool branch                                    | INFERRED | MEDIUM     |
| RD-2 | Biggest risk       | Flaky timing on API seeding, not testid breakage; mitigate with `pollUntil`                                 | DECIDED  | HIGH       |
| RD-3 | CI pipeline        | Not gated on PRs currently; document manual `npx playwright test workflow-tool`                             | DECIDED  | MEDIUM     |
| RD-4 | Artifacts          | Already configured: `trace: 'on-first-retry'`, `screenshot: 'only-on-failure'`                              | ANSWERED | HIGH       |
| RD-5 | Definition of done | 4 specs pass + test-spec matrix updated + `/post-impl-sync` for BETA promotion                              | DECIDED  | HIGH       |

## Next phase

Run `/compact`, then `/implement workflow-as-tool` to begin phased implementation with pr-reviewer agent running 5 mandatory audit rounds per phase.

---

## 2026-04-14 — UI E2E LLD (sibling plan for FR-8/FR-9 BETA gap)

**Output**: `docs/plans/2026-04-14-workflow-as-tool-ui-e2e-impl-plan.md`
**Scope**: test-only, additive (Studio testids + 2 Playwright spec files). No UI HLD — architecture is trivial.

### Audit rounds (compressed loop: 2 rounds — test-only scope; parent LLD cleared 5 rounds for backend)

#### Round 1 — NEEDS_CHANGES (lld-reviewer — architecture + completeness + pattern consistency)

2 HIGH + 3 MEDIUM + 2 LOW findings, all resolved in-place:

- HIGH: UI-E2E-1 step 9 (async-mode default pre-fill) missing from task 2a.3 — expanded to "9 steps from lines 162–171" with explicit step-9 call-out.
- HIGH: UI-E2E-1 Isolation Check from test spec line 174 not mapped — added to task 2a.3.
- MEDIUM: UI-E2E-3 cross-project check (line 202) — line range widened to 194–202 with explicit assertion sentence in task 2b.1.
- MEDIUM: Testid count mismatch (change-map said "6" for WorkflowConfigForm, listed 5) — corrected to 5; Phase 1 exit criterion updated to "13 total patterns" with per-file breakdown.
- MEDIUM: `save-tool-button` file reassignment (LLD → ToolDetailPage.tsx, test-spec prereq says WorkflowConfigForm) — now explicitly noted in the file-change-map row with rationale; LLD declared authoritative for file placement.
- LOW: `namePrefix` JSDoc referenced `nanoid(6)` but plan uses `crypto.randomUUID().slice(0,6)` — JSDoc updated.
- LOW: OQ-3 (existence of `apps/studio/agents.md`) — resolved in-LLD; Phase 2b will append workflow-tool E2E section.

#### Round 2 — APPROVED (phase-auditor — cross-phase consistency)

0 CRITICAL / 0 HIGH. One MEDIUM deferred to `/post-impl-sync`:

- MEDIUM: Test spec prereq block still lists `save-tool-button` under `WorkflowConfigForm.tsx` — to be reconciled when `/post-impl-sync` flips the coverage matrix.

Round 3 skipped — auditor explicitly noted "No round 3 needed unless LLD is modified." Test-only, additive scope makes further rounds low-value.

### Artifact state (UI E2E plan)

- **3 implementation phases**: Phase 1 testids (5 production files, additive), Phase 2a spec file for UI-E2E-1+2, Phase 2b spec file for UI-E2E-3+4, Phase 3 manual-doc annotation.
- **10 design decisions** (D-1..D-10) covering ship order, file placement, seed helper extraction, fixture strategy, auto-retry assertion, cross-project approach, testid naming, dev-server reuse, serial/parallel mode, manual doc coexistence.
- **3 new files**, **5 modified production files**, **2 modified docs** — all within `apps/studio` package; zero cross-package changes.
- **Commit plan**: 3 commits — `test(studio): add workflow-tool testids for UI E2E`, then `test(studio): FR-8/FR-9 workflow-tool config UI E2E (UI-E2E-1, UI-E2E-2)`, then `test(studio): workflow-tool list & badge UI E2E (UI-E2E-3, UI-E2E-4)`, plus `docs(testing): annotate workflow-as-tool manual smoke doc`.
- **Acceptance criteria** (8 items) gated on 3-consecutive-local-run stability + `/post-impl-sync` promoting ALPHA → BETA.

### Next phase

Run `/compact`, then `/implement workflow-as-tool-ui-tests` (or spawn implementer directly against the new plan). Each phase is independently commit-able; Phase 1 must merge before Phase 2a/2b.
