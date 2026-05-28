# LLD: Journal Scoping Fix — Project-Level Queries Drop userId Filter

**Date**: 2026-04-08
**Ticket**: ABLP-162
**Branch**: features/arch-ai

## Problem Statement

Journal entries created during onboarding are invisible in the in-project overlay because `journalService.query()` always filters by `userId`. When a different user (or same user with different auth context) opens the in-project overlay, they see "No journal entries" despite 19+ entries existing in the DB for that project. This contradicts how every other project-level artifact (agents, tools, configs) works — they scope by `tenantId + projectId`, not `userId`.

## Design Decision

Journal queries become **project-scoped** when `projectId` is provided (no `userId` filter), and remain **user-scoped** when querying by `sessionId` only. This matches the pattern used by `ProjectAgent`, `ModelConfig`, and all other project-level data.

## Implementation Phases

### Phase 1: Fix journalService.query() — Drop userId for projectId queries

**Files**:

- `packages/arch-ai/src/journal/journal-service.ts`

**Tasks**:

1. In `query()` method (line 99-115): When `params.projectId` is provided, do NOT add `userId` to the filter. Only add `userId` when querying by `sessionId` without `projectId`.
2. In `linkToProject()` method (line 187-193): Remove `userId` from the updateMany filter — link ALL session entries to the project, not just the current user's.

**Exit Criteria**:

- `pnpm build --filter=@agent-platform/arch-ai` passes
- Unit concept: `query({projectId: 'x'}, ctx)` produces filter WITHOUT userId; `query({sessionId: 'x'}, ctx)` produces filter WITH userId

### Phase 2: Fix read_journal tool — Query by projectId, not sessionId

**Files**:

- `apps/studio/src/app/api/arch-ai/message/route.ts`

**Tasks**:

1. In the `read_journal` tool execute function (~line 1895-1938): Change the query to use `projectId` instead of `sessionId` when in IN_PROJECT mode. The tool has access to `projectId` from the closure.
2. Add `projectId` as a query option so the tool can fetch the full project decision history across all sessions.

**Exit Criteria**:

- `pnpm build --filter=@agent-platform/studio` typecheck passes (via `tsc --noEmit`)

### Phase 3: Add project access control to journal route

**Files**:

- `apps/studio/src/app/api/arch-ai/sessions/[id]/journal/route.ts`

**Tasks**:

1. When `projectId` query param is provided, call `requireProjectAccess(projectId, auth)` before querying. This ensures only project members can read project-scoped journal entries.

**Exit Criteria**:

- `pnpm build --filter=@agent-platform/studio` typecheck passes

### Phase 4: Verify end-to-end

**Tasks**:

1. Restart Studio
2. API test: Query journal for SmartSchedule project (019d6c98-0ebf-758e-a38c-32c10b6669a7) — should return 19 entries
3. Verify onboarding session-scoped queries still work (query by sessionId returns only that user's entries)

**Exit Criteria**:

- Project-scoped query returns entries regardless of userId
- Session-scoped query still filters by userId
- No regressions

## Wiring Checklist

- [ ] `journalService.query()` updated in `packages/arch-ai/src/journal/journal-service.ts`
- [ ] `linkToProject()` updated in same file
- [ ] `read_journal` tool updated in `apps/studio/src/app/api/arch-ai/message/route.ts`
- [ ] Journal route access control added in `apps/studio/src/app/api/arch-ai/sessions/[id]/journal/route.ts`
- [ ] `@agent-platform/arch-ai` rebuilt

## Acceptance Criteria

- [ ] In-project JournalPanel shows entries from the onboarding session that created the project
- [ ] Different users on the same project can see the same journal entries
- [ ] Session-scoped queries (onboarding) still filter by userId
- [ ] Project access is verified before returning project-scoped journal entries
- [ ] `pnpm build` passes for affected packages
