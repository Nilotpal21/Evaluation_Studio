# Ownership Enforcement & Conflict Auto-Resolution — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire the existing ownership permission checker into agent CRUD routes, and wire `autoResolveConflicts()` into the git push flow (respecting each project's `conflictStrategy` setting).

**Architecture:** A shared `checkAgentPermission()` helper loads ownership from DB, builds `PermissionContext`, calls `canPerform()`. Each agent route calls this helper explicitly. For conflicts, the `GitSyncService.push()` method gains an optional `conflictStrategy` param that triggers auto-resolution before returning conflicts.

**Tech Stack:** TypeScript, Next.js route handlers, Mongoose (AgentOwnership model), Vitest

---

## Pre-flight

```bash
cd /Users/prasannaarikala/projects/agent-platform
pnpm build
pnpm test --filter=@agent-platform/project-io
```

Confirm all existing tests pass before starting.

---

## Task 1: Create `checkAgentPermission` Helper

**Files:**

- Create: `apps/studio/src/lib/agent-permission.ts`
- Test: `apps/studio/src/__tests__/agent-permission.test.ts` (new)

**Context:**

The permission checker at `packages/project-io/src/ownership/permission-checker.ts` exports `canPerform(ctx, operation)` which takes a `PermissionContext`. We need a helper that loads the ownership record from MongoDB, builds the context, and returns an allow/deny decision. The helper must handle the "no ownership record" case gracefully (fall through to project member role).

The `ProjectAccessResult` from `apps/studio/src/lib/project-access.ts` gives us `project.ownerId` and `project.tenantId`. The `AuthenticatedUser` from `apps/studio/src/lib/auth.ts` gives us `user.id` and `user.tenantId`.

**Step 1: Write the helper**

```typescript
/**
 * Agent Permission Helper — loads ownership and checks agent-level permissions.
 *
 * Wraps the pure canPerform() logic with MongoDB lookups for ownership,
 * project membership role, and team memberships.
 */

import { NextResponse } from 'next/server';
import { canPerform, type PermissionContext } from '@agent-platform/project-io/ownership';
import type { AgentOperation } from '@agent-platform/project-io';
import { ensureConnected, AgentOwnership, ProjectMember } from '@agent-platform/database/models';
import type { AuthenticatedUser } from './auth';
import type { ProjectAccessResult } from './project-access';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('agent-permission');

export interface AgentPermissionResult {
  allowed: boolean;
  /** Set when allowed=false */
  response?: NextResponse;
}

/**
 * Check whether the authenticated user can perform `operation` on the specified agent.
 *
 * Returns { allowed: true } or { allowed: false, response } with a 403 NextResponse.
 * Falls through to project member role if no ownership record exists.
 */
export async function checkAgentPermission(
  projectId: string,
  agentId: string,
  user: AuthenticatedUser,
  project: ProjectAccessResult['project'],
  operation: AgentOperation,
): Promise<AgentPermissionResult> {
  try {
    await ensureConnected();

    // Load ownership record (may not exist for legacy agents)
    const ownership = await AgentOwnership.findOne({ projectId, agentId }).lean();

    // Resolve project member role
    let projectMemberRole: 'admin' | 'developer' | 'viewer' | null = null;
    const membership = await ProjectMember.findOne({
      projectId,
      userId: user.id,
    }).lean();
    if (membership) {
      projectMemberRole = (membership as Record<string, unknown>).role as
        | 'admin'
        | 'developer'
        | 'viewer'
        | null;
    }

    // Build permission context
    const ctx: PermissionContext = {
      userId: user.id,
      projectOwnerId: project.ownerId,
      projectMemberRole,
      agentOwnerId: ((ownership as Record<string, unknown>)?.ownerId as string | null) ?? null,
      agentOwnerTeamId:
        ((ownership as Record<string, unknown>)?.ownerTeamId as string | null) ?? null,
      userTeamMemberships: [], // TODO: wire team membership lookup when Team model is available
      explicitPermissions:
        ((ownership as Record<string, unknown>)?.permissions as Array<{
          principalType: 'user' | 'team';
          principalId: string;
          operations: AgentOperation[];
          expiresAt: Date | null;
        }>) ?? [],
    };

    if (canPerform(ctx, operation)) {
      return { allowed: true };
    }

    log.info('Agent permission denied', {
      projectId,
      agentId,
      userId: user.id,
      operation,
      projectMemberRole,
      hasOwnership: !!ownership,
    });

    return {
      allowed: false,
      response: NextResponse.json(
        { error: 'You do not have permission to perform this action' },
        { status: 403 },
      ),
    };
  } catch (error) {
    // Fail open with warning — permission system should not block on DB errors
    log.warn('Agent permission check failed — allowing request (fail-open)', {
      projectId,
      agentId,
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
    return { allowed: true };
  }
}
```

