# Feature Spec Log: Module Studio Wiring

**Date**: 2026-03-25
**Phase**: FEATURE-SPEC
**Artifact**: `docs/features/sub-features/module-studio-wiring.md`

## Oracle Decisions

All 15 clarifying questions answered by product-oracle. No AMBIGUOUS items — all resolved from code evidence and established patterns.

| #   | Classification | Decision Summary                                                                        |
| --- | -------------- | --------------------------------------------------------------------------------------- |
| Q1  | DECIDED        | Wire all 7 components in a single spec — same integration pattern, minimal effort delta |
| Q2  | DECIDED        | 2 standalone pages, not 3 — catalog and contract preview stay embedded in dialogs       |
| Q3  | ANSWERED       | `loadDependencies` is critical path — #1 priority for `useImportedSymbols` fix          |
| Q4  | DECIDED        | Scope includes wiring + minimal new navigation entries                                  |
| Q5  | INFERRED       | Sidebar items always visible, feature gate at component level                           |
| Q6  | DECIDED        | All module author actions under single `settings-modules` page                          |
| Q7  | DECIDED        | Dependencies in Resources sidebar section (not Settings)                                |
| Q8  | DECIDED        | Two sidebar items: Dependencies (Resources) + Module Settings (Settings group)          |
| Q9  | DECIDED        | Load dependencies eagerly at project load time                                          |
| Q10 | ANSWERED       | Keep promotion as optional field in PublishModuleDialog                                 |
| Q11 | DECIDED        | Two new ProjectPage variants: `settings-modules`, `module-dependencies`                 |
| Q12 | DECIDED        | Both items always visible (no conditional navigation)                                   |
| Q13 | DECIDED        | Project-level init hook for loadDependencies only                                       |
| Q14 | ANSWERED       | AppShell renderContent switch, not Next.js app router pages                             |
| Q15 | DECIDED        | All test types — priority on dependency loading lifecycle                               |

## Audit Rounds

### Round 1: NEEDS_REVISION

- 3 HIGH findings, 3 MEDIUM findings
- [FS-6] User isolation incorrectly characterized as RBAC → Fixed to N/A with proper justification
- [FS-3] FR-6 contained implementation detail → Moved to section 7
- [FS-2] Route file count (7→11) and function count (15→16) corrected
- [FS-9] Added 3 E2E scenarios to section 17
- [FS-8] Added test spec scenario references to delivery plan task 5

### Round 2: APPROVED

- 1 MEDIUM finding: section 10 still said "15 functions" → Fixed to "16"
- All round 1 fixes verified
- Cross-phase consistency PASS on all 5 checks

## Files Created/Updated

- `docs/features/sub-features/module-studio-wiring.md` — feature spec (new)
- `docs/testing/sub-features/module-studio-wiring.md` — testing guide placeholder (new)
- `docs/features/sub-features/README.md` — added index entry
- `docs/features/README.md` — added to sub-features table
- `docs/testing/sub-features/README.md` — added index entry
- `docs/testing/README.md` — added sub-features section
