# Fix useStaleToolCheck Implementation Gaps

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align useStaleToolCheck implementation with DSL-native tools documentation requirements (D5, R9.1, R9.8, C9.3)

**Architecture:** Fix type definition to match canonical source, add missing "new tools" detection, update UI to display all three tool change categories (stale/deleted/new)

**Tech Stack:** TypeScript, React, SWR, Vitest

**Reference Documents:**

- `docs/plans/2026-02-24-dsl-native-tools-decisions.md` (D5, R9.1-R9.13, C9.1-C9.7)
- Decision D5: Full toolSnapshot with `dslContent`
- Requirement R9.8: Detect "updated", "deleted", AND "new" tools

---

## ✅ Task 1: Fix Incomplete ToolSnapshotEntry Interface

**Files:**

- Modify: `apps/studio/src/hooks/useStaleToolCheck.ts:1-112`

**Background:** The hook defines a local `ToolSnapshotEntry` interface that's missing the `dslContent` field required by D5, R9.1, and C9.3. The canonical definition exists in `apps/studio/src/api/versions.ts` with all 6 fields.

**Step 1: Import ToolSnapshotEntry from canonical source**

Edit `apps/studio/src/hooks/useStaleToolCheck.ts`:

```typescript
// Line 11-14, update imports
import useSWR from 'swr';
import { fetchVersions } from '../api/versions';
import { fetchTools } from '../api/tools';
import type { VersionRecord, ToolSnapshotEntry } from '../api/versions'; // Add ToolSnapshotEntry here
```

**Step 2: Remove local interface definition**

Delete lines 16-23:

```typescript
// DELETE THESE LINES:
/** Tool snapshot entry stored on agent versions (new format) */
interface ToolSnapshotEntry {
  name: string;
  projectToolId: string;
  sourceHash: string;
  toolType: 'http' | 'sandbox' | 'mcp';
  description: string | null;
}
```

**Step 3: Verify TypeScript compilation**

Run: `pnpm tsc --noEmit --project apps/studio/tsconfig.json`

Expected: No errors (the imported type has all required fields including `dslContent`)

**Step 4: Commit**

```bash
git add apps/studio/src/hooks/useStaleToolCheck.ts
git commit -m "fix(studio): import ToolSnapshotEntry from canonical source

- Remove local interface definition (missing dslContent field)
- Import from apps/studio/src/api/versions.ts
- Aligns with D5, R9.1, C9.3 requirements for full snapshot state"
```

---

## ✅ Task 2: Add New Tools Detection - Write Tests First

**Files:**

- Create: `apps/studio/src/hooks/__tests__/useStaleToolCheck.test.ts`

**Background:** Requirement R9.8 states stale detection must identify "new" tools (in current project_tools but not in snapshot). Currently only detects stale and deleted.

**Step 1: Write failing test for new tools detection**