**Step 2: Write unit tests**

Create `apps/studio/src/__tests__/agent-permission.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database models before importing the module under test
vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  AgentOwnership: {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
  },
  ProjectMember: {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { checkAgentPermission } from '../lib/agent-permission';
import { AgentOwnership, ProjectMember } from '@agent-platform/database/models';

const mockUser = { id: 'user-1', tenantId: 'tenant-1', permissions: [] } as any;
const mockProject = {
  id: 'proj-1',
  ownerId: 'owner-1',
  tenantId: 'tenant-1',
  name: 'Test',
  slug: 'test',
};

describe('checkAgentPermission', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allows project owner full access', async () => {
    const ownerUser = { ...mockUser, id: 'owner-1' };
    const result = await checkAgentPermission('proj-1', 'agent-1', ownerUser, mockProject, 'edit');
    expect(result.allowed).toBe(true);
  });

  it('allows agent owner full access', async () => {
    (AgentOwnership.findOne as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue({ ownerId: 'user-1', ownerTeamId: null, permissions: [] }),
    });
    const result = await checkAgentPermission('proj-1', 'agent-1', mockUser, mockProject, 'delete');
    expect(result.allowed).toBe(true);
  });

  it('allows project admin full access via member role', async () => {
    (ProjectMember.findOne as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue({ role: 'admin' }),
    });
    const result = await checkAgentPermission('proj-1', 'agent-1', mockUser, mockProject, 'deploy');
    expect(result.allowed).toBe(true);
  });

  it('allows developer view+edit but denies deploy', async () => {
    (ProjectMember.findOne as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue({ role: 'developer' }),
    });
    const viewResult = await checkAgentPermission(
      'proj-1',
      'agent-1',
      mockUser,
      mockProject,
      'view',
    );
    expect(viewResult.allowed).toBe(true);

    const deployResult = await checkAgentPermission(
      'proj-1',
      'agent-1',
      mockUser,
      mockProject,
      'deploy',
    );
    expect(deployResult.allowed).toBe(false);
    expect(deployResult.response?.status).toBe(403);
  });

  it('allows viewer only view', async () => {
    (ProjectMember.findOne as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue({ role: 'viewer' }),
    });
    const viewResult = await checkAgentPermission(
      'proj-1',
      'agent-1',
      mockUser,
      mockProject,
      'view',
    );
    expect(viewResult.allowed).toBe(true);

    const editResult = await checkAgentPermission(
      'proj-1',
      'agent-1',
      mockUser,
      mockProject,
      'edit',
    );
    expect(editResult.allowed).toBe(false);
  });

  it('denies access when no ownership and no project membership', async () => {
    const result = await checkAgentPermission('proj-1', 'agent-1', mockUser, mockProject, 'edit');
    expect(result.allowed).toBe(false);
  });

  it('fails open on database error', async () => {
    (AgentOwnership.findOne as any).mockReturnValue({
      lean: vi.fn().mockRejectedValue(new Error('DB down')),
    });
    const result = await checkAgentPermission('proj-1', 'agent-1', mockUser, mockProject, 'edit');
    expect(result.allowed).toBe(true);
  });

  it('respects explicit permission grants', async () => {
    (AgentOwnership.findOne as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        ownerId: 'other-user',
        ownerTeamId: null,
        permissions: [
          {
            principalType: 'user',
            principalId: 'user-1',
            operations: ['view', 'deploy'],
            expiresAt: null,
          },
        ],
      }),
    });
    const deployResult = await checkAgentPermission(
      'proj-1',
      'agent-1',
      mockUser,
      mockProject,
      'deploy',
    );
    expect(deployResult.allowed).toBe(true);

    const deleteResult = await checkAgentPermission(
      'proj-1',
      'agent-1',
      mockUser,
      mockProject,
      'delete',
    );
    expect(deleteResult.allowed).toBe(false);
  });
});
```

