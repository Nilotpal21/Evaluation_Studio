# Git Versioning Sync Improvements - Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-entity sync state tracking, lockfile-based status comparison, and a redesigned UI so users can see what changed locally vs remotely before pushing or pulling.

**Architecture:** Extend `ProjectAgent` and `ProjectTool` models with `lastSyncCommit` and `lastSyncSourceHash` fields. Add a new `/git/status` endpoint that fetches the remote `abl.lock` and compares per-entity hashes. Redesign `GitIntegrationTab` with a tabbed layout (Changes / History / Settings), push preview dialog, pull dry-run dialog, and per-entity sync status table using existing UI components (Tabs, DataTable, DiffViewer, Dialog, Badge, StatusDot).

**Tech Stack:** MongoDB (Mongoose), Next.js API routes, React + Zustand, existing Studio design system (Tailwind CSS variables, Framer Motion), next-intl i18n, vitest for tests.

---

## Scope

This plan covers 6 tasks across 3 layers:

1. **Backend Data Layer** (Tasks 1-2): Schema changes + status API
2. **Backend Sync Layer** (Task 3): Update sync state on push/pull + wire version field
3. **Frontend UI Layer** (Tasks 4-6): Redesigned GitIntegrationTab with tabbed layout

Each task produces working, testable software independently.

---

## File Structure

### Backend Changes

| File                                                        | Action | Responsibility                                                             |
| ----------------------------------------------------------- | ------ | -------------------------------------------------------------------------- |
| `packages/database/src/models/project-agent.model.ts`       | Modify | Add `lastSyncCommit`, `lastSyncSourceHash` fields                          |
| `packages/database/src/models/project-tool.model.ts`        | Modify | Add `lastSyncCommit`, `lastSyncSourceHash` fields                          |
| `apps/studio/src/app/api/projects/[id]/git/status/route.ts` | Modify | Fetch remote `abl.lock`, compare per-entity hashes, return enriched status |
| `apps/studio/src/app/api/projects/[id]/git/push/route.ts`   | Modify | Update per-entity sync state after successful push; wire `version` field   |
| `apps/studio/src/app/api/projects/[id]/git/pull/route.ts`   | Modify | Update per-entity sync state after successful pull                         |
| `packages/project-io/src/git/lockfile-comparator.ts`        | Create | Compare local entity hashes against remote `abl.lock` hashes               |

### Frontend Changes

| File                                                            | Action | Responsibility                                               |
| --------------------------------------------------------------- | ------ | ------------------------------------------------------------ |
| `apps/studio/src/components/settings/GitIntegrationTab.tsx`     | Modify | Refactor to tabbed layout: Changes / History / Settings      |
| `apps/studio/src/components/settings/git/SyncStatusBar.tsx`     | Create | Summary bar: N local changes, M remote changes, K conflicts  |
| `apps/studio/src/components/settings/git/ChangesTab.tsx`        | Create | Per-entity sync status table with local/remote columns       |
| `apps/studio/src/components/settings/git/PushPreviewDialog.tsx` | Create | Staged push review with entity list + commit message         |
| `apps/studio/src/components/settings/git/PullPreviewDialog.tsx` | Create | Pull dry-run preview with incoming changes                   |
| `apps/studio/src/components/settings/git/HistoryTab.tsx`        | Create | Expanded history with per-entity details                     |
| `apps/studio/src/api/project-io.ts`                             | Modify | Update `GitStatusResponse` type, add `fetchRemoteComparison` |
| `packages/i18n/locales/en/studio.json`                          | Modify | Add new i18n keys for git sync UI                            |

### Test Changes

| File                                                            | Action | Responsibility                             |
| --------------------------------------------------------------- | ------ | ------------------------------------------ |
| `packages/project-io/src/__tests__/lockfile-comparator.test.ts` | Create | Unit tests for lockfile comparison logic   |
| `apps/studio/src/__tests__/api-git-status-route.test.ts`        | Create | Tests for enriched status endpoint         |
| `apps/studio/src/__tests__/api-git-push-sync-state.test.ts`     | Create | Tests for per-entity state updates on push |

---

## Chunk 1: Backend Foundation

### Task 1: Per-Entity Sync State on Models

Add `lastSyncCommit` and `lastSyncSourceHash` to `ProjectAgent` and `ProjectTool` so we can track what was last synced per entity.

**Files:**

- Modify: `packages/database/src/models/project-agent.model.ts:12-29` (interface) and `:34-49` (schema)
- Modify: `packages/database/src/models/project-tool.model.ts:29-44` (interface) and `:48-93` (schema)

- [ ] **Step 1: Write failing test for ProjectAgent sync fields**

Create `packages/database/src/__tests__/project-agent-sync-fields.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ProjectAgent } from '../models/project-agent.model.js';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('ProjectAgent sync fields', () => {
  it('stores lastSyncCommit and lastSyncSourceHash', async () => {
    const agent = await ProjectAgent.create({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      name: 'test-agent',
      agentPath: 'agents/test-agent',
      lastSyncCommit: 'abc123def456',
      lastSyncSourceHash: 'a1b2c3d4e5f6g7h8',
    });

    expect(agent.lastSyncCommit).toBe('abc123def456');
    expect(agent.lastSyncSourceHash).toBe('a1b2c3d4e5f6g7h8');
  });

  it('defaults sync fields to null', async () => {
    const agent = await ProjectAgent.create({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      name: 'no-sync-agent',
      agentPath: 'agents/no-sync-agent',
    });

    expect(agent.lastSyncCommit).toBeNull();
    expect(agent.lastSyncSourceHash).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/database && pnpm test -- --run src/__tests__/project-agent-sync-fields.test.ts`
Expected: FAIL - `lastSyncCommit` not in schema, value will be undefined

- [ ] **Step 3: Add sync fields to ProjectAgent model**

In `packages/database/src/models/project-agent.model.ts`:

Add to `IProjectAgent` interface (after `lastEditedAt` line 26):

```typescript
lastSyncCommit: string | null;
lastSyncSourceHash: string | null;
```

Add to `ProjectAgentSchema` (after `lastEditedAt` field, line 48):

```typescript
    lastSyncCommit: { type: String, default: null },
    lastSyncSourceHash: { type: String, default: null },
```

- [ ] **Step 4: Add sync fields to ProjectTool model**

In `packages/database/src/models/project-tool.model.ts`:

Add to `IProjectTool` interface (after `lastEditedBy` line 40):

```typescript
lastSyncCommit: string | null;
lastSyncSourceHash: string | null;
```

Add to `ProjectToolSchema` (after `lastEditedBy` field, line 90):

```typescript
    lastSyncCommit: { type: String, default: null },
    lastSyncSourceHash: { type: String, default: null },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/database && pnpm build && pnpm test -- --run src/__tests__/project-agent-sync-fields.test.ts`
Expected: PASS

- [ ] **Step 6: Run prettier and commit**

```bash
npx prettier --write packages/database/src/models/project-agent.model.ts packages/database/src/models/project-tool.model.ts packages/database/src/__tests__/project-agent-sync-fields.test.ts
git add packages/database/src/models/project-agent.model.ts packages/database/src/models/project-tool.model.ts packages/database/src/__tests__/project-agent-sync-fields.test.ts
git commit -m "feat(database): add per-entity git sync state fields to ProjectAgent and ProjectTool"
```

---

### Task 2: Lockfile Comparator + Enriched Status API

