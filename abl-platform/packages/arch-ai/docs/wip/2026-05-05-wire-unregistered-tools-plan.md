# Wire 4 Unregistered Arch-AI Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `agent_ops`, `deployment_ops`, `testing_ops`, `analytics_ops` tools to the LLM via `buildInProjectTools` so they become invokable in IN_PROJECT mode. Resolve pre-existing specialist-tool-map drift in the same change.

**Architecture:** Each tool is a thin Zod-schema-validated `tool({ description, inputSchema, execute })` registration that lazy-imports the existing executor (no executor changes). Specialist allow-lists in `IN_PROJECT_SPECIALIST_TOOL_MAP` (authoritative + display copy) get the new tool names; pre-existing drift between the two maps is resolved alongside. Permissions are already in `guards.ts`; `DANGEROUS_ACTIONS` gets `configure_channel` added and orphan `rollback` removed.

**Tech Stack:** TypeScript, Zod, Vercel AI SDK `tool()`, vitest, existing `executeToolsOps`-style executors.

**Spec:** [packages/arch-ai/docs/wip/2026-05-05-wire-unregistered-tools-spec.md](./2026-05-05-wire-unregistered-tools-spec.md)

---

## Task 1: Add 4 entries to `ToolName` union

**Files:**

- Modify: `packages/arch-ai/src/types/tools.ts:10-53`

**Why first:** TypeScript will reject every subsequent change that references these names until the union includes them.

- [ ] **Step 1: Edit `packages/arch-ai/src/types/tools.ts`, append 4 entries before `'search_docs'` on line 53**

```ts
  | 'kb_documents'
  | 'agent_ops'
  | 'deployment_ops'
  | 'testing_ops'
  | 'analytics_ops'
  | 'search_docs';
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm build --filter=@agent-platform/arch-ai
```

Expected: PASS — no consumers reference these yet.

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write packages/arch-ai/src/types/tools.ts
git add packages/arch-ai/src/types/tools.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] feat(shared): extend ToolName union with 4 in-project tools

Adds agent_ops, deployment_ops, testing_ops, analytics_ops to the
ToolName union so subsequent registration commits compile cleanly.
EOF
)"
```

(Replace `ABLP-162` with the actual ticket. If no ticket exists, create one before committing per CLAUDE.md JIRA Workflow.)

---

## Task 2: Resolve pre-existing `IN_PROJECT_SPECIALIST_TOOL_MAP` drift + add drift test

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/tools/build-tools.ts:50-182`
- Create: `packages/arch-ai/src/__tests__/specialist-tool-map-drift.test.ts`

**Why before tool wiring:** Tasks 3-6 each add entries to BOTH maps. If `build-tools.ts` already lags `types/tools.ts` by 9 entries, those tasks would be additive against a broken baseline. Fix the baseline first, then additions stay clean.

**Drift to resolve** (from spec §4.3):

| Specialist                  | Add to `build-tools.ts`                          |
| --------------------------- | ------------------------------------------------ |
| `diagnostician`             | `search_docs`                                    |
| `abl-construct-expert`      | `search_docs`                                    |
| `channel-voice`             | `search_docs`                                    |
| `entity-collection`         | `search_docs`                                    |
| `analyst`                   | `search_docs`                                    |
| `observer`                  | `search_docs`                                    |
| `multi-agent-architect`     | `read_agent`, `search_docs`                      |
| `testing-eval`              | `search_docs`                                    |
| `integration-methodologist` | `variable_ops`, `integration_ops`, `search_docs` |

- [ ] **Step 1: Write failing drift test**

Create `packages/arch-ai/src/__tests__/specialist-tool-map-drift.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { IN_PROJECT_SPECIALIST_TOOL_MAP as packageMap } from '../types/tools.js';

describe('IN_PROJECT_SPECIALIST_TOOL_MAP drift', () => {
  it('package and Studio definitions agree per specialist', async () => {
    const studioModule =
      await import('../../../../../apps/studio/src/lib/arch-ai/tools/build-tools');
    const studioMap = studioModule.IN_PROJECT_SPECIALIST_TOOL_MAP as Record<
      string,
      readonly string[]
    >;

    const specialists = Object.keys(packageMap) as Array<keyof typeof packageMap>;
    for (const specialist of specialists) {
      const fromPackage = [...(packageMap[specialist] ?? [])].sort();
      const fromStudio = [...(studioMap[specialist] ?? [])].sort();
      expect(fromStudio, `Specialist '${String(specialist)}' drift`).toEqual(fromPackage);
    }
  });
});
```

- [ ] **Step 2: Run test — expected to fail**

```bash
pnpm vitest run packages/arch-ai/src/__tests__/specialist-tool-map-drift.test.ts
```

Expected: FAIL — Studio map missing 12 entries across 9 specialists.

- [ ] **Step 3: Fix `apps/studio/src/lib/arch-ai/tools/build-tools.ts`**

For each of the 9 specialists in `IN_PROJECT_SPECIALIST_TOOL_MAP` (lines 50-182), add the missing tool names to match the package definition. Specifically:

- `diagnostician` (line 51): append `'search_docs'` after `'manage_memory'` (before `...KB_TOOL_NAMES`)
- `abl-construct-expert` (line 72): append `'search_docs'` similarly
- `channel-voice` (line 90): append `'search_docs'` after `'manage_memory'`
- `entity-collection` (line 101): append `'search_docs'`
- `analyst` (line 112): append `'search_docs'`
- `observer` (line 126): append `'search_docs'`
- `multi-agent-architect` (line 142): add `'read_agent'` as second entry; append `'search_docs'` at end
- `testing-eval` (line 154): append `'search_docs'`
- `integration-methodologist` (line 166): add `'variable_ops'` and `'integration_ops'` (positions matching `types/tools.ts:253,256`); append `'search_docs'`

- [ ] **Step 4: Run drift test — expected to pass**

```bash
pnpm vitest run packages/arch-ai/src/__tests__/specialist-tool-map-drift.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

```bash
pnpm build --filter=@agent-platform/arch-ai --filter=@agent-platform/studio
```

Expected: PASS.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/tools/build-tools.ts packages/arch-ai/src/__tests__/specialist-tool-map-drift.test.ts
git add apps/studio/src/lib/arch-ai/tools/build-tools.ts packages/arch-ai/src/__tests__/specialist-tool-map-drift.test.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] fix(studio): align specialist tool map with package definition

Resolves drift between IN_PROJECT_SPECIALIST_TOOL_MAP in
packages/arch-ai/src/types/tools.ts (authoritative) and
apps/studio/src/lib/arch-ai/tools/build-tools.ts (display copy).

Adds 12 missing entries across 9 specialists. Adds a contract test
that asserts both definitions stay aligned going forward.
EOF
)"
```

---

## Task 3: Wire `agent_ops` tool

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts` (add registration block)
- Modify: `packages/arch-ai/src/types/tools.ts` (add `'agent_ops'` to specialist allow-lists)
- Modify: `apps/studio/src/lib/arch-ai/tools/build-tools.ts` (mirror)
- Create: `apps/studio/src/__tests__/arch-ai/agent-ops.test.ts`

**Specialists granted:** `abl-construct-expert`, `multi-agent-architect`, `diagnostician`.

- [ ] **Step 1: Write failing executor test**

Create `apps/studio/src/__tests__/arch-ai/agent-ops.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPermissionContext } from '@/lib/arch-ai/guards';

const { findProjectAgentMock, getProjectAgentsMock, deleteProjectAgentMock } = vi.hoisted(() => ({
  findProjectAgentMock: vi.fn(),
  getProjectAgentsMock: vi.fn(),
  deleteProjectAgentMock: vi.fn(),
}));

vi.mock('@/repos/project-repo', () => ({
  findProjectAgent: findProjectAgentMock,
  getProjectAgents: getProjectAgentsMock,
  deleteProjectAgent: deleteProjectAgentMock,
}));

const TOOL_CONTEXT: ToolPermissionContext = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
  authToken: 'token-1',
  user: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    permissions: ['agent:read', 'agent:update', 'agent:delete'],
  },
};

describe('agent_ops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists agents in the project', async () => {
    getProjectAgentsMock.mockResolvedValue([
      { name: 'Refund', dslContent: 'AGENT: Refund\n' },
      { name: 'Router', dslContent: 'SUPERVISOR: Router\n' },
    ]);

    const { executeAgentOps } = await import('@/lib/arch-ai/tools/agent-ops');
    const result = await executeAgentOps({ action: 'list' }, TOOL_CONTEXT);

    expect(result.success).toBe(true);
    expect(getProjectAgentsMock).toHaveBeenCalledWith('proj-1', 'tenant-1');
  });

  it('returns needsConfirmation when delete is unconfirmed', async () => {
    const { executeAgentOps } = await import('@/lib/arch-ai/tools/agent-ops');
    const result = await executeAgentOps({ action: 'delete', agentName: 'Refund' }, TOOL_CONTEXT);

    expect(result.needsConfirmation).toBe(true);
    expect(deleteProjectAgentMock).not.toHaveBeenCalled();
  });

  it('returns FORBIDDEN when permission missing', async () => {
    const noPerm: ToolPermissionContext = {
      ...TOOL_CONTEXT,
      user: { ...TOOL_CONTEXT.user, permissions: [] },
    };

    const { executeAgentOps } = await import('@/lib/arch-ai/tools/agent-ops');
    const result = await executeAgentOps({ action: 'list' }, noPerm);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN');
  });
});
```

- [ ] **Step 2: Run test — expected to pass (executor already works)**

```bash
pnpm vitest run apps/studio/src/__tests__/arch-ai/agent-ops.test.ts
```

Expected: PASS — `executeAgentOps` already exists; the test exercises it.

- [ ] **Step 3: Add `agent_ops` registration to `in-project-tools.ts`**

In `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`, immediately AFTER the `tools_ops` registration block (which ends around line 2217), insert:

```ts
    agent_ops: tool({
      description:
        'Direct project agent CRUD. Actions: read, list, create, modify, compile, delete (requires confirmed: true), propose_modification. Use propose_modification + apply_modification for safe iterative edits; use create/modify only for trusted bulk authoring. Returns the agent record or compile diagnostics.',
      inputSchema: z.object({
        action: z.enum([
          'read',
          'list',
          'create',
          'modify',
          'compile',
          'delete',
          'propose_modification',
        ]),
        agentName: z.string().min(1).optional().describe('Agent name'),
        content: z.string().optional().describe('Full ABL content (for create)'),
        edits: z
          .array(
            z.object({
              section: z.string().min(1),
              content: z.string().nullable(),
            }),
          )
          .optional()
          .describe('Section edits (for modify)'),
        dryRun: z.boolean().optional().describe('Validate without writing'),
        confirmed: z.boolean().optional().describe('Confirmation flag (required for delete)'),
        modification: z
          .string()
          .optional()
          .describe('Free-text mutation (for propose_modification)'),
        changes: z
          .array(
            z.object({
              construct: z.string(),
              before: z.string().nullable(),
              after: z.string().nullable(),
              rationale: z.string(),
            }),
          )
          .optional()
          .describe('Structured proposal (for propose_modification)'),
      }),
      execute: async (input) => {
        const { executeAgentOps } = await import('@/lib/arch-ai/tools/agent-ops');
        return executeAgentOps(input, {
          projectId,
          sessionId,
          user: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            permissions: ctx.permissions ?? [],
          },
          authToken,
        });
      },
    }),