Create `apps/studio/src/hooks/__tests__/useStaleToolCheck.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

/**
 * Internal function exported for testing only
 * Located at apps/studio/src/hooks/useStaleToolCheck.ts
 */
interface ToolSnapshotEntry {
  name: string;
  projectToolId: string;
  sourceHash: string;
  toolType: 'http' | 'sandbox' | 'mcp';
  description: string | null;
  dslContent: string;
}

interface StaleToolInfo {
  name: string;
  projectToolId: string;
  snapshotHash: string;
  currentHash: string;
  toolType: string;
}

interface DeletedToolInfo {
  name: string;
  projectToolId: string;
}

interface NewToolInfo {
  name: string;
  projectToolId: string;
}

// Mock implementation - will be replaced with actual import after implementation
function detectStaleTools(
  snapshot: ToolSnapshotEntry[],
  currentTools: Array<{ id: string; name: string; sourceHash?: string }>,
): { stale: StaleToolInfo[]; deleted: DeletedToolInfo[]; new: NewToolInfo[] } {
  // This is a placeholder that will fail the test
  return { stale: [], deleted: [], new: [] };
}

describe('detectStaleTools', () => {
  it('should detect stale tools (hash changed)', () => {
    const snapshot: ToolSnapshotEntry[] = [
      {
        name: 'get_weather',
        projectToolId: 'tool-1',
        sourceHash: 'abc123',
        toolType: 'http',
        description: 'Get weather',
        dslContent: 'get_weather() -> object\n  type: http',
      },
    ];

    const currentTools = [{ id: 'tool-1', name: 'get_weather', sourceHash: 'def456' }];

    const result = detectStaleTools(snapshot, currentTools);

    expect(result.stale).toHaveLength(1);
    expect(result.stale[0]).toEqual({
      name: 'get_weather',
      projectToolId: 'tool-1',
      snapshotHash: 'abc123',
      currentHash: 'def456',
      toolType: 'http',
    });
  });

  it('should detect deleted tools (not in current)', () => {
    const snapshot: ToolSnapshotEntry[] = [
      {
        name: 'old_tool',
        projectToolId: 'tool-1',
        sourceHash: 'abc123',
        toolType: 'sandbox',
        description: null,
        dslContent: 'old_tool() -> string\n  type: sandbox',
      },
    ];

    const currentTools: Array<{ id: string; name: string; sourceHash?: string }> = [];

    const result = detectStaleTools(snapshot, currentTools);

    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0]).toEqual({
      name: 'old_tool',
      projectToolId: 'tool-1',
    });
  });

  it('should detect new tools (in current but not in snapshot)', () => {
    const snapshot: ToolSnapshotEntry[] = [];

    const currentTools = [{ id: 'tool-1', name: 'new_tool', sourceHash: 'xyz789' }];

    const result = detectStaleTools(snapshot, currentTools);

    expect(result.new).toHaveLength(1);
    expect(result.new[0]).toEqual({
      name: 'new_tool',
      projectToolId: 'tool-1',
    });
  });

  it('should not detect new tools without sourceHash', () => {
    const snapshot: ToolSnapshotEntry[] = [];

    const currentTools = [{ id: 'tool-1', name: 'draft_tool', sourceHash: undefined }];

    const result = detectStaleTools(snapshot, currentTools);

    expect(result.new).toHaveLength(0);
  });

  it('should handle mixed scenarios', () => {
    const snapshot: ToolSnapshotEntry[] = [
      {
        name: 'unchanged',
        projectToolId: 'tool-1',
        sourceHash: 'aaa',
        toolType: 'http',
        description: null,
        dslContent: 'unchanged() -> void\n  type: http',
      },
      {
        name: 'updated',
        projectToolId: 'tool-2',
        sourceHash: 'bbb',
        toolType: 'mcp',
        description: null,
        dslContent: 'updated() -> void\n  type: mcp',
      },
      {
        name: 'deleted',
        projectToolId: 'tool-3',
        sourceHash: 'ccc',
        toolType: 'sandbox',
        description: null,
        dslContent: 'deleted() -> void\n  type: sandbox',
      },
    ];

    const currentTools = [
      { id: 'tool-1', name: 'unchanged', sourceHash: 'aaa' }, // same hash
      { id: 'tool-2', name: 'updated', sourceHash: 'bbb-new' }, // different hash
      { id: 'tool-4', name: 'new_tool', sourceHash: 'ddd' }, // not in snapshot
      // tool-3 'deleted' is missing from current
    ];

    const result = detectStaleTools(snapshot, currentTools);

    expect(result.stale).toHaveLength(1);
    expect(result.stale[0].name).toBe('updated');

    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0].name).toBe('deleted');

    expect(result.new).toHaveLength(1);
    expect(result.new[0].name).toBe('new_tool');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test apps/studio/src/hooks/__tests__/useStaleToolCheck.test.ts`

Expected: FAIL - Mock function returns empty arrays, tests expect populated arrays

**Step 3: Export detectStaleTools for testing**

Edit `apps/studio/src/hooks/useStaleToolCheck.ts` line 38:

```typescript
// Change from:
function detectStaleTools(

// To:
export function detectStaleTools(
```

Add NewToolInfo interface after DeletedToolInfo (after line 36):

```typescript
export interface DeletedToolInfo {
  name: string;
  projectToolId: string;
}

export interface NewToolInfo {
  name: string;
  projectToolId: string;
}
```

**Step 4: Update detectStaleTools to detect new tools**

Edit `apps/studio/src/hooks/useStaleToolCheck.ts`, replace the entire function (lines 38-69):

```typescript
export function detectStaleTools(
  snapshot: ToolSnapshotEntry[],
  currentTools: Array<{ id: string; name: string; sourceHash?: string }>,
): { stale: StaleToolInfo[]; deleted: DeletedToolInfo[]; new: NewToolInfo[] } {
  const stale: StaleToolInfo[] = [];
  const deleted: DeletedToolInfo[] = [];
  const newTools: NewToolInfo[] = [];

  const currentByName = new Map(currentTools.map((t) => [t.name, t]));
  const snapshotByName = new Map(snapshot.map((t) => [t.name, t]));

  // Detect stale and deleted tools
  for (const entry of snapshot) {
    const current = currentByName.get(entry.name);

    if (!current) {
      deleted.push({
        name: entry.name,
        projectToolId: entry.projectToolId,
      });
      continue;
    }

    if (current.sourceHash && current.sourceHash !== entry.sourceHash) {
      stale.push({
        name: entry.name,
        projectToolId: entry.projectToolId,
        snapshotHash: entry.sourceHash,
        currentHash: current.sourceHash,
        toolType: entry.toolType,
      });
    }
  }

  // Detect new tools (in current but not in snapshot)
  for (const current of currentTools) {
    const inSnapshot = snapshotByName.get(current.name);
    if (!inSnapshot && current.sourceHash) {
      newTools.push({
        name: current.name,
        projectToolId: current.id,
      });
    }
  }

  return { stale, deleted, new: newTools };
}
```

**Step 5: Update test to import real function**

Edit `apps/studio/src/hooks/__tests__/useStaleToolCheck.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { detectStaleTools } from '../useStaleToolCheck';
import type { StaleToolInfo, DeletedToolInfo, NewToolInfo } from '../useStaleToolCheck';

// Remove mock implementation and local interfaces - use real imports

describe('detectStaleTools', () => {
  // ... rest of tests stay the same
```

**Step 6: Run test to verify it passes**

Run: `pnpm test apps/studio/src/hooks/__tests__/useStaleToolCheck.test.ts`

Expected: PASS - All 5 tests pass

**Step 7: Commit**

```bash
git add apps/studio/src/hooks/useStaleToolCheck.ts apps/studio/src/hooks/__tests__/useStaleToolCheck.test.ts
git commit -m "feat(studio): add new tools detection to stale check

- Add NewToolInfo interface
- Update detectStaleTools to detect tools in current but not in snapshot
- Add comprehensive test suite covering stale/deleted/new/mixed scenarios
- Fulfills requirement R9.8 (detect updated, deleted, and new)"
```

---

## ✅ Task 3: Update Hook Return Type and Consumer

**Files:**

- Modify: `apps/studio/src/hooks/useStaleToolCheck.ts:72-111`
- Modify: `apps/studio/src/components/agent-detail/StaleToolBanner.tsx`

**Step 1: Update useStaleToolCheck return type**

Edit `apps/studio/src/hooks/useStaleToolCheck.ts`, update return statement (around line 105):

```typescript
return {
  staleTools: data?.stale ?? [],
  deletedTools: data?.deleted ?? [],
  newTools: data?.new ?? [], // Add this line
  isLoading,
  error: error ? String(error) : null,
};
```

**Step 2: Verify TypeScript compilation**

Run: `pnpm tsc --noEmit --project apps/studio/tsconfig.json`

Expected: No errors

**Step 3: Update StaleToolBanner props**