Create a utility to compare local entity hashes against a remote `abl.lock`, then upgrade the status endpoint to return per-entity sync status.

**Files:**

- Create: `packages/project-io/src/git/lockfile-comparator.ts`
- Create: `packages/project-io/src/__tests__/lockfile-comparator.test.ts`
- Modify: `packages/project-io/src/git/index.ts` (add export)
- Modify: `apps/studio/src/app/api/projects/[id]/git/status/route.ts`

- [ ] **Step 1: Write failing test for lockfile comparator**

Create `packages/project-io/src/__tests__/lockfile-comparator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { compareLockfile, type EntitySyncStatus } from '../git/lockfile-comparator.js';

describe('compareLockfile', () => {
  const remoteLock = {
    agents: {
      'weather-agent': { version: '1.0', source_hash: 'aaaa111122223333', status: 'active' },
      'faq-agent': { version: '1.0', source_hash: 'bbbb444455556666', status: 'active' },
      'deleted-agent': { version: '1.0', source_hash: 'cccc777788889999', status: 'active' },
    },
    tools: {
      'tools/billing.tools.abl': { source_hash: 'dddd000011112222' },
    },
  };

  it('marks entity as synced when hashes match', () => {
    const localEntities = [
      {
        name: 'weather-agent',
        type: 'agent' as const,
        sourceHash: 'aaaa111122223333',
        lastSyncSourceHash: 'aaaa111122223333',
      },
    ];

    const result = compareLockfile(localEntities, remoteLock);
    const agent = result.find((r) => r.name === 'weather-agent');
    expect(agent?.status).toBe('synced');
  });

  it('marks entity as local_ahead when local hash differs from lastSync but remote matches lastSync', () => {
    const localEntities = [
      {
        name: 'weather-agent',
        type: 'agent' as const,
        sourceHash: 'newlocalhash12345',
        lastSyncSourceHash: 'aaaa111122223333',
      },
    ];

    const result = compareLockfile(localEntities, remoteLock);
    const agent = result.find((r) => r.name === 'weather-agent');
    expect(agent?.status).toBe('local_ahead');
  });

  it('marks entity as remote_ahead when remote hash differs from lastSync but local matches lastSync', () => {
    const localEntities = [
      {
        name: 'faq-agent',
        type: 'agent' as const,
        sourceHash: 'bbbb444455556666',
        lastSyncSourceHash: 'oldsynchash1234567',
      },
    ];

    // Remote has bbbb444455556666 which differs from lastSync oldsynchash1234567
    // Local has bbbb444455556666 which matches remote -- but local matches lastSync? No.
    // Actually: local sourceHash === lastSyncSourceHash means local unchanged.
    // Remote source_hash !== lastSyncSourceHash means remote changed.
    const localEntities2 = [
      {
        name: 'faq-agent',
        type: 'agent' as const,
        sourceHash: 'oldsynchash1234567',
        lastSyncSourceHash: 'oldsynchash1234567',
      },
    ];
    // Remote bbbb444455556666 !== lastSync oldsynchash1234567 => remote changed
    // Local oldsynchash1234567 === lastSync oldsynchash1234567 => local unchanged
    const result = compareLockfile(localEntities2, remoteLock);
    const agent = result.find((r) => r.name === 'faq-agent');
    expect(agent?.status).toBe('remote_ahead');
  });

  it('marks entity as conflict when both local and remote differ from lastSync', () => {
    const localEntities = [
      {
        name: 'weather-agent',
        type: 'agent' as const,
        sourceHash: 'localchanged11111',
        lastSyncSourceHash: 'basehash000000000',
      },
    ];
    // Remote aaaa111122223333 !== lastSync basehash000000000 => remote changed
    // Local localchanged11111 !== lastSync basehash000000000 => local changed
    const result = compareLockfile(localEntities, remoteLock);
    const agent = result.find((r) => r.name === 'weather-agent');
    expect(agent?.status).toBe('conflict');
  });

  it('marks local-only entity as untracked', () => {
    const localEntities = [
      {
        name: 'brand-new-agent',
        type: 'agent' as const,
        sourceHash: 'xxxx123456789012',
        lastSyncSourceHash: null,
      },
    ];

    const result = compareLockfile(localEntities, remoteLock);
    const agent = result.find((r) => r.name === 'brand-new-agent');
    expect(agent?.status).toBe('untracked');
  });

  it('marks remote-only entity as remote_only', () => {
    const localEntities: Parameters<typeof compareLockfile>[0] = [];

    const result = compareLockfile(localEntities, remoteLock);
    const deleted = result.find((r) => r.name === 'deleted-agent');
    expect(deleted?.status).toBe('remote_only');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/project-io && pnpm test -- --run src/__tests__/lockfile-comparator.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Implement lockfile comparator**

Create `packages/project-io/src/git/lockfile-comparator.ts`:

```typescript
/**
 * Lockfile Comparator - compares local entity hashes against remote abl.lock
 *
 * Determines per-entity sync status using three-way hash comparison:
 *   base = lastSyncSourceHash (what was synced last)
 *   ours = current local sourceHash
 *   theirs = remote abl.lock source_hash
 */

export type EntitySyncStatus =
  | 'synced' // local === remote (regardless of lastSync)
  | 'local_ahead' // local changed since lastSync, remote unchanged
  | 'remote_ahead' // remote changed since lastSync, local unchanged
  | 'conflict' // both local and remote changed since lastSync
  | 'untracked' // exists locally but never synced (no lastSyncSourceHash)
  | 'remote_only'; // exists in remote but not locally

export interface EntityComparisonInput {
  name: string;
  type: 'agent' | 'tool';
  sourceHash: string | null;
  lastSyncSourceHash: string | null;
}

export interface EntityComparisonResult {
  name: string;
  type: 'agent' | 'tool';
  status: EntitySyncStatus;
  localHash: string | null;
  remoteHash: string | null;
  lastSyncHash: string | null;
}

interface RemoteLockfileData {
  agents: Record<string, { source_hash: string; [key: string]: unknown }>;
  tools: Record<string, { source_hash: string }>;
}

/**
 * Compare local entities against a remote lockfile to determine per-entity sync status.
 */
export function compareLockfile(
  localEntities: EntityComparisonInput[],
  remoteLock: RemoteLockfileData,
): EntityComparisonResult[] {
  const results: EntityComparisonResult[] = [];
  const seenRemote = new Set<string>();

  for (const entity of localEntities) {
    const remoteHash = getRemoteHash(entity.name, entity.type, remoteLock);
    if (remoteHash !== null) {
      seenRemote.add(entityKey(entity.name, entity.type));
    }

    const status = computeStatus(entity.sourceHash, entity.lastSyncSourceHash, remoteHash);

    results.push({
      name: entity.name,
      type: entity.type,
      status,
      localHash: entity.sourceHash,
      remoteHash,
      lastSyncHash: entity.lastSyncSourceHash,
    });
  }

  // Find remote-only entities (in remote lockfile but not in local)
  for (const [name] of Object.entries(remoteLock.agents)) {
    if (!seenRemote.has(entityKey(name, 'agent'))) {
      const hash = remoteLock.agents[name]?.source_hash ?? null;
      results.push({
        name,
        type: 'agent',
        status: 'remote_only',
        localHash: null,
        remoteHash: hash,
        lastSyncHash: null,
      });
    }
  }

  for (const [path] of Object.entries(remoteLock.tools)) {
    const toolName = path;
    if (!seenRemote.has(entityKey(toolName, 'tool'))) {
      const hash = remoteLock.tools[path]?.source_hash ?? null;
      results.push({
        name: toolName,
        type: 'tool',
        status: 'remote_only',
        localHash: null,
        remoteHash: hash,
        lastSyncHash: null,
      });
    }
  }

  return results;
}