```

- [ ] **Step 4: Add `'agent_ops'` to specialist allow-lists in `packages/arch-ai/src/types/tools.ts`**

In `IN_PROJECT_SPECIALIST_TOOL_MAP`:

- `diagnostician` (line 116): append `'agent_ops'` (e.g., between `'configure_model'` and `'recommend_model'`)
- `abl-construct-expert` (line 139): append `'agent_ops'` similarly
- `multi-agent-architect` (line 215): append `'agent_ops'`

- [ ] **Step 5: Mirror in `apps/studio/src/lib/arch-ai/tools/build-tools.ts`**

Same insertions in the same three specialists.

- [ ] **Step 6: Run drift test + executor test**

```bash
pnpm vitest run packages/arch-ai/src/__tests__/specialist-tool-map-drift.test.ts apps/studio/src/__tests__/arch-ai/agent-ops.test.ts
```

Expected: PASS for both.

- [ ] **Step 7: Run typecheck**

```bash
pnpm build --filter=@agent-platform/arch-ai --filter=@agent-platform/studio
```

Expected: PASS.

- [ ] **Step 8: Format and commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/tools/in-project-tools.ts packages/arch-ai/src/types/tools.ts apps/studio/src/lib/arch-ai/tools/build-tools.ts apps/studio/src/__tests__/arch-ai/agent-ops.test.ts
git add apps/studio/src/lib/arch-ai/tools/in-project-tools.ts packages/arch-ai/src/types/tools.ts apps/studio/src/lib/arch-ai/tools/build-tools.ts apps/studio/src/__tests__/arch-ai/agent-ops.test.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] feat(shared): wire agent_ops tool for in-project agent CRUD

Registers agent_ops in buildInProjectTools and grants it to
diagnostician, abl-construct-expert, and multi-agent-architect
specialists. Executor (executeAgentOps) was already implemented;
this commit only wires the LLM-facing surface.

Adds executor-level test covering list, delete-confirmation gate,
and FORBIDDEN permission path.
EOF
)"
```

---

## Task 4: Wire `deployment_ops` + update `DANGEROUS_ACTIONS`

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts` (add registration)
- Modify: `packages/arch-ai/src/types/tools.ts` (allow-list)
- Modify: `apps/studio/src/lib/arch-ai/tools/build-tools.ts` (mirror)
- Modify: `apps/studio/src/lib/arch-ai/guards.ts:178-191` (`DANGEROUS_ACTIONS`)
- Create: `apps/studio/src/__tests__/arch-ai/deployment-ops.test.ts`

**Specialists granted:** `multi-agent-architect`, `integration-methodologist`.

**Permissions changes:**

- ADD `configure_channel` to `DANGEROUS_ACTIONS.deployment_ops`.
- REMOVE orphan `rollback` from `DANGEROUS_ACTIONS.deployment_ops` (no executor case exists).

**Action enum (ship subset per spec §7):** `list`, `deploy`, `promote`, `configure_channel`, `list_channels`. Defer none — all 5 have executor cases.

- [ ] **Step 1: Write failing executor test**

Create `apps/studio/src/__tests__/arch-ai/deployment-ops.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPermissionContext } from '@/lib/arch-ai/guards';

const { fetchDeploymentsMock, fetchMock } = vi.hoisted(() => ({
  fetchDeploymentsMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@/api/deployments', () => ({
  fetchDeployments: fetchDeploymentsMock,
  createDeployment: vi.fn(),
  promoteDeployment: vi.fn(),
}));

vi.stubGlobal('fetch', fetchMock);

const TOOL_CONTEXT: ToolPermissionContext = {
  projectId: 'proj-1',
  authToken: 'token-1',
  user: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    permissions: ['deployment:read', 'deployment:create', 'channel:read', 'channel:update'],
  },
};

describe('deployment_ops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists deployments', async () => {
    fetchDeploymentsMock.mockResolvedValue([{ id: 'dep-1', environment: 'staging' }]);

    const { executeDeploymentOps } = await import('@/lib/arch-ai/tools/deployment-ops');
    const result = await executeDeploymentOps({ action: 'list' }, TOOL_CONTEXT);

    expect(result.success).toBe(true);
    expect(fetchDeploymentsMock).toHaveBeenCalled();
  });

  it('blocks deploy without confirmed flag', async () => {
    const { executeDeploymentOps } = await import('@/lib/arch-ai/tools/deployment-ops');
    const result = await executeDeploymentOps(
      { action: 'deploy', environment: 'production' },
      TOOL_CONTEXT,
    );

    expect(result.needsConfirmation).toBe(true);
  });

  it('lists channels via runtime', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ channels: [{ id: 'chan-1', name: 'Slack', channelType: 'slack' }] }),
    });

    const { executeDeploymentOps } = await import('@/lib/arch-ai/tools/deployment-ops');
    const result = await executeDeploymentOps({ action: 'list_channels' }, TOOL_CONTEXT);

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/proj-1/sdk-channels'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-1' }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run test — expected to pass**