**Step 3: Run tests — expect PASS**

```bash
pnpm --filter @agent-platform/studio test -- "agent-permission" 2>&1 | tail -20
```

**Step 4: Commit**

```bash
npx prettier --write apps/studio/src/lib/agent-permission.ts apps/studio/src/__tests__/agent-permission.test.ts
git add apps/studio/src/lib/agent-permission.ts apps/studio/src/__tests__/agent-permission.test.ts
git commit -m "feat(studio): add checkAgentPermission helper for agent-level authorization"
```

---

## Task 2: Wire Permission Check into Agent PATCH Route

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/agents/[agentId]/route.ts:50-81`

**Context:**

The PATCH handler currently does `requireAuth` + `requireProjectAccess` but no agent-level permission check. Add `checkAgentPermission(projectId, agentId, user, project, 'edit')` after the existing access checks.

**Step 1: Modify the PATCH handler**

Add import at top of file:

```typescript
import { checkAgentPermission } from '@/lib/agent-permission';
```

After the `requireProjectAccess` call (line 56-57), add:

```typescript
// Agent-level permission check
const perm = await checkAgentPermission(id, agentId, user, access.project, 'edit');
if (!perm.allowed) return perm.response!;
```

**Step 2: Run Prettier**

```bash
npx prettier --write "apps/studio/src/app/api/projects/[id]/agents/[agentId]/route.ts"
```

**Step 3: Commit**

```bash
git add "apps/studio/src/app/api/projects/[id]/agents/[agentId]/route.ts"
git commit -m "feat(studio): enforce agent edit permission on PATCH /agents/:agentId"
```

---

## Task 3: Wire Permission Check into Agent DELETE Route

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/agents/[agentId]/route.ts:83-113`

**Context:**

Same file as Task 2. The DELETE handler needs `'delete'` permission.

**Step 1: Modify the DELETE handler**

After the `requireProjectAccess` call (line 89-90), add:

```typescript
// Agent-level permission check
const perm = await checkAgentPermission(id, agentId, user, access.project, 'delete');
if (!perm.allowed) return perm.response!;
```

**Step 2: Run Prettier, commit**

```bash
npx prettier --write "apps/studio/src/app/api/projects/[id]/agents/[agentId]/route.ts"
git add "apps/studio/src/app/api/projects/[id]/agents/[agentId]/route.ts"
git commit -m "feat(studio): enforce agent delete permission on DELETE /agents/:agentId"
```

---

