# LLD Log: KB IA Redesign

## Oracle Decisions (2026-05-06)

### Implementation Strategy

| #   | Question                    | Classification | Decision                                              |
| --- | --------------------------- | -------------- | ----------------------------------------------------- |
| Q1  | Feature flag?               | DECIDED        | No — branch isolation sufficient                      |
| Q2  | Implementation order?       | DECIDED        | Sidebar infra first, then extract pages incrementally |
| Q3  | Delete old components when? | DECIDED        | Phase 5 as `refactor()` commit                        |
| Q4  | Sidebar collapse behavior?  | INFERRED       | Match Agent detail (auto-collapse to 56px)            |
| Q5  | KBHeader fate?              | ANSWERED       | Eliminate entirely — sidebar absorbs all header info  |

### Technical Details

| #   | Question                | Classification | Decision                                                           |
| --- | ----------------------- | -------------- | ------------------------------------------------------------------ |
| Q6  | Routing mechanism?      | DECIDED        | Reuse existing `tab` URL segment with `KB_PAGE_SEGMENTS` mapping   |
| Q7  | Layout component?       | DECIDED        | Replace KBDetailLayout with KBContextualSidebar + standalone pages |
| Q8  | Pipeline store persist? | DECIDED        | Add sessionStorage persist for draft state                         |
| Q9  | Cross-page filters?     | ANSWERED       | Existing data-tab-filter-store works as-is                         |
| Q10 | Connector store?        | ANSWERED       | Already global singleton, no changes needed                        |

### Risk & Dependencies

| #   | Question                 | Classification     | Decision                                                          |
| --- | ------------------------ | ------------------ | ----------------------------------------------------------------- |
| Q11 | E2E test strategy?       | INFERRED           | Tests are API-driven, unaffected. Update visual baselines after.  |
| Q12 | Conflicting branches?    | ANSWERED           | No active KB branches other than current                          |
| Q13 | Visual regression level? | AMBIGUOUS→RESOLVED | Option A: Apply layout improvements during migration (user chose) |
| Q14 | Analytics events?        | ANSWERED           | No analytics instrumentation in KB tab navigation                 |
| Q15 | Browse Preview changes?  | ANSWERED           | No — standalone Next.js page, completely independent              |

## Audit Rounds 1-5 (Sequential)

### Round 1: Architecture Compliance (lld-reviewer)

**Verdict**: NEEDS_CHANGES → Fixed

- [CRITICAL] Removed `isEditorActive` misuse — sidebar works at 240px via navGroups naturally
- [CRITICAL] Added `handleNav` KB URL construction with kbId from nav store
- [HIGH] Fixed i18n keys to flat namespace (`kb_overview` not `search_ai.nav.overview`)
- [HIGH] Fixed i18n file path to `packages/i18n/locales/en/studio.json`
- [HIGH] Expanded Task 5.10 to list all `'chunks'` consumers
- [MEDIUM] Added `useMemo` stabilization for KBDetailContext
- [MEDIUM] Specified exact `buildPath` and `parseUrl` return shapes
- [MEDIUM] Added AppShell cross-phase edits note
- [MEDIUM] Specified pipeline-store validation wiring

### Round 2: Pattern Consistency (lld-reviewer)

**Verdict**: NEEDS_CHANGES → Fixed

- [CRITICAL] Removed 3 surviving `isEditorActive` references (file map, wiring checklist)
- [HIGH] Fixed Zustand persist syntax to `createJSONStorage(() => sessionStorage)`
- [HIGH] Fixed remaining i18n namespace reference in file change map
- [MEDIUM] Fixed section labels to Title Case (matching Settings pattern)
- [MEDIUM] Changed empty-string section to `'Settings'` label
- [MEDIUM] Corrected animation key note (existing key pattern works naturally)
- [MEDIUM] Added explicit `KnowledgeBaseDetailPage` guard removal to Task 1.8