```bash
pnpm vitest run apps/studio/src/__tests__/arch-ai/deployment-ops.test.ts
```

Expected: PASS.

- [ ] **Step 3: Update `DANGEROUS_ACTIONS` in `apps/studio/src/lib/arch-ai/guards.ts:186`**

Change:

```ts
  deployment_ops: ['deploy', 'promote', 'rollback'],
```

to:

```ts
  // 'rollback' was previously listed but no executor case exists — drop until reimplemented.
  deployment_ops: ['deploy', 'promote', 'configure_channel'],
```

- [ ] **Step 4: Add `deployment_ops` registration to `in-project-tools.ts`**

After the `agent_ops` block from Task 3:

```ts
    deployment_ops: tool({
      description:
        'Manage deployments and project-level channel config. Actions: list (deployments), deploy (promote ABL to env, requires confirmed: true), promote (move between envs, requires confirmed: true), list_channels, configure_channel (creates or updates SDK channel — requires confirmed: true since it touches production routing). Channel agent-binding is NOT in this tool; future channel_ops will own that.',
      inputSchema: z.object({
        action: z.enum(['list', 'deploy', 'promote', 'configure_channel', 'list_channels']),
        deploymentId: z.string().optional(),
        environment: z.string().optional().describe('Target environment (staging, production)'),
        channelType: z.string().optional().describe('Channel type (slack, voice, web, etc.)'),
        channelConfig: z.record(z.unknown()).optional().describe('Channel config payload'),
        confirmed: z
          .boolean()
          .optional()
          .describe('Confirmation flag (required for deploy/promote/configure_channel)'),
      }),
      execute: async (input) => {
        const { executeDeploymentOps } = await import('@/lib/arch-ai/tools/deployment-ops');
        return executeDeploymentOps(input, {
          projectId,
          user: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            permissions: ctx.permissions ?? [],
          },
          authToken,
        });
      },
    }),
```

- [ ] **Step 5: Add to specialist allow-lists in `types/tools.ts`**

- `multi-agent-architect` (line 215): append `'deployment_ops'`
- `integration-methodologist` (line 242): append `'deployment_ops'`

- [ ] **Step 6: Mirror in `build-tools.ts`**

- [ ] **Step 7: Run drift + deployment-ops + analytics-ops + agent-ops tests**

```bash
pnpm vitest run packages/arch-ai/src/__tests__/specialist-tool-map-drift.test.ts apps/studio/src/__tests__/arch-ai/deployment-ops.test.ts apps/studio/src/__tests__/arch-ai/agent-ops.test.ts
```

Expected: PASS.

- [ ] **Step 8: Confirm `executeDeploymentOps` enforces `configure_channel` confirmation**

Read `apps/studio/src/lib/arch-ai/tools/deployment-ops.ts` and verify the `configure_channel` case checks `input.confirmed`. If it does NOT, add a confirmation gate that mirrors the `deploy` case. (Per spec §4.4: `configure_channel` mutates production routing and needs a confirmation gate.)

If a fix is needed, write the test for it BEFORE editing:

```ts
it('blocks configure_channel without confirmed flag', async () => {
  const { executeDeploymentOps } = await import('@/lib/arch-ai/tools/deployment-ops');
  const result = await executeDeploymentOps(
    { action: 'configure_channel', channelType: 'slack', channelConfig: {} },
    TOOL_CONTEXT,
  );

  expect(result.needsConfirmation).toBe(true);
});
```

Then patch `deployment-ops.ts` to gate `configure_channel` on `confirmed`.

- [ ] **Step 9: Typecheck and commit**

```bash
pnpm build --filter=@agent-platform/arch-ai --filter=@agent-platform/studio
npx prettier --write apps/studio/src/lib/arch-ai/tools/in-project-tools.ts apps/studio/src/lib/arch-ai/tools/deployment-ops.ts apps/studio/src/lib/arch-ai/guards.ts packages/arch-ai/src/types/tools.ts apps/studio/src/lib/arch-ai/tools/build-tools.ts apps/studio/src/__tests__/arch-ai/deployment-ops.test.ts
git add apps/studio/src/lib/arch-ai/tools/in-project-tools.ts apps/studio/src/lib/arch-ai/tools/deployment-ops.ts apps/studio/src/lib/arch-ai/guards.ts packages/arch-ai/src/types/tools.ts apps/studio/src/lib/arch-ai/tools/build-tools.ts apps/studio/src/__tests__/arch-ai/deployment-ops.test.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] feat(shared): wire deployment_ops tool + harden DANGEROUS_ACTIONS

Registers deployment_ops in buildInProjectTools (list, deploy, promote,
configure_channel, list_channels). Granted to multi-agent-architect and
integration-methodologist.

DANGEROUS_ACTIONS changes:
- Add configure_channel (mutates production routing).
- Remove orphan rollback (no executor case existed).

Gates configure_channel on input.confirmed in executeDeploymentOps.
EOF
)"
```

---