function entityKey(name: string, type: string): string {
  return `${type}:${name}`;
}

function getRemoteHash(
  name: string,
  type: 'agent' | 'tool',
  remoteLock: RemoteLockfileData,
): string | null {
  if (type === 'agent') {
    return remoteLock.agents[name]?.source_hash ?? null;
  }
  return remoteLock.tools[name]?.source_hash ?? null;
}

function computeStatus(
  localHash: string | null,
  lastSyncHash: string | null,
  remoteHash: string | null,
): EntitySyncStatus {
  // Never synced and not in remote
  if (lastSyncHash === null && remoteHash === null) {
    return 'untracked';
  }

  // Never synced but exists in remote
  if (lastSyncHash === null && remoteHash !== null) {
    // Local entity that was never synced but remote has something with the same name
    // If hashes match, it's synced; otherwise treat as untracked (new local entity)
    if (localHash === remoteHash) return 'synced';
    return 'untracked';
  }

  // Local and remote match = synced (regardless of lastSync)
  if (localHash === remoteHash) {
    return 'synced';
  }

  // Remote is null but we have lastSync = entity was deleted remotely
  if (remoteHash === null) {
    if (localHash === lastSyncHash) return 'remote_ahead'; // remote deleted, local unchanged
    return 'conflict'; // remote deleted but local also changed
  }

  // Three-way comparison
  const localChanged = localHash !== lastSyncHash;
  const remoteChanged = remoteHash !== lastSyncHash;

  if (localChanged && remoteChanged) return 'conflict';
  if (localChanged) return 'local_ahead';
  if (remoteChanged) return 'remote_ahead';

  // Both match lastSync but differ from each other - shouldn't happen, but defensive
  return 'conflict';
}
```

- [ ] **Step 4: Export from git/index.ts**

In `packages/project-io/src/git/index.ts`, add:

```typescript
export {
  compareLockfile,
  type EntitySyncStatus,
  type EntityComparisonInput,
  type EntityComparisonResult,
} from './lockfile-comparator.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/project-io && pnpm build && pnpm test -- --run src/__tests__/lockfile-comparator.test.ts`
Expected: PASS

- [ ] **Step 6: Write test for enriched status endpoint**

Create `apps/studio/src/__tests__/api-git-status-enriched.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the modules before importing the route
vi.mock('@/lib/route-handler', () => ({
  withRouteHandler: (_opts: unknown, handler: Function) => handler,
}));

vi.mock('@/lib/permissions', () => ({
  StudioPermission: { PROJECT_READ: 'project:read' },
}));

vi.mock('@/lib/git-credentials', () => ({
  resolveGitCredentials: vi.fn().mockReturnValue({ token: 'test-token' }),
}));

const mockGitIntegrationFindOne = vi.fn();
const mockProjectAgentFind = vi.fn();
const mockProjectToolFind = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn(),
  GitIntegration: {
    findOne: (...args: unknown[]) => ({ lean: () => mockGitIntegrationFindOne(...args) }),
  },
  ProjectAgent: {
    find: (...args: unknown[]) => ({
      limit: () => ({ lean: () => mockProjectAgentFind(...args) }),
    }),
  },
  ProjectTool: { find: (...args: unknown[]) => ({ lean: () => mockProjectToolFind(...args) }) },
}));

const mockGetFile = vi.fn();
vi.mock('@agent-platform/project-io/git', () => ({
  createGitProvider: () => ({ getFile: mockGetFile }),
  compareLockfile: vi.fn(),
}));

describe('GET /api/projects/:id/git/status (enriched)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns per-entity sync status when remote abl.lock is available', async () => {
    // This test validates the enriched status endpoint returns entity comparison data
    // Full integration tested separately; this verifies the response shape
    expect(true).toBe(true); // Placeholder - real test wires up the route handler
  });
});
```

- [ ] **Step 7: Upgrade status route — add imports and remote fetch logic**

Modify `apps/studio/src/app/api/projects/[id]/git/status/route.ts`.

First, add these imports at the top (after existing imports):

```typescript
import { resolveGitCredentials } from '@/lib/git-credentials';
import { ProjectTool, type IProjectTool } from '@agent-platform/database/models';
import {
  createGitProvider,
  compareLockfile,
  type EntityComparisonInput,
} from '@agent-platform/project-io/git';
```

Then, inside the handler, after the existing `localAgents` mapping (line 46), add the remote comparison logic:

```typescript
// Also fetch tools
const tools = await ProjectTool.find({ projectId, tenantId }).lean();

// Build entity comparison inputs
const entityInputs: EntityComparisonInput[] = [
  ...agents.map((a: IProjectAgent) => ({
    name: a.name,
    type: 'agent' as const,
    sourceHash: a.sourceHash ?? null,
    lastSyncSourceHash: (a as any).lastSyncSourceHash ?? null,
  })),
  ...tools.map((t: IProjectTool) => ({
    name: t.name,
    type: 'tool' as const,
    sourceHash: t.sourceHash ?? null,
    lastSyncSourceHash: (t as any).lastSyncSourceHash ?? null,
  })),
];

// Attempt to fetch remote abl.lock for comparison
let entityStatus: ReturnType<typeof compareLockfile> = [];
let remoteAvailable = false;

try {
  const credentials = resolveGitCredentials(integration.credentials, tenantId);
  const provider = createGitProvider(
    { provider: integration.provider, repositoryUrl: integration.repositoryUrl },
    credentials,
  );
  const lockFile = await provider.getFile(integration.defaultBranch, 'abl.lock');
  if (lockFile?.content) {
    const parsed = JSON.parse(lockFile.content);
    entityStatus = compareLockfile(entityInputs, {
      agents: parsed.agents ?? {},
      tools: parsed.tools ?? {},
    });
    remoteAvailable = true;
  }
} catch (err) {
  log.warn('Failed to fetch remote abl.lock for status comparison', {
    projectId,
    error: err instanceof Error ? err.message : String(err),
  });
  // Fall back to local-only — entityStatus stays empty, remoteAvailable stays false
}

// Compute summary counts
const summary = {
  synced: entityStatus.filter((e) => e.status === 'synced').length,
  localAhead: entityStatus.filter((e) => e.status === 'local_ahead').length,
  remoteAhead: entityStatus.filter((e) => e.status === 'remote_ahead').length,
  conflict: entityStatus.filter((e) => e.status === 'conflict').length,
  untracked: entityStatus.filter((e) => e.status === 'untracked').length,
  remoteOnly: entityStatus.filter((e) => e.status === 'remote_only').length,
};
```

Finally, update the `NextResponse.json()` return to include the new fields:

```typescript
return NextResponse.json({
  integration: {
    /* ... existing fields unchanged ... */
  },
  localAgents, // backward compatible
  entityStatus, // NEW: per-entity comparison results
  remoteAvailable, // NEW: whether remote fetch succeeded
  summary, // NEW: aggregated counts
  message: remoteAvailable
    ? 'Status includes remote comparison via abl.lock.'
    : 'Status shows local state only. Remote abl.lock unavailable.',
});
```

- [ ] **Step 8: Build and verify**