Edit `apps/studio/src/components/agent-detail/StaleToolBanner.tsx` line 16-21:

```typescript
interface StaleToolBannerProps {
  staleTools: StaleToolInfo[];
  deletedTools?: DeletedToolInfo[];
  newTools?: NewToolInfo[]; // Add this line
  onRecompile?: () => void;
  isRecompiling?: boolean;
}
```

Update component signature (line 23):

```typescript
export function StaleToolBanner({
  staleTools,
  deletedTools = [],
  newTools = [],  // Add this line
  onRecompile,
  isRecompiling = false,
}: StaleToolBannerProps) {
```

Update visibility check (line 31):

```typescript
const show =
  !dismissed && (staleTools.length > 0 || deletedTools.length > 0 || newTools.length > 0);
```

**Step 4: Add NewToolInfo import**

Edit `apps/studio/src/components/agent-detail/StaleToolBanner.tsx` line 14:

```typescript
import type { StaleToolInfo, DeletedToolInfo, NewToolInfo } from '../../hooks/useStaleToolCheck';
```

**Step 5: Verify TypeScript compilation**

Run: `pnpm tsc --noEmit --project apps/studio/tsconfig.json`

Expected: No errors

**Step 6: Commit**

```bash
git add apps/studio/src/hooks/useStaleToolCheck.ts apps/studio/src/components/agent-detail/StaleToolBanner.tsx
git commit -m "feat(studio): update hook and banner to support new tools

- Add newTools to useStaleToolCheck return type
- Update StaleToolBanner props to accept newTools
- Update visibility check to include new tools"
```

---

## ✅ Task 4: Update StaleToolBanner UI to Display New Tools

**Files:**

- Modify: `apps/studio/src/components/agent-detail/StaleToolBanner.tsx:44-82`

**Step 1: Add new tools display section**

Edit `apps/studio/src/components/agent-detail/StaleToolBanner.tsx`, add after the deletedTools section (after line 81, before line 82):

```typescript
              {deletedTools.length > 0 && (
                <div className={staleTools.length > 0 ? 'mt-2' : ''}>
                  <p className="font-medium text-error">
                    {deletedTools.length} tool{deletedTools.length !== 1 ? 's' : ''}{' '}
                    {deletedTools.length !== 1 ? 'have' : 'has'} been deleted. Recompile will fail
                    until the tool reference is removed from the TOOLS section.
                  </p>
                  <ul className="mt-1.5 space-y-0.5">
                    {deletedTools.map((tool) => (
                      <li key={tool.projectToolId} className="flex items-center gap-1.5 text-xs">
                        <Trash2 className="w-3 h-3 text-error/60" />
                        <span className="font-mono text-error/80 line-through">{tool.name}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {newTools.length > 0 && (
                <div className={(staleTools.length > 0 || deletedTools.length > 0) ? 'mt-2' : ''}>
                  <p className="font-medium text-info">
                    {newTools.length} new tool{newTools.length !== 1 ? 's' : ''} added since last
                    compile. Recompile to include {newTools.length !== 1 ? 'them' : 'it'} in the
                    agent version snapshot.
                  </p>
                  <ul className="mt-1.5 space-y-0.5">
                    {newTools.map((tool) => (
                      <li key={tool.projectToolId} className="flex items-center gap-1.5 text-xs">
                        <Plus className="w-3 h-3 text-info/60" />
                        <span className="font-mono text-info/80">{tool.name}</span>
                        <span className="text-info/50">new</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
```

**Step 2: Add Plus icon import**

Edit `apps/studio/src/components/agent-detail/StaleToolBanner.tsx` line 11:

```typescript
import { AlertTriangle, Trash2, X, RefreshCw, Plus } from 'lucide-react';
```

**Step 3: Update recompile button condition**

Edit line 84, update the condition to also show button when there are new tools:

```typescript
              {onRecompile && (staleTools.length > 0 || newTools.length > 0) && (
```

**Step 4: Verify TypeScript compilation**

