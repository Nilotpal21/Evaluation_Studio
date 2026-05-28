# HLD Log: Module Studio Wiring

**Date**: 2026-03-25
**Phase**: HLD
**Artifact**: `docs/specs/module-studio-wiring.hld.md`

## Oracle Decisions

All 15 clarifying questions answered by product-oracle. No AMBIGUOUS items.

| #   | Classification | Decision Summary                                                                                      |
| --- | -------------- | ----------------------------------------------------------------------------------------------------- |
| Q1  | ANSWERED       | Follow exact 5-step pattern: ProjectPage union → parseUrl → buildPath → renderContent → sidebar entry |
| Q2  | DECIDED        | Separate useEffect for loadDependencies — consistent with AppShell's single-responsibility pattern    |
| Q3  | ANSWERED       | Thin page wrappers: zero props, reads from stores, composes existing child components                 |
| Q4  | DECIDED        | No abort controller — zero precedent in AppShell, INT-4 regression marker covers the race condition   |
| Q5  | ANSWERED       | Purely apps/studio changes + packages/i18n additive keys                                              |
| Q6  | ANSWERED       | Almost entirely apps/studio internal; no database/shared/runtime/compiler changes                     |
| Q7  | ANSWERED       | Adding union variants is always additive and non-breaking in TypeScript                               |
| Q8  | ANSWERED       | loadDependencies is purely client-side, does not interact with compile-deploy-execute lifecycle       |
| Q9  | ANSWERED       | Both config/navigation.ts AND ProjectSidebar.tsx local arrays must be updated (dual-source warning)   |
| Q10 | ANSWERED       | Two i18n keys: "modules" and "dependencies" in nav namespace                                          |
| Q11 | INFERRED       | Biggest risk is loadDependencies lifecycle — timing, re-renders, stale-data race on project switch    |
| Q12 | ANSWERED       | No data migration needed — purely additive client-side changes                                        |
| Q13 | ANSWERED       | Rollback: git revert + redeploy Studio, or soft rollback via feature flag                             |
| Q14 | ANSWERED       | Sidebar items unconditionally visible (FR-9); feature gating at component level                       |
| Q15 | ANSWERED       | Zero blast radius — loadDependencies failure is caught, authoring surfaces degrade to empty           |

## Audit Rounds

### Round 1: NEEDS_REVISION

- 0 CRITICAL, 4 HIGH, 2 MEDIUM
- [HD-2] "12 tabs" → corrected to "13 sub-pages"
- [HD-4] useImportedSymbols data shape: alias\_\_name prefix → separate name + alias fields
- [HD-5] API paths: /module/catalog → /module-catalog, /module/reverse-deps → /module/consumers, added 4 missing endpoints
- [HD-6] Dual-source navigation warning added to dependencies table
- [HD-10] Added OPEN question #4 about config/navigation.ts divergence
- [HD-9] Ran design-lint — passes at 95%
- Added "Overview & Goal" section (design-lint requirement)

### Round 2: NEEDS_REVISION

- 1 CRITICAL, 1 HIGH (informational)
- [HD-5] API table errors: archive PATCH → POST, fabricated /module/contract removed, upgrade path corrected, added GET /module settings
- [XP-4] Test spec has stale idv\_\_ notation (informational — for post-impl-sync correction)

### Round 3: APPROVED

- All round 2 fixes verified
- Cross-phase consistency PASS on all 5 checks
- 15 API endpoints verified against actual route files
- design-lint passes at 95%

## Key Design Decisions

| Decision                          | Rationale                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------- |
| Option B: Standard wiring pattern | 20+ existing pages follow this pattern; lowest risk, clean persona separation |
| Separate useEffect                | Consistent with AppShell's single-responsibility effect pattern               |
| No abort controller               | Zero precedent in AppShell; race window negligible (max 5 items)              |
| Update both nav config files      | ProjectSidebar.tsx + config/navigation.ts (for UniversalSearch)               |

## Files Created

- `docs/specs/module-studio-wiring.hld.md` — HLD (new)