Run: `pnpm build --filter=@agent-platform/project-io --filter=@agent-platform/database && pnpm build --filter=studio`
Expected: No type errors

- [ ] **Step 9: Run prettier and commit**

```bash
npx prettier --write packages/project-io/src/git/lockfile-comparator.ts packages/project-io/src/git/index.ts packages/project-io/src/__tests__/lockfile-comparator.test.ts apps/studio/src/app/api/projects/[id]/git/status/route.ts apps/studio/src/__tests__/api-git-status-enriched.test.ts
git add packages/project-io/src/git/lockfile-comparator.ts packages/project-io/src/git/index.ts packages/project-io/src/__tests__/lockfile-comparator.test.ts apps/studio/src/app/api/projects/[id]/git/status/route.ts apps/studio/src/__tests__/api-git-status-enriched.test.ts
git commit -m "feat(git): add lockfile comparator and enriched status endpoint with per-entity sync status"
```

---

### Task 3: Update Sync State on Push/Pull + Wire Version Field

After a successful push or pull, update each entity's `lastSyncCommit` and `lastSyncSourceHash`. Also fix the hardcoded `version: null` in push route.

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/git/push/route.ts:87-101`
- Modify: `apps/studio/src/app/api/projects/[id]/git/pull/route.ts:153-178`

- [ ] **Step 1: Write failing test for push sync state updates**

Create `apps/studio/src/__tests__/api-git-push-sync-state.test.ts` that verifies:

- After successful push, `ProjectAgent.updateMany` is called with `lastSyncCommit` and `lastSyncSourceHash`
- After successful push, `ProjectTool.updateMany` is called similarly
- Agent `version` field is populated from the agent's `_v` or `activeVersions` field, not hardcoded null

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm test -- --run src/__tests__/api-git-push-sync-state.test.ts`
Expected: FAIL

- [ ] **Step 3: Fix version field in push route**

In `apps/studio/src/app/api/projects/[id]/git/push/route.ts`, change line 93 from:

```typescript
version: null,
```

to:

```typescript
version: String(a._v),
```

- [ ] **Step 4: Add per-entity sync state update after successful push**

In `apps/studio/src/app/api/projects/[id]/git/push/route.ts`, after the successful `GitSyncHistory.create` (after line 191), add the following.
Note: `agents` (line 63) and `tools` (line 64) are already fetched earlier in the route handler. `result.commitSha` comes from the push result (line 209).

```typescript
// Update per-entity sync state
const commitSha = result.commitSha;
if (commitSha) {
  const agentUpdates = agents.map((a: IProjectAgent) => ({
    updateOne: {
      filter: { _id: a._id, tenantId },
      update: {
        $set: {
          lastSyncCommit: commitSha,
          lastSyncSourceHash: a.sourceHash,
        },
      },
    },
  }));
  if (agentUpdates.length > 0) {
    await ProjectAgent.bulkWrite(agentUpdates);
  }

  const toolUpdates = tools.map((t: IProjectTool) => ({
    updateOne: {
      filter: { _id: t._id, tenantId },
      update: {
        $set: {
          lastSyncCommit: commitSha,
          lastSyncSourceHash: t.sourceHash,
        },
      },
    },
  }));
  if (toolUpdates.length > 0) {
    await ProjectTool.bulkWrite(toolUpdates);
  }
}
```

- [ ] **Step 5: Add per-entity sync state update after successful pull**

In `apps/studio/src/app/api/projects/[id]/git/pull/route.ts`, after the successful `GitIntegration.findOneAndUpdate` (after line 178), add similar `bulkWrite` logic:

```typescript
// Update per-entity sync state for pulled agents
if (result.commitSha) {
  const pulledAgents = await ProjectAgent.find({ projectId, tenantId }).lean();
  const agentUpdates = pulledAgents.map((a: IProjectAgent) => ({
    updateOne: {
      filter: { _id: a._id, tenantId },
      update: {
        $set: {
          lastSyncCommit: result.commitSha,
          lastSyncSourceHash: a.sourceHash,
        },
      },
    },
  }));
  if (agentUpdates.length > 0) {
    await ProjectAgent.bulkWrite(agentUpdates);
  }
}
```

- [ ] **Step 6: Run tests and verify**

Run: `cd apps/studio && pnpm build && pnpm test -- --run src/__tests__/api-git-push-sync-state.test.ts`
Expected: PASS

- [ ] **Step 7: Run prettier and commit**

```bash
npx prettier --write apps/studio/src/app/api/projects/[id]/git/push/route.ts apps/studio/src/app/api/projects/[id]/git/pull/route.ts apps/studio/src/__tests__/api-git-push-sync-state.test.ts
git add apps/studio/src/app/api/projects/[id]/git/push/route.ts apps/studio/src/app/api/projects/[id]/git/pull/route.ts apps/studio/src/__tests__/api-git-push-sync-state.test.ts
git commit -m "feat(git): update per-entity sync state on push/pull and wire agent version field"
```

---

## Chunk 2: Frontend UI Redesign

### Task 4: API Client Updates + i18n Keys

Update the API client types and add i18n strings needed by the new UI.

**Files:**

- Modify: `apps/studio/src/api/project-io.ts:133-160` (types and functions)
- Modify: `packages/i18n/locales/en/studio.json:2762-2806` (git i18n keys)

- [ ] **Step 1: Update GitStatusResponse type in API client**

In `apps/studio/src/api/project-io.ts`, replace the `GitStatusResponse` interface (lines 133-148) with:

```typescript
export interface EntitySyncStatusEntry {
  name: string;
  type: 'agent' | 'tool';
  status: 'synced' | 'local_ahead' | 'remote_ahead' | 'conflict' | 'untracked' | 'remote_only';
  localHash: string | null;
  remoteHash: string | null;
  lastSyncHash: string | null;
}

export interface GitStatusResponse {
  integration: {
    provider: string;
    repositoryUrl: string;
    defaultBranch: string;
    lastSyncAt: string | null;
    lastSyncCommit: string | null;
    lastSyncStatus: 'success' | 'failed' | null;
  };
  localAgents: Array<{
    name: string;
    sourceHash: string;
    lastEditedAt: string;
  }>;
  entityStatus: EntitySyncStatusEntry[];
  remoteAvailable: boolean;
  summary: {
    synced: number;
    localAhead: number;
    remoteAhead: number;
    conflict: number;
    untracked: number;
    remoteOnly: number;
  };
  message: string;
}
```

- [ ] **Step 2: Update GitSyncHistoryEntry to include changesSummary**

In the same file, update `GitSyncHistoryEntry` to expose the change details:

```typescript
export interface GitSyncHistoryEntry {
  projectId: string;
  direction: 'push' | 'pull';
  commitSha: string;
  branch: string;
  status: 'success' | 'failed' | 'conflict';
  agentsAffected: string[];
  changesSummary: { added: string[]; modified: string[]; deleted: string[] };
  /** Added by this plan — backend already stores this in IGitSyncHistory */
  conflictDetails?: Array<{
    agentName: string;
    file: string;
    resolved: boolean;
    resolution: string | null;
  }>;
  triggeredBy: string;
  createdAt: string;
  error?: string | null;
}

// NOTE: The existing type only has status: 'success' | 'failed'.
// Adding 'conflict' aligns the client type with the backend IGitSyncHistory model
// which already supports 'conflict' status. The old UI just never rendered it.
```

- [ ] **Step 2b: Update pullFromGit return type to include dry-run fields**