Run: `pnpm tsc --noEmit --project apps/studio/tsconfig.json`

Expected: No errors

**Step 5: Commit**

```bash
git add apps/studio/src/components/agent-detail/StaleToolBanner.tsx
git commit -m "feat(studio): add new tools display in stale banner

- Show new tools section with Plus icon and info styling
- Display 'N new tools added since last compile' message
- Include new tools in recompile button visibility check
- UI now shows all three categories: stale, deleted, new"
```

---

## ✅ Task 5: Update Components That Use useStaleToolCheck

**Files:**

- Find: `apps/studio/src/components/` (grep for useStaleToolCheck usage)

**Step 1: Find all consumers of useStaleToolCheck**

Run: `grep -r "useStaleToolCheck" apps/studio/src/components/ --include="*.tsx" --include="*.ts"`

Expected: Likely in AgentDetailPage or similar

**Step 2: Update consumer to pass newTools**

For each file found, update the StaleToolBanner call to include `newTools`:

Example (if in AgentDetailPage):

```typescript
const { staleTools, deletedTools, newTools, isLoading, error } = useStaleToolCheck(projectId, agentName);

// Later in JSX:
<StaleToolBanner
  staleTools={staleTools}
  deletedTools={deletedTools}
  newTools={newTools}  // Add this line
  onRecompile={handleRecompile}
  isRecompiling={isRecompiling}
/>
```

**Step 3: Verify TypeScript compilation**

Run: `pnpm tsc --noEmit --project apps/studio/tsconfig.json`

Expected: No errors

**Step 4: Commit**

```bash
git add apps/studio/src/components/[affected-files]
git commit -m "feat(studio): wire newTools through to StaleToolBanner

- Extract newTools from useStaleToolCheck hook
- Pass to StaleToolBanner component
- Completes new tools detection feature"
```

---

## ✅ Task 6: Add JSDoc Documentation

**Files:**

- Modify: `apps/studio/src/hooks/useStaleToolCheck.ts`

**Step 1: Add JSDoc to detectStaleTools**

Edit `apps/studio/src/hooks/useStaleToolCheck.ts`, add before the function (line 38):

```typescript
/**
 * Detects tool changes between agent version snapshot and current project tools.
 *
 * Returns three categories of changes:
 * - **stale**: Tool exists in both, but sourceHash differs (tool was updated)
 * - **deleted**: Tool exists in snapshot but not in current project_tools
 * - **new**: Tool exists in current project_tools but not in snapshot
 *
 * Tools without a sourceHash are ignored (considered drafts).
 *
 * @param snapshot - Tool snapshot from agent version (baseline for comparison)
 * @param currentTools - Current project_tools state from database
 * @returns Object with stale, deleted, and new tool arrays
 *
 * @example
 * const result = detectStaleTools(versionSnapshot, projectTools);
 * if (result.stale.length > 0) {
 *   console.log('Tools changed:', result.stale.map(t => t.name));
 * }
 */
export function detectStaleTools(
```

**Step 2: Add JSDoc to useStaleToolCheck**

Edit `apps/studio/src/hooks/useStaleToolCheck.ts`, add before the hook (line 72):

```typescript
/**
 * Compares project tools against the latest active agent version's tool snapshot
 * to detect stale, deleted, and new tools.
 *
 * **Comparison logic:**
 * - Compares against **active** version's snapshot (fallback: latest version with snapshot)
 * - Uses sourceHash-based comparison (no version numbers)
 * - Identifies three change types: stale (updated), deleted, new
 *
 * **Caching:**
 * - SWR with 5-minute refresh interval, 1-minute deduplication
 * - No revalidation on focus (prevents unnecessary fetches)
 *
 * **Requirements:** R9.6-R9.8 (stale detection), C9.6 (active version priority)
 *
 * @param projectId - Project identifier (null disables hook)
 * @param agentName - Agent name (null disables hook)
 * @returns Stale/deleted/new tool lists, loading state, and error
 *
 * @example
 * const { staleTools, deletedTools, newTools, isLoading } = useStaleToolCheck(projectId, agentName);
 * if (staleTools.length > 0) {
 *   showBanner('Tools have changed. Recompile to pick up updates.');
 * }
 */
export function useStaleToolCheck(projectId: string | null, agentName: string | null) {
```