## Task 5: Wire `testing_ops` + collapse standalone `run_test`

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts` (add `testing_ops`, remove `run_test` block at line 1467-1489)
- Modify: `packages/arch-ai/src/types/tools.ts` (replace `'run_test'` with `'testing_ops'` for `testing-eval`; add to `analyst`)
- Modify: `apps/studio/src/lib/arch-ai/tools/build-tools.ts` (mirror)
- Optional: `packages/arch-ai/src/types/tools.ts:23` — keep `'run_test'` in `ToolName` union for now (other code may reference) OR remove if no consumers
- Create: `apps/studio/src/__tests__/arch-ai/testing-ops.test.ts`

**Specialists granted:** `testing-eval` (replaces `run_test`), `analyst` (additive).

- [ ] **Step 1: Verify no consumers of `'run_test'` outside tool maps**

```bash
grep -rn "'run_test'" apps/studio/src packages/arch-ai/src --include='*.ts' --include='*.tsx' | grep -v tool-map | grep -v __tests__ | grep -v '\.d\.ts'
```

If only `in-project-tools.ts:1467` and the two specialist maps reference it, safe to collapse. If other code branches on the tool name, document and keep both registrations.

- [ ] **Step 2: Write failing testing_ops executor test**

Create `apps/studio/src/__tests__/arch-ai/testing-ops.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPermissionContext } from '@/lib/arch-ai/guards';

const { findProjectAgentMock, findEvalSetsByProjectMock, createEvalSetMock, fetchMock } =
  vi.hoisted(() => ({
    findProjectAgentMock: vi.fn(),
    findEvalSetsByProjectMock: vi.fn(),
    createEvalSetMock: vi.fn(),
    fetchMock: vi.fn(),
  }));

vi.mock('@/repos/project-repo', () => ({
  findProjectAgent: findProjectAgentMock,
}));
vi.mock('@/repos/eval-repo', () => ({
  findEvalSetsByProject: findEvalSetsByProjectMock,
  createEvalSet: createEvalSetMock,
}));
vi.stubGlobal('fetch', fetchMock);

const TOOL_CONTEXT: ToolPermissionContext = {
  projectId: 'proj-1',
  authToken: 'token-1',
  user: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    permissions: ['session:read', 'session:execute'],
  },
};

describe('testing_ops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs a test against the live runtime', async () => {
    findProjectAgentMock.mockResolvedValue({ name: 'Refund', dslContent: 'AGENT: Refund\n' });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ reply: 'Hello', sessionId: 'sess-99' }),
    });

    const { executeTestingOps } = await import('@/lib/arch-ai/tools/testing-ops');
    const result = await executeTestingOps(
      { action: 'run_test', agentName: 'Refund', testMessage: 'hi' },
      TOOL_CONTEXT,
    );

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/chat'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('lists eval sets for the project', async () => {
    findEvalSetsByProjectMock.mockResolvedValue([{ id: 'eval-1', name: 'happy path' }]);

    const { executeTestingOps } = await import('@/lib/arch-ai/tools/testing-ops');
    const result = await executeTestingOps({ action: 'list_evals' }, TOOL_CONTEXT);

    expect(result.success).toBe(true);
    expect(findEvalSetsByProjectMock).toHaveBeenCalledWith('tenant-1', 'proj-1');
  });

  it('persists eval set name only (Phase 1 caveat)', async () => {
    createEvalSetMock.mockResolvedValue({ id: 'eval-2', name: 'my eval' });

    const { executeTestingOps } = await import('@/lib/arch-ai/tools/testing-ops');
    const result = await executeTestingOps(
      {
        action: 'create_eval',
        evalConfig: {
          name: 'my eval',
          scenarios: [{ input: 'hi', expectedBehavior: 'greet' }],
        },
      },
      TOOL_CONTEXT,
    );

    expect(result.success).toBe(true);
    // Phase 1: scenarios are silently dropped — verify createEvalSet
    // was called without scenarios in payload.
    const callArgs = createEvalSetMock.mock.calls[0]?.[0] ?? {};
    expect(callArgs).not.toHaveProperty('scenarios');
  });
});
```

- [ ] **Step 3: Run test — expected to pass**

```bash
pnpm vitest run apps/studio/src/__tests__/arch-ai/testing-ops.test.ts
```

Expected: PASS.

- [ ] **Step 4: Add `testing_ops` registration to `in-project-tools.ts`**

After the `deployment_ops` block from Task 4:

```ts
    testing_ops: tool({
      description:
        'Test runs and eval CRUD (Phase 1: read + run + propose). Actions: run_test (live runtime call), list_evals (read eval sets), create_eval (persists name + description only — scenarios are saved via Studio UI in this phase). Phase 2 will add full eval-write surface when eval-quality validators land.',
      inputSchema: z.object({
        action: z.enum(['run_test', 'list_evals', 'create_eval']),
        agentName: z.string().min(1).optional().describe('Agent to test (for run_test)'),
        testMessage: z.string().min(1).optional().describe('Test message (for run_test)'),
        evalConfig: z
          .object({
            name: z.string().min(1),
            description: z.string().optional(),
            scenarios: z
              .array(z.object({ input: z.string(), expectedBehavior: z.string() }))
              .optional()
              .describe('Phase 1: scenarios are NOT persisted — save via Studio UI'),
          })
          .optional()
          .describe('Eval config (for create_eval)'),
      }),
      execute: async (input) => {
        const { executeTestingOps } = await import('@/lib/arch-ai/tools/testing-ops');
        return executeTestingOps(input, {
          projectId,
          user: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            permissions: ctx.permissions ?? [],
          },
          authToken,
        });
      },
    }),
