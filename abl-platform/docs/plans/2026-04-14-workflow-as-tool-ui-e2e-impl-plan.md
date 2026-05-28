# LLD: Workflow-as-Tool — FR-8/FR-9 UI E2E Coverage (BETA Gap)

**Feature Spec**: `docs/features/workflow-as-tool.md` (status: ALPHA → targeting BETA)
**HLD**: N/A — architecture is trivial ("Playwright specs at known path with prescribed testids"). The backend HLD at `docs/specs/workflow-as-tool.hld.md` (status: IMPLEMENTED) governs the system under test.
**Test Spec**: `docs/testing/workflow-as-tool.md` §2 UI-E2E-1..4 (lines 155–215) + testid prerequisite block (lines 219–227) + file location convention (line 217)
**Parent LLD**: `docs/plans/2026-04-13-workflow-as-tool-impl-plan.md` (status: DONE)
**Status**: DONE
**Date**: 2026-04-14

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                                                                                                                             | Rationale                                                                                                                               | Alternatives Rejected                                                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | Ship testid additions as a **separate additive commit** before any spec file lands.                                                                                                                  | Respects commit-scope-guard (≤40 files, ≤3 pkgs) and keeps production-code churn testable on its own; unblocks parallel spec authoring. | Bundle testids + specs into one commit → violates additive-feat rule and blocks partial revert.                                  |
| D-2  | Spec files live at `apps/studio/e2e/workflow-tool-config.spec.ts` and `apps/studio/e2e/workflow-tool-list.spec.ts` (Tools-page tier).                                                                | Tier table in `apps/studio/e2e/workflows/agents.md` reserves `workflows/` subfolder for canvas/engine-integration tests.                | Place under `workflows/` → violates tier table and triggers wrong `agents.md` sync requirement.                                  |
| D-3  | Introduce a **single new helper** `e2e/helpers/workflow-seed.ts` exporting `seedWorkflowWithWebhook(ctx, token, opts)` and `seedCronOnlyWorkflow(ctx, token, opts)`; re-export from `helpers/index`. | Seeding logic shared across UI-E2E-1..4; avoids 4× inline duplication. Thin wrappers around existing `apiPost`.                         | Inline `apiPost` in every spec → duplicated URL strings + payload drift between tests.                                           |
| D-4  | Use a **shared project fixture** (`Weather App` pattern from `tools.spec.ts`), seed per-test workflows with unique name suffixes (`wf_ui_sync_<nanoid>`).                                            | Matches existing `tools.spec.ts` convention; avoids per-test project creation overhead (~2s).                                           | Create+destroy project per test → slower and duplicates `loginViaDevApi` orchestration.                                          |
| D-5  | UI-E2E-3 "no-flash" assertion uses Playwright's auto-retrying `expect(locator).toHaveAttribute('aria-selected', 'true')` on the target tab only; no console sentinel or MutationObserver in round 1. | Simpler; auto-retry rides through React reconciliation. Falls back to MutationObserver only if flakes observed in CI (test-spec OQ-5).  | Ship MutationObserver first → unnecessary complexity; violates "optimal not over-engineered."                                    |
| D-6  | UI-E2E-4 cross-project isolation uses the **same user, different projectId in URL**.                                                                                                                 | Auth token is tenant-scoped; project isolation is enforced at route-handler layer; test must assert fetch path, not token path.         | Seed a second user → adds auth plumbing that test spec §2 doesn't mandate; cross-**tenant** is already covered by backend E2E-6. |
| D-7  | Testid naming: **kebab-case**, exact strings from test spec §2 prereq block (lines 219–226) — no additional testids added in this pass.                                                              | Test-spec is authoritative; adding extra testids expands surface area without coverage benefit.                                         | Invent a registry — out of scope for this LLD.                                                                                   |
| D-8  | The 4 specs run against the existing `pnpm dev` stack (Studio 5173, Runtime 3112, Workflow-Engine 9081) via `playwright.config.ts` `reuseExistingServer: true`.                                      | Matches how `tools.spec.ts` and `workflows/*.spec.ts` already run locally and in CI.                                                    | Spin up new test stack → duplicates Docker/PM2 setup already working.                                                            |
| D-9  | Each spec uses `test.describe.configure({ mode: 'serial' })` within its file (list + config each serialize their own tests) but **files run in parallel** (Playwright default).                      | UI-E2E-1→2→3→4 share seeded workflows across `beforeAll`; serial keeps seed state predictable without cross-file coupling.              | Full parallel within a file → seeded workflow state would race between tests; split into 4 files → costs 4× auth orchestration.  |
| D-10 | Manual smoke test doc (`docs/testing/manual-smoke-tests/workflow-as-tool-studio.md`) is **kept as visual/UX regression checklist**; annotate each item with `[automated by UI-E2E-N]` in Phase 3.    | Confirmed in test-spec OQ-4.                                                                                                            | Delete the doc → loses UX regression value (design-token colors, layout rhythm not asserted by testids).                         |