**Step 3: Add interface documentation**

Edit interfaces to add JSDoc comments:

```typescript
/** Information about a tool that has been updated since the snapshot */
export interface StaleToolInfo {
  name: string;
  projectToolId: string;
  snapshotHash: string;
  currentHash: string;
  toolType: string;
}

/** Information about a tool that was deleted from project_tools */
export interface DeletedToolInfo {
  name: string;
  projectToolId: string;
}

/** Information about a tool that was added to project_tools */
export interface NewToolInfo {
  name: string;
  projectToolId: string;
}
```

**Step 4: Verify TypeScript compilation**

Run: `pnpm tsc --noEmit --project apps/studio/tsconfig.json`

Expected: No errors

**Step 5: Commit**

```bash
git add apps/studio/src/hooks/useStaleToolCheck.ts
git commit -m "docs(studio): add JSDoc to useStaleToolCheck

- Document detectStaleTools comparison logic
- Document useStaleToolCheck caching and requirements
- Add interface documentation for all exported types
- Improve code maintainability and IDE hints"
```

---

## ✅ Task 7: Integration Testing and Verification

**Files:**

- Modify: `apps/studio/src/hooks/__tests__/useStaleToolCheck.test.ts`

**Step 1: Add integration-style test**

Add to the test file:

```typescript
describe('useStaleToolCheck integration', () => {
  it('should return all three detection categories', () => {
    // This test verifies the hook return type includes all three categories
    // In a real integration test, we'd mock fetchVersions and fetchTools

    const snapshot = [
      {
        name: 'stale_tool',
        projectToolId: 'tool-1',
        sourceHash: 'old-hash',
        toolType: 'http' as const,
        description: null,
        dslContent: 'stale_tool() -> void\n  type: http',
      },
      {
        name: 'deleted_tool',
        projectToolId: 'tool-2',
        sourceHash: 'hash',
        toolType: 'sandbox' as const,
        description: null,
        dslContent: 'deleted_tool() -> void\n  type: sandbox',
      },
    ];

    const currentTools = [
      { id: 'tool-1', name: 'stale_tool', sourceHash: 'new-hash' },
      { id: 'tool-3', name: 'new_tool', sourceHash: 'hash' },
    ];

    const result = detectStaleTools(snapshot, currentTools);

    // Verify hook would return all three arrays
    expect(result).toHaveProperty('stale');
    expect(result).toHaveProperty('deleted');
    expect(result).toHaveProperty('new');

    expect(result.stale.length).toBe(1);
    expect(result.deleted.length).toBe(1);
    expect(result.new.length).toBe(1);
  });
});
```

**Step 2: Run all tests**

Run: `pnpm test apps/studio/src/hooks/__tests__/useStaleToolCheck.test.ts`

Expected: All tests pass (6 total)

**Step 3: Run TypeScript compilation**

Run: `pnpm tsc --noEmit --project apps/studio/tsconfig.json`

Expected: No errors

**Step 4: Run studio build**

Run: `pnpm --filter studio build`

Expected: Build succeeds

**Step 5: Commit**

```bash
git add apps/studio/src/hooks/__tests__/useStaleToolCheck.test.ts
git commit -m "test(studio): add integration test for stale tool detection

- Verify hook return type includes all three categories
- Test mixed scenario with stale, deleted, and new tools
- Confirms end-to-end type safety"
```

---

## ✅ Task 8: Final Verification and Documentation Update

**Files:**

- Verify: All TypeScript compilation, tests, build
- Update: This plan document with completion status

**Step 1: Run full test suite**

Run: `pnpm test`

Expected: All tests pass

