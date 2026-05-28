# LLD + Implementation Plan: Agent Development (Studio)

**Feature**: Agent Development (Studio)
**Date**: 2026-03-22
**Status**: STABLE (documenting existing + gap closure)
**Feature Spec**: [docs/features/agent-development-studio.md](../features/agent-development-studio.md)
**HLD**: [docs/specs/agent-development-studio.hld.md](../specs/agent-development-studio.hld.md)
**Test Spec**: [docs/testing/agent-development-studio.md](../testing/agent-development-studio.md)

---

## 1. Design Decisions

### Decision Log

| Decision                                           | Rationale                                                                                              | Alternatives Rejected                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Use 500ms debounce for section edits               | Balances responsiveness with API call volume. Matches typical typing pauses.                           | 1s debounce (too slow), no debounce (too many API calls), WebSocket streaming (over-engineered for this use case) |
| Use SWR for data fetching                          | Provides caching, revalidation, focus-based refetch out of the box. Matches existing codebase pattern. | React Query (similar but not used elsewhere), manual fetch (no caching), RTK Query (adds Redux dependency)        |
| Section editors read from compiled IR, not raw DSL | IR provides structured, typed data for form rendering. Raw DSL would require per-section parsing.      | Parse DSL client-side (fragile regex), store section data separately (sync issues)                                |
| Client-side routing via NavigationStore            | Enables SPA navigation without full-page reloads. Preserves editor state across navigations.           | Next.js App Router pages (full reloads lose editor state), hash routing (limited)                                 |
| Git circuit breaker at provider level              | Prevents cascading failures from external git APIs. Standard resilience pattern.                       | Retry-only (no protection from sustained outages), per-request timeout (insufficient for cascading)               |

### Key Interfaces & Types

```typescript
// EditorStore (apps/studio/src/store/editor-store.ts)
interface EditorState {
  dslContent: string;
  originalContent: string;
  isDirty: boolean;
  parseErrors: ParseError[];
  compiledIR: unknown | null;
  compileErrors: string[];
  isCompiling: boolean;
  diagnostics: Diagnostic[];
  viewMode: 'view' | 'edit';
}

// AgentDetailStore section data types (apps/studio/src/store/agent-detail-store.ts)
type SectionId =
  | 'IDENTITY'
  | 'TOOLS'
  | 'GATHER'
  | 'FLOW'
  | 'RULES'
  | 'COORDINATION'
  | 'BEHAVIOR'
  | 'LIFECYCLE';
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

// Section edit hook (apps/studio/src/hooks/useSectionEdit.ts)
interface SectionEdit {
  section: string;
  data: unknown;
}

// Git sync result (packages/project-io/src/git/git-sync-service.ts)
interface SyncResult {
  success: boolean;
  commitSha?: string;
  changes: { added: string[]; modified: string[]; deleted: string[] };
  conflicts: ConflictInfo[];
  error?: string;
}
```

### Module Boundaries

| Module                                     | Responsibility                                      | Dependencies                                              |
| ------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------- |
| `apps/studio/src/components/agent-editor/` | Agent editing UI (17 section editors, header, menu) | EditorStore, AgentDetailStore, useSectionEdit, useAgentIR |
| `apps/studio/src/components/projects/`     | Project dashboard, import/export dialogs            | ProjectStore, LifecycleStore                              |
| `apps/studio/src/components/settings/`     | Project settings UI (10 tabs)                       | NavigationStore, API routes                               |
| `apps/studio/src/components/topology/`     | Multi-agent topology canvas                         | CanvasStore, topology API                                 |
| `apps/studio/src/store/`                   | Client state management (20+ stores)                | Zustand, SWR                                              |
| `apps/studio/src/app/api/`                 | Studio API routes (60+)                             | requireAuth, repos, runtime proxy                         |
| `apps/studio/src/hooks/`                   | Shared hooks (useAgentIR, useSectionEdit, etc.)     | Stores, API client                                        |
| `apps/studio/src/repos/`                   | Data access layer                                   | MongoDB/Prisma                                            |
| `apps/studio/src/services/`                | Business logic (project, auth, arch, export)        | Repos, external APIs                                      |
| `packages/project-io/`                     | Project transport (export, import, git sync)        | Git providers, MongoDB                                    |

---

## 2. File-Level Change Map