### Key Interfaces & Types

```typescript
// apps/studio/e2e/helpers/workflow-seed.ts (new)
import type { APIRequestContext, Page } from '@playwright/test';

export interface SeededWorkflow {
  workflowId: string;
  triggerId: string;
  name: string; // display name, unique per seed call
}

export interface SeedWorkflowOptions {
  projectId: string;
  /** Default: 'sync' */
  mode?: 'sync' | 'async';
  /** Default: [{ name: 'topic', type: 'string', required: true }] */
  inputVariables?: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'json';
    required?: boolean;
    description?: string;
  }>;
  /** Default: auto-generated `wf_ui_${mode}_<6-char suffix>` via `crypto.randomUUID().slice(0,6)` */
  namePrefix?: string;
  /** Default: 'active' */
  status?: 'active' | 'draft';
}

/** Seeds an active workflow with exactly one webhook trigger via POST /api/projects/:projectId/workflows. */
export function seedWorkflowWithWebhook(
  ctx: Page | APIRequestContext,
  token: string,
  opts: SeedWorkflowOptions,
): Promise<SeededWorkflow>;

/** Seeds an active workflow with exactly one cron trigger (zero webhooks). Used by UI-E2E-2. */
export function seedCronOnlyWorkflow(
  ctx: Page | APIRequestContext,
  token: string,
  opts: Omit<SeedWorkflowOptions, 'mode'>,
): Promise<SeededWorkflow>;

/** Deletes a seeded workflow by id; safe to call in `afterAll`. */
export function deleteSeededWorkflow(
  ctx: Page | APIRequestContext,
  token: string,
  projectId: string,
  workflowId: string,
): Promise<void>;
```

### Module Boundaries

| Module                                   | Responsibility                                                       | Depends On                                               |
| ---------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------- |
| `e2e/helpers/workflow-seed.ts` (new)     | Idempotent workflow seeding via HTTP API; unique-name-suffix policy. | `helpers/api.ts` (`apiPost`, `apiDelete`), `helpers/env` |
| `e2e/workflow-tool-config.spec.ts` (new) | UI-E2E-1 (picker + mode default), UI-E2E-2 (empty-state).            | `helpers/*`, `workflow-seed`                             |
| `e2e/workflow-tool-list.spec.ts` (new)   | UI-E2E-3 (tab + deep-link), UI-E2E-4 (badge + binding panel).        | `helpers/*`, `workflow-seed`                             |
| Studio components (5 files)              | Expose `data-testid` attributes listed in test-spec prereq block.    | No new runtime deps                                      |

---

## 2. File-Level Change Map

### New Files

| File                                           | Purpose                           | LOC  |
| ---------------------------------------------- | --------------------------------- | ---- |
| `apps/studio/e2e/helpers/workflow-seed.ts`     | Seeding helpers (D-3).            | ~90  |
| `apps/studio/e2e/workflow-tool-config.spec.ts` | UI-E2E-1 + UI-E2E-2 (Playwright). | ~220 |
| `apps/studio/e2e/workflow-tool-list.spec.ts`   | UI-E2E-3 + UI-E2E-4 (Playwright). | ~180 |

### Modified Files

