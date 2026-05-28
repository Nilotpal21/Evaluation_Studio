# LLD Log — Prompt Library

**Feature slug:** `prompt-library`
**Phase:** 4 (LLD)
**Started:** 2026-04-27
**Author:** prasanna@kore.com (driven by Claude Code SDLC pipeline)

---

## Inputs

- Feature spec: `docs/features/prompt-library.md`
- Test spec: `docs/testing/prompt-library.md`
- HLD: `docs/specs/prompt-library.hld.md`
- Phase-3 log: `docs/sdlc-logs/prompt-library/hld.log.md`

## Product oracle decisions (Phase 4 clarifying questions)

Oracle agent (separate spawn) answered questions across Implementation Strategy (5), Technical Details (5), Risk & Dependencies (5).

### Outcomes by classification

| Classification | Count | Notes                                                                |
| -------------- | ----- | -------------------------------------------------------------------- |
| ANSWERED       | 12    | Grounded in codebase — file/line cited                               |
| DECIDED        | 3     | Oracle made judgment calls within established patterns; logged below |
| INFERRED       | 0     | All inferences confirmed by direct code evidence                     |
| AMBIGUOUS      | 0     | No escalations needed                                                |

### DECIDED items (oracle judgment calls)

1. **Implementation order (D-1)**: Data layer first (models + RBAC), then runtime service + routes, then compile hook, then Studio proxy, then Studio UI, then E2E tests. Each phase independently deployable.
2. **`resolveLibraryRef()` location (D-2)**: Separate file in `agent-compile/` directory. `createVersion()` is 285 lines — CLAUDE.md forbids rewriting functions >200 lines in one pass. Separate file enables independent testing (INT-8).
3. **`usageCount` decrement (D-COV-2)**: Descoped from v1. Increment-only in v1; reverse-reference query is the authoritative source. Decrement requires non-trivial "was previous version using libraryRef" tracking — deferred to v1.5.

### Key code references confirmed

| Concern                             | Reference                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `AgentBasedDocument` type name      | `apps/runtime/src/services/version-service.ts:307`                                               |
| `CreateVersionParams` interface     | `apps/runtime/src/services/version-service.ts:37-47`                                             |
| `findProjectAgentForProject()`      | `apps/runtime/src/repos/project-repo.ts:192-226`                                                 |
| cascade-delete dynamic import       | `packages/database/src/cascade/cascade-delete.ts:214-247` (dynamic `await import`)               |
| `deleteTenant()` counts pattern     | `packages/database/src/cascade/cascade-delete.ts:49-84`                                          |
| `AuditEventType` union              | `packages/compiler/src/platform/core/types.ts:393-441`                                           |
| `LogAuditParams.resourceType`       | `packages/compiler/src/platform/stores/audit-store.ts:37-46`                                     |
| `StudioPermission` object           | `apps/studio/src/lib/permissions.ts:15-63`                                                       |
| `STUDIO_PROJECT_PERMISSION_ALIASES` | `apps/studio/src/lib/project-permission.ts:21-38`                                                |
| `AppShell.tsx` `renderContent()`    | `apps/studio/src/components/navigation/AppShell.tsx:556-680`                                     |
| Studio is SPA (not App Router)      | Pages are components in `renderContent()` switch, NOT Next.js App Router files                   |
| cascade test mock files             | `mongo-cascade.test.ts`, `cascade-delete-auth-profile.test.ts`, `cascade-delete-modules.test.ts` |

## Files created

- `docs/plans/2026-04-27-prompt-library-impl-plan.md` — full LLD (5 audit rounds, APPROVED)
- `docs/sdlc-logs/prompt-library/lld.log.md` — this log

## Audit findings

### Round 1 (lld-reviewer) — NEEDS_CHANGES

- **C-1 (CRITICAL)**: libraryRef data flow gap — `IProjectAgent` had no field to store the library reference intent; `CreateVersionParams` had no `libraryRef?` field. FIXED — added `systemPromptLibraryRef?` to `IProjectAgent`, `libraryRef?` to `CreateVersionParams`, injection step in `createVersion()`, and `versions.ts` route forwarding.
- **C-2 (CRITICAL)**: cascade delete missing — `deleteProject()` and `deleteTenant()` in `cascade-delete.ts` did not delete prompt-library collections. FIXED — task 1.8 added to both functions.
- **H-3 (HIGH)**: `ParsedAgentDocument` → `AgentBasedDocument` type name. FIXED.
- **H-4 (HIGH)**: `StudioPermission` constants + aliases missing. FIXED — task 4.0 added.
- **H-5 (HIGH)**: `nav.prompt_library` i18n key missing. FIXED — task 5.1 added.
- **H-6 (HIGH)**: `ProjectSidebar.tsx` has independent `resourceNavDefs`. FIXED — task 5.1 clarified.
- **M-8 (MEDIUM)**: Injection point pin more precisely. FIXED — L305 after tool resolution, before L307 `allDocuments`.
- **M-9 (MEDIUM)**: INT-12 test path `[projectId]` → `[id]`. FIXED.