Since Agent Development (Studio) is a STABLE, fully-implemented feature, this LLD focuses on gap closure and hardening rather than greenfield implementation. The phases below address the gaps identified in the feature spec (GAP-001 through GAP-010) and the test coverage gaps from the test spec.

### New Files

| File                                                           | Purpose                                                           | LOC Estimate |
| -------------------------------------------------------------- | ----------------------------------------------------------------- | ------------ |
| `apps/studio/src/__tests__/topology-canvas.test.tsx`           | Unit tests for TopologyCanvas layout algorithm                    | ~150         |
| `apps/studio/src/__tests__/section-edit-roundtrip.test.ts`     | Integration test for surgical edit -> DSL -> recompile round-trip | ~200         |
| `apps/studio/src/__tests__/settings-version-lifecycle.test.ts` | Integration test for settings version promotion lifecycle         | ~150         |
| `apps/studio/src/__tests__/api-compile-rate-limit.test.ts`     | Integration test for compilation rate limiting enforcement        | ~100         |
| `apps/studio/src/__tests__/project-isolation-authz.test.ts`    | Integration test for cross-tenant/cross-project isolation         | ~200         |
| `apps/studio/e2e/agent-authoring-journey.spec.ts`              | E2E: Full create/edit/compile/save journey                        | ~250         |
| `apps/studio/e2e/settings-version-lifecycle.spec.ts`           | E2E: Settings version create/promote/verify                       | ~150         |

### Modified Files

| File                                                                   | Change Description                                              | Risk   |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- | ------ |
| `apps/studio/src/services/project-service.ts`                          | Replace `any` types with proper Project/ProjectAgent interfaces | Low    |
| `apps/studio/src/hooks/useSectionEdit.ts`                              | Add flush-on-navigation via beforeunload handler                | Low    |
| `apps/studio/src/components/agent-editor/AgentEditor.tsx`              | Add save-before-leave guard via flush call                      | Low    |
| `apps/studio/src/app/api/projects/[id]/agents/[agentId]/lock/route.ts` | Add automatic lock lease expiry (configurable timeout)          | Medium |
| `apps/studio/src/components/settings/ProjectSettingsPage.tsx`          | No changes needed                                               | --     |

### Deleted Files

None. This plan is additive -- gap closure and hardening.

---

## 3. Implementation Phases

### Phase 1: Type Safety and Code Quality

**Goal**: Eliminate `any` types in project service and strengthen type safety in editor pipeline.

**Tasks**:
1.1. Read `apps/studio/src/services/project-service.ts` and replace `any` types for Project and ProjectAgent with proper interfaces imported from `project-repo.ts` or `project-store.ts`.
1.2. Verify all callers of project-service functions handle the typed returns correctly.
1.3. Run `pnpm build --filter=studio` to verify no type errors.

**Files Touched**:

- `apps/studio/src/services/project-service.ts` -- Replace `type Project = any` and `type ProjectAgent = any` with proper typed interfaces

**Exit Criteria**:

- [ ] `project-service.ts` has zero `any` type declarations
- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] All existing unit tests for project-service pass

**Test Strategy**:

- Unit: Existing `apps/studio/src/__tests__/project-services.test.ts` continues to pass
- Integration: N/A (type-only change)

**Rollback**: Revert the type changes. No data impact.

---

### Phase 2: Editor Save Reliability

**Goal**: Ensure pending section edits are flushed before navigation or window unload, closing the data-loss risk identified in the feature spec.

**Tasks**:
2.1. Add a `beforeunload` event handler in `useSectionEdit` that calls `saveEditsNow()` on window unload.
2.2. Add a save-before-leave guard in `AgentEditor` that calls `saveEditsNow()` before navigation events (via NavigationStore).
2.3. Add a test for the beforeunload flush behavior.

**Files Touched**:

- `apps/studio/src/hooks/useSectionEdit.ts` -- Add beforeunload listener that calls flush()
- `apps/studio/src/components/agent-editor/AgentEditor.tsx` -- Add navigation guard calling saveEditsNow before route changes

**Exit Criteria**:

- [ ] `useSectionEdit` registers and cleans up beforeunload handler
- [ ] Pending edits are flushed on navigation away from editor
- [ ] Existing section edit tests still pass
- [ ] New test verifies beforeunload flush behavior