### Round 3: Completeness (lld-reviewer)

**Verdict**: NEEDS_CHANGES → Fixed

- [HIGH] Added PipelineProgressTracker (indexing state) to Overview page
- [HIGH] Added useKBShortcuts hook handling (rewrite or delete in Phase 5)
- [HIGH] Added SettingsTab.tsx and HomeSection.tsx to deletion/preservation plan
- [MEDIUM] Added setSubPageLabel breadcrumb preservation
- [MEDIUM] Added search-tab-store reset on KB change
- [MEDIUM] Corrected Task 5.10 consumer list (removed phantom test files)
- [MEDIUM] Specified KBSettingsPage reuses existing GeneralSection/IndexConfigSection/DangerZoneSection

### Round 4: Cross-Phase Consistency (phase-auditor)

**Verdict**: NEEDS_REVISION → Fixed

- [CRITICAL] Fixed Phase 2 wiring condition from `page === 'search-ai'` to `page?.startsWith('kb-')`
- [HIGH] Fixed deletion count inconsistency (8→expanded list)
- [MEDIUM] Added viewport math clarification to Decision D-4
- [MEDIUM] Fixed "move" language to "add" in Phase 3 task 3.4

### Round 5: Final Sweep (lld-reviewer)

**Verdict**: APPROVED

- [MEDIUM] Added 4 orphaned test file deletions to Phase 5
- [MEDIUM] Added IntelligenceCard + cards/ directory deletion to Phase 5
- All CRITICAL/HIGH findings from R1-R4 verified resolved

## Audit Rounds 6-8 (Parallel)

### Round 6: Platform Audit

**Verdict**: NEEDS_REVISION → Fixed

- [HIGH] `buildPath` must reverse-map KBPage variants; `setTab`/`setSubSection` integration risk — added warning to Task 1.4
- [HIGH] `PageHeader` inside `DetailPageShell` creates double-header — fixed to use shell's own title/actions props
- [MEDIUM] `SettingsTab.tsx` and `useKBShortcuts.ts` paths corrected
- [MEDIUM] Added `handleNav` KB URL construction to wiring checklist
- [MEDIUM] Added `NeedsAttentionCard.buildAttentionItems` audit note to Task 5.10
- Platform invariants: No violations (pure frontend refactor)
- File existence: All verified

### Round 7: Industry Research

**Verdict**: 10 findings (3 IMPROVEMENT, 3 RISK, 3 GAP, 1 strength)

- [RISK] F-3: SSR hydration race — added `skipHydration: true` + client-side `rehydrate()` to Task 4.1b
- [RISK] F-4: No beforeunload warning — added `beforeunload` handler + restore toast to Task 4.1b
- [RISK] F-8: No persist version/migrate — added `version: 1` + no-op `migrate` scaffold
- [GAP] F-7: No parseUrl/buildPath unit tests — added pure-function unit tests to Phase 1 test strategy
- [GAP] F-10: No a11y testing — added keyboard nav + aria-current checks to Phase 1 and Phase 6
- [GAP] F-6: No visual regression tests — noted but deferred (existing Playwright snapshot infra is optional)
- [IMPROVEMENT] F-1: Context splitting for re-renders — deferred (useMemo adequate for low-frequency SWR updates; add use-context-selector if profiling shows issues)
- [IMPROVEMENT] F-5, F-9: Phase order and URL-based nav are strengths — no changes

### Round 8: OSS Library Audit

**Verdict**: APPROVED — No new dependencies needed

- All 5 patterns reuse already-installed libraries (Zustand, Framer Motion, ReactFlow, SWR, React Context)
- Evaluated: `use-context-selector` (skip — marginal benefit), `jotai` (skip — second paradigm), `nuqs` (skip — incompatible), `TanStack Router` (skip — rewrite cost)
- `createJSONStorage(() => sessionStorage)` is built-in Zustand feature, not a new dep