### Round 2 (lld-reviewer) — NEEDS_CHANGES

- **C-3 (CRITICAL)**: `AuditEventType`, `AuditLog.resourceType`, `LogAuditParams.resourceType` are strict unions missing prompt types. FIXED — task 1.6 added.
- **H-7 (HIGH)**: cascade-delete uses dynamic `await import()` inside function body, NOT static imports. FIXED — task 1.8 corrected.
- **H-8 (HIGH)**: `StudioPermission` constants belong in `permissions.ts`; aliases in `project-permission.ts`. FIXED — task 4.0 split into Part A + Part B.
- **H-9 (HIGH)**: Proxy routes should use `StudioPermission.PROMPT_CREATE`, not `'prompt:create' as any`. FIXED — template updated.
- **H-10 (HIGH)**: `findProjectAgentForProject()` return type may need cast to `IProjectAgent`. FIXED — note added.
- **M-10 (MEDIUM)**: navigation arrays are intentionally different (4 vs 3 entries). FIXED — note added.
- **M-11 (MEDIUM)**: deleteProject should use `projectTenantId` variable, not `tenantId` param. FIXED.
- **M-12 (MEDIUM)**: `prompt-builder.ts` missing from Modified Files table. FIXED.
- **M-13 (MEDIUM)**: i18n coverage incomplete. FIXED — task 5.3 added with full namespace planning.

### Round 3 (lld-reviewer) — NEEDS_CHANGES

- **C-4 (CRITICAL)**: Studio pages are NOT Next.js App Router routes — Studio is a SPA with `AppShell.tsx` `renderContent()` switch. FIXED — page files changed to component files; `AppShell.tsx` added to task 5.1 + Modified Files table + Wiring Checklist.
- **H-11 (HIGH)**: `STUDIO_PROJECT_PERMISSION_ALIASES` uses string literal keys, not computed property names. FIXED — task 4.0 Part B shows the exact pattern.
- **H-12 (HIGH)**: `findProjectAgentForProject()` undefined = no-op path not documented. FIXED — note added.
- **H-13 (HIGH)**: `deleteTenant()` needed explicit code snippet with `counts.*` pattern. FIXED.
- **M-14 (MEDIUM)**: Duplicate Phase 1 task numbering (1.7 twice). FIXED — renumbered to 1.8, 1.9.
- **M-15 (MEDIUM)**: Duplicate Phase 5 task numbering (5.3 twice). FIXED — renumbered.
- **M-16 (MEDIUM)**: `QueryAuditParams.resourceType` not updated. FIXED — added to task 1.6.
- **M-17 (MEDIUM)**: Non-automatable manual curl exit criterion. FIXED — removed.
- **M-18 (MEDIUM)**: New Files table had App Router paths. FIXED by C-4 fix.

### Round 4 (phase-auditor — cross-phase consistency) — APPROVED

- **COV-1 (HIGH)**: INT-2 sourceHash assertions not explicitly listed. FIXED — UT-2 task updated with 3 specific assertions.
- **COV-2 (HIGH)**: INT-3 steps 3-4 have no enabling implementation (usageCount decrement). FIXED — descoped to v1.5; documented in §7 Open Questions item 5. INT-3 description updated to "steps 1-2 only".
- **XP-5 (HIGH)**: Cascade test mock files not enumerated. FIXED — task 1.8 now names all 3 files with exact mock factory pattern.
- **OTH-1 (MEDIUM)**: Storybook stories not in any phase. FIXED — documented in §7 Open Questions item 6 as deferred.
- All 10 HLD architectural concerns traced to LLD tasks. All 15 FRs traced. Phase dependency order valid.

### Round 5 (lld-reviewer — final sweep) — APPROVED, no blockers

- **CRITICAL**: None.
- **HIGH**: None.
- All round-4 fixes verified correct.
- Three MEDIUM items (stale references in feature spec, test spec, HLD) deferred to `/post-impl-sync`.
- Wiring checklist (19 items) complete and verified.
- All 6 phases have valid dependency order, measurable exit criteria, and rollback strategies.

## Open items carried forward

- **§7.1**: `ModelResolutionService.resolve()` + `tenantModelId` invocation path — verify at Phase 2 task 2.2 implementation time.
- **§7.5**: `usageCount` decrement descoped to v1.5 — increment-only in v1.
- **§7.6**: Storybook stories for new Studio components — deferred to post-implementation.
- Three stale references to correct during `/post-impl-sync`: feature spec §10 (compiler.ts + `[projectId]` path), test spec INT-12 path, HLD §5 ID prefix naming.

## Next phase

`/implement prompt-library` to execute the 6-phase implementation plan.
