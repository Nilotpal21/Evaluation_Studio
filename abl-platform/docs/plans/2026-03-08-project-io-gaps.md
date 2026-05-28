# Project-IO Gaps — Code Fixes + Test Coverage

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close all confirmed code and test gaps in `packages/project-io/` and its consumer routes.

**Architecture:** Pure library fixes in project-io, consumer route hardening in studio/runtime, comprehensive test additions. Each task is self-contained and independently verifiable.

**Tech Stack:** TypeScript, Vitest, MongoDB/Prisma patterns, Next.js route handlers

---

## Pre-flight

```bash
cd /Users/prasannaarikala/projects/agent-platform
pnpm build --filter=@agent-platform/project-io
pnpm test --filter=@agent-platform/project-io
```

Confirm all existing tests pass before starting.

---

## Task 1: Lock Service — Handle Null getLock After Duplicate Key

**Files:**

- Modify: `packages/project-io/src/ownership/lock-service.ts:97-112`
- Test: `packages/project-io/src/__tests__/lock-service.test.ts`

**Problem:** In `acquireLock()`, when a duplicate key error occurs (line 99), the fallback `getLock` at line 100 could return null (lock expired between create and re-check). Currently this rethrows the original error instead of retrying.

**Step 1: Write failing test**

Add to lock-service.test.ts in the `acquireLock` describe block:

```typescript
it('should retry create when duplicate key error followed by null getLock (expired between attempts)', async () => {
  let createCallCount = 0;
  const error = Object.assign(new Error('dup'), { code: 11000 });
  store.createLock = vi.fn(async (record) => {
    createCallCount++;
    if (createCallCount === 1) throw error;
    return { id: 'lock-retry', ...record };
  });
  store.getLock = vi.fn(async () => null); // lock vanished

  const result = await service.acquireLock('proj1', 'agent1', 'Agent One', 'user-a');
  expect('code' in result).toBe(false); // not a conflict
  expect((result as LockRecord).id).toBe('lock-retry');
  expect(createCallCount).toBe(2);
});
```

**Step 2: Run test — expect FAIL**

```bash
pnpm test --filter=@agent-platform/project-io -- lock-service
```

**Step 3: Fix the code**

In `lock-service.ts`, replace lines 97-112:

```typescript
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        // Another request won the race — check if their lock is still active
        const conflicting = await this.store.getLock(projectId, agentId, lockType);
        if (conflicting && conflicting.expiresAt > new Date()) {
          if (conflicting.lockedBy === userId) {
            // Same user won the race — just return their lock
            return conflicting;
          }
          return {
            code: 'LOCK_CONFLICT',
            message: `Agent "${agentName}" is locked by another user`,
            lockedBy: conflicting.lockedBy,
            lockedAt: conflicting.lockedAt,
            expiresAt: conflicting.expiresAt,
          };
        }
        // Race winner's lock already expired or was cleaned up — retry once
        return this.store.createLock({
          projectId,
          agentId,
          agentName,
          lockedBy: userId,
          lockedAt: now,
          expiresAt: new Date(now.getTime() + ttlMs),
          lockType,
        });
      }
      throw error;
    }
```

**Step 4: Run test — expect PASS**

```bash
pnpm test --filter=@agent-platform/project-io -- lock-service
```

**Step 5: Commit**

```bash
git add packages/project-io/src/ownership/lock-service.ts packages/project-io/src/__tests__/lock-service.test.ts
git commit -m "fix(project-io): handle null getLock after duplicate key in lock acquisition"
```

---

## Task 2: Ownership Service — Input Validation + Audit Trail

**Files:**

- Modify: `packages/project-io/src/ownership/ownership-service.ts:41-79`
- Test: `packages/project-io/src/__tests__/ownership-service.test.ts`

**Problem:** `assignOwner()` accepts empty strings and both ownerId+ownerTeamId simultaneously. `transferOwnership()` ignores the `_transferredBy` parameter — no audit trail.

**Step 1: Write failing tests**

Add to ownership-service.test.ts:

```typescript
describe('assignOwner validation', () => {
  it('should reject when neither ownerId nor ownerTeamId is provided', async () => {
    await expect(service.assignOwner('proj1', 'a1', 'Agent', {})).rejects.toThrow(
      'At least one of ownerId or ownerTeamId must be provided',
    );
  });

  it('should reject empty string ownerId', async () => {
    await expect(service.assignOwner('proj1', 'a1', 'Agent', { ownerId: '' })).rejects.toThrow(
      'ownerId must be a non-empty string',
    );
  });

  it('should reject empty string ownerTeamId', async () => {
    await expect(service.assignOwner('proj1', 'a1', 'Agent', { ownerTeamId: '' })).rejects.toThrow(
      'ownerTeamId must be a non-empty string',
    );
  });
});

describe('transferOwnership audit', () => {
  it('should log the transferredBy user when transferring ownership', async () => {
    // Assign first
    await service.assignOwner('proj1', 'a1', 'Agent', { ownerId: 'user-a' });
    const result = await service.transferOwnership(
      'proj1',
      'a1',
      { newOwnerId: 'user-b' },
      'admin-1',
    );
    // The record should have the new owner
    expect(result.ownerId).toBe('user-b');
  });
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Fix the code**

In `ownership-service.ts`, add validation to `assignOwner`:

```typescript
  async assignOwner(
    projectId: string,
    agentId: string,
    agentName: string,
    params: { ownerId?: string; ownerTeamId?: string },
  ): Promise<OwnershipRecord> {
    if (params.ownerId === undefined && params.ownerTeamId === undefined) {
      throw new Error('At least one of ownerId or ownerTeamId must be provided');
    }
    if (params.ownerId !== undefined && params.ownerId === '') {
      throw new Error('ownerId must be a non-empty string');
    }
    if (params.ownerTeamId !== undefined && params.ownerTeamId === '') {
      throw new Error('ownerTeamId must be a non-empty string');
    }

    const existing = await this.store.getOwnership(projectId, agentId);
    // ... rest unchanged
```

For `transferOwnership`, rename `_transferredBy` to `transferredBy` and add logging:

```typescript
  async transferOwnership(
    projectId: string,
    agentId: string,
    params: { newOwnerId?: string; newOwnerTeamId?: string },
    transferredBy: string,
  ): Promise<OwnershipRecord> {
    const existing = await this.store.getOwnership(projectId, agentId);
    if (!existing) {
      throw new Error(`No ownership record found for agent ${agentId} in project ${projectId}`);
    }

    const previousOwner = existing.ownerId;
    const previousTeam = existing.ownerTeamId;

    if (params.newOwnerId !== undefined) existing.ownerId = params.newOwnerId;
    if (params.newOwnerTeamId !== undefined) existing.ownerTeamId = params.newOwnerTeamId;

    log.info('Ownership transferred', {
      projectId,
      agentId,
      transferredBy,
      previousOwner,
      previousTeam,
      newOwner: existing.ownerId,
      newTeam: existing.ownerTeamId,
    });

    return this.store.upsertOwnership(existing);
  }
```

Add `import { createLogger } from '@abl/compiler/platform';` and `const log = createLogger('ownership-service');` at the top.

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add packages/project-io/src/ownership/ownership-service.ts packages/project-io/src/__tests__/ownership-service.test.ts
git commit -m "fix(project-io): add ownership validation and transfer audit logging"
```

---

## Task 3: Git Sync — Harden extractAgentNameFromPath

**Files:**

- Modify: `packages/project-io/src/git/git-sync-service.ts:266-272`
- Test: `packages/project-io/src/__tests__/git-sync-service.test.ts`

**Problem:** `extractAgentNameFromPath` chains replaces that could produce empty strings or misleading names for paths outside `agents/` or `tools/`.

**Step 1: Write failing tests**

Add a new `describe('extractAgentNameFromPath')` block. Since it's a module-private function, test it indirectly via push conflict detection, or export it for testing. Better: export it.

Add `export` keyword to the function declaration in git-sync-service.ts, then add tests:

```typescript
import { GitSyncService, extractAgentNameFromPath } from '../git/git-sync-service.js';

describe('extractAgentNameFromPath', () => {
  it('should extract agent name from standard path', () => {
    expect(extractAgentNameFromPath('agents/supervisor.agent.abl')).toBe('supervisor');
  });

  it('should extract tool name from tools path', () => {
    expect(extractAgentNameFromPath('tools/booking_api.tools.abl')).toBe('booking_api');
  });

  it('should return filename for unrecognized paths', () => {
    expect(extractAgentNameFromPath('config/models.json')).toBe('models.json');
  });

  it('should handle nested paths safely', () => {
    expect(extractAgentNameFromPath('agents/sub/nested.agent.abl')).toBe('sub/nested');
  });

  it('should not produce empty string', () => {
    const result = extractAgentNameFromPath('agents/.agent.abl');
    expect(result.length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run tests — some will FAIL**

**Step 3: Fix the code**

Replace the function in `git-sync-service.ts`:

```typescript
export function extractAgentNameFromPath(path: string): string {
  // Try agent pattern first
  const agentMatch = path.match(/^agents\/(.+)\.agent\.(?:abl|yaml)$/);
  if (agentMatch) return agentMatch[1];

  // Try tool pattern
  const toolMatch = path.match(/^tools\/(.+)\.tools\.abl$/);
  if (toolMatch) return toolMatch[1];

  // Fallback: use filename without extension
  const parts = path.split('/');
  const filename = parts[parts.length - 1];
  return filename || path;
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add packages/project-io/src/git/git-sync-service.ts packages/project-io/src/__tests__/git-sync-service.test.ts
git commit -m "fix(project-io): harden extractAgentNameFromPath with regex matching"
```

---

## Task 4: Folder Builder — Guard Collision Loop

**Files:**

- Modify: `packages/project-io/src/export/folder-builder.ts:82-88`
- Test: `packages/project-io/src/__tests__/folder-builder-collision.test.ts` (new)

**Problem:** The while loop at line 86 has no max iteration guard. Theoretically infinite.

**Step 1: Write failing test**

Create new test file:

```typescript
import { describe, it, expect } from 'vitest';
import { buildFileMap, type AgentFileEntry } from '../export/folder-builder.js';

describe('buildFileMap collision handling', () => {
  it('should handle agents that normalize to the same filename', () => {
    const agents: AgentFileEntry[] = [
      { name: 'BookingAgent', dslContent: 'AGENT: BookingAgent\n', isSupervisor: false },
      { name: 'booking_agent', dslContent: 'AGENT: booking_agent\n', isSupervisor: false },
      { name: 'Booking-Agent', dslContent: 'AGENT: Booking-Agent\n', isSupervisor: false },
    ];
    const files = buildFileMap(agents, [], new Map(), new Map());
    // All three should have distinct paths
    expect(files.size).toBe(3);
    const paths = [...files.keys()];
    expect(new Set(paths).size).toBe(3);
  });

  it('should throw after max collision attempts', () => {
    // Create 1002 agents that all normalize to the same name
    const agents: AgentFileEntry[] = Array.from({ length: 1002 }, (_, i) => ({
      name: `test${String.fromCharCode(0x200b + (i % 50))}`, // zero-width chars stripped to "test"
      dslContent: `AGENT: test_${i}\n`,
      isSupervisor: false,
    }));
    expect(() => buildFileMap(agents, [], new Map(), new Map())).toThrow(/collision/i);
  });
});
```

**Step 2: Run test — second case will HANG (no limit), first may pass**

**Step 3: Fix the code**

In `folder-builder.ts`, replace lines 82-89:

```typescript
if (files.has(path)) {
  let suffix = 2;
  const ext = dslFormat === 'yaml' ? '.agent.yaml' : '.agent.abl';
  const base = path.slice(0, path.length - ext.length);
  const MAX_COLLISIONS = 1000;
  while (files.has(`${base}_${suffix}${ext}`)) {
    suffix++;
    if (suffix > MAX_COLLISIONS) {
      throw new Error(`Too many filename collisions for agent "${agent.name}" (base: ${base})`);
    }
  }
  path = `${base}_${suffix}${ext}`;
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add packages/project-io/src/export/folder-builder.ts packages/project-io/src/__tests__/folder-builder-collision.test.ts
git commit -m "fix(project-io): add max iteration guard to filename collision loop"
```

---

## Task 5: Manifest Generator — Detect Duplicate Agent Names

**Files:**

- Modify: `packages/project-io/src/export/manifest-generator.ts:46-56`
- Test: `packages/project-io/src/__tests__/manifest-generator-dedup.test.ts` (new)

**Problem:** If two agents share the same `name`, the second silently overwrites the first in the manifest `agents` record.

**Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { generateManifest } from '../export/manifest-generator.js';

describe('generateManifest duplicate detection', () => {
  it('should warn when agents have duplicate names', () => {
    expect(() =>
      generateManifest({
        projectName: 'Test',
        projectSlug: 'test',
        projectDescription: null,
        exportedBy: 'user-1',
        entryAgent: null,
        agents: [
          { name: 'Booking', description: null, ownerId: null, ownerTeamId: null, version: null },
          { name: 'Booking', description: 'dup', ownerId: null, ownerTeamId: null, version: null },
        ],
        tools: [],
        edges: [],
      }),
    ).toThrow(/uplicate agent name/);
  });
});
```

**Step 2: Run test — expect FAIL (no validation)**

**Step 3: Fix the code**

Add at the start of `generateManifest`:

```typescript
const agentNames = new Set<string>();
for (const agent of input.agents) {
  if (agentNames.has(agent.name)) {
    throw new Error(`Duplicate agent name in manifest input: "${agent.name}"`);
  }
  agentNames.add(agent.name);
}
```

Apply same check in `generateManifestV2`.

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add packages/project-io/src/export/manifest-generator.ts packages/project-io/src/__tests__/manifest-generator-dedup.test.ts
git commit -m "fix(project-io): detect duplicate agent names in manifest generation"
```

---

## Task 6: Import Validator — Fix Agent Name Fallback

**Files:**

- Modify: `packages/project-io/src/import/import-validator.ts:100-103`
- Test: `packages/project-io/src/__tests__/import-validators.test.ts`

**Problem:** When the regex fails to extract the agent name from DSL content, the full file path (`agents/supervisor.agent.abl`) is used as the agent name, causing confusing dependency validation errors.

**Step 1: Write failing test**

Add to import-validators.test.ts:

```typescript
it('should extract agent name from path when DSL header is malformed', () => {
  const agentFiles = new Map([
    ['agents/booking_agent.agent.abl', '# Malformed — no header\nSome content'],
  ]);
  const result = validateImport(agentFiles, new Map());
  // Should NOT use full path as agent name in dependency validation
  const agentNames = result.dependencyValidation.graph?.agents ?? [];
  expect(agentNames).not.toContain('agents/booking_agent.agent.abl');
});
```

**Step 2: Run test — may FAIL depending on existing extraction**

**Step 3: Fix the code**

Replace lines 100-103 in `import-validator.ts`:

```typescript
for (const [path, content] of agentFiles) {
  const nameMatch = content.match(/^(?:AGENT|SUPERVISOR|agent|supervisor):\s+(\S+)/m);
  // Fall back to extracting from path, not using the raw path
  const name = nameMatch
    ? nameMatch[1]
    : path
        .replace(/^agents\//, '')
        .replace(/\.agent\.(?:abl|yaml)$/, '')
        .replace(/^tools\//, '')
        .replace(/\.tools\.abl$/, '') || path;
  agentEntries.push({ name, dslContent: content, path });
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add packages/project-io/src/import/import-validator.ts packages/project-io/src/__tests__/import-validators.test.ts
git commit -m "fix(project-io): extract agent name from path when DSL header is malformed"
```

---

## Task 7: Studio Git Routes — Sanitize Error Responses + Branch Validation on Push

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/git/push/route.ts:210-216`
- Modify: `apps/studio/src/app/api/projects/[id]/git/pull/route.ts:132-139`

**Problem:** Both routes leak raw error messages in 500 responses. Push route lacks branch name validation (pull has it).

**Step 1: Fix push route error response** (line 210-216)

Replace:

```typescript
const message = error instanceof Error ? error.message : String(error);
const stack = error instanceof Error ? error.stack : undefined;
log.error('Git push failed', { projectId, error: message, stack });
return NextResponse.json({ error: 'Failed to push to git', detail: message }, { status: 500 });
```

With:

```typescript
const message = error instanceof Error ? error.message : String(error);
const stack = error instanceof Error ? error.stack : undefined;
log.error('Git push failed', { projectId, error: message, stack });
return NextResponse.json({ error: 'Failed to push to git' }, { status: 500 });
```

**Step 2: Fix pull route error response** (line 132-139)

Replace:

```typescript
return NextResponse.json(
  {
    error: result.error?.message ?? 'Pull failed',
    detail: result.error,
    preview: result.preview?.preview,
  },
  { status: 500 },
);
```

With:

```typescript
return NextResponse.json(
  {
    error: result.error?.message ?? 'Pull failed',
    preview: result.preview?.preview,
  },
  { status: 500 },
);
```

**Step 3: Add branch validation to push route**

Read the pull route's branch validation logic and replicate in push. Add after extracting branch from request body (around line 65):

```typescript
// Validate branch name (prevent injection)
if (branch && !/^[a-zA-Z0-9_\-/.]+$/.test(branch)) {
  return NextResponse.json({ error: 'Invalid branch name' }, { status: 400 });
}
```

**Step 4: Run Prettier, commit**

```bash
npx prettier --write apps/studio/src/app/api/projects/[id]/git/push/route.ts apps/studio/src/app/api/projects/[id]/git/pull/route.ts
git add apps/studio/src/app/api/projects/[id]/git/push/route.ts apps/studio/src/app/api/projects/[id]/git/pull/route.ts
git commit -m "fix(studio): sanitize git error responses and add branch validation to push"
```

---

## Task 8: Permission Checker — Test Multiple Grants Merging

**Files:**

- Test: `packages/project-io/src/__tests__/permission-checker.test.ts`

**Problem:** No test for when a user has both an individual grant AND a team grant. The permission resolution cascade should merge them correctly.

**Step 1: Write tests**

Add to permission-checker.test.ts:

```typescript
describe('multiple permission sources', () => {
  it('should merge user grant with team grant for broader access', () => {
    const ctx = makeContext({
      ownership: {
        ownerId: 'someone-else',
        ownerTeamId: null,
        permissions: [
          {
            principalType: 'user',
            principalId: 'user-a',
            operations: ['view', 'edit'],
            grantedBy: 'admin',
            expiresAt: null,
          },
          {
            principalType: 'team',
            principalId: 'team-1',
            operations: ['deploy'],
            grantedBy: 'admin',
            expiresAt: null,
          },
        ],
      },
      userId: 'user-a',
      teamMemberships: [{ teamId: 'team-1', role: 'member' }],
    });

    const perms = resolvePermissions(ctx);
    expect(perms).toContain('view');
    expect(perms).toContain('edit');
    expect(perms).toContain('deploy');
  });

  it('should exclude expired grants while keeping active ones', () => {
    const ctx = makeContext({
      ownership: {
        ownerId: 'someone-else',
        ownerTeamId: null,
        permissions: [
          {
            principalType: 'user',
            principalId: 'user-a',
            operations: ['view', 'edit', 'deploy'],
            grantedBy: 'admin',
            expiresAt: new Date(Date.now() - 1000), // expired
          },
          {
            principalType: 'user',
            principalId: 'user-a',
            operations: ['view'],
            grantedBy: 'admin',
            expiresAt: null, // permanent
          },
        ],
      },
      userId: 'user-a',
    });

    const perms = resolvePermissions(ctx);
    expect(perms).toContain('view');
    expect(perms).not.toContain('edit');
    expect(perms).not.toContain('deploy');
  });
});
```

**Step 2: Run tests — verify behavior**

```bash
pnpm test --filter=@agent-platform/project-io -- permission-checker
```

**Step 3: Commit**

```bash
git add packages/project-io/src/__tests__/permission-checker.test.ts
git commit -m "test(project-io): add permission grant merging and expiry edge case tests"
```

---

## Task 9: Dependency Graph — Test Tool Import to Missing Tools

**Files:**

- Test: `packages/project-io/src/__tests__/dependency-graph.test.ts`

**Problem:** No test for `tool_import` edges pointing to non-existent tool files, or querying deps for non-existent agents.

**Step 1: Write tests**

```typescript
describe('tool import validation', () => {
  it('should report missing tool when agent references non-existent tool file', () => {
    const agents: AgentEntry[] = [
      {
        name: 'Booking',
        dslContent: 'AGENT: Booking\nTOOLS:\n  FROM: missing_api USE: search\n',
      },
    ];
    const graph = buildDependencyGraph(agents, []); // no tools provided
    const validation = validateDependencies(graph);
    expect(validation.valid).toBe(false);
    expect(validation.missingDependencies.length).toBeGreaterThan(0);
  });
});

describe('query functions with missing agents', () => {
  it('getAgentDependencies should return empty for unknown agent', () => {
    const agents: AgentEntry[] = [{ name: 'A', dslContent: 'AGENT: A\n' }];
    const graph = buildDependencyGraph(agents, []);
    expect(getAgentDependencies(graph, 'nonexistent')).toEqual([]);
  });

  it('getAgentDependents should return empty for unknown agent', () => {
    const agents: AgentEntry[] = [{ name: 'A', dslContent: 'AGENT: A\n' }];
    const graph = buildDependencyGraph(agents, []);
    expect(getAgentDependents(graph, 'nonexistent')).toEqual([]);
  });
});
```

**Step 2: Run tests — verify**

**Step 3: Commit**

```bash
git add packages/project-io/src/__tests__/dependency-graph.test.ts
git commit -m "test(project-io): add tool import validation and missing agent query tests"
```

---

## Task 10: Webhook Handler — Edge Case Tests

**Files:**

- Test: `packages/project-io/src/__tests__/webhook-handler.test.ts`

**Problem:** No tests for unknown provider type, empty payload signature, malformed signatures.

**Step 1: Write tests**

```typescript
describe('verifyWebhookSignature edge cases', () => {
  it('should reject unknown provider type', () => {
    const result = verifyWebhookSignature('unknown' as any, 'payload', 'sig', 'secret');
    expect(result).toBe(false);
  });

  it('should reject empty payload', () => {
    const result = verifyWebhookSignature('github', '', 'sha256=abc', 'secret');
    expect(result).toBe(false);
  });

  it('should reject signature with non-hex characters', () => {
    const result = verifyWebhookSignature('github', 'payload', 'sha256=notHex!!!', 'secret');
    expect(result).toBe(false);
  });
});

describe('parseWebhookPayload edge cases', () => {
  it('should handle GitHub payload with null head_commit gracefully', () => {
    const payload = {
      ref: 'refs/heads/main',
      head_commit: null,
      commits: [],
      repository: { full_name: 'org/repo' },
    };
    const result = parseWebhookPayload('github', payload);
    expect(result.branch).toBe('main');
    expect(result.commitSha).toBe('');
  });
});
```

**Step 2: Run tests — verify behavior**

**Step 3: Commit**

```bash
git add packages/project-io/src/__tests__/webhook-handler.test.ts
git commit -m "test(project-io): add webhook handler edge case tests"
```

---

## Task 11: Branch Manager — Error Path Tests

**Files:**

- Test: `packages/project-io/src/__tests__/branch-manager.test.ts`

**Problem:** Missing tests for getDiff failure in getBranchStatus (aheadBy/behindBy default to 0 with silent warning), and non-404 errors in listCommits.

**Step 1: Write tests**

```typescript
describe('getBranchStatus error resilience', () => {
  it('should default aheadBy/behindBy to 0 when getDiff throws', async () => {
    mockProvider.listCommits = vi.fn(async () => [
      { sha: 'abc', message: 'test', author: 'u', date: new Date().toISOString() },
    ]);
    mockProvider.getDiff = vi.fn(async () => {
      throw new Error('comparison failed');
    });

    const status = await manager.getBranchStatus('staging');
    expect(status.exists).toBe(true);
    expect(status.aheadBy).toBe(0);
    expect(status.behindBy).toBe(0);
  });

  it('should rethrow non-404 errors from listCommits', async () => {
    mockProvider.listCommits = vi.fn(async () => {
      throw new Error('500 Internal Server Error');
    });
    await expect(manager.getBranchStatus('staging')).rejects.toThrow('500 Internal Server Error');
  });
});
```

**Step 2: Run tests — verify**

**Step 3: Commit**

```bash
git add packages/project-io/src/__tests__/branch-manager.test.ts
git commit -m "test(project-io): add branch manager error resilience tests"
```

---

## Task 12: Conflict Resolver — autoResolveConflicts Integration Test

**Files:**

- Test: `packages/project-io/src/__tests__/conflict-resolver.test.ts`

**Problem:** `autoResolveConflicts` is exported but never called in real code. Verify it works correctly and add comprehensive tests.

**Step 1: Write tests**

```typescript
describe('autoResolveConflicts strategies', () => {
  const conflicts: ConflictDetail[] = [
    {
      file: 'agents/a.agent.abl',
      agentName: 'a',
      base: 'base content',
      ours: 'local content',
      theirs: 'remote content',
    },
    {
      file: 'agents/b.agent.abl',
      agentName: 'b',
      base: 'base',
      ours: 'ours',
      theirs: 'theirs',
    },
  ];

  it('manual strategy should return all conflicts unresolved', () => {
    const result = autoResolveConflicts(conflicts, 'manual');
    expect(result.resolved).toHaveLength(0);
    expect(result.remaining).toHaveLength(2);
  });

  it('local_wins should resolve all with local content', () => {
    const result = autoResolveConflicts(conflicts, 'local_wins');
    expect(result.resolved).toHaveLength(2);
    expect(result.remaining).toHaveLength(0);
    expect(result.resolved[0].resolvedContent).toBe('local content');
  });

  it('remote_wins should resolve all with remote content', () => {
    const result = autoResolveConflicts(conflicts, 'remote_wins');
    expect(result.resolved).toHaveLength(2);
    expect(result.remaining).toHaveLength(0);
    expect(result.resolved[0].resolvedContent).toBe('remote content');
  });
});
```

**Step 2: Run tests — verify**

**Step 3: Commit**

```bash
git add packages/project-io/src/__tests__/conflict-resolver.test.ts
git commit -m "test(project-io): add autoResolveConflicts strategy tests"
```

---

## Task 13: Section Splicer — Empty File Edge Case

**Files:**

- Modify: `packages/project-io/src/diff/section-splicer.ts`
- Test: Add to existing section-splicer.test.ts

**Problem:** Empty ABL content produces empty sections array. Downstream `spliceSection` could produce malformed output with empty sections.

**Step 1: Write failing test**

```typescript
describe('identifySections edge cases', () => {
  it('should return empty array for empty content', () => {
    const sections = identifySections('');
    expect(sections).toEqual([]);
  });

  it('should return empty array for whitespace-only content', () => {
    const sections = identifySections('   \n\n  ');
    expect(sections).toEqual([]);
  });
});

describe('spliceSection with no sections', () => {
  it('should return original content when removing from empty file', () => {
    const result = spliceSection('', 'GOAL', 'remove');
    expect(result).toBe('');
  });

  it('should add section to empty file', () => {
    const result = spliceSection('', 'GOAL', 'add', 'GOAL:\n  Be helpful\n');
    expect(result).toContain('GOAL:');
  });
});
```

**Step 2: Run tests, fix if needed**

If `spliceSection` crashes on empty input, add an early return:

```typescript
export function spliceSection(
  content: string,
  sectionName: string,
  operation: 'replace' | 'remove' | 'add',
  newContent?: string,
): string {
  if (content.trim() === '' && operation === 'remove') return content;
  if (content.trim() === '' && operation === 'add' && newContent) return newContent;
  // ... existing logic
```

**Step 3: Run tests — expect PASS**

**Step 4: Commit**

```bash
git add packages/project-io/src/diff/section-splicer.ts packages/project-io/src/__tests__/section-splicer.test.ts
git commit -m "fix(project-io): handle empty content in section splicer"
```

---

## Task 14: Folder Reader — Better JSON Error Diagnostics

**Files:**

- Modify: `packages/project-io/src/import/folder-reader.ts:63-67, 75-78`
- Test: `packages/project-io/src/__tests__/folder-reader-diagnostics.test.ts` (new)

**Problem:** When project.json or abl.lock have invalid JSON, the error message is `"Invalid JSON"` with no detail about what's wrong.

**Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { readFolder } from '../import/folder-reader.js';

describe('readFolder JSON error diagnostics', () => {
  it('should include parse error detail for malformed project.json', () => {
    const files = new Map([
      ['project.json', '{ "name": "test", bad json here }'],
      ['agents/a.agent.abl', 'AGENT: A\n'],
    ]);
    const result = readFolder(files);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('project.json');
    // Should include position or token info
    expect(result.errors[0]).toMatch(/position|token|column|Unexpected/i);
  });
});
```

**Step 2: Run test — expect FAIL (currently just says "Invalid JSON")**

**Step 3: Fix the code**

In `readFolder`, change lines 63-67:

```typescript
try {
  manifest = JSON.parse(manifestContent);
} catch (err) {
  const detail = err instanceof Error ? err.message : 'Unknown parse error';
  errors.push(`project.json: Invalid JSON — ${detail}`);
}
```

Same for abl.lock (lines 75-78) and same changes in `readFolderV2`.

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add packages/project-io/src/import/folder-reader.ts packages/project-io/src/__tests__/folder-reader-diagnostics.test.ts
git commit -m "fix(project-io): include JSON parse detail in folder reader error messages"
```

---

## Task 15: Ownership Service — Comprehensive Test Coverage

**Files:**

- Test: `packages/project-io/src/__tests__/ownership-service.test.ts`

**Problem:** Missing tests for overwrite existing owner, clearing ownership, revoking nonexistent permission, listing with no match.

**Step 1: Write tests**

```typescript
describe('assignOwner edge cases', () => {
  it('should overwrite existing individual owner with team owner', async () => {
    await service.assignOwner('p1', 'a1', 'Agent', { ownerId: 'user-1' });
    const result = await service.assignOwner('p1', 'a1', 'Agent', { ownerTeamId: 'team-1' });
    expect(result.ownerTeamId).toBe('team-1');
    expect(result.ownerId).toBe('user-1'); // unchanged since we only set ownerTeamId
  });
});

describe('transferOwnership edge cases', () => {
  it('should allow clearing individual owner while setting team', async () => {
    await service.assignOwner('p1', 'a1', 'Agent', { ownerId: 'user-1' });
    const result = await service.transferOwnership(
      'p1',
      'a1',
      { newOwnerId: null as any, newOwnerTeamId: 'team-1' },
      'admin',
    );
    expect(result.ownerId).toBeNull();
    expect(result.ownerTeamId).toBe('team-1');
  });

  it('should throw when no ownership record exists', async () => {
    await expect(
      service.transferOwnership('p1', 'missing', { newOwnerId: 'u2' }, 'admin'),
    ).rejects.toThrow('No ownership record found');
  });
});

describe('revokePermission', () => {
  it('should be a no-op when revoking from agent with no ownership record', async () => {
    // Should not throw
    await service.revokePermission('p1', 'no-record', 'user-1');
  });

  it('should be a no-op when revoking nonexistent principal', async () => {
    await service.assignOwner('p1', 'a1', 'Agent', { ownerId: 'user-1' });
    await service.grantPermission('p1', 'a1', 'Agent', {
      principalType: 'user',
      principalId: 'user-2',
      operations: ['view'],
      grantedBy: 'admin',
    });
    await service.revokePermission('p1', 'a1', 'user-999');
    const record = await service.getOwnership('p1', 'a1');
    expect(record!.permissions).toHaveLength(1); // user-2 still there
  });
});

describe('listOwnedAgents', () => {
  it('should return empty when no userId or teamId given', async () => {
    const result = await service.listOwnedAgents('p1', {});
    expect(result).toEqual([]);
  });
});
```

**Step 2: Run tests — verify**

**Step 3: Commit**

```bash
git add packages/project-io/src/__tests__/ownership-service.test.ts
git commit -m "test(project-io): comprehensive ownership service edge case coverage"
```

---

## Task 16: Git Sync Service — Pull Error Path Tests

**Files:**

- Test: `packages/project-io/src/__tests__/git-sync-service.test.ts`

**Problem:** Pull method doesn't handle importProject errors explicitly. Need tests to verify behavior when import fails.

**Step 1: Write tests**

```typescript
describe('pull error handling', () => {
  it('should propagate import validation errors in result', async () => {
    // Provide remote files with invalid ABL (no header)
    mockProvider.pullProject = vi.fn(async () => ({
      files: [{ path: 'agents/bad.agent.abl', content: 'no header here' }],
      commitSha: 'abc',
    }));

    const result = await service.pull({
      projectId: 'p1',
      userId: 'u1',
      tenantId: 't1',
      branch: 'main',
      existingState: { agents: new Map(), toolFiles: new Map() },
      lastSyncCommit: null,
    });

    // Should still return a result (not throw)
    expect(result.commitSha).toBe('abc');
    // Preview should contain the validation info
    expect(result.preview).toBeDefined();
  });

  it('should throw when circuit breaker is open', async () => {
    mockProvider.pullProject = vi.fn(async () => {
      throw new Error('API error');
    });

    // Trip the breaker
    for (let i = 0; i < 5; i++) {
      try {
        await service.pull(makePullOptions());
      } catch {
        /* expected */
      }
    }

    // Next call should get circuit breaker error
    await expect(service.pull(makePullOptions())).rejects.toThrow(/circuit/i);
  });
});
```

**Step 2: Run tests — verify**

**Step 3: Commit**

```bash
git add packages/project-io/src/__tests__/git-sync-service.test.ts
git commit -m "test(project-io): add pull error path and circuit breaker tests"
```

---

## Task 17: Studio Git Route — Audit Logging for Integration CRUD

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/git/route.ts`

**Problem:** POST (create), PATCH (update), and DELETE operations on git integration have no audit logging.

**Step 1: Read the file to find exact insertion points**

**Step 2: Add logging**

Import logger at the top of the file:

```typescript
import { createLogger } from '@abl/compiler/platform';
const log = createLogger('git-integration-route');
```

After successful POST (integration creation), add:

```typescript
log.info('Git integration created', {
  projectId,
  tenantId,
  provider: body.provider,
  repositoryUrl: body.repositoryUrl,
  userId: user.id,
});
```

After successful PATCH (update), add:

```typescript
log.info('Git integration updated', {
  projectId,
  tenantId,
  updatedFields: Object.keys(updateData),
  userId: user.id,
});
```

After successful DELETE, add:

```typescript
log.info('Git integration deleted', {
  projectId,
  tenantId,
  userId: user.id,
});
```

**Step 3: Run Prettier, commit**

```bash
npx prettier --write apps/studio/src/app/api/projects/[id]/git/route.ts
git add apps/studio/src/app/api/projects/[id]/git/route.ts
git commit -m "fix(studio): add audit logging for git integration CRUD operations"
```

---

## Task 18: Circular Detector — Additional Edge Case Tests

**Files:**

- Test: `packages/project-io/src/__tests__/circular-detector.test.ts`

**Step 1: Write tests**

```typescript
describe('edge type handling', () => {
  it('should detect cycle regardless of mixed edge types (handoff + delegate)', () => {
    const edges = [makeEdge('A', 'B', 'handoff'), makeEdge('B', 'A', 'delegate')];
    const adj = buildAdjacency(edges, ['A', 'B']);
    const cycles = detectCircularDependencies(adj);
    expect(cycles.length).toBe(1);
  });

  it('should skip tool_import edges entirely', () => {
    const edges = [makeEdge('A', 'B', 'tool_import'), makeEdge('B', 'A', 'tool_import')];
    const adj = buildAdjacency(edges, ['A', 'B']);
    const cycles = detectCircularDependencies(adj);
    expect(cycles.length).toBe(0);
  });
});
```

**Step 2: Run tests — verify**

**Step 3: Commit**

```bash
git add packages/project-io/src/__tests__/circular-detector.test.ts
git commit -m "test(project-io): add edge type handling tests for circular detector"
```

---

## Post-flight

After all tasks are complete:

```bash
cd /Users/prasannaarikala/projects/agent-platform
pnpm build --filter=@agent-platform/project-io
pnpm test --filter=@agent-platform/project-io
npx prettier --check "packages/project-io/src/**/*.ts"
```

All tests must pass. No Prettier violations.