## Task 4: Wire Permission Check into Agent Edit (Surgical) Route

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/agents/[agentId]/edit/route.ts:20-85`

**Context:**

The surgical section edit route at `/agents/:agentId/edit` performs writes to agent DSL content. Needs `'edit'` permission.

**Step 1: Add import and permission check**

Add import:

```typescript
import { checkAgentPermission } from '@/lib/agent-permission';
```

After the `requireProjectAccess` call (line 25-26), add:

```typescript
// Agent-level permission check
const perm = await checkAgentPermission(
  projectId,
  decodeURIComponent(agentName),
  user,
  access.project,
  'edit',
);
if (!perm.allowed) return perm.response!;
```

Note: `agentName` is the URL param (decoded at line 24). The agentId in the ownership model maps to the agent name.

**Step 2: Run Prettier, commit**

```bash
npx prettier --write "apps/studio/src/app/api/projects/[id]/agents/[agentId]/edit/route.ts"
git add "apps/studio/src/app/api/projects/[id]/agents/[agentId]/edit/route.ts"
git commit -m "feat(studio): enforce agent edit permission on surgical edit route"
```

---

## Task 5: Wire Auto-Resolution into GitSyncService.push()

**Files:**

- Modify: `packages/project-io/src/git/git-sync-service.ts:30-39,63-161`
- Test: `packages/project-io/src/__tests__/git-sync-service.test.ts`

**Context:**

Currently `push()` detects conflicts via `checkConflicts()` (line 147) but always returns them to the caller. We need to add a `conflictStrategy` option so that when the strategy is `'local_wins'` or `'remote_wins'`, detected conflicts are auto-resolved and the push continues with the merged content.

The `autoResolveConflicts()` function at `conflict-resolver.ts:96-107` is already imported via `checkConflicts` — we need to also import `autoResolveConflicts`.

**Step 1: Add `conflictStrategy` to PushOptions**

In `git-sync-service.ts`, modify `PushOptions` (line 30-39):

```typescript
export interface PushOptions {
  projectData: ProjectData;
  userId: string;
  tenantId: string;
  branch: string;
  commitMessage: string;
  committer: Committer;
  lastSyncCommit: string | null;
  createPR?: { title: string; description: string; targetBranch: string };
  /** Conflict resolution strategy. Default: 'manual' (return conflicts to caller). */
  conflictStrategy?: ConflictStrategy;
}
```

Add `ConflictStrategy` to the type imports at line 9:

```typescript
import type {
  GitFile,
  Committer,
  ChangesSummary,
  ConflictDetail,
  ConflictStrategy,
} from '../types.js';
```

Add `autoResolveConflicts` to the conflict-resolver import at line 12:

```typescript
import { checkConflicts, autoResolveConflicts, type ThreeWayInput } from './conflict-resolver.js';
```

**Step 2: Wire auto-resolution into the push conflict block**

Replace lines 146-160 (the conflict detection block):

```typescript
if (threeWayInputs.length > 0) {
  const { resolved: autoResolved, conflicts } = checkConflicts(threeWayInputs);
  if (conflicts.length > 0) {
    const strategy = options.conflictStrategy ?? 'manual';
    if (strategy === 'manual') {
      return {
        success: false,
        commitSha: null,
        changes: { added: [], modified: [], deleted: [] },
        conflicts,
        error: {
          code: 'SYNC_CONFLICT',
          message: `${conflicts.length} file(s) have conflicts that must be resolved`,
        },
      };
    }

    // Auto-resolve using configured strategy
    const resolutions = autoResolveConflicts(conflicts, strategy);
    log.info('Auto-resolved conflicts', {
      strategy,
      count: resolutions.length,
      files: resolutions.map((r) => r.file),
    });

    // Apply resolved content to export files
    for (const resolution of resolutions) {
      if (resolution.mergedContent !== undefined) {
        exportResult.files.set(resolution.file, resolution.mergedContent);
      }
    }
  }

  // Apply auto-resolved files from three-way merge (accept_theirs / keep_ours)
  for (const res of autoResolved) {
    exportResult.files.set(res.file, res.content);
  }
}
```

**Step 3: Write failing test**

Add to `git-sync-service.test.ts`:

```typescript
describe('push — conflict auto-resolution', () => {
  it('should auto-resolve with local_wins and continue push', async () => {
    // Setup: remote has different content, base differs from both
    const baseContent = 'AGENT: Test\nGOAL:\n  base goal\n';
    const localContent = 'AGENT: Test\nGOAL:\n  local goal\n';
    const remoteContent = 'AGENT: Test\nGOAL:\n  remote goal\n';

    mockProvider.pullProject = vi.fn(async () => ({
      files: [{ path: 'agents/test.agent.abl', content: remoteContent }],
      commitSha: 'remote-sha',
    }));
    mockProvider.getFile = vi.fn(async () => ({ content: baseContent }));
    mockProvider.pushFiles = vi.fn(async () => ({ commitSha: 'push-sha' }));

    const result = await service.push({
      projectData: {
        name: 'Test',
        slug: 'test',
        description: null,
        entryAgentName: null,
        agents: [
          {
            name: 'Test',
            description: null,
            dslContent: localContent,
            ownerId: null,
            ownerTeamId: null,
            version: null,
            status: 'active',
          },
        ],
        toolFiles: [],
        deployments: [],
      },
      userId: 'user-1',
      tenantId: 'tenant-1',
      branch: 'main',
      commitMessage: 'sync',
      committer: { name: 'User', email: 'u@test.com' },
      lastSyncCommit: 'base-sha',
      conflictStrategy: 'local_wins',
    });

    expect(result.success).toBe(true);
    expect(result.conflicts).toHaveLength(0);
    // Verify pushFiles was called (not blocked by conflicts)
    expect(mockProvider.pushFiles).toHaveBeenCalled();
    // Verify the pushed content is the local version (local_wins)
    const pushedFiles = mockProvider.pushFiles.mock.calls[0][1] as Array<{
      path: string;
      content: string;
    }>;
    const agentFile = pushedFiles.find((f: { path: string }) => f.path === 'agents/test.agent.abl');
    expect(agentFile?.content).toBe(localContent);
  });

  it('should return conflicts when strategy is manual', async () => {
    const baseContent = 'AGENT: Test\nGOAL:\n  base\n';
    const localContent = 'AGENT: Test\nGOAL:\n  local\n';
    const remoteContent = 'AGENT: Test\nGOAL:\n  remote\n';

    mockProvider.pullProject = vi.fn(async () => ({
      files: [{ path: 'agents/test.agent.abl', content: remoteContent }],
      commitSha: 'remote-sha',
    }));
    mockProvider.getFile = vi.fn(async () => ({ content: baseContent }));

    const result = await service.push({
      projectData: {
        name: 'Test',
        slug: 'test',
        description: null,
        entryAgentName: null,
        agents: [
          {
            name: 'Test',
            description: null,
            dslContent: localContent,
            ownerId: null,
            ownerTeamId: null,
            version: null,
            status: 'active',
          },
        ],
        toolFiles: [],
        deployments: [],
      },
      userId: 'user-1',
      tenantId: 'tenant-1',
      branch: 'main',
      commitMessage: 'sync',
      committer: { name: 'User', email: 'u@test.com' },
      lastSyncCommit: 'base-sha',
      conflictStrategy: 'manual',
    });

    expect(result.success).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.error?.code).toBe('SYNC_CONFLICT');
  });

  it('should auto-resolve with remote_wins', async () => {
    const baseContent = 'AGENT: Test\nGOAL:\n  base\n';
    const localContent = 'AGENT: Test\nGOAL:\n  local\n';
    const remoteContent = 'AGENT: Test\nGOAL:\n  remote\n';

    mockProvider.pullProject = vi.fn(async () => ({
      files: [{ path: 'agents/test.agent.abl', content: remoteContent }],
      commitSha: 'remote-sha',
    }));
    mockProvider.getFile = vi.fn(async () => ({ content: baseContent }));
    mockProvider.pushFiles = vi.fn(async () => ({ commitSha: 'push-sha' }));

    const result = await service.push({
      projectData: {
        name: 'Test',
        slug: 'test',
        description: null,
        entryAgentName: null,
        agents: [
          {
            name: 'Test',
            description: null,
            dslContent: localContent,
            ownerId: null,
            ownerTeamId: null,
            version: null,
            status: 'active',
          },
        ],
        toolFiles: [],
        deployments: [],
      },
      userId: 'user-1',
      tenantId: 'tenant-1',
      branch: 'main',
      commitMessage: 'sync',
      committer: { name: 'User', email: 'u@test.com' },
      lastSyncCommit: 'base-sha',
      conflictStrategy: 'remote_wins',
    });

    expect(result.success).toBe(true);
    // Verify pushed content is the remote version
    const pushedFiles = mockProvider.pushFiles.mock.calls[0][1] as Array<{
      path: string;
      content: string;
    }>;
    const agentFile = pushedFiles.find((f: { path: string }) => f.path === 'agents/test.agent.abl');
    expect(agentFile?.content).toBe(remoteContent);
  });
});
```

**Step 4: Build and run tests**

```bash
pnpm build --filter=@agent-platform/project-io
pnpm test --filter=@agent-platform/project-io -- git-sync-service
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
npx prettier --write packages/project-io/src/git/git-sync-service.ts packages/project-io/src/__tests__/git-sync-service.test.ts
git add packages/project-io/src/git/git-sync-service.ts packages/project-io/src/__tests__/git-sync-service.test.ts
git commit -m "feat(project-io): wire autoResolveConflicts into push with configurable strategy"
```

---

## Task 6: Pass `conflictStrategy` from Studio Push Route

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/git/push/route.ts:105-114`