```

- [ ] **Step 5: Remove standalone `run_test` block (in-project-tools.ts:1467-1489)**

Delete the `run_test: tool({...})` block. The `testing_ops:run_test` action covers the same functionality.

- [ ] **Step 6: Update specialist allow-lists in `types/tools.ts`**

- `testing-eval` (line 229): replace `'run_test'` with `'testing_ops'`
- `analyst` (line 183): append `'testing_ops'`

- [ ] **Step 7: Mirror in `build-tools.ts`**

- [ ] **Step 8: Run drift + testing-ops + previous tests**

```bash
pnpm vitest run packages/arch-ai/src/__tests__/specialist-tool-map-drift.test.ts apps/studio/src/__tests__/arch-ai/testing-ops.test.ts apps/studio/src/__tests__/arch-ai/agent-ops.test.ts apps/studio/src/__tests__/arch-ai/deployment-ops.test.ts
```

Expected: PASS.

- [ ] **Step 9: Search for any test or fixture that referenced the standalone `run_test` tool**

```bash
grep -rn "'run_test'" apps/studio/src --include='*.ts' --include='*.tsx'
```

If any match exists outside the now-updated tool maps and `ToolName` union, update or remove the reference.

- [ ] **Step 10: Typecheck and commit**

```bash
pnpm build --filter=@agent-platform/arch-ai --filter=@agent-platform/studio
npx prettier --write apps/studio/src/lib/arch-ai/tools/in-project-tools.ts packages/arch-ai/src/types/tools.ts apps/studio/src/lib/arch-ai/tools/build-tools.ts apps/studio/src/__tests__/arch-ai/testing-ops.test.ts
git add apps/studio/src/lib/arch-ai/tools/in-project-tools.ts packages/arch-ai/src/types/tools.ts apps/studio/src/lib/arch-ai/tools/build-tools.ts apps/studio/src/__tests__/arch-ai/testing-ops.test.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] feat(shared): wire testing_ops; collapse standalone run_test

Registers testing_ops with run_test, list_evals, create_eval actions
(Phase 1 per audit decision §8.3 — scenarios save via Studio UI).
Granted to testing-eval (replaces standalone run_test) and analyst.

Removes the standalone run_test tool registration. Functionality is
unchanged — testing_ops:run_test is a strict superset.

create_eval persists name + description only in this phase. Scenarios
in evalConfig.scenarios are silently dropped (executor behavior, not
new). Test asserts the caveat.
EOF
)"
```

---

## Task 6: Wire `analytics_ops` + drop stub actions

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts` (add registration)
- Modify: `apps/studio/src/lib/arch-ai/tools/analytics-ops.ts:9` (narrow action enum)
- Modify: `packages/arch-ai/src/types/tools.ts` (allow-list)
- Modify: `apps/studio/src/lib/arch-ai/tools/build-tools.ts` (mirror)
- Create: `apps/studio/src/__tests__/arch-ai/analytics-ops.test.ts`

**Specialists granted:** `analyst`, `observer`.

**Action enum (ship subset):** `metrics`, `anomalies`. Drop `intents` and `quality_scores` from the public surface until the analytics pipeline produces real data.

- [ ] **Step 1: Write failing test**