| File                                                         | Change Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Risk |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `apps/studio/src/components/tools/ToolsListPage.tsx`         | Add `data-testid="tools-tab-workflow"` on workflow tab trigger; `data-testid={\`tool-row-${tool.id}\`}`on list rows;`data-testid="tool-create-button"` on the primary New Tool button.                                                                                                                                                                                                                                                                                             | Low  |
| `apps/studio/src/components/tools/ToolCreateDialog.tsx`      | Add `data-testid="tool-type-option-workflow"` on the workflow option; `data-testid="tool-create-name-input"` on the name input.                                                                                                                                                                                                                                                                                                                                                    | Low  |
| `apps/studio/src/components/tools/WorkflowConfigForm.tsx`    | Add 5 testids: `workflow-picker-select`, `trigger-picker-select`, `mode-selector`, `input-variables-preview`, `no-webhook-triggers-empty-state`.                                                                                                                                                                                                                                                                                                                                   | Low  |
| `apps/studio/src/components/tools/ToolDetailPage.tsx`        | Add `data-testid="workflow-binding-panel"` on the binding panel container; `data-testid="save-tool-button"` on the save button (~line 652-660 per oracle TD-3). **Note**: test spec prereq block (line 223) assigns `save-tool-button` to `WorkflowConfigForm.tsx`; we assign it to `ToolDetailPage.tsx` because the save button lives in the detail-page header, not the config form. The test-spec line is treated as a shorthand — the LLD is authoritative for file placement. | Low  |
| `apps/studio/src/components/tools/ToolTypeBadge.tsx`         | Add `data-testid="tool-type-badge-workflow"` when `type === 'workflow'`.                                                                                                                                                                                                                                                                                                                                                                                                           | Low  |
| `apps/studio/e2e/helpers/index.ts`                           | Re-export `seedWorkflowWithWebhook`, `seedCronOnlyWorkflow`, `deleteSeededWorkflow` from `./workflow-seed`.                                                                                                                                                                                                                                                                                                                                                                        | Low  |
| `docs/testing/manual-smoke-tests/workflow-as-tool-studio.md` | Annotate each checklist item with `[automated by UI-E2E-N]` where applicable (Phase 3).                                                                                                                                                                                                                                                                                                                                                                                            | Low  |
| `docs/testing/workflow-as-tool.md`                           | Flip FR-8/FR-9 E2E column 🟡 → ✅ after specs pass CI; update Last Updated (done by `/post-impl-sync`).                                                                                                                                                                                                                                                                                                                                                                            | Low  |

### Deleted Files

None. This change is additive-only.

---

## 3. Implementation Phases

### Phase 1: Testid Additions (Production Code, Additive)

**Goal**: Add all `data-testid` attributes required by UI-E2E-1..4 without any behavior change.

**Tasks**:

1.1. In `ToolsListPage.tsx`, add `data-testid` on: (a) the workflow tab trigger element (search for the existing tab-list rendering that includes other tool types), (b) each rendered list row (`tool-row-${tool.id}`), (c) the primary "New Tool" CTA button.
1.2. In `ToolCreateDialog.tsx`, add `data-testid="tool-type-option-workflow"` on the workflow type option; `data-testid="tool-create-name-input"` on the name `<Input>`.
1.3. In `WorkflowConfigForm.tsx`, add testids on: workflow picker `<Select>` trigger, trigger picker `<Select>` trigger, mode selector `<Select>` trigger, read-only input variables preview container, and the empty-state block rendered when `selectedWorkflow.triggers.filter(t => t.type === 'webhook').length === 0`.
1.4. In `ToolDetailPage.tsx`, add `data-testid="workflow-binding-panel"` on the binding panel container (for `toolType === 'workflow'`); `data-testid="save-tool-button"` on the header save button.
1.5. In `ToolTypeBadge.tsx`, conditionally add `data-testid="tool-type-badge-workflow"` when `type === 'workflow'` only (keep other types untouched this pass).