**Step 2: Verify no TypeScript errors**

Run: `pnpm tsc --noEmit`

Expected: No errors across all packages

**Step 3: Manual browser verification (optional)**

1. Start dev server: `pnpm dev`
2. Navigate to agent detail page with tools
3. Verify StaleToolBanner shows:
   - Stale tools (if tool sourceHash changed)
   - Deleted tools (if tool removed)
   - New tools (if tool added since last version)
4. Click "Recompile" and verify snapshot captures current state

**Step 4: Create summary commit**

```bash
git add .
git commit -m "feat(studio): complete stale tool check alignment with docs

Summary of changes:
- Fixed incomplete ToolSnapshotEntry interface (import from canonical source)
- Added new tools detection (R9.8 requirement)
- Updated StaleToolBanner UI to display all three categories
- Added comprehensive test coverage
- Added JSDoc documentation

Aligns with:
- Decision D5: Full toolSnapshot with dslContent
- Requirement R9.1: Full state capture
- Requirement R9.8: Detect stale/deleted/new tools
- Constraint C9.3: Complete snapshot fields

Closes: [reference issue if exists]"
```

**Step 5: Update this plan**

Add completion checkmarks:

- ✅ Task 1: Fix incomplete interface
- ✅ Task 2: Add new tools detection
- ✅ Task 3: Update return types
- ✅ Task 4: Update UI
- ✅ Task 5: Wire through components
- ✅ Task 6: Add documentation
- ✅ Task 7: Integration tests
- ✅ Task 8: Final verification

---

## Testing Strategy

**Unit Tests:**

- `detectStaleTools()` function with all scenarios
- Covered: stale, deleted, new, mixed, edge cases

**Integration Tests:**

- Hook return type verification
- Multi-category detection

**Manual Testing:**

- Browser verification of banner display
- Recompile button functionality
- All three tool categories visible

**Type Safety:**

- TypeScript compilation at every step
- No `any` types
- Proper import from canonical sources

---

## Rollback Plan

If issues arise, rollback is straightforward:

```bash
# Revert all commits
git revert HEAD~8..HEAD

# Or reset to before changes
git reset --hard <commit-before-task-1>
```

No database migrations involved. Changes are pure TypeScript/React - fully reversible.

---

## Post-Implementation

**Future improvements** (not in scope):

1. View tool `dslContent` from historical snapshots (R9.2)
2. Consolidate all `ToolSnapshotEntry` definitions to single source in `packages/shared`
3. Add "Restore Tool" from snapshot feature (R9.13)
4. Add visual diff viewer for tool changes between versions

**Related work:**

- Tool version diff UI (currently shows agent DSL diff only)
- Rename detection in version diff (uses `projectToolId` matching per R9.10)

---

## Estimated Effort

- Task 1: 5 minutes
- Task 2: 20 minutes (TDD)
- Task 3: 5 minutes
- Task 4: 10 minutes
- Task 5: 5 minutes
- Task 6: 10 minutes
- Task 7: 10 minutes
- Task 8: 10 minutes

**Total: ~75 minutes** (1 hour 15 minutes)

Small, focused changes with frequent commits and verification at each step.

---

## Implementation Completed

**Completion Date:** 2026-02-25 10:31 AM

**Final Status:**

- All 8 tasks completed successfully
- Tests: 6/6 passing (5 unit + 1 integration)
- TypeScript: Clean compilation (no errors in modified files)
- Build: Successful
- Commit: `87beb40d` - "[ABLP-2] fix(studio): implement complete stale tool detection"

**Verification Summary:**

- ✅ All stale tool detection tests pass
- ✅ TypeScript compilation clean for modified files
- ✅ No regressions introduced
- ✅ Requirements R9.6-R9.8, R9.1, C9.6 fully addressed
- ✅ UI now displays all three tool categories (stale, deleted, new)

**Note:** Pre-existing test failures in `@agent-platform/database` and Studio UI tests are unrelated to this implementation and were present before these changes.