Create `apps/studio/src/__tests__/arch-ai/analytics-ops.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPermissionContext } from '@/lib/arch-ai/guards';

const { ensureDbMock, sessionFindMock, projectFindOneMock } = vi.hoisted(() => ({
  ensureDbMock: vi.fn(),
  sessionFindMock: vi.fn(),
  projectFindOneMock: vi.fn(),
}));

vi.mock('@agent-platform/database', () => ({
  ensureDb: ensureDbMock,
}));

vi.mock('@agent-platform/database/models', () => ({
  Session: { find: sessionFindMock },
  Project: { findOne: projectFindOneMock },
}));

const TOOL_CONTEXT: ToolPermissionContext = {
  projectId: 'proj-1',
  user: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    permissions: ['session:read'],
  },
  authToken: 'token-1',
};

describe('analytics_ops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureDbMock.mockResolvedValue(undefined);
    projectFindOneMock.mockResolvedValue({ _id: 'proj-1', tenantId: 'tenant-1' });
  });

  it('aggregates session metrics over the time range', async () => {
    sessionFindMock.mockReturnValue({
      sort: () => ({
        limit: () => ({
          lean: async () => [
            { _id: 's1', createdAt: new Date(), tenantId: 'tenant-1', projectId: 'proj-1' },
          ],
        }),
      }),
    });

    const { executeAnalyticsOps } = await import('@/lib/arch-ai/tools/analytics-ops');
    const result = await executeAnalyticsOps({ action: 'metrics', timeRange: '24h' }, TOOL_CONTEXT);

    expect(result.success).toBe(true);
  });

  it('detects anomalies', async () => {
    sessionFindMock.mockReturnValue({
      sort: () => ({
        limit: () => ({
          lean: async () => [],
        }),
      }),
    });

    const { executeAnalyticsOps } = await import('@/lib/arch-ai/tools/analytics-ops');
    const result = await executeAnalyticsOps(
      { action: 'anomalies', timeRange: '24h' },
      TOOL_CONTEXT,
    );

    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test — expected to pass**

```bash
pnpm vitest run apps/studio/src/__tests__/arch-ai/analytics-ops.test.ts
```

Expected: PASS.

- [ ] **Step 3: Narrow action enum in `analytics-ops.ts`**

Per CLAUDE.md "Export removal guard": removing entries from a TS union is technically removing exported behavior. Check whether `intents` / `quality_scores` are referenced anywhere outside `analytics-ops.ts` itself:

```bash
grep -rn "'intents'\|'quality_scores'" apps/studio/src packages/arch-ai/src --include='*.ts'
```

If only the executor file references them, safe to narrow. The action enum lives at `analytics-ops.ts:9-13`:

```ts
interface AnalyticsOpsInput {
  action: 'metrics' | 'intents' | 'quality_scores' | 'anomalies';
  timeRange?: '1h' | '24h' | '7d' | '30d';
  agentName?: string;
}
```

Change to:

```ts
interface AnalyticsOpsInput {
  action: 'metrics' | 'anomalies';
  timeRange?: '1h' | '24h' | '7d' | '30d';
  agentName?: string;
}
```

Remove the `case 'intents'` and `case 'quality_scores'` branches (they returned `{ available: false }` stubs).

If consumers exist, keep the type as-is and instead narrow the Zod enum at the registration site only. Document the divergence inline.

- [ ] **Step 4: Add `analytics_ops` registration to `in-project-tools.ts`**

After the `testing_ops` block from Task 5:

```ts
    analytics_ops: tool({
      description:
        'Read-only session analytics. Actions: metrics (aggregate session counts/durations/errors over a time range), anomalies (detect unusual patterns — high error rate, empty sessions, escalation spikes). Optional agentName narrows results. Backed by direct DB read of Session collection (last 200 sessions in the time window).',
      inputSchema: z.object({
        action: z.enum(['metrics', 'anomalies']),
        timeRange: z.enum(['1h', '24h', '7d', '30d']).optional().describe('Time window'),
        agentName: z.string().optional().describe('Filter to a specific agent'),
      }),
      execute: async (input) => {
        const { executeAnalyticsOps } = await import('@/lib/arch-ai/tools/analytics-ops');
        return executeAnalyticsOps(input, {
          projectId,
          user: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            permissions: ctx.permissions ?? [],
          },
          authToken,
        });
      },
    }),
```

- [ ] **Step 5: Add to specialist allow-lists in `types/tools.ts`**

- `analyst` (line 183): append `'analytics_ops'`
- `observer` (line 198): append `'analytics_ops'`

- [ ] **Step 6: Mirror in `build-tools.ts`**

- [ ] **Step 7: Run all tests**

```bash
pnpm vitest run packages/arch-ai/src/__tests__/specialist-tool-map-drift.test.ts apps/studio/src/__tests__/arch-ai/analytics-ops.test.ts apps/studio/src/__tests__/arch-ai/testing-ops.test.ts apps/studio/src/__tests__/arch-ai/agent-ops.test.ts apps/studio/src/__tests__/arch-ai/deployment-ops.test.ts
```

Expected: PASS for all.

- [ ] **Step 8: Typecheck and commit**

```bash
pnpm build --filter=@agent-platform/arch-ai --filter=@agent-platform/studio
npx prettier --write apps/studio/src/lib/arch-ai/tools/in-project-tools.ts apps/studio/src/lib/arch-ai/tools/analytics-ops.ts packages/arch-ai/src/types/tools.ts apps/studio/src/lib/arch-ai/tools/build-tools.ts apps/studio/src/__tests__/arch-ai/analytics-ops.test.ts
git add apps/studio/src/lib/arch-ai/tools/in-project-tools.ts apps/studio/src/lib/arch-ai/tools/analytics-ops.ts packages/arch-ai/src/types/tools.ts apps/studio/src/lib/arch-ai/tools/build-tools.ts apps/studio/src/__tests__/arch-ai/analytics-ops.test.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] feat(shared): wire analytics_ops tool (metrics + anomalies)

Registers analytics_ops with the two implemented actions: metrics and
anomalies. Granted to analyst and observer specialists.

Drops intents and quality_scores from the public action enum — those
were stub branches returning { available: false }. They will return
when the analytics pipeline produces real data.
EOF
)"
```

---

## Task 7: Extend registry-level test

**Files:**

- Modify: `apps/studio/src/__tests__/arch-ai/engine-factory-in-project-tools.test.ts:56-72`

**Why last:** the registry test asserts the LLM-facing surface of `buildInProjectTools`. Wait until all 4 tools are wired to add the assertion for all of them in one pass.

- [ ] **Step 1: Read the existing assertion shape**

```bash
sed -n '50,80p' apps/studio/src/__tests__/arch-ai/engine-factory-in-project-tools.test.ts
```

Note the pattern (`expect(toolNames).toContain(...)` or similar).

- [ ] **Step 2: Add assertions for the 4 new tool names**

In the existing `it()` block that asserts registered tool names, add:

```ts
expect(toolNames).toContain('agent_ops');
expect(toolNames).toContain('deployment_ops');
expect(toolNames).toContain('testing_ops');
expect(toolNames).toContain('analytics_ops');
```

Add a separate it-block asserting the standalone `run_test` is no longer registered (since Task 5 collapsed it):

```ts
it('does not register the legacy standalone run_test tool', () => {
  const tools = buildInProjectTools(/* ... existing args ... */);
  expect(Object.keys(tools)).not.toContain('run_test');
});
```

- [ ] **Step 3: Run test**

```bash
pnpm vitest run apps/studio/src/__tests__/arch-ai/engine-factory-in-project-tools.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run full arch-ai test suite for confidence**

