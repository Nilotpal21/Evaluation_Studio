# Pass 4 Consistency Review: Reusable Agent Modules

**Date:** 2026-03-21
**Reviewer:** LLD Reviewer Agent (Pass 4 of 5)
**Documents reviewed:**

- `docs/specs/reusable-agent-modules-phase1.lld.md` (LLD)
- `docs/specs/reusable-agent-modules-phase-plan.hld.md` (HLD)
- `docs/features/reusable-agent-modules.md` (Feature doc)
- `docs/testing/reusable-agent-modules.md` (Test guide)

---

## VERDICT: NEEDS_FIXES

Three remaining cross-document alignment issues need resolution. All are MEDIUM severity -- no critical or high issues remain after Pass 3 fixes.

---

## Pass 3 Fix Verification

### P1-U21 Duplication (FIXED)

- HLD line 717: single occurrence of P1-U21 -- no duplicate found.
- LLD line 435: references `// resolves P1-U21` in the module-selector code.
- Test guide line 451: single occurrence in "New Scenarios Added" table.
- **Status: Clean.**

### `entryAgentName` in All Three Artifact Type Definitions (FIXED)

- HLD line 210: `entryAgentName: string; // fixed preview entry agent (refined in LLD)` -- present in `ModuleReleaseArtifact`.
- LLD line 132: `entryAgentName: string;` -- present in `ModuleReleaseArtifact`.
- Feature doc line 197: `entryAgentName: string;` -- present in `ModuleReleaseArtifact`.
- **Status: All three artifact types are aligned.**

### `compiledIR` in ModuleRelease Key Fields (FIXED)

- HLD line 192: `compiledIR` listed in ModuleRelease key fields.
- LLD line 110: `compiledIR: Record<string, AgentIR>` in `IModuleRelease` interface.
- Feature doc line 113: `compiledIR: Record<string, AgentIR>` in module_releases collection.
- **Status: Consistent across all three docs.**

### `contractSnapshot` + `createdAt` in ProjectModuleDependency (FIXED)

- HLD line 194: `contractSnapshot`, `createdBy`, `createdAt`, `updatedAt` all listed.
- LLD lines 224-228: All fields present in `IProjectModuleDependency`.
- Feature doc lines 151-154: All fields present in project_module_dependencies collection.
- **Status: Consistent across all three docs.**

### `compressedPayload` Storage Consistency (FIXED)

- HLD line 195: `compressedPayload (gzip; see LLD for physical storage)`.
- LLD line 258: `compressedPayload: Buffer; // gzip-compressed JSON` with full size enforcement in lines 275-278.
- Feature doc lines 168-174: `compressedPayload: Buffer (gzip-compressed JSON of DeploymentModuleSnapshotPayload)` with 8 MB limit and gzip notes.
- **Status: Consistent. HLD correctly defers physical storage details to LLD.**

### `moduleDependencyVersion` / `archivedAt` / `archivedBy` in Projects Collection (FIXED)

- LLD lines 44-46: All three fields in `IProject` interface.
- Feature doc lines 92-94: All three fields in projects collection description.
- HLD line 191 (Project key fields): Only `kind` and `moduleVisibility` listed. See MEDIUM-1 below.

### Listing Index on module_releases (FIXED)

- LLD line 124: `{ tenantId: 1, moduleProjectId: 1, createdAt: -1 } // listing`.
- Feature doc line 122: `{ tenantId: 1, moduleProjectId: 1, createdAt: -1 } (listing)`.
- HLD line 390: Lists uniqueness indexes only, does NOT include the listing index. See MEDIUM-2 below.

---

## Remaining Issues

### MEDIUM-1: HLD Project entity key fields are incomplete

The HLD domain model table (line 191) lists only `kind` and `moduleVisibility` as new Project fields. However, the LLD and feature doc both include three additional fields: `moduleDependencyVersion`, `archivedAt`, and `archivedBy`. The HLD mentions `dependencyVersion` in the concurrency rules section (line 172) but not in the domain model table.

**File:** `docs/specs/reusable-agent-modules-phase-plan.hld.md` line 191
**Fix:** Add `moduleDependencyVersion`, `archivedAt?`, `archivedBy?` to the Project entity's key fields column in the domain model table.