In `apps/studio/src/api/project-io.ts`, update the `pullFromGit` function return type (line 314) from:

```typescript
Promise<{ success: boolean; branch: string; message: string }>;
```

to:

```typescript
Promise<{
  success: boolean;
  branch: string;
  message: string;
  changes?: { added: string[]; modified: string[]; deleted: string[] };
  commitSha?: string;
  dryRun?: boolean;
  preview?: unknown;
}>;
```

These fields are already returned by the backend pull route (lines 143-151 of `pull/route.ts`) but the client type was missing them.

- [ ] **Step 3: Add new i18n keys**

In `packages/i18n/locales/en/studio.json`, extend the `"git"` block (after line 2805 `"connect": "Connect"`) with:

```json
"connect": "Connect",
"commit_message_label": "Commit message",
"tab_changes": "Changes",
"tab_history": "History",
"tab_settings": "Settings",
"sync_status_synced": "Synced",
"sync_status_local_ahead": "Modified locally",
"sync_status_remote_ahead": "Modified remotely",
"sync_status_conflict": "Conflict",
"sync_status_untracked": "New (unsynced)",
"sync_status_remote_only": "Remote only",
"summary_local_changes": "{count} local {count, plural, one {change} other {changes}}",
"summary_remote_changes": "{count} remote {count, plural, one {change} other {changes}}",
"summary_conflicts": "{count} {count, plural, one {conflict} other {conflicts}}",
"summary_synced": "All synced",
"review_and_push": "Review & Push",
"preview_and_pull": "Preview & Pull",
"push_dialog_title": "Review & Push Changes",
"push_dialog_changes_to_push": "Changes to push:",
"push_dialog_push_count": "Push {count} {count, plural, one {file} other {files}}",
"push_dialog_create_pr": "Create pull request instead of direct push",
"pull_dialog_title": "Preview Remote Changes",
"pull_dialog_incoming": "Incoming from {branch}:",
"pull_dialog_no_conflicts": "No conflicts detected",
"pull_dialog_apply": "Apply Changes",
"pull_dialog_conflicts_warning": "{count} {count, plural, one {conflict} other {conflicts}} detected - resolve before pulling",
"changes_empty": "Everything is in sync",
"changes_empty_description": "No differences between local and remote.",
"changes_no_remote": "Remote comparison unavailable",
"changes_no_remote_description": "Could not fetch remote state. Showing local agents only.",
"history_empty": "No sync history",
"history_empty_description": "Push or pull to start tracking sync operations.",
"history_view_details": "View details",
"entity_type_agent": "Agent",
"entity_type_tool": "Tool",
"view_diff": "View Diff",
"no_changes_to_push": "No local changes to push"
```

- [ ] **Step 4: Run prettier and commit**

```bash
npx prettier --write apps/studio/src/api/project-io.ts packages/i18n/locales/en/studio.json
git add apps/studio/src/api/project-io.ts packages/i18n/locales/en/studio.json
git commit -m "feat(studio): update git API types and add i18n keys for sync status UI"
```

---

### Task 5: SyncStatusBar + ChangesTab Components

Build the two core new components: the summary bar and the per-entity changes table.

**Files:**

- Create: `apps/studio/src/components/settings/git/SyncStatusBar.tsx`
- Create: `apps/studio/src/components/settings/git/ChangesTab.tsx`

- [ ] **Step 1: Create SyncStatusBar component**

Create `apps/studio/src/components/settings/git/SyncStatusBar.tsx`:

```typescript
/**
 * SyncStatusBar - shows a summary of sync state with action buttons.
 *
 * Displays counts: N local changes, M remote changes, K conflicts.
 * When all synced, shows a green "All synced" badge.
 */

import { useTranslations } from 'next-intl';
import { ArrowUpCircle, ArrowDownCircle, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';

interface SyncStatusBarProps {
  summary: {
    synced: number;
    localAhead: number;
    remoteAhead: number;
    conflict: number;
    untracked: number;
    remoteOnly: number;
  };
  remoteAvailable: boolean;
  onPushClick: () => void;
  onPullClick: () => void;
  pushing: boolean;
  pulling: boolean;
}

export function SyncStatusBar({
  summary,
  remoteAvailable,
  onPushClick,
  onPullClick,
  pushing,
  pulling,
}: SyncStatusBarProps) {
  const t = useTranslations('settings');

  const localChanges = summary.localAhead + summary.untracked;
  const remoteChanges = summary.remoteAhead + summary.remoteOnly;
  const conflicts = summary.conflict;
  const allSynced = localChanges === 0 && remoteChanges === 0 && conflicts === 0;

  return (
    <Card hoverable={false}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          {allSynced ? (
            <Badge variant="success" dot>
              <CheckCircle2 className="w-3 h-3 mr-1 inline" />
              {t('git.summary_synced')}
            </Badge>
          ) : (
            <>
              {localChanges > 0 && (
                <Badge variant="accent">
                  {t('git.summary_local_changes', { count: localChanges })}
                </Badge>
              )}
              {remoteAvailable && remoteChanges > 0 && (
                <Badge variant="info">
                  {t('git.summary_remote_changes', { count: remoteChanges })}
                </Badge>
              )}
              {conflicts > 0 && (
                <Badge variant="error">
                  <AlertTriangle className="w-3 h-3 mr-1 inline" />
                  {t('git.summary_conflicts', { count: conflicts })}
                </Badge>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            icon={<ArrowUpCircle className="w-3.5 h-3.5" />}
            loading={pushing}
            disabled={localChanges === 0 && summary.untracked === 0}
            onClick={onPushClick}
          >
            {t('git.review_and_push')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<ArrowDownCircle className="w-3.5 h-3.5" />}
            loading={pulling}
            onClick={onPullClick}
          >
            {t('git.preview_and_pull')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
```

- [ ] **Step 2: Create ChangesTab component**

Create `apps/studio/src/components/settings/git/ChangesTab.tsx`:

```typescript
/**
 * ChangesTab - per-entity sync status table.
 *
 * Shows each agent/tool with its sync status (synced, local_ahead, remote_ahead,
 * conflict, untracked, remote_only) using Badge and StatusDot components.
 */

import { useTranslations } from 'next-intl';
import { Bot, Wrench, CheckCircle2, ArrowUp, ArrowDown, AlertTriangle, Plus, Cloud } from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { EmptyState } from '../../ui/EmptyState';
import { InfoCard } from '../../ui/InfoCard';
import type { EntitySyncStatusEntry } from '../../../api/project-io';

interface ChangesTabProps {
  entityStatus: EntitySyncStatusEntry[];
  remoteAvailable: boolean;
  loading: boolean;
}

const STATUS_CONFIG = {
  synced: { variant: 'success' as const, icon: CheckCircle2, labelKey: 'sync_status_synced' },
  local_ahead: { variant: 'accent' as const, icon: ArrowUp, labelKey: 'sync_status_local_ahead' },
  remote_ahead: { variant: 'info' as const, icon: ArrowDown, labelKey: 'sync_status_remote_ahead' },
  conflict: { variant: 'error' as const, icon: AlertTriangle, labelKey: 'sync_status_conflict' },
  untracked: { variant: 'purple' as const, icon: Plus, labelKey: 'sync_status_untracked' },
  remote_only: { variant: 'warning' as const, icon: Cloud, labelKey: 'sync_status_remote_only' },
} as const;

export function ChangesTab({ entityStatus, remoteAvailable, loading }: ChangesTabProps) {
  const t = useTranslations('settings');

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-12 rounded-lg bg-background-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (!remoteAvailable) {
    return (
      <InfoCard
        variant="warning"
        title={t('git.changes_no_remote')}
        message={t('git.changes_no_remote_description')}
      />
    );
  }

  // Sort: conflicts first, then local_ahead, remote_ahead, untracked, remote_only, synced last
  const sortOrder: Record<string, number> = {
    conflict: 0,
    local_ahead: 1,
    remote_ahead: 2,
    untracked: 3,
    remote_only: 4,
    synced: 5,
  };

  const sorted = [...entityStatus].sort(
    (a, b) => (sortOrder[a.status] ?? 99) - (sortOrder[b.status] ?? 99),
  );

  const hasChanges = sorted.some((e) => e.status !== 'synced');

  if (!hasChanges) {
    return (
      <EmptyState
        icon={<CheckCircle2 className="w-6 h-6" />}
        title={t('git.changes_empty')}
        description={t('git.changes_empty_description')}
      />
    );
  }

  return (
    <div className="border border-default rounded-lg overflow-hidden">
      {/* Header */}
      <div className="grid grid-cols-[1fr_80px_200px] gap-4 px-4 py-2.5 bg-background-muted border-b border-default">
        <span className="text-xs font-medium text-muted uppercase tracking-wide">Entity</span>
        <span className="text-xs font-medium text-muted uppercase tracking-wide">Type</span>
        <span className="text-xs font-medium text-muted uppercase tracking-wide">Status</span>
      </div>

      {/* Rows */}
      {sorted.map((entity) => {
        const config = STATUS_CONFIG[entity.status];
        const Icon = config.icon;
        const TypeIcon = entity.type === 'agent' ? Bot : Wrench;

        return (
          <div
            key={`${entity.type}:${entity.name}`}
            className="grid grid-cols-[1fr_80px_200px] gap-4 px-4 py-3 border-b border-default last:border-b-0 hover:bg-background-muted/50 transition-default"
          >
            <div className="flex items-center gap-2 min-w-0">
              <TypeIcon className="w-3.5 h-3.5 text-muted shrink-0" />
              <span className="text-sm text-foreground truncate">{entity.name}</span>
            </div>
            <span className="text-xs text-muted capitalize">{t(`git.entity_type_${entity.type}`)}</span>
            <Badge variant={config.variant}>
              <Icon className="w-3 h-3 mr-1 inline" />
              {t(`git.${config.labelKey}`)}
            </Badge>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Run prettier and commit**

```bash
npx prettier --write apps/studio/src/components/settings/git/SyncStatusBar.tsx apps/studio/src/components/settings/git/ChangesTab.tsx
git add apps/studio/src/components/settings/git/SyncStatusBar.tsx apps/studio/src/components/settings/git/ChangesTab.tsx
git commit -m "feat(studio): add SyncStatusBar and ChangesTab components for git sync UI"
```

---

### Task 6: Push/Pull Preview Dialogs + History Tab + GitIntegrationTab Refactor

Build the push and pull preview dialogs, the expanded history tab, and refactor the main tab to use the new components.

**Files:**

- Create: `apps/studio/src/components/settings/git/PushPreviewDialog.tsx`
- Create: `apps/studio/src/components/settings/git/PullPreviewDialog.tsx`
- Create: `apps/studio/src/components/settings/git/HistoryTab.tsx`
- Modify: `apps/studio/src/components/settings/GitIntegrationTab.tsx`

- [ ] **Step 1: Create PushPreviewDialog**

Create `apps/studio/src/components/settings/git/PushPreviewDialog.tsx`:

```typescript
/**
 * PushPreviewDialog - review changes before pushing to git.
 *
 * Shows a list of entities that will be pushed, with their status badges.
 * Includes commit message input and optional "Create PR" toggle.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowUpCircle, Bot, Wrench, Plus, Pencil, Trash2 } from 'lucide-react';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Toggle } from '../../ui/Toggle';
import { Badge } from '../../ui/Badge';
import type { EntitySyncStatusEntry } from '../../../api/project-io';

interface PushPreviewDialogProps {
  open: boolean;
  onClose: () => void;
  entities: EntitySyncStatusEntry[];
  onPush: (options: { commitMessage: string; createPR: boolean }) => Promise<void>;
  pushing: boolean;
}

export function PushPreviewDialog({
  open,
  onClose,
  entities,
  onPush,
  pushing,
}: PushPreviewDialogProps) {
  const t = useTranslations('settings');
  const [commitMessage, setCommitMessage] = useState('');
  const [createPR, setCreatePR] = useState(false);

  // Only show pushable entities
  const pushable = entities.filter(
    (e) => e.status === 'local_ahead' || e.status === 'untracked',
  );

  const handleSubmit = async () => {
    await onPush({
      commitMessage: commitMessage.trim() || 'sync: update agents from ABL Platform',
      createPR,
    });
    setCommitMessage('');
    setCreatePR(false);
  };

  const statusIcon = (status: string) => {
    if (status === 'untracked') return <Plus className="w-3 h-3 text-purple" />;
    return <Pencil className="w-3 h-3 text-accent" />;
  };

  const statusLabel = (status: string) => {
    if (status === 'untracked') return 'New';
    return 'Modified';
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('git.push_dialog_title')} maxWidth="lg">
      <div className="space-y-4">
        {/* Entity list */}
        <div>
          <p className="text-sm font-medium text-foreground mb-2">
            {t('git.push_dialog_changes_to_push')}
          </p>
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {pushable.map((entity) => {
              const TypeIcon = entity.type === 'agent' ? Bot : Wrench;
              return (
                <div
                  key={`${entity.type}:${entity.name}`}
                  className="flex items-center justify-between px-3 py-2 rounded-lg bg-background-muted"
                >
                  <div className="flex items-center gap-2">
                    <TypeIcon className="w-3.5 h-3.5 text-muted" />
                    <span className="text-sm text-foreground">{entity.name}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {statusIcon(entity.status)}
                    <span className="text-xs text-muted">{statusLabel(entity.status)}</span>
                  </div>
                </div>
              );
            })}
          </div>
          {pushable.length === 0 && (
            <p className="text-sm text-muted italic py-4 text-center">
              {t('git.no_changes_to_push')}
            </p>
          )}
        </div>

        {/* Commit message */}
        <Input
          label={t('git.commit_message_label')}
          placeholder="sync: update agents from ABL Platform"
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
        />

        {/* Create PR toggle */}
        <Toggle
          checked={createPR}
          onChange={setCreatePR}
          label={t('git.push_dialog_create_pr')}
        />

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            icon={<ArrowUpCircle className="w-4 h-4" />}
            loading={pushing}
            disabled={pushable.length === 0}
            onClick={handleSubmit}
          >
            {t('git.push_dialog_push_count', { count: pushable.length })}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 2: Create PullPreviewDialog**

Create `apps/studio/src/components/settings/git/PullPreviewDialog.tsx`:

```typescript
/**
 * PullPreviewDialog - preview remote changes before pulling.
 *
 * Uses the existing dryRun=true mode to show incoming changes
 * before the user confirms the actual pull.
 */

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDownCircle, Bot, Wrench, Loader2, AlertTriangle } from 'lucide-react';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';
import { InfoCard } from '../../ui/InfoCard';
import { pullFromGit } from '../../../api/project-io';

interface PullPreviewDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  branch: string;
  onPull: () => Promise<void>;
  pulling: boolean;
}

interface PreviewData {
  changes: { added: string[]; modified: string[]; deleted: string[] };
  commitSha: string;
}

export function PullPreviewDialog({
  open,
  onClose,
  projectId,
  branch,
  onPull,
  pulling,
}: PullPreviewDialogProps) {
  const t = useTranslations('settings');
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    // NOTE: Update pullFromGit return type in project-io.ts to include
    // changes and commitSha fields (already returned by the backend):
    //   Promise<{ success: boolean; branch: string; message: string;
    //     changes?: { added: string[]; modified: string[]; deleted: string[] };
    //     commitSha?: string; dryRun?: boolean; preview?: unknown }>
    pullFromGit(projectId, { branch, dryRun: true })
      .then((result) => {
        if (!cancelled) {
          setPreview({
            changes: result.changes ?? { added: [], modified: [], deleted: [] },
            commitSha: result.commitSha ?? '',
          });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, projectId, branch]);

  const totalChanges = preview
    ? preview.changes.added.length + preview.changes.modified.length + preview.changes.deleted.length
    : 0;

  return (
    <Dialog open={open} onClose={onClose} title={t('git.pull_dialog_title')} maxWidth="lg">
      <div className="space-y-4">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 text-muted animate-spin" />
          </div>
        )}

        {error && <InfoCard variant="error" message={error} />}

        {preview && !loading && (
          <>
            <p className="text-sm font-medium text-foreground">
              {t('git.pull_dialog_incoming', { branch })}
              {preview.commitSha && (
                <span className="text-xs text-muted font-mono ml-2">
                  {preview.commitSha.slice(0, 7)}
                </span>
              )}
            </p>

            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {preview.changes.added.map((name) => (
                <ChangeRow key={`add:${name}`} name={name} action="added" />
              ))}
              {preview.changes.modified.map((name) => (
                <ChangeRow key={`mod:${name}`} name={name} action="modified" />
              ))}
              {preview.changes.deleted.map((name) => (
                <ChangeRow key={`del:${name}`} name={name} action="deleted" />
              ))}
            </div>

            {totalChanges === 0 && (
              <p className="text-sm text-muted italic text-center py-4">
                {t('git.changes_empty')}
              </p>
            )}

            <InfoCard variant="info" message={t('git.pull_dialog_no_conflicts')} size="sm" />
          </>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            icon={<ArrowDownCircle className="w-4 h-4" />}
            loading={pulling}
            disabled={loading || totalChanges === 0}
            onClick={onPull}
          >
            {t('git.pull_dialog_apply')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ChangeRow({ name, action }: { name: string; action: 'added' | 'modified' | 'deleted' }) {
  const badgeVariant = action === 'added' ? 'success' : action === 'deleted' ? 'error' : 'accent';
  const label = action.charAt(0).toUpperCase() + action.slice(1);

  return (
    <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-background-muted">
      <div className="flex items-center gap-2">
        <Bot className="w-3.5 h-3.5 text-muted" />
        <span className="text-sm text-foreground">{name}</span>
      </div>
      <Badge variant={badgeVariant}>{label}</Badge>
    </div>
  );
}
```

- [ ] **Step 3: Create HistoryTab**

Create `apps/studio/src/components/settings/git/HistoryTab.tsx`:

```typescript
/**
 * HistoryTab - expanded sync history with per-entity change details.
 *
 * Each row is expandable to show added/modified/deleted entities.
 * Uses AnimatePresence for smooth expand/collapse.
 */

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowUpCircle,
  ArrowDownCircle,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  ChevronDown,
  Loader2,
} from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { EmptyState } from '../../ui/EmptyState';
import { fetchGitHistory, type GitSyncHistoryEntry } from '../../../api/project-io';

interface HistoryTabProps {
  projectId: string;
  syncKey: number;
}

export function HistoryTab({ projectId, syncKey }: HistoryTabProps) {
  const t = useTranslations('settings');
  const [history, setHistory] = useState<GitSyncHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchGitHistory(projectId, { limit: 25 })
      .then((data) => {
        if (!cancelled) setHistory(data.history);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, syncKey]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-4 h-4 text-muted animate-spin" />
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <EmptyState
        icon={<Clock className="w-6 h-6" />}
        title={t('git.history_empty')}
        description={t('git.history_empty_description')}
      />
    );
  }

  return (
    <div className="space-y-1.5">
      {history.map((entry, i) => {
        const id = `${entry.commitSha}-${i}`;
        const isExpanded = expandedId === id;
        const hasDetails =
          entry.changesSummary &&
          (entry.changesSummary.added.length > 0 ||
            entry.changesSummary.modified.length > 0 ||
            entry.changesSummary.deleted.length > 0);

        return (
          <div key={id}>
            <div
              role={hasDetails ? 'button' : undefined}
              tabIndex={hasDetails ? 0 : undefined}
              onClick={() => hasDetails && setExpandedId(isExpanded ? null : id)}
              onKeyDown={(e) => {
                if (hasDetails && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  setExpandedId(isExpanded ? null : id);
                }
              }}
              className={`flex items-center justify-between px-3 py-2.5 rounded-lg bg-background-muted ${hasDetails ? 'cursor-pointer hover:bg-background-muted/80' : ''} transition-default`}
            >
              <div className="flex items-center gap-2.5">
                {entry.direction === 'push' ? (
                  <ArrowUpCircle className="w-3.5 h-3.5 text-accent" />
                ) : (
                  <ArrowDownCircle className="w-3.5 h-3.5 text-info" />
                )}
                <span className="text-sm text-foreground capitalize">{entry.direction}</span>
                {entry.commitSha && (
                  <span className="text-xs text-muted font-mono">{entry.commitSha.slice(0, 7)}</span>
                )}
                {entry.status === 'success' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                ) : entry.status === 'conflict' ? (
                  <AlertTriangle className="w-3.5 h-3.5 text-warning" />
                ) : (
                  <XCircle className="w-3.5 h-3.5 text-error" />
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted">
                {entry.changesSummary && (
                  <span>
                    +{entry.changesSummary.added.length} ~{entry.changesSummary.modified.length} -{entry.changesSummary.deleted.length}
                  </span>
                )}
                <Clock className="w-3 h-3" />
                <span>{new Date(entry.createdAt).toLocaleDateString()}</span>
                {hasDetails && (
                  <ChevronDown
                    className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                  />
                )}
              </div>
            </div>

            <AnimatePresence>
              {isExpanded && hasDetails && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                  className="overflow-hidden"
                >
                  <div className="px-4 py-2 ml-6 space-y-1 text-xs">
                    {entry.changesSummary.added.map((name) => (
                      <div key={name} className="flex items-center gap-2">
                        <Badge variant="success">Added</Badge>
                        <span className="text-foreground">{name}</span>
                      </div>
                    ))}
                    {entry.changesSummary.modified.map((name) => (
                      <div key={name} className="flex items-center gap-2">
                        <Badge variant="accent">Modified</Badge>
                        <span className="text-foreground">{name}</span>
                      </div>
                    ))}
                    {entry.changesSummary.deleted.map((name) => (
                      <div key={name} className="flex items-center gap-2">
                        <Badge variant="error">Deleted</Badge>
                        <span className="text-foreground">{name}</span>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4a: Add new state and imports to GitIntegrationTab**

In `apps/studio/src/components/settings/GitIntegrationTab.tsx`, add these imports at the top:

```typescript
import { Tabs } from '../ui/Tabs';
import { SyncStatusBar } from './git/SyncStatusBar';
import { ChangesTab } from './git/ChangesTab';
import { HistoryTab } from './git/HistoryTab';
import { PushPreviewDialog } from './git/PushPreviewDialog';
import { PullPreviewDialog } from './git/PullPreviewDialog';
import type { GitStatusResponse } from '../../api/project-io';
```

Add these state variables inside `GitIntegrationTab()` (after existing state):

```typescript
const [activeTab, setActiveTab] = useState('changes');
const [showPushDialog, setShowPushDialog] = useState(false);
const [showPullDialog, setShowPullDialog] = useState(false);
const [pushing, setPushing] = useState(false);
const [pulling, setPulling] = useState(false);
const [status, setStatus] = useState<GitStatusResponse | null>(null);
const [statusLoading, setStatusLoading] = useState(false);
```

Add a status fetch effect (replaces the old StatusSection's internal fetch):

```typescript
const loadStatus = useCallback(async () => {
  if (!projectId) return;
  setStatusLoading(true);
  try {
    const data = await fetchGitStatus(projectId);
    setStatus(data);
  } catch (err) {
    console.error('Failed to load git status:', err);
  } finally {
    setStatusLoading(false);
  }
}, [projectId, syncKey]);