```bash
pnpm vitest run packages/arch-ai/src/__tests__/ apps/studio/src/__tests__/arch-ai/
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/__tests__/arch-ai/engine-factory-in-project-tools.test.ts
git add apps/studio/src/__tests__/arch-ai/engine-factory-in-project-tools.test.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] test(shared): assert 4 newly wired tools registered

Extends engine-factory-in-project-tools.test.ts with assertions that
agent_ops, deployment_ops, testing_ops, analytics_ops appear in
buildInProjectTools output and the legacy standalone run_test no
longer appears.
EOF
)"
```

---

## Task 8: Patch the audit doc + acceptance walkthrough

**Files:**

- Modify: `packages/arch-ai/docs/wip/2026-05-05-arch-ai-capabilities-and-gaps-audit.md` (CRUD coverage matrix row for analytics + tool-count totals + gap #1 status)

The audit's Channels/Deployments rows still say "0 reachable" — they're now reachable. Tool count rises from 36 to 39 (collapsing run_test into testing_ops nets +3). Gap #1 status moves to "addressed".

- [ ] **Step 1: Update the audit's CRUD matrix and counts**

Edit the audit doc to:

- Mark gap #1 (Section 7) as ADDRESSED with a link to the spec doc.
- Update the action-count table: Channels/deployments from "0 reachable" to count, tools from 36 to 39, total reachable from ~111 to ~125 (add: 7 agent_ops + 5 deployment_ops + 3 testing_ops + 2 analytics_ops − 2 run_test legacy = +15).
- Update the corrected `analytics_ops` row (already done in a prior commit) — verify it.

- [ ] **Step 2: Walk through acceptance criteria**

Confirm each box from spec §8 passes:

- [ ] `pnpm build --filter=@agent-platform/arch-ai --filter=@agent-platform/studio` clean.
- [ ] `pnpm test --filter=@agent-platform/studio -- arch-ai` passes.
- [ ] LLM in IN_PROJECT mode can invoke each of the 4 tools (verified via registry test).
- [ ] `guards.ts:DANGEROUS_ACTIONS` no longer references `deployment_ops:rollback`; does reference `deployment_ops:configure_channel`.
- [ ] Drift test passes.
- [ ] No deletions of existing exported symbols (`run_test` tool registration removal is the only deletion; verify it's not exported).
- [ ] Audit doc patched.

- [ ] **Step 3: Final commit (audit doc)**

```bash
npx prettier --write packages/arch-ai/docs/wip/2026-05-05-arch-ai-capabilities-and-gaps-audit.md
git add packages/arch-ai/docs/wip/2026-05-05-arch-ai-capabilities-and-gaps-audit.md
git commit -m "$(cat <<'EOF'
[ABLP-162] docs(shared): mark gap #1 addressed in capabilities audit

Updates CRUD matrix, action counts, and gap status to reflect the 4
newly wired tools.
EOF
)"
```

---

## Self-review checklist (apply after Task 8 lands)

- [ ] All 8 tasks committed.
- [ ] Each commit ≤40 files (CLAUDE.md commit-scope guard).
- [ ] Each commit ≤3 packages (commit-scope guard). Tasks 3-6 touch `arch-ai` + `studio` packages = 2 packages OK.
- [ ] No `feat()` commit deletes exported symbols (Task 5 removes `run_test:` block — verify no other code imports `run_test` as a symbol).
- [ ] Drift test passes after every commit (run after each task).
- [ ] Audit doc analytics_ops correction landed (it was patched in an earlier commit before this plan ran; verify still there).

## Post-implementation follow-ups (out of scope for this plan)

1. **Channel `bind_to_agent` / `unbind_from_agent`** — separate spec per audit §8.2. Requires backend work.
2. **Eval Phase 2 (`eval_ops` with full write)** — separate spec per audit §8.3.
3. **Deploy / promote UX confirmation widget** — `deployment_ops:deploy` and `:promote` work but lack a confirmation widget that shows the diff before deploying. Track separately.
4. **`rollback`** — document in a future spec when rollback becomes a real feature.
5. **DI refactor of executors** — current tests still mock at `@/...` import boundary (the existing pattern); refactoring executors to take dependencies as parameters is a larger refactor flagged in CLAUDE.md "Test Architecture".

---

## References

- Spec: [packages/arch-ai/docs/wip/2026-05-05-wire-unregistered-tools-spec.md](./2026-05-05-wire-unregistered-tools-spec.md)
- Audit: [packages/arch-ai/docs/wip/2026-05-05-arch-ai-capabilities-and-gaps-audit.md](./2026-05-05-arch-ai-capabilities-and-gaps-audit.md)
- Tool registration template: [apps/studio/src/lib/arch-ai/tools/in-project-tools.ts:2183-2217](apps/studio/src/lib/arch-ai/tools/in-project-tools.ts:2183)
- Test pattern reference: [apps/studio/src/**tests**/arch-ai/integration-ops.test.ts:1-130](apps/studio/src/__tests__/arch-ai/integration-ops.test.ts:1)
- CLAUDE.md cross-cutting rules: commit scope guard (40 files / 3 packages), additive feat() (no exported-symbol deletion), prettier-before-commit, JIRA Workflow, type safety read-before-write