**Context:**

The push route already loads the `GitIntegration` document at line 53, which has `syncConfig.conflictStrategy`. Pass this to `syncService.push()`.

**Step 1: Add conflictStrategy to push call**

At line 105-114, modify the `syncService.push()` call to include `conflictStrategy`:

```typescript
const result = await syncService.push({
  projectData,
  userId: user.id,
  tenantId,
  branch,
  commitMessage,
  committer: { name: user.name ?? user.id, email: user.email ?? 'noreply@ablplatform.io' },
  lastSyncCommit: integration.lastSyncCommit,
  createPR: body.createPR,
  conflictStrategy: (integration as Record<string, unknown>).syncConfig
    ? (((integration as Record<string, unknown>).syncConfig as Record<string, unknown>)
        .conflictStrategy as 'manual' | 'local_wins' | 'remote_wins')
    : 'manual',
});
```

**Step 2: Update the conflict response block**

The existing conflict response block at lines 116-143 handles `result.conflicts.length > 0`. With auto-resolution, conflicts only appear when strategy is 'manual'. But to be safe, keep the existing handler — it still works correctly.

**Step 3: Populate `conflictDetails` in GitSyncHistory**

In the conflict history creation (line 118-128), add `conflictDetails`:

```typescript
await GitSyncHistory.create({
  projectId,
  tenantId,
  direction: 'push',
  commitSha: null,
  branch,
  status: 'conflict',
  agentsAffected: agents.map((a: IProjectAgent) => a.name),
  changesSummary: result.changes,
  conflictDetails: result.conflicts.map((c) => ({
    agentName: c.agentName,
    file: c.file,
    resolved: false,
    resolution: null,
  })),
  triggeredBy: user.id,
});
```