### MEDIUM-2: HLD index list omits module_releases listing index

The HLD Workstream A notes (line 390) list compound indexes for uniqueness constraints but omit the listing index `{ tenantId: 1, moduleProjectId: 1, createdAt: -1 }` that both the LLD (line 124) and feature doc (line 122) include.

**File:** `docs/specs/reusable-agent-modules-phase-plan.hld.md` line 390
**Fix:** Add `(tenantId, moduleProjectId, createdAt desc)` for release listing to the compound index list.

### MEDIUM-3: Test guide regression matrix IDs P1-R06 through P1-R10 diverge from HLD

The regression matrix in the test guide (lines 401-405) uses the same IDs P1-R06 through P1-R10 as the HLD (lines 846-850), but the descriptions are completely different. Mapping:

| ID     | HLD Description                                           | Test Guide Description                             |
| ------ | --------------------------------------------------------- | -------------------------------------------------- |
| P1-R06 | Auth profile resolution for local tools regresses         | Trace consumers break on provenance fields         |
| P1-R07 | Deployment resolver breaks when no module snapshot exists | Auth profile rename/delete causes credential drift |
| P1-R08 | Project deletion leaks module records                     | Session resume loses module provenance             |
| P1-R09 | Cross-tenant access leaks module existence                | Failed deployment retires last healthy deployment  |
| P1-R10 | Trace consumers break on new provenance fields            | Feature flag off-path regresses Studio UX          |

Three HLD regression scenarios are **missing** from the test guide entirely (no matching description under any ID):

1. **HLD P1-R06**: Auth profile resolution for local tools regresses
2. **HLD P1-R07**: Deployment resolver breaks when no module snapshot exists
3. **HLD P1-R08**: Project deletion leaks module records

One HLD scenario exists in the test guide but under a different ID:

- **HLD P1-R09** (cross-tenant access) -- partially covered by test guide P1-E07 and the coverage map checklist but absent from the regression matrix.

**File:** `docs/testing/reusable-agent-modules.md` lines 396-423
**Fix:** Realign test guide regression matrix IDs P1-R01 through P1-R28 to match the HLD 1:1. Add the three missing scenarios. This is important because implementors use the regression matrix as a checklist -- mismatched IDs between docs will cause confusion during implementation.

---

## Verified Clean

- [x] P1-U21 is no longer duplicated in HLD -- single occurrence at line 717
- [x] `entryAgentName` appears in all three `ModuleReleaseArtifact` type definitions (HLD, LLD, feature doc)
- [x] `compiledIR` appears in all three `ModuleRelease` specifications
- [x] `contractSnapshot`, `createdBy`, `createdAt`, `updatedAt` appear consistently in `ProjectModuleDependency` across all docs
- [x] `compressedPayload` storage (gzip Buffer, 8 MB limit) is consistent across all docs
- [x] `moduleDependencyVersion`, `archivedAt`, `archivedBy` are consistent between LLD and feature doc
- [x] Module_releases listing index is consistent between LLD and feature doc
- [x] Test IDs are clean within each document -- no duplicate IDs within the HLD test plan, LLD, or test guide individually
- [x] Unit test IDs P1-U01 through P1-U23 are sequential with no gaps
- [x] E2E test IDs P1-E01 through P1-E15 are sequential with no gaps
- [x] Regression IDs P1-R01 through P1-R28 are sequential with no gaps in each doc
- [x] `ModuleReleaseArtifact` type fields match across all three docs (dslFormat, entryAgentName, agents, tools)
- [x] `DeploymentModuleSnapshotPayload` type fields match between HLD and feature doc
- [x] All four new collection names are consistent: `module_releases`, `module_environment_pointers`, `project_module_dependencies`, `deployment_module_snapshots`
- [x] Index definitions match between LLD and feature doc for all four new collections

---

## Notes for Pass 5

- MEDIUM-1 and MEDIUM-2 are HLD-only gaps; the LLD and feature doc are already correct. These are documentation completeness fixes, not design changes.
- MEDIUM-3 is the most impactful remaining issue. The test guide regression matrix should be the authoritative implementation checklist, and having different scenario descriptions under the same IDs as the HLD will cause confusion during Sprint 4 (E2E + Regression tests).
- All Pass 3 fixes were applied cleanly with no regressions.
