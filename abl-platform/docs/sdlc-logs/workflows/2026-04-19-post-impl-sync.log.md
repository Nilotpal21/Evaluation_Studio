# Post-Implementation Sync — Workflows

**Date**: 2026-04-19
**Scope**: Test coverage hardening + two user-visible fixes in the workflows feature area. Not a feature rollout.
**JIRA**: ABLP-2

---

## Commits Synced

This log captures the doc updates made after the following feat/fix/test/refactor commits landed on `feat/workflow-version`:

| SHA          | Type     | Summary                                                                                    |
| ------------ | -------- | ------------------------------------------------------------------------------------------ |
| `f823309745` | fix      | studio: stop auto-save firing on Steps tab mount (React Flow `dimensions`/`select` filter) |
| `4bf1598258` | refactor | workflow-engine: rename output `_state` → `_status`                                        |
| `248e166c7e` | test     | workflow-engine: oauth-grant-resolver, restate-client, `_status` convention                |
| `d5ce37aa04` | refactor | workflow-engine: extract restate-endpoint shared handlers + tests                          |
| `9921d90573` | test     | workflow-engine: version-resolution cascade, trigger-scheduler lifecycle, parallel e2e     |
| `4db2f64f93` | test     | workflow-engine: execution-payload + route-helpers lib                                     |
| `adb844ea73` | test     | studio: unified inbox UI shell E2E spec + data-testids                                     |

Everything is on branch `feat/workflow-version`, Jira `ABLP-2`. No schema migrations, no production-config changes, no breaking API changes.

---

## Documents Updated