**Test Strategy**:

- Unit: New test in `apps/studio/src/__tests__/section-edit-hook.test.ts` verifying beforeunload registration
- Integration: Verify via E2E in Phase 5

**Rollback**: Revert hook change. Behavior returns to current (no flush on navigation).

---

### Phase 3: Agent Lock Lease Expiry

**Goal**: Add automatic lock lease expiry to prevent stale locks from blocking agent editing (GAP-008).

**Tasks**:
3.1. Read the current lock endpoint at `apps/studio/src/app/api/projects/[id]/agents/[agentId]/lock/route.ts`.
3.2. Add a `lockExpiresAt` field to the lock acquisition logic (default 30 minutes, configurable).
3.3. Modify the lock check logic to treat expired locks as available.
3.4. Add a test for lock lease expiry behavior.

**Files Touched**:

- `apps/studio/src/app/api/projects/[id]/agents/[agentId]/lock/route.ts` -- Add `lockExpiresAt` field and expiry check

**Exit Criteria**:

- [ ] Lock acquisition sets `lockExpiresAt = now + 30min` (configurable)
- [ ] Lock status check returns "unlocked" for expired locks
- [ ] Existing lock tests pass
- [ ] New test verifies expired lock is treated as available

**Test Strategy**:

- Integration: New test in `apps/studio/src/__tests__/` verifying lock expiry behavior
- Unit: N/A

**Rollback**: Revert route change. Locks revert to no-expiry behavior.

---

### Phase 4: Test Coverage -- Topology and Surgical Editing

**Goal**: Add dedicated test coverage for topology canvas layout algorithm and surgical section edit round-trips, closing the two largest coverage gaps.

**Tasks**:
4.1. Create `apps/studio/src/__tests__/topology-canvas.test.tsx` with tests for:

- Empty topology (0 nodes)
- Single agent (1 node, no edges)
- Supervisor with 3 child agents (4 nodes, 3 edges)
- Deep hierarchy (5 levels)
- Disconnected nodes
  4.2. Create `apps/studio/src/__tests__/section-edit-roundtrip.test.ts` with tests for:
- Edit identity section -> verify DSL mutation
- Edit tools section -> verify DSL mutation
- Edit flow section -> verify DSL mutation
- Invalid section name -> verify error
- Batch edits (multiple sections) -> verify all applied

**Files Touched**:

- `apps/studio/src/__tests__/topology-canvas.test.tsx` -- New file
- `apps/studio/src/__tests__/section-edit-roundtrip.test.ts` -- New file

**Exit Criteria**:

- [ ] Topology canvas tests cover 5 graph shapes (empty, single, tree, deep, disconnected)
- [ ] Section edit round-trip tests cover 3 section types + error case + batch
- [ ] All new tests pass: `pnpm --filter studio test -- topology-canvas` and `pnpm --filter studio test -- section-edit-roundtrip`

**Test Strategy**:

- Unit: Topology layout algorithm tested with mock TopologyData
- Integration: Section edit round-trip tested via API call simulation

**Rollback**: Delete new test files. No production code impact.

---

### Phase 5: Test Coverage -- E2E Authoring Journey and Settings Lifecycle

**Goal**: Add the two most critical missing E2E test suites: full agent authoring journey and settings version lifecycle.

**Tasks**:
5.1. Create `apps/studio/e2e/agent-authoring-journey.spec.ts` implementing E2E-1 from the test spec:

- Create project
- Create agent
- Upload DSL
- Compile and verify
- Surgical edit and verify
- Verify topology
  5.2. Create `apps/studio/e2e/settings-version-lifecycle.spec.ts` implementing E2E-4 from the test spec:
- Update settings working copy
- Create version snapshot
- Promote through lifecycle
- Verify active version
  5.3. Add API-level E2E for project isolation (cross-tenant returns 404).

**Files Touched**:

- `apps/studio/e2e/agent-authoring-journey.spec.ts` -- New file
- `apps/studio/e2e/settings-version-lifecycle.spec.ts` -- New file

**Exit Criteria**:

- [ ] Agent authoring journey E2E passes with real Studio + Runtime servers
- [ ] Settings version lifecycle E2E passes
- [ ] Cross-tenant isolation check returns 404
- [ ] No mocking of codebase components in E2E tests
- [ ] E2E tests use structured ABL DSL content (not just plain strings)