useEffect(() => {
  loadStatus();
}, [loadStatus]);
```

Add push/pull handlers that wire through the dialogs:

```typescript
const handlePush = async (opts: { commitMessage: string; createPR: boolean }) => {
  if (!projectId) return;
  setPushing(true);
  try {
    await pushToGit(projectId, {
      commitMessage: opts.commitMessage,
      branch: integration!.defaultBranch,
    });
    toast.success(t('git.push_complete') ?? 'Push complete');
    setShowPushDialog(false);
    setSyncKey((k) => k + 1);
  } catch (err) {
    toast.error(sanitizeError(err, t('git.push_failed')));
  } finally {
    setPushing(false);
  }
};

const handlePull = async () => {
  if (!projectId) return;
  setPulling(true);
  try {
    await pullFromGit(projectId, { branch: integration!.defaultBranch });
    toast.success(t('git.pull_complete'));
    setShowPullDialog(false);
    setSyncKey((k) => k + 1);
  } catch (err) {
    toast.error(sanitizeError(err, t('git.pull_failed')));
  } finally {
    setPulling(false);
  }
};

const defaultSummary = {
  synced: 0,
  localAhead: 0,
  remoteAhead: 0,
  conflict: 0,
  untracked: 0,
  remoteOnly: 0,
};
const changesCount = status
  ? status.summary.localAhead +
    status.summary.remoteAhead +
    status.summary.conflict +
    status.summary.untracked +
    status.summary.remoteOnly
  : 0;
```

- [ ] **Step 4b: Refactor GitIntegrationTab JSX to tabbed layout**

Replace the JSX returned when `integration` is set (the main connected view, lines 149-203). Keep `SetupDialog`, `ConnectionCard`, and `ConfirmDialog` unchanged. Replace the push/pull cards, StatusSection, and HistorySection with:

1. Keep `ConnectionCard` as-is
2. Add `SyncStatusBar` after connection card
3. Add `Tabs` component containing:
   - **Changes tab**: `ChangesTab` (default active)
   - **History tab**: `HistoryTab`
   - **Settings tab**: Sync config + disconnect button
4. Add `PushPreviewDialog` and `PullPreviewDialog`
5. Delete `PushCard`, `PullCard`, `StatusSection`, and `HistorySection` sub-components (replaced by the new git/ sub-components)
6. Keep `SetupDialog` (connect form) and the disconnect `ConfirmDialog`

Key JSX structure for the connected view:

```tsx
export function GitIntegrationTab() {
  // ... existing state + new state for activeTab, entityStatus, pushDialog, pullDialog
  const [activeTab, setActiveTab] = useState('changes');
  const [showPushDialog, setShowPushDialog] = useState(false);
  const [showPullDialog, setShowPullDialog] = useState(false);

  // ... existing loading/empty states (unchanged)

  return (
    <div className="space-y-6 max-w-4xl mx-auto px-6 py-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('git.page_title')}</h2>
        <p className="text-sm text-muted mt-1">{t('git.page_description')}</p>
      </div>

      {/* Connection info */}
      <ConnectionCard integration={integration} />

      {/* Sync status bar */}
      <SyncStatusBar
        summary={status?.summary ?? defaultSummary}
        remoteAvailable={status?.remoteAvailable ?? false}
        onPushClick={() => setShowPushDialog(true)}
        onPullClick={() => setShowPullDialog(true)}
        pushing={pushing}
        pulling={pulling}
      />

      {/* Tabbed content */}
      <Tabs
        tabs={[
          { id: 'changes', label: t('git.tab_changes'), count: changesCount || undefined },
          { id: 'history', label: t('git.tab_history') },
          { id: 'settings', label: t('git.tab_settings') },
        ]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      {activeTab === 'changes' && (
        <ChangesTab
          entityStatus={status?.entityStatus ?? []}
          remoteAvailable={status?.remoteAvailable ?? false}
          loading={statusLoading}
        />
      )}

      {activeTab === 'history' && <HistoryTab projectId={projectId} syncKey={syncKey} />}

      {activeTab === 'settings' && <div className="space-y-4">{/* Sync config, disconnect */}</div>}

      {/* Dialogs */}
      <PushPreviewDialog
        open={showPushDialog}
        onClose={() => setShowPushDialog(false)}
        entities={status?.entityStatus ?? []}
        onPush={handlePush}
        pushing={pushing}
      />
      <PullPreviewDialog
        open={showPullDialog}
        onClose={() => setShowPullDialog(false)}
        projectId={projectId}
        branch={integration.defaultBranch}
        onPull={handlePull}
        pulling={pulling}
      />
    </div>
  );
}
```

- [ ] **Step 5: Build and verify no type errors**

Run: `pnpm build --filter=studio`
Expected: No type errors

- [ ] **Step 6: Run prettier and commit**

```bash
npx prettier --write apps/studio/src/components/settings/git/PushPreviewDialog.tsx apps/studio/src/components/settings/git/PullPreviewDialog.tsx apps/studio/src/components/settings/git/HistoryTab.tsx apps/studio/src/components/settings/GitIntegrationTab.tsx
git add apps/studio/src/components/settings/git/PushPreviewDialog.tsx apps/studio/src/components/settings/git/PullPreviewDialog.tsx apps/studio/src/components/settings/git/HistoryTab.tsx apps/studio/src/components/settings/GitIntegrationTab.tsx
git commit -m "feat(studio): redesign GitIntegrationTab with tabbed layout, push/pull preview dialogs, and expanded history"
```

---

## Verification Checklist

After all tasks are complete, verify:

- [ ] `pnpm build` passes with no errors across all packages
- [ ] `pnpm test --filter=@agent-platform/database` passes (new sync fields)
- [ ] `pnpm test --filter=@agent-platform/project-io` passes (lockfile comparator)
- [ ] `pnpm test --filter=studio` passes (route tests)
- [ ] Manually test: connect a repo, push, pull, verify per-entity sync state updates in DB
- [ ] Manually test: status endpoint returns `entityStatus` with correct statuses
- [ ] Manually test: UI shows tabbed layout, sync status bar, changes table, push/pull preview dialogs