| File                                             | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/features/workflows.md`                     | §9 Active Gaps: added GAP-30 (canvas auto-save), GAP-31 (`_status` rename), GAP-32 (coverage audit closures). Updated GAP-01 test-count headline (700 → 790 tests, 52 → 59 workflow-engine files, 12 → 14 Playwright specs). `Last Updated` already 2026-04-19.                                                                                                                                                                                                                       |
| `docs/testing/workflows.md`                      | Workflow-Engine table: added 7 new file rows (oauth-grant-resolver, restate-client, restate-endpoint, workflow-output-status-convention, version-resolution, trigger-scheduler-lifecycle, execution-payload, route-helpers). Studio E2E table: added workflow-webhook-versioning + workflow-inbox rows. Gap Areas: struck out OAuth grant resolver integration, added Approval/human-task Playwright lifecycle gap. Headline updated to 790+ / 59 files. `Last Updated` → 2026-04-19. |
| `docs/testing/README.md`                         | Row #48 Workflows: UI count 12 → 14, date → 04-19.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `apps/workflow-engine/agents.md`                 | Appended 3 new 2026-04-19 sections: (1) output `_state` → `_status` convention + rename checklist, (2) restate-endpoint handlers extracted as pure exports, (3) coverage hardening recipe (DI fakes, no internal-package mocks). Plus gotcha on `trigger-scheduler-timezone.test.ts` scope.                                                                                                                                                                                           |
| `apps/studio/src/components/workflows/agents.md` | Appended 2 new 2026-04-19 sections: (1) React Flow `onNodesChange` dirty-filter gotcha, (2) parallel-step e2e pattern (handler overrides injected branchRunner).                                                                                                                                                                                                                                                                                                                      |
| `apps/studio/e2e/workflows/agents.md`            | (Updated in commit `adb844ea73` itself.) Folder Layout + Test Tiers table gained the inbox spec row; Node Types `human` row updated; Monitor & Debug gained an Inbox sub-section; Testid registry gained Inbox + Task Card sections.                                                                                                                                                                                                                                                  |

---

## Coverage Delta

| Package / Tier                                 | Before                                                                                                                                                                                                                              | After                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Workflow-engine unit / integration             | 52 files, 700+ tests                                                                                                                                                                                                                | **59 files, 790+ tests** (+7 / +90)                                                          |
| Workflow-engine gaps with ZERO direct coverage | oauth-grant-resolver (391 LOC), restate-client (248), restate-endpoint (176), version-resolution (indirect only), trigger-scheduler (15% — timezone only), execution-payload (96), route-helpers (102), output `_status` convention | All closed with direct unit tests                                                            |
| Handler-level e2e parallel coverage            | Absent from `e2e-basic/medium/advanced`                                                                                                                                                                                             | 3 new cases in `e2e-advanced.test.ts` (happy path, fail_fast throw, downstream reachability) |
| Studio Playwright specs                        | 12                                                                                                                                                                                                                                  | **14** (+`workflow-webhook-versioning`, +`workflow-inbox`)                                   |
| Studio inbox UI testids                        | none                                                                                                                                                                                                                                | `unified-inbox-*`, `inbox-type-filter-*`, `human-task-*` families                            |

**Production-code changes (non-test):**

- `apps/studio/src/store/workflow-canvas-store.ts` — filtered React Flow change events before flipping `isDirty` (closed GAP-30)
- `apps/workflow-engine/src/handlers/workflow-handler.ts` — renamed `_state` → `_status` in success + failure output (closed GAP-31)
- `apps/studio/src/components/workflows/canvas/panels/StepLogItem.tsx` — `StateReasonBanner` → `StatusReasonBanner`
- `apps/workflow-engine/src/services/restate-endpoint.ts` — extracted 4 shared-handler bodies as exported pure fns (no behaviour change; enables DI testing)
- `apps/studio/src/components/inbox/UnifiedInboxPage.tsx` + `TaskCard.tsx` — additive `data-testid` attributes

---

## Status Field Transitions

- **Feature spec (`docs/features/workflows.md`)**: BETA → **BETA** (no change). This sync is incremental hardening inside an existing BETA feature. No new functional capability shipped; no STABLE promotion criteria newly met (no production soak cited, full human-task Playwright lifecycle still Planned).
- **Test spec (`docs/testing/workflows.md`)**: PARTIAL → **PARTIAL** (no change). OAuth grant resolver gap closed, but approval/human-task Playwright lifecycle gap remains — the status stays PARTIAL until that Playwright spec can be written and validated against a live Restate stack.

---

## Remaining Gaps

1. **Approval / human-task Playwright lifecycle** (MEDIUM, documented in `docs/testing/workflows.md` §4 Gap Areas). Blocked on a dev-stack configuration that reliably produces a Restate-suspended workflow + durable promise. The UI-shell (empty state, filter pills, mailbox toggle) is now covered by `workflow-inbox.spec.ts`; the resolve-via-UI lifecycle still needs live suspension to test end-to-end. Testids for the action surface (`human-task-approve`, `human-task-reject`, `human-task-notes`) already exist so the eventual spec can hook in cleanly.
2. **Active gaps in `docs/features/workflows.md` §9** unchanged by this sync: GAP-02, GAP-03, GAP-05, GAP-06, GAP-07, GAP-08, GAP-10, GAP-11, GAP-12, GAP-13. None were in-scope for this coverage-hardening pass.

---

## Deviations from Plan

This was not a planned feature rollout — no LLD/HLD preceded it. Deviations therefore are internal to the coverage-audit workstream:

1. **`restate-endpoint` required a small refactor to be testable.** The original plan was "write a test for each flagged module." Four of the five shared-handler bodies in `buildRestateEndpoint` were inline lambdas calling the Restate SDK's `restate.handlers.workflow.shared(...)` wrapper — testing them would have forced `vi.mock('@restatedev/restate-sdk')` which violates CLAUDE.md's no-platform-mock rule (even though the SDK is third-party, the project prefers DI). Resolution: extracted the 4 bodies as pure exported functions (`handleCancel`, `handleResolveCallback`, `handleResolveApproval`, `handleResolveHumanTask`) taking a minimal `SharedCtxLike` interface. Refactor + test committed together (`d5ce37aa04`).
2. **`trigger-scheduler-lifecycle.test.ts` was created as a sibling file instead of extending the timezone file.** The existing `trigger-scheduler-timezone.test.ts` is named for its focus but covers more than timezone (scheduleOnce, basic processJob, unschedule, shutdown). Adding `schedulePolling` + version-cascade + callbackUrl + worker-failed-listener would have muddied that file's scope. A new focused file preserves the timezone suite's purpose and keeps each file's role clear — documented as a gotcha in `apps/workflow-engine/agents.md` so future authors know which file their new test belongs in.
3. **Approval/human-task full Playwright lifecycle was explicitly deferred.** Initially estimated as in-scope; dropped after verifying that (a) the dev-stack cannot reliably produce a suspended Restate promise without additional setup, (b) writing the spec without running it would either be a TODO-stub (blocked by `e2e-test-quality-lint.sh`) or fragile fiction. What shipped instead: `workflow-inbox.spec.ts` (4 UI-shell tests) + complete `data-testid` plumbing on `UnifiedInboxPage` and `TaskCard` so the eventual lifecycle spec can be written against stable selectors.
4. **Commits were split rather than bundled** per CLAUDE.md commit discipline (max 40 files, max 3 packages, refactor and test paired when they have to ship together). Ended with 7 focused commits over the session instead of one megacommit.

---

## Audit Findings

Self-audit against `post-impl-sync` quality gates:

- [x] Coverage matrix in `docs/testing/workflows.md` reflects actual test files (grep-verified)
- [x] File paths in `docs/features/workflows.md` match real locations (no invented files)
- [x] Status fields consistent (both feature spec and test spec remain at their pre-sync tiers — no promotion claimed)
- [x] Deviations documented above
- [x] `agents.md` updated for both packages touched (`apps/workflow-engine/`, `apps/studio/src/components/workflows/`) plus the e2e folder (`apps/studio/e2e/workflows/` — updated in the originating commit)
- [x] No mocks-as-coverage: every new test uses DI or stubs `globalThis.fetch` only. No `vi.mock` of `@agent-platform/*` / `@abl/*` / relative imports.