**Test Strategy**:

- E2E: Real servers on random ports, full middleware chain, HTTP API interaction only
- No direct DB access, no `vi.mock()` or `jest.mock()`

**Rollback**: Delete new E2E files. No production code impact.

---

### Phase 6: Integration Test Coverage -- Rate Limiting and Authorization

**Goal**: Add integration tests for compilation rate limiting and project authorization, covering security-critical gaps.

**Tasks**:
6.1. Create `apps/studio/src/__tests__/api-compile-rate-limit.test.ts` implementing INT-1 (step 6) from the test spec:

- Submit 30 compile requests -> all succeed
- Submit 31st request -> verify 429 with Retry-After header
  6.2. Create `apps/studio/src/__tests__/project-isolation-authz.test.ts` implementing INT-6 from the test spec:
- Viewer can read but not write
- Non-member gets 404 (not 403)
- Editor can write
  6.3. Verify DSL size limit (500KB) enforcement in compilation test.

**Files Touched**:

- `apps/studio/src/__tests__/api-compile-rate-limit.test.ts` -- New file
- `apps/studio/src/__tests__/project-isolation-authz.test.ts` -- New file

**Exit Criteria**:

- [ ] Rate limiting test verifies 429 on 31st request within 60s window
- [ ] Authorization test verifies viewer/editor/non-member behavior
- [ ] DSL size limit (500KB) test verifies 400 response
- [ ] All new tests pass

**Test Strategy**:

- Integration: Real API routes with mocked auth context (different user IDs/roles)
- No mocking of rate limiter or permission middleware internals

**Rollback**: Delete new test files. No production code impact.

---

## 4. Wiring Checklist

Since this plan is primarily gap closure (tests + hardening) rather than new feature wiring, the checklist focuses on ensuring new code is properly connected:

- [ ] Phase 1: project-service.ts type changes -- no new exports needed, verify existing callers
- [ ] Phase 2: beforeunload handler -- registered in useSectionEdit hook (no new exports)
- [ ] Phase 2: Navigation guard -- wired in AgentEditor component (no new exports)
- [ ] Phase 3: Lock expiry -- modification to existing route handler (no new exports)
- [ ] Phase 4-6: Test files -- no wiring needed (vitest discovers test files automatically)
- [ ] All new test files follow naming convention `*.test.ts` or `*.test.tsx`
- [ ] E2E test files follow naming convention `*.spec.ts`
- [ ] No new environment variables required
- [ ] No new package dependencies required

---

## 5. Cross-Phase Concerns

### Database Changes

- **Phase 3 (lock expiry)**: The lock mechanism may need a `lockExpiresAt` field in the lock record. If locks are stored in MongoDB, this is an additive schema change (no migration needed -- new field is optional, old locks without it are treated as never-expiring for backward compatibility).

### Feature Flags

- No feature flags needed. All changes are backward-compatible or additive.

### Configuration Changes

- **Phase 3**: Lock lease duration should be configurable. Default: 30 minutes. Could be an environment variable (`AGENT_LOCK_LEASE_MS`) or project-level setting.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All phases complete with exit criteria met
- [ ] `project-service.ts` has zero `any` types
- [ ] Editor saves are flushed on navigation and window unload
- [ ] Agent locks expire after configurable timeout
- [ ] Topology canvas has 5+ layout test cases passing
- [ ] Section edit round-trip has 5+ test cases passing
- [ ] Full authoring journey E2E passes (create -> edit -> compile -> save -> topology)
- [ ] Settings version lifecycle E2E passes
- [ ] Rate limiting integration test passes (429 on threshold exceed)
- [ ] Project isolation integration test passes (viewer/editor/non-member)
- [ ] No regressions in existing 100+ Studio tests
- [ ] `pnpm build --filter=studio` succeeds with 0 errors

---

## 7. Open Questions

1. Should the lock lease timeout be configurable per-project or global? Global is simpler to implement; per-project provides more flexibility but adds UI complexity.
2. Should the beforeunload handler show a browser-native "unsaved changes" dialog, or silently flush? Silent flush is better UX but may fail if the page is being force-closed.
3. Should the rate limiting integration test use a real Redis instance or an in-memory rate limiter? Real Redis is more realistic but adds CI infrastructure requirements.
