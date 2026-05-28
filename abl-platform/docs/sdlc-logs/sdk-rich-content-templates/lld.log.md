# SDLC Log: SDK Rich Content Templates — LLD

**Phase**: LLD
**Date**: 2026-03-24
**Artifact**: `docs/plans/2026-03-24-sdk-rich-content-templates-impl-plan.md`

---

## Oracle Decisions

All 15 clarifying questions answered. No AMBIGUOUS items.

| #   | Question                        | Classification | Decision                                                                             |
| --- | ------------------------------- | -------------- | ------------------------------------------------------------------------------------ |
| Q1  | Implementation order            | DECIDED        | Cherry-pick first, then fix (matching feature spec delivery plan)                    |
| Q2  | Cherry-pick phases              | DECIDED        | Break into phases: registry → Tier 1 → Tier 2 → Studio → fixes                       |
| Q3  | Cherry-pick strategy            | DECIDED        | Squash into logical groups; use diff-and-apply, not mechanical cherry-pick           |
| Q4  | Feature flag                    | DECIDED        | No feature flag — all fields optional, rollback is git revert                        |
| Q5  | Phase 1 scope                   | DECIDED        | Phase 1 = registry + renderers + backend + security + hooks; Phase 2 = Studio        |
| Q6  | templates/ directory creation   | DECIDED        | Manually create per HLD component diagram                                            |
| Q7  | isSafeUrl placement             | ANSWERED       | Extract to templates/utils/safe-url.ts, re-export from rich-renderer.ts              |
| Q8  | SDK i18n mechanism              | DECIDED        | Simple Record<string, string> defaults with setStrings() override                    |
| Q9  | AST→IR compiler transform       | ANSWERED       | Extend existing compileRichContent() at compiler.ts:1966                             |
| Q10 | Test strategy                   | DECIDED        | Cherry-pick tests alongside, augment with new tests for fixes                        |
| Q11 | Cherry-pick conflict risk       | ANSWERED       | Low — target files have no uncommitted changes; watch index.ts barrel                |
| Q12 | Biggest implementation risk     | DECIDED        | Type alignment across packages (core/compiler/web-sdk)                               |
| Q13 | Conflicting changes on types.ts | ANSWERED       | types.ts clean on develop; index.ts needs careful merge                              |
| Q14 | Monitoring before rollout       | DECIDED        | No new metrics sufficient; future templateRenderError SDK event deferred             |
| Q15 | Definition of done              | DECIDED        | 13 FRs passing, clean build, tsc, zero XSS/hooks violations, tests green, on develop |

## Audit Rounds

| Round | Reviewer      | Verdict        | Critical | High | Medium |
| ----- | ------------- | -------------- | -------- | ---- | ------ |
| 1     | lld-reviewer  | NEEDS_REVISION | 4        | 0    | 0      |
| 2     | lld-reviewer  | NEEDS_REVISION | 2        | 0    | 0      |
| 3     | lld-reviewer  | NEEDS_REVISION | 1        | 3    | 3      |
| 4     | phase-auditor | NEEDS_REVISION | 3        | 6    | 6      |
| 5     | lld-reviewer  | APPROVED       | 0        | 0    | 5      |

### Round 1 — lld-reviewer (structural)

- **C-1**: isSafeUrl called "backwards-compatible" but never exported → Corrected to "new public export"
- **C-2**: `react/components/RichContent.tsx` breaks flat convention → Changed to `react/RichContent.tsx`
- **C-3**: Studio wiring details missing → Added navigation-store.ts, AppShell.tsx, ProjectSidebar.tsx mods
- **C-4**: `/template` command conflict with TemplatePickerModal → Added `/rich-template` command

### Round 2 — lld-reviewer (detail pass)

- **C-1**: ABLEditor `command.id.includes('template')` dispatch collision → Documented exact-match fix
- **C-2**: `react/index.ts` not updated → Added task 2.11b for RichContent export

### Round 3 — lld-reviewer (deep pass)

- **C-1**: Circular dependency risk → Added warning to Task 2.9 (import from registry.ts not barrel)
- **H-1**: Spread pattern semantics change → Added note about omitted vs undefined keys
- **H-2**: Task 3.1 inconsistent with Open Question 1 (rich-content-ast.ts) → Fixed: Task 3.1 now creates new file, agent-based.ts imports/re-exports
- **H-3**: hasRichContent array checks → Added array vs object field check specification
- **M-3**: ABLEditor dispatch fix revised → Added exact-match before catch-all pattern

### Round 4 — phase-auditor (cross-phase consistency)

**Critical (all fixed)**:

- **C-1**: Test file count mismatch (17 in feature spec vs 7 in LLD) → Added test file mapping note and consolidation plan for Phase 5 doc sync
- **C-2**: Task 3.4 spread pattern contradicts HLD D-7 (explicit per-type handlers) → Changed to explicit field enumeration matching existing code pattern
- **C-3**: ABLEditor dispatch fix needed exact code diff and voice-template collision note → Added exact code snippet and pre-existing collision note

**High (all fixed)**:

- **H-1**: Feature spec `data/template-catalog.ts` vs LLD `lib/template-catalog.ts` → Added to Phase 5 doc sync list
- **H-2**: FR-9 says `/template` but LLD uses `/rich-template` → Added rationale and Phase 5 sync note
- **H-3**: E2E scenarios deferred without GAP acknowledgement → Added explicit GAP note and Phase 5 follow-up
- **H-4**: Integration scenarios 1, 4, 5 had no explicit test tasks → Added Tasks 2.14 (backwards compat), 2.15 (registry dispatch), and clarified 4.11 template-preview.test.tsx covers scenario 5
- **H-5**: LayoutTemplate icon import verified correct (no change needed)
- **H-6**: i18n namespace `'templates'` verified consistent with Studio pattern (no change needed)

**Medium (addressed)**:

- **M-1**: Package filter name `@agent-platform/web-sdk` to be verified at implementation time
- **M-2**: markdown.ts → rich-renderer.ts dependency is intentional → Added explicit note to Task 2.2
- **M-3**: Feature spec `react/components/RichContent.tsx` vs LLD `react/RichContent.tsx` → Added to Phase 5 sync list
- **M-4**: `rich-content-ast.ts` in wrong table → Moved from Modified to New Files table
- **M-5**: `template:action` event target unspecified → Added: emitted on `document` with structured `detail`
- **M-6**: FR-13 hooks exit criterion partial → Phase 2 exit criteria already covers this sufficiently

### Round 5 — lld-reviewer (final sweep)

**APPROVED** with 5 non-blocking MEDIUM findings:

- M-1: Package filter names `@abl/runtime` and `studio` corrected to `@agent-platform/runtime` and `@agent-platform/studio`
- M-2: `LayoutTemplate` icon to be verified at implementation time
- M-3: `useTranslations('templates')` namespace is consistent with existing Studio pattern
- M-4: Phase 2 "18 NEW renderer files" count is cosmetically imprecise (17 renderers + RichContent.tsx)
- M-5: Barrel import order matches HLD — verified, no issue

## Next Phase

Run `/implement SDK Rich Content Templates` to begin implementation.