**Files Touched**: 5 files in `apps/studio/src/components/tools/`.

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/studio` succeeds with 0 errors.
- [ ] `grep -rn "data-testid=\"workflow-picker-select\"" apps/studio/src/components/tools/` returns exactly 1 hit (and similarly for each of the 12 unique testid literals + the `tool-row-${id}` template, for 13 total patterns: 3 in ToolsListPage, 2 in ToolCreateDialog, 5 in WorkflowConfigForm, 2 in ToolDetailPage, 1 in ToolTypeBadge).
- [ ] `npx prettier --check "apps/studio/src/components/tools/**/*.tsx"` passes.
- [ ] Existing `apps/studio/e2e/tools.spec.ts` still passes locally (regression check).
- [ ] Diff is additive-only — zero removed lines (verify with `git diff --shortstat`; deletion count must be 0).

**Test Strategy**: Component changes are inert at runtime. Verified by (a) successful build, (b) visual regression is implicit via `pnpm dev` smoke (no new markup, only attribute additions), (c) follow-up Phase 2 specs will exercise them.

**Rollback**: `git revert <testid-commit>` — fully reversible since additive-only.

**Commit message**: `[ABLP-2] test(studio): add workflow-tool testids for UI E2E`

---

### Phase 2a: Seed Helper + Config Specs (UI-E2E-1 + UI-E2E-2)

**Goal**: Land the shared seeding helper and the first spec file covering FR-8 picker behavior and FR-9 empty-state.

**Tasks**:

2a.1. Create `apps/studio/e2e/helpers/workflow-seed.ts` per §1 type signatures. Use `apiPost` to `POST /api/projects/:projectId/workflows` with the established payload (inspect `apps/workflow-engine` routes for the exact shape). Generate unique suffixes via `crypto.randomUUID().slice(0, 6)`. Return `{ workflowId, triggerId, name }` extracted from the response. Include `deleteSeededWorkflow` using `apiDelete`.
2a.2. Re-export the three new symbols from `apps/studio/e2e/helpers/index.ts`.
2a.3. Create `apps/studio/e2e/workflow-tool-config.spec.ts`:

- Top-of-file JSDoc: `@e2e-real` tag; enumerate FR-8 / FR-9 coverage.
- `test.describe.configure({ mode: 'serial' })` (D-9).
- `beforeAll`: `loginViaDevApi` → resolve `projectId` → seed `wf_ui_sync` (sync webhook), `wf_ui_async` (async webhook), `wf_ui_draft` (status `draft`), `wf_cron_only` (no webhook) via helper. Save handles on `TestState` or module scope.
- **UI-E2E-1** (`test('FR-8 workflow + webhook-trigger picker, mode default, user override')`): implement the 9 steps from test spec §2 UI-E2E-1 lines 162–171 — **including step 9 (re-select `wf_ui_async`/`trg_async`, assert `mode-selector` pre-fills `async`)** verifying both sync AND async default pre-fill. Also implement the Isolation Check from test spec line 174 (attempt to select a same-tenant, other-project workflowId via URL-param hack; assert workflow picker does NOT surface it).
- **UI-E2E-2** (`test('FR-9 empty-state when workflow has zero webhook triggers + submit blocked')`): implement test spec §2 UI-E2E-2 lines 181–186.
- `afterAll`: `deleteSeededWorkflow` for each seeded id; swallow 404 only (log any other error).

**Files Touched**: 3 new files, 1 modified (`helpers/index.ts`).

**Exit Criteria**:

- [ ] `pnpm --filter=@agent-platform/studio exec playwright test e2e/workflow-tool-config.spec.ts --project=chromium` passes locally against `pnpm dev`.
- [ ] Both tests run in < 90s total on a dev machine.
- [ ] `grep -rn "vi\.mock\|jest\.mock\|fetchMock" apps/studio/e2e/workflow-tool-config.spec.ts apps/studio/e2e/helpers/workflow-seed.ts` returns 0 hits (platform-mock-lint hook passes).
- [ ] `grep -rn "mongoose\|WorkflowModel\|ToolModel" apps/studio/e2e/workflow-tool-config.spec.ts` returns 0 hits (no direct DB access).
- [ ] `npx prettier --check` passes on the 3 new files.
- [ ] Commit passes `commit-scope-guard.sh` (3 files new + 1 modified = 4 files, all in `apps/studio`).

**Test Strategy**:

- E2E: the file itself IS the coverage. No additional unit/integration tests — the helper is tested via the specs it serves (per CLAUDE.md "test the code, not the mocks").
- Regression: run the full Studio e2e suite locally to verify no shared-fixture collisions.

**Rollback**: `git revert <phase-2a-commit>`.

**Commit message**: `[ABLP-2] test(studio): FR-8/FR-9 workflow-tool config UI E2E (UI-E2E-1, UI-E2E-2)`

---

### Phase 2b: List Specs (UI-E2E-3 + UI-E2E-4)

**Goal**: Second spec file covering Tools list tab + deep-link and badge/binding panel.

**Tasks**:

2b.1. Create `apps/studio/e2e/workflow-tool-list.spec.ts`:

- Same header pattern as 2a.3.
- `beforeAll`: login → resolve `projectId` AND a second `projectY` (either the second seed project visible from `GET /api/projects` or dynamically created). Seed 2 workflow tools (`tool_a`, `tool_b`) in `projectId` and `badge_tool` in `projectId`. Nothing seeded in `projectY`.
- **UI-E2E-3** (`test('Workflow tab + ?tab=workflow deep-link')`): implement test spec §2 UI-E2E-3 lines 194–202. Use D-5 `toHaveAttribute('aria-selected', 'true')` auto-retry. Additionally assert cross-project isolation per test spec line 202 (navigate to `projectY`, assert workflow tab badge count === 0 and the list renders empty with no tool rows leaking from `projectId`).
- **UI-E2E-4** (`test('Workflow tool badge + detail-page binding panel + cross-project isolation')`): implement test spec §2 UI-E2E-4 lines 207–214. For cross-project check: `page.goto(\`${STUDIO_URL}/projects/${projectY}/tools?tab=workflow\`)`→ assert`[data-testid="tool-row-badge_tool"]`is NOT present (use`expect(locator).toHaveCount(0)`). Assert design-token accent via `getComputedStyle(...).backgroundColor`compared against the token value resolved from the live DOM (read the CSS variable from`:root`, not a hex).
- `afterAll`: delete seeded tools.

**Files Touched**: 1 new file.

**Exit Criteria**:

- [ ] `pnpm --filter=@agent-platform/studio exec playwright test e2e/workflow-tool-list.spec.ts --project=chromium` passes locally.
- [ ] Both tests complete in < 90s.
- [ ] Same 0-hit grep checks for `vi.mock`, `jest.mock`, `mongoose`, direct model imports.
- [ ] `npx prettier --check` passes.
- [ ] Design-token assertion reads from CSS var, not hardcoded color (grep for hex color literals in the spec → 0 hits).

**Test Strategy**: Same as 2a — the spec IS the coverage.

**Rollback**: `git revert <phase-2b-commit>`.

**Commit message**: `[ABLP-2] test(studio): workflow-tool list & badge UI E2E (UI-E2E-3, UI-E2E-4)`

---

### Phase 3: Doc Sync (Annotate Manual Smoke Doc)

**Goal**: Keep the manual smoke test doc aligned — it becomes a visual/UX regression checklist once automation lands (D-10).

**Tasks**:

3.1. In `docs/testing/manual-smoke-tests/workflow-as-tool-studio.md`, append `[automated by UI-E2E-N]` to each checklist item covered by a spec. Retain items that assert visual/UX properties not testable by Playwright (brand color rhythm, spacing, copy polish).
3.2. (Deferred to `/post-impl-sync` — not done in this LLD) Flip FR-8/FR-9 coverage matrix cells 🟡 → ✅ in `docs/testing/workflow-as-tool.md` and promote feature spec ALPHA → BETA.

**Files Touched**: 1 modified doc.

**Exit Criteria**:

- [ ] Every item in the manual doc is either annotated `[automated by UI-E2E-N]` or explicitly marked `[manual-only — visual/UX regression]`.
- [ ] `pnpm prettier --check "docs/testing/manual-smoke-tests/workflow-as-tool-studio.md"` passes (if markdown is linted).

**Test Strategy**: N/A — documentation change.

**Rollback**: `git revert <phase-3-commit>`.

**Commit message**: `[ABLP-2] docs(testing): annotate workflow-as-tool manual smoke doc for UI-E2E coverage`

---

## 4. Wiring Checklist

- [ ] `workflow-seed.ts` helpers exported from `e2e/helpers/index.ts`.
- [ ] Both new spec files match Playwright's `testMatch` glob (default `**/*.spec.ts`) — verify by running `playwright test --list`.
- [ ] New testids compile into production bundle (not behind `process.env.NODE_ENV === 'test'` guard) — required because Playwright runs against `pnpm dev` which is `development` mode, and CI against build artifacts.
- [ ] `ToolsListPage.tsx` URL-param whitelist (line ~117, flagged in parent LLD round 3 MEDIUM) already includes `'workflow'` — verify during Phase 1 by reading the file fresh.
- [ ] No new routes, DI registrations, model exports, or middleware — this change ships ONLY testid attributes + test files.
- [ ] Manual smoke doc cross-reference: each UI-E2E-N has a corresponding annotation in the manual doc after Phase 3.
- [ ] `agents.md` in `apps/studio/` updated with "workflow-tool UI E2E lives at `e2e/workflow-tool-*.spec.ts`; seeding via `helpers/workflow-seed.ts`" (Phase 2b commit).

---

## 5. Cross-Phase Concerns

### Database Migrations

None.

### Feature Flags

None (D-1 confirms no kill-switch needed for test-only code; Phase 1 testids are inert).

### Configuration Changes

None. Tests run against existing `WORKFLOW_ENGINE_URL`, Studio 5173, Runtime 3112 as defined in `helpers/env.ts`.

### Commit Ordering

Phase 1 (testids) MUST merge before Phase 2a/2b specs — otherwise specs fail on selectors. Phase 2a and 2b can land in either order but both depend on Phase 1. Phase 3 can land any time after Phase 2a if partial automation is sufficient.

---

## 6. Acceptance Criteria (Whole Feature — BETA Promotion)

- [ ] Phase 1 testids commit landed; `pnpm build --filter=@agent-platform/studio` clean.
- [ ] Phase 2a spec file lands; UI-E2E-1 and UI-E2E-2 pass 3 consecutive local runs.
- [ ] Phase 2b spec file lands; UI-E2E-3 and UI-E2E-4 pass 3 consecutive local runs.
- [ ] `grep -rn "vi\.mock\|jest\.mock" apps/studio/e2e/workflow-tool-*.spec.ts apps/studio/e2e/helpers/workflow-seed.ts` → 0 hits.
- [ ] `grep -rn "import.*mongoose\|from '@agent-platform/database/models'" apps/studio/e2e/workflow-tool-*.spec.ts` → 0 hits.
- [ ] `pnpm build && pnpm test:report` shows zero regressions against `main`.
- [ ] Phase 3 doc annotations complete.
- [ ] `/post-impl-sync workflow-as-tool` flips FR-8/FR-9 E2E column to ✅ and promotes feature status ALPHA → BETA (criteria: automated UI coverage + 1-week production soak already satisfied per post-impl-sync log).

---

## 7. Open Questions

1. Should UI-E2E-3's "no-flash" assertion escalate to a MutationObserver fallback now, or defer until flakes observed? **Decision**: defer (D-5); track in test-spec §9 OQ-5.
2. Does `POST /api/projects/:projectId/workflows` currently accept a `status: 'draft'` field, or is the lifecycle mediated differently (e.g., PATCH to archive)? **Resolution**: verify during Phase 2a.1 by reading `apps/workflow-engine/src/routes/workflows.ts`; if `draft` is not a writable status, swap UI-E2E-1 fixture to create-then-PATCH-archive (same pattern as backend E2E-5 stale-binding case).
3. ~~Is there an existing `apps/studio/agents.md` to update in Phase 2b~~ — RESOLVED: `apps/studio/agents.md` exists. Phase 2b will append a "Workflow-tool UI E2E" section referencing `e2e/workflow-tool-*.spec.ts` and the `helpers/workflow-seed.ts` seeding pattern.

---

## 8. References

- Test spec: `docs/testing/workflow-as-tool.md` §2 UI-E2E-1..4 (lines 155–215), prereq block (219–227), file-location clarification (217).
- Parent LLD: `docs/plans/2026-04-13-workflow-as-tool-impl-plan.md` — completed backend implementation.
- Post-impl-sync log: `docs/sdlc-logs/workflow-as-tool/post-impl-sync.log.md` — identified FR-8/FR-9 gap as BETA blocker.
- Helper patterns: `apps/studio/e2e/helpers/{api.ts, auth.ts, index.ts}`.
- Existing Tools-tier spec: `apps/studio/e2e/tools.spec.ts` (pattern to mirror).
- Canvas-tier conventions (for contrast): `apps/studio/e2e/workflows/agents.md`.