**Step 4: Run Prettier, commit**

```bash
npx prettier --write "apps/studio/src/app/api/projects/[id]/git/push/route.ts"
git add "apps/studio/src/app/api/projects/[id]/git/push/route.ts"
git commit -m "feat(studio): pass conflictStrategy to push and populate conflictDetails in history"
```

---

## Task 7: Log Auto-Resolution in Push Success History

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/git/push/route.ts:173-194`

**Context:**

When conflicts were auto-resolved, the push succeeds but we should record that conflicts were resolved in the sync history. Add a `conflictsAutoResolved` count to the success response and log it.

**Step 1: Add import for autoResolveConflicts type awareness**

No new imports needed — the `result` from `syncService.push()` already returns empty conflicts on success (auto-resolved ones don't appear in the response).

Instead, add a `log.info` after the successful push when `lastSyncCommit` was set (indicating a sync that could have had conflicts):

After the `GitIntegration.findOneAndUpdate` success block (line 186-194), before the return:

```typescript
log.info('Git push succeeded', {
  projectId,
  branch,
  commitSha: result.commitSha,
  added: result.changes.added.length,
  modified: result.changes.modified.length,
  deleted: result.changes.deleted.length,
});
```

**Step 2: Run Prettier, commit**

```bash
npx prettier --write "apps/studio/src/app/api/projects/[id]/git/push/route.ts"
git add "apps/studio/src/app/api/projects/[id]/git/push/route.ts"
git commit -m "feat(studio): add audit logging for successful git push"
```

---

## Post-flight

After all tasks are complete:

```bash
cd /Users/prasannaarikala/projects/agent-platform
pnpm build
pnpm test --filter=@agent-platform/project-io
npx prettier --check "packages/project-io/src/**/*.ts" "apps/studio/src/lib/agent-permission.ts"
```

All tests must pass. No Prettier violations.
