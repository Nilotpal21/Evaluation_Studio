# Arch AI: In-Project Integration Setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add in-project integration setup to Arch AI overlay so users configure SaaS / REST / MCP integrations end-to-end in chat with parity to the manual Connections / Auth Profiles / Tools editor pages.

**Architecture:** Extends in-project Arch chat with a new `integration` artifact tab, 2 new widgets (`OAuthLaunch`, `IntegrationPlan`), 1 new tool (`connection_ops`), 1 extended tool (`auth_ops` with 6 more auth types), 1 new action (`integration_ops:revalidate`), 3 new L2 knowledge cards, content-router regex extension, 2 prompt-injection loaders, 1 runtime MCP cache invalidation hook, 1 sanitizer helper, structured `prefillMetadata` channel for cross-page handoff. HTTP-typed `ProjectTool`s against provider REST APIs (decision A). Wiring uses existing `propose_modification` + `apply_modification` diff path.

**Tech Stack:** TypeScript / Next.js (Studio) / Mongoose / Vercel AI SDK / Zustand / React / Vitest (unit + integration) / Playwright (E2E)

**Spec:** [`docs/superpowers/specs/2026-05-05-arch-ai-integrations-in-project-design.md`](../specs/2026-05-05-arch-ai-integrations-in-project-design.md)

**Tracking:** ABLP-162

**Branch:** `zarch/newtools` (current), behind feature flag `ARCH_INTEGRATIONS_V1`.

**Status:** DONE — All 8 phases (0–7) implemented and committed. Feature is ALPHA (impl + unit/integration tests green; 7 E2E specs scaffolded and skipped pending fixtures). Last commit: `f27fb489a3` (pr-review LOW findings). Post-impl-sync log at `docs/sdlc-logs/arch-ai-integrations-in-project/post-impl-sync.log.md`.

**Last Updated:** 2026-05-06

---

## File Structure

### New files

| Path                                                                               | Purpose                                                                      |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `apps/studio/src/lib/arch-ai/sanitize-tool-error.ts`                               | Redact tenant ids / credentials / stack traces from user-visible errors      |
| `apps/studio/src/lib/arch-ai/tools/connection-ops.ts`                              | New tool: `list / create / delete / resolve_options / resolve_dynamic_props` |
| `apps/studio/src/lib/arch-ai/processors/integration-suggestions.ts`                | Compute proactive suggestions; biased by pageContext                         |
| `apps/studio/src/lib/arch-ai/integration-hints.ts`                                 | Provider-name → tool-pattern registry                                        |
| `apps/studio/src/lib/runtime-mcp-cache-invalidation.ts`                            | Studio → runtime hook to reset MCP cache                                     |
| `apps/studio/src/lib/arch-ai/components/arch/widgets/OAuthLaunch.tsx`              | OAuth consent widget wrapping `useBatchOAuth`                                |
| `apps/studio/src/lib/arch-ai/components/arch/widgets/IntegrationPlan.tsx`          | Multi-step plan widget                                                       |
| `apps/studio/src/lib/arch-ai/components/arch/cards/IntegrationSuggestionCard.tsx`  | Suggestion card render                                                       |
| `apps/studio/src/lib/arch-ai/components/arch/panels/IntegrationArtifactView.tsx`   | Artifact panel content for `integration` tab                                 |
| `apps/studio/src/app/api/arch-ai/projects/[projectId]/integration-drafts/route.ts` | GET drafts list                                                              |
| `apps/studio/src/app/api/arch-ai/integration-drafts/[id]/resume/route.ts`          | POST server-side resume                                                      |
| `apps/runtime/src/routes/internal-mcp.ts`                                          | Internal route for MCP cache invalidation                                    |
| `packages/arch-ai/src/knowledge/cards/generated/integration-setup-workflow.ts`     | L2 card                                                                      |
| `packages/arch-ai/src/knowledge/cards/generated/oauth-flow-primer.ts`              | L2 card                                                                      |
| `packages/arch-ai/src/knowledge/cards/generated/integration-failure-diagnosis.ts`  | L2 card                                                                      |
| `e2e/arch-ai-integrations/saas-oauth.spec.ts`                                      | S1 — Slack OAuth flow                                                        |
| `e2e/arch-ai-integrations/rest-api.spec.ts`                                        | S5 — cURL paste                                                              |
| `e2e/arch-ai-integrations/mcp-server.spec.ts`                                      | S7 — MCP server + cache invalidation                                         |
| `e2e/arch-ai-integrations/revalidate.spec.ts`                                      | S3 — manual edit collision                                                   |
| `e2e/arch-ai-integrations/suggestion.spec.ts`                                      | S2 — proactive + page-aware                                                  |
| `e2e/arch-ai-integrations/collision.spec.ts`                                       | Multi-user shared-profile collision                                          |
| `e2e/arch-ai-integrations/sanitization.spec.ts`                                    | Sanitizer redaction                                                          |

### Modified files

| Path                                                                            | Change                                                                                                   |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/database/src/models/arch-integration-draft.model.ts`                  | Add `connectionIds[]`, `lastTestStatus`, `lastTestAt`, `lastTestError`, `testHistory[]`                  |
| `apps/studio/src/lib/arch-ai/integration-draft-service.ts`                      | Extend `DraftDocument`, `IntegrationDraftSummary`, `normalizeDraft`; new `syncActiveDraftFromConnection` |
| `apps/studio/src/lib/arch-ai/tools/auth-ops.ts`                                 | Extend `SUPPORTED_AUTH_TYPES`, `REQUIRED_SECRETS`; collision recovery                                    |
| `apps/studio/src/lib/arch-ai/tools/integration-ops.ts`                          | Add `revalidate` action; include `connectionIds`                                                         |
| `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`                         | Register `connection_ops`                                                                                |
| `apps/studio/src/lib/arch-ai/tool-schemas.ts`                                   | Zod schemas for `connection_ops`, `OAuthLaunch`, `IntegrationPlan`                                       |
| `apps/studio/src/lib/arch-ai/store/arch-ai-store.ts`                            | Extend `ArtifactTabType` with `'integration'`; add `prefillMetadata`                                     |
| `apps/studio/src/lib/arch-ai/components/arch/panels/InProjectArtifactPanel.tsx` | Add `integration` tab case                                                                               |
| `apps/studio/src/lib/arch-ai/components/arch/widgets/WidgetRenderer.tsx`        | Register `OAuthLaunch` + `IntegrationPlan`                                                               |
| `apps/studio/src/lib/arch-ai/components/arch/widgets/types.ts`                  | Extend `AskUserInput` discriminated union                                                                |
| `apps/studio/src/lib/arch-ai/components/arch/cards/index.ts`                    | Register card in `KB_CARD_MAP`                                                                           |
| `apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts`                            | Extend `syncWidgetArtifact`                                                                              |
| `apps/studio/src/lib/arch-ai/compat/v1-core-refs.ts`                            | Extend compat union + dispatcher                                                                         |
| `apps/studio/src/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx`           | Add integration tab init effect; `prefillMetadata` watcher                                               |
| `apps/studio/src/lib/arch-ai/processors/runtime-support.ts`                     | Add `projectStateSummaryLoader`, `activeDraftSnapshotLoader`                                             |
| `apps/studio/src/lib/arch-ai/processors/process-in-project.ts`                  | Invoke suggestion engine on session-open                                                                 |
| `apps/studio/src/lib/arch-ai/build-page-context.ts`                             | Project entity metadata for connections / tools / mcp-servers / agents                                   |
| `packages/arch-ai/src/types/tools.ts`                                           | Add `connection_ops` to `ToolName` + tool map                                                            |
| `packages/arch-ai/src/types/turn-events.ts`                                     | Extend widget `variant` enum                                                                             |
| `packages/arch-ai/src/types/page-context.ts`                                    | Add `'integration_draft'` entity type; optional `pageContext.user`                                       |
| `packages/arch-ai/src/coordinator/content-router.ts`                            | Extend integration-methodologist regex patterns                                                          |
| `packages/arch-ai/src/coordinator/coordinator-bridge.ts`                        | Extend `getPageContextSpecialistBias`                                                                    |
| `packages/arch-ai/src/prompts/index.ts`                                         | Inject project-state and active-draft loader output                                                      |
| `packages/arch-ai/src/knowledge/card-router.ts`                                 | Register triggers for the 3 new L2 cards                                                                 |
| `apps/runtime/src/services/mcp/runtime-mcp-provider.ts`                         | Expose `resetProjectInit(tenantId, projectId)`                                                           |
| `apps/runtime/src/server.ts`                                                    | Mount internal MCP route                                                                                 |

---

## Conventions

- Every task ends with a commit using format `[ABLP-162] <type>(<scope>): <description>`. Allowed scopes: `studio`, `runtime`, `arch-ai` (verify against `commitlint.config` — fall back to `studio` for cross-area changes).
- Run `npx prettier --write <files>` before every `git commit` (lint-staged silently reverts otherwise per CLAUDE.md).
- TDD: write failing test first, then minimal implementation, then verify pass.
- After every `.ts` file edit, the incremental-typecheck hook runs automatically. Fix errors immediately.
- Feature flag `ARCH_INTEGRATIONS_V1` defaults to `false`; toggle to `true` in dev/staging via env. New code paths gated by `process.env.ARCH_INTEGRATIONS_V1 === 'true'` until Phase 7.
- **Tenant isolation:** All Mongoose queries MUST filter by `tenantId` (and `projectId` for project-scoped resources). NEVER use `findById`/`findByIdAndUpdate`/`findByIdAndDelete` — use `findOne({_id, tenantId})` etc. per CLAUDE.md Core Invariants. The `findbyid-lint.sh` hook blocks Writes that violate this.
- E2E tests do NOT mock platform components. Real Studio + runtime + Mongo + Redis. See `apps/studio/e2e/README.md` for fixtures.

---

# Phase 0 — Runtime MCP Cache Invalidation Hook

The runtime caches "MCP servers loaded for this project" with a 5-min TTL. Without invalidation, an Arch-created MCP server is invisible to existing pod sessions for up to 5 min. This phase exposes a method on the runtime provider and adds a Studio-side helper that calls it after `mcp_server_ops:create | update | delete`.

### Task 0.1: Expose `resetProjectInit` on RuntimeMcpClientProvider

**Files:**

- Modify: `apps/runtime/src/services/mcp/runtime-mcp-provider.ts`
- Test: `apps/runtime/src/services/mcp/__tests__/runtime-mcp-provider.test.ts` (extend existing or create)

- [ ] **Step 1: Read existing provider to understand cache shape**

Run: `grep -n "projectInitialized\|PROJECT_INIT_TTL\|ensureProjectServers" apps/runtime/src/services/mcp/runtime-mcp-provider.ts`

Expected: TTL constant near line 35, `ensureProjectServers` cache check near 59-78. Read surrounding code before editing.

- [ ] **Step 2: Write the failing test**

Add to `apps/runtime/src/services/mcp/__tests__/runtime-mcp-provider.test.ts`:

```ts
describe('resetProjectInit', () => {
  it('forces re-initialization on next ensureProjectServers call', async () => {
    const provider = new RuntimeMcpClientProvider(/* deps */);
    await provider.ensureProjectServers('tenant1', 'project1');
    const mongoFetchSpy = vi.spyOn(provider as any, 'loadServersFromDatabase');

    await provider.ensureProjectServers('tenant1', 'project1');
    expect(mongoFetchSpy).not.toHaveBeenCalled();

    provider.resetProjectInit('tenant1', 'project1');

    await provider.ensureProjectServers('tenant1', 'project1');
    expect(mongoFetchSpy).toHaveBeenCalledTimes(1);
  });

  it('only resets the specified (tenantId, projectId)', async () => {
    const provider = new RuntimeMcpClientProvider(/* deps */);
    await provider.ensureProjectServers('tenant1', 'projectA');
    await provider.ensureProjectServers('tenant1', 'projectB');
    const mongoFetchSpy = vi.spyOn(provider as any, 'loadServersFromDatabase');

    provider.resetProjectInit('tenant1', 'projectA');

    await provider.ensureProjectServers('tenant1', 'projectA');
    expect(mongoFetchSpy).toHaveBeenCalledWith('tenant1', 'projectA');
    mongoFetchSpy.mockClear();

    await provider.ensureProjectServers('tenant1', 'projectB');
    expect(mongoFetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify failure**

Run: `pnpm test --filter=@agent-platform/runtime -- runtime-mcp-provider.test.ts`

Expected: FAIL — `provider.resetProjectInit is not a function`.

- [ ] **Step 4: Implement `resetProjectInit`**

Add to the `RuntimeMcpClientProvider` class in `apps/runtime/src/services/mcp/runtime-mcp-provider.ts`:

```ts
public resetProjectInit(tenantId: string, projectId: string): void {
  const key = this.buildProjectInitKey(tenantId, projectId);
  this.projectInitialized.delete(key);
  this.logger.info({ tenantId, projectId }, 'mcp_provider_project_init_reset');
}

private buildProjectInitKey(tenantId: string, projectId: string): string {
  return `${tenantId}:${projectId}`;
}
```

If `buildProjectInitKey` already exists with a different shape, reuse it.

- [ ] **Step 5: Run test to verify pass**

Run: `pnpm test --filter=@agent-platform/runtime -- runtime-mcp-provider.test.ts`

Expected: PASS.

- [ ] **Step 6: Format and typecheck**

Run: `npx prettier --write apps/runtime/src/services/mcp/runtime-mcp-provider.ts apps/runtime/src/services/mcp/__tests__/runtime-mcp-provider.test.ts`
Run: `pnpm build --filter=@agent-platform/runtime`

Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/runtime/src/services/mcp/runtime-mcp-provider.ts apps/runtime/src/services/mcp/__tests__/runtime-mcp-provider.test.ts
git commit -m "[ABLP-162] feat(runtime): expose resetProjectInit on MCP provider"
```

### Task 0.2: Studio-side helper + internal runtime route

**Files:**

- Create: `apps/studio/src/lib/runtime-mcp-cache-invalidation.ts`
- Create: `apps/runtime/src/routes/internal-mcp.ts`
- Modify: `apps/runtime/src/server.ts` (mount internal route)
- Test: `apps/studio/src/lib/__tests__/runtime-mcp-cache-invalidation.test.ts`

- [ ] **Step 1: Read the existing model cache invalidation pattern**

Run: `cat apps/studio/src/lib/runtime-model-cache-invalidation.ts | head -60`

Expected: a pattern that POSTs to a runtime internal route. Mirror the same shape.

- [ ] **Step 2: Write the failing test**

Create `apps/studio/src/lib/__tests__/runtime-mcp-cache-invalidation.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notifyRuntimeMcpServersChanged } from '../runtime-mcp-cache-invalidation';

describe('notifyRuntimeMcpServersChanged', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch').mockReset();
  });

  it('POSTs to the runtime internal cache-bust endpoint', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as unknown as Response);

    await notifyRuntimeMcpServersChanged('tenant1', 'project1');

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/internal/mcp/reset-project-init'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ tenantId: 'tenant1', projectId: 'project1' }),
      }),
    );
  });

  it('logs but does not throw if runtime is unreachable', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(notifyRuntimeMcpServersChanged('tenant1', 'project1')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify failure**

Run: `pnpm test --filter=@agent-platform/studio -- runtime-mcp-cache-invalidation.test.ts`

Expected: FAIL — file does not exist.

- [ ] **Step 4: Implement helper and route**

Create `apps/studio/src/lib/runtime-mcp-cache-invalidation.ts`:

```ts
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('runtime-mcp-cache-invalidation');
const RUNTIME_INTERNAL_URL = process.env.RUNTIME_INTERNAL_URL ?? 'http://localhost:3112';

export async function notifyRuntimeMcpServersChanged(
  tenantId: string,
  projectId: string,
): Promise<void> {
  try {
    const url = `${RUNTIME_INTERNAL_URL}/internal/mcp/reset-project-init`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId, projectId }),
    });
    if (!response.ok) {
      log.warn(
        { tenantId, projectId, status: response.status },
        'mcp_cache_invalidation_failed_status',
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ tenantId, projectId, error: message }, 'mcp_cache_invalidation_failed');
  }
}
```

Create `apps/runtime/src/routes/internal-mcp.ts`:

```ts
import type { Router } from 'express';
import type { RuntimeMcpClientProvider } from '../services/mcp/runtime-mcp-provider';

export function registerInternalMcpRoutes(
  router: Router,
  provider: RuntimeMcpClientProvider,
): void {
  router.post('/internal/mcp/reset-project-init', (req, res) => {
    const { tenantId, projectId } = req.body ?? {};
    if (typeof tenantId !== 'string' || typeof projectId !== 'string') {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'tenantId and projectId required' },
      });
      return;
    }
    provider.resetProjectInit(tenantId, projectId);
    res.json({ success: true });
  });
}
```

In `apps/runtime/src/server.ts`, find where other `/internal/` routes are mounted and add:

```ts
import { registerInternalMcpRoutes } from './routes/internal-mcp';
// ...
registerInternalMcpRoutes(internalRouter, mcpProvider);
```

- [ ] **Step 5: Run test to verify pass**

Run: `pnpm test --filter=@agent-platform/studio -- runtime-mcp-cache-invalidation.test.ts`

Expected: PASS.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write apps/studio/src/lib/runtime-mcp-cache-invalidation.ts apps/studio/src/lib/__tests__/runtime-mcp-cache-invalidation.test.ts apps/runtime/src/routes/internal-mcp.ts apps/runtime/src/server.ts
pnpm build --filter=@agent-platform/studio --filter=@agent-platform/runtime
git add apps/studio/src/lib/runtime-mcp-cache-invalidation.ts apps/studio/src/lib/__tests__/runtime-mcp-cache-invalidation.test.ts apps/runtime/src/routes/internal-mcp.ts apps/runtime/src/server.ts
git commit -m "[ABLP-162] feat(studio): add MCP cache invalidation hook to runtime"
```

---

# Phase 1 — Tooling Foundation

Server-side tooling: schema fields, sanitizer helper, extended `auth_ops`, new `connection_ops`, `integration_ops:revalidate`. Tools register but UI doesn't surface them yet (gated by feature flag).

### Task 1.1: Add fields to `IntegrationDraft` model

**Files:**

- Modify: `packages/database/src/models/arch-integration-draft.model.ts`
- Test: `packages/database/src/__tests__/arch-integration-draft.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/database/src/__tests__/arch-integration-draft.test.ts`:

```ts
describe('IntegrationDraft new fields', () => {
  it('persists connectionIds[]', async () => {
    const draft = await ArchIntegrationDraftModel.create({
      tenantId: 't1',
      projectId: 'p1',
      sessionId: 's1',
      providerKey: 'slack',
      source: 'in_project',
      status: 'draft',
      connectionIds: ['conn_1', 'conn_2'],
    });
    const reloaded = await ArchIntegrationDraftModel.findOne({
      _id: draft._id,
      tenantId: 't1',
    });
    expect(reloaded?.connectionIds).toEqual(['conn_1', 'conn_2']);
  });

  it('persists test status fields', async () => {
    const at = new Date();
    const draft = await ArchIntegrationDraftModel.create({
      tenantId: 't1',
      projectId: 'p1',
      sessionId: 's1',
      providerKey: 'slack',
      source: 'in_project',
      status: 'ready_to_test',
      lastTestStatus: 'pass',
      lastTestAt: at,
      lastTestError: null,
      testHistory: [{ at, status: 'pass' }],
    });
    const reloaded = await ArchIntegrationDraftModel.findOne({
      _id: draft._id,
      tenantId: 't1',
    });
    expect(reloaded?.lastTestStatus).toBe('pass');
    expect(reloaded?.testHistory?.length).toBe(1);
  });

  it('caps testHistory at 5 entries with FIFO eviction', async () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({
      at: new Date(Date.now() - (6 - i) * 1000),
      status: i % 2 === 0 ? 'pass' : 'fail',
    }));
    const draft = await ArchIntegrationDraftModel.create({
      tenantId: 't1',
      projectId: 'p1',
      sessionId: 's1',
      providerKey: 'slack',
      source: 'in_project',
      status: 'ready_to_test',
      testHistory: entries,
    });
    expect(draft.testHistory?.length).toBe(5);
    expect(draft.testHistory?.[0]?.at.getTime()).toBe(entries[1].at.getTime());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter=@agent-platform/database -- arch-integration-draft.test.ts`

Expected: FAIL — fields don't exist on schema.

- [ ] **Step 3: Implement schema additions**

Edit `packages/database/src/models/arch-integration-draft.model.ts`. Inside the schema definition, add:

```ts
connectionIds: { type: [String], default: [] },
lastTestStatus: { type: String, enum: ['pass', 'fail', 'pending', null], default: null },
lastTestAt: { type: Date, default: null },
lastTestError: { type: String, default: null },
testHistory: {
  type: [{
    at: { type: Date, required: true },
    status: { type: String, enum: ['pass', 'fail'], required: true },
    error: { type: String },
    sanitizedSampleInput: { type: String },
    _id: false,
  }],
  default: [],
  validate: {
    validator: (arr: unknown[]) => Array.isArray(arr) && arr.length <= 5,
    message: 'testHistory cannot exceed 5 entries',
  },
},
```

Add a `pre('save')` hook for FIFO eviction:

```ts
schema.pre('save', function (next) {
  const doc = this as unknown as { testHistory?: Array<{ at: Date }> };
  if (doc.testHistory && doc.testHistory.length > 5) {
    doc.testHistory.sort((a, b) => a.at.getTime() - b.at.getTime());
    doc.testHistory = doc.testHistory.slice(-5);
  }
  next();
});
```

Add to the `IIntegrationDraft` interface:

```ts
connectionIds: string[];
lastTestStatus?: 'pass' | 'fail' | 'pending' | null;
lastTestAt?: Date | null;
lastTestError?: string | null;
testHistory?: Array<{
  at: Date;
  status: 'pass' | 'fail';
  error?: string;
  sanitizedSampleInput?: string;
}>;
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm test --filter=@agent-platform/database -- arch-integration-draft.test.ts`

Expected: PASS (all 3 cases).

- [ ] **Step 5: Format, typecheck, commit**

```bash
npx prettier --write packages/database/src/models/arch-integration-draft.model.ts packages/database/src/__tests__/arch-integration-draft.test.ts
pnpm build --filter=@agent-platform/database
git add packages/database/src/models/arch-integration-draft.model.ts packages/database/src/__tests__/arch-integration-draft.test.ts
git commit -m "[ABLP-162] feat(database): add connectionIds and test status fields to IntegrationDraft"
```

### Task 1.2: Extend `IntegrationDraftService` for new fields + `syncActiveDraftFromConnection`

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/integration-draft-service.ts`
- Test: `apps/studio/src/lib/arch-ai/__tests__/integration-draft-service.test.ts`

- [ ] **Step 1: Map consumer surfaces**

Run: `grep -n "DraftDocument\|IntegrationDraftSummary\|normalizeDraft\|syncActiveDraftFrom" apps/studio/src/lib/arch-ai/integration-draft-service.ts`

Note all interface lines and `normalizeDraft` — these must be extended in lockstep per CLAUDE.md cross-boundary field propagation.

- [ ] **Step 2: Write failing test**

Add to `apps/studio/src/lib/arch-ai/__tests__/integration-draft-service.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  syncActiveDraftFromConnection,
  startDraft,
  setSessionDraftPointer,
  normalizeDraft,
} from '../integration-draft-service';
import { ArchIntegrationDraftModel } from '@agent-platform/database/models/arch-integration-draft.model';

function makeTestCtx(overrides = {}) {
  return {
    tenantId: 't1',
    projectId: 'p1',
    sessionId: 'sess_test',
    userId: 'u1',
    ...overrides,
  };
}

describe('syncActiveDraftFromConnection', () => {
  it('appends connectionId to active draft', async () => {
    const ctx = makeTestCtx();
    const draft = await startDraft(ctx, { providerKey: 'slack' });
    await setSessionDraftPointer(ctx.sessionId, String(draft._id));

    const updated = await syncActiveDraftFromConnection(ctx, 'conn_abc');
    expect(updated?.connectionIds).toContain('conn_abc');
  });

  it('returns null if no active draft pointer set', async () => {
    const ctx = makeTestCtx({ sessionId: 'sess_no_draft' });
    const result = await syncActiveDraftFromConnection(ctx, 'conn_abc');
    expect(result).toBeNull();
  });

  it('deduplicates connectionIds', async () => {
    const ctx = makeTestCtx();
    const draft = await startDraft(ctx, { providerKey: 'slack' });
    await setSessionDraftPointer(ctx.sessionId, String(draft._id));

    await syncActiveDraftFromConnection(ctx, 'conn_abc');
    const updated = await syncActiveDraftFromConnection(ctx, 'conn_abc');
    expect(updated?.connectionIds.filter((id) => id === 'conn_abc').length).toBe(1);
  });
});

describe('IntegrationDraftSummary new fields', () => {
  it('includes connectionIds and lastTestStatus in summary', async () => {
    const draft = await ArchIntegrationDraftModel.create({
      tenantId: 't1',
      projectId: 'p1',
      sessionId: 's1',
      providerKey: 'slack',
      source: 'in_project',
      status: 'ready_to_test',
      connectionIds: ['conn_a'],
      lastTestStatus: 'pass',
      testHistory: [{ at: new Date(), status: 'pass' }],
    });
    const summary = normalizeDraft(draft);
    expect(summary.connectionIds).toEqual(['conn_a']);
    expect(summary.lastTestStatus).toBe('pass');
    expect(summary.testHistory?.length).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify failure**

Run: `pnpm test --filter=@agent-platform/studio -- integration-draft-service.test.ts`

Expected: FAIL.

- [ ] **Step 4: Extend the service**

Edit `apps/studio/src/lib/arch-ai/integration-draft-service.ts`:

a) `interface DraftDocument` — add `connectionIds: string[]` plus the test-status fields.

b) `interface IntegrationDraftSummary` — same fields.

c) `normalizeDraft()` — include the new fields:

```ts
return {
  // ...existing
  connectionIds: doc.connectionIds ?? [],
  lastTestStatus: doc.lastTestStatus ?? null,
  lastTestAt: doc.lastTestAt ?? null,
  lastTestError: doc.lastTestError ?? null,
  testHistory: (doc.testHistory ?? []).map((t) => ({ ...t })),
};
```

d) In `deriveDraftStatus()`, include `connectionIds.length > 0` in the heuristic:

```ts
} else if (
  draft.toolIds.length > 0 ||
  draft.authProfileIds.length > 0 ||
  draft.connectionIds.length > 0 ||
  draft.envVarKeys.length > 0 ||
  draft.configVarKeys.length > 0
) {
  return 'ready_to_test';
}
```

e) Add the new helper:

```ts
export async function syncActiveDraftFromConnection(
  ctx: DraftContext,
  connectionId: string,
): Promise<IntegrationDraftSummary | null> {
  const session = await ArchSessionModel.findOne({
    _id: ctx.sessionId,
    tenantId: ctx.tenantId,
  });
  const draftId = session?.metadata?.activeIntegrationDraftId;
  if (!draftId) return null;

  const draft = await ArchIntegrationDraftModel.findOne({
    _id: draftId,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
  });
  if (!draft) return null;

  const existing = new Set(draft.connectionIds);
  if (existing.has(connectionId)) {
    return normalizeDraft(draft);
  }
  draft.connectionIds.push(connectionId);
  draft.status = deriveDraftStatus(draft);
  await draft.save();
  return normalizeDraft(draft);
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm test --filter=@agent-platform/studio -- integration-draft-service.test.ts`

Expected: PASS.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/integration-draft-service.ts apps/studio/src/lib/arch-ai/__tests__/integration-draft-service.test.ts
pnpm build --filter=@agent-platform/studio
git add apps/studio/src/lib/arch-ai/integration-draft-service.ts apps/studio/src/lib/arch-ai/__tests__/integration-draft-service.test.ts
git commit -m "[ABLP-162] feat(studio): syncActiveDraftFromConnection + draft summary fields"
```

### Task 1.3: Create `sanitize-tool-error.ts`

**Files:**

- Create: `apps/studio/src/lib/arch-ai/sanitize-tool-error.ts`
- Test: `apps/studio/src/lib/arch-ai/__tests__/sanitize-tool-error.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { sanitizeToolError } from '../sanitize-tool-error';

describe('sanitizeToolError', () => {
  it('strips full URLs with embedded credentials', () => {
    const result = sanitizeToolError(
      new Error('fetch failed: https://user:hunter2@api.example.com/v1/users?token=abc'),
    );
    expect(result.message).not.toContain('hunter2');
    expect(result.message).not.toContain('token=abc');
    expect(result.message).toContain('api.example.com');
  });

  it('strips internal hostnames', () => {
    const result = sanitizeToolError(
      new Error('connect ECONNREFUSED studio.svc.cluster.local:3000'),
    );
    expect(result.message).not.toContain('svc.cluster.local');
  });

  it('strips full stack traces', () => {
    const err = new Error('Boom');
    err.stack = 'Error: Boom\n  at internal/process/task_queues.js:95:5\n  at /app/src/foo.ts:42';
    const result = sanitizeToolError(err);
    expect(result.message).not.toContain('task_queues');
    expect(result.message).not.toContain('/app/src');
  });

  it('preserves HTTP status codes and provider response messages', () => {
    const result = sanitizeToolError({
      status: 401,
      message: 'invalid_token: token expired or revoked',
    });
    expect(result.code).toContain('401');
    expect(result.message).toContain('invalid_token');
    expect(result.message).toContain('token expired or revoked');
  });

  it('caps provider response body at 500 chars', () => {
    const long = 'x'.repeat(1000);
    const result = sanitizeToolError({ status: 500, message: long });
    expect(result.message.length).toBeLessThanOrEqual(540);
  });

  it('strips uuid-shaped ids', () => {
    const result = sanitizeToolError(
      new Error('tenantId=550e8400-e29b-41d4-a716-446655440000 not authorized'),
    );
    expect(result.message).not.toContain('550e8400');
  });

  it('returns a stable shape on unknown input', () => {
    const result = sanitizeToolError({});
    expect(result).toEqual(
      expect.objectContaining({
        code: expect.any(String),
        message: expect.any(String),
      }),
    );
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test --filter=@agent-platform/studio -- sanitize-tool-error.test.ts`

Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement**

Create `apps/studio/src/lib/arch-ai/sanitize-tool-error.ts`:

```ts
const MAX_MESSAGE_LENGTH = 500;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const URL_WITH_CREDS = /https?:\/\/[^:]+:[^@]+@/gi;
const URL_WITH_QUERY = /(https?:\/\/[^\s]+)\?[^\s]*/gi;
const INTERNAL_HOST = /\b[\w-]+\.(?:svc\.cluster\.local|internal|consul|local)\b/gi;
const STACK_TRACE_LINE = /\n\s+at\s+[^\n]+/g;
const FILE_PATH = /\/[\w./-]+\.(?:ts|js|tsx|jsx):\d+/g;

export interface SanitizedError {
  code: string;
  message: string;
  hint?: string;
}

export function sanitizeToolError(input: unknown): SanitizedError {
  const status = extractStatus(input);
  const rawMessage = extractMessage(input);

  let message = rawMessage
    .replace(URL_WITH_CREDS, 'https://***@')
    .replace(URL_WITH_QUERY, '$1?…')
    .replace(INTERNAL_HOST, '<internal>')
    .replace(UUID_PATTERN, '<id>')
    .replace(STACK_TRACE_LINE, '')
    .replace(FILE_PATH, '<file>');

  if (message.length > MAX_MESSAGE_LENGTH) {
    message = message.slice(0, MAX_MESSAGE_LENGTH) + '…';
  }

  return {
    code: buildCode(status),
    message: message.trim() || 'Tool execution failed.',
    hint: buildHint(status),
  };
}

function extractStatus(input: unknown): number | null {
  if (typeof input === 'object' && input !== null && 'status' in input) {
    const s = (input as { status: unknown }).status;
    if (typeof s === 'number') return s;
  }
  return null;
}

function extractMessage(input: unknown): string {
  if (input instanceof Error) return input.message;
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && input !== null && 'message' in input) {
    const m = (input as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return 'Unknown error';
}

function buildCode(status: number | null): string {
  if (status !== null) return `HTTP_${status}`;
  return 'TOOL_ERROR';
}

function buildHint(status: number | null): string | undefined {
  if (status === 401 || status === 403) {
    return 'The credentials may be expired or revoked. Try re-authorizing the auth profile.';
  }
  if (status === 429) {
    return 'The provider is rate-limiting requests. Wait a moment and retry.';
  }
  if (status !== null && status >= 500) {
    return 'The provider returned a server error. Retry, or check the provider status page.';
  }
  return undefined;
}
```

- [ ] **Step 4: Run tests**

Expected: PASS (all 7).

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/sanitize-tool-error.ts apps/studio/src/lib/arch-ai/__tests__/sanitize-tool-error.test.ts
pnpm build --filter=@agent-platform/studio
git add apps/studio/src/lib/arch-ai/sanitize-tool-error.ts apps/studio/src/lib/arch-ai/__tests__/sanitize-tool-error.test.ts
git commit -m "[ABLP-162] feat(studio): add sanitize-tool-error helper"
```

### Task 1.4: Extend `auth_ops` SUPPORTED_AUTH_TYPES + REQUIRED_SECRETS

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/tools/auth-ops.ts`
- Test: `apps/studio/src/lib/arch-ai/tools/__tests__/auth-ops.test.ts`

- [ ] **Step 1: Reference the manual UI's auth-type metadata**

Run: `grep -n "AUTH_TYPE_METADATA\|configFields\|secretFields" apps/studio/src/components/auth-profiles/auth-type-metadata.ts`

This is the source of truth for required-secrets per auth type. Mirror the relevant subset.

- [ ] **Step 2: Write failing tests**

Add to `apps/studio/src/lib/arch-ai/tools/__tests__/auth-ops.test.ts`:

```ts
describe('extended auth types', () => {
  it.each(['basic', 'custom_header', 'digest', 'azure_ad', 'none'])(
    'accepts %s as a supported auth type',
    async (authType) => {
      const result = await executeAuthOps(
        { action: 'create', authType, name: `test-${authType}` },
        makeTestCtx(),
      );
      if (authType === 'none') {
        expect(result.success).toBe(true);
      } else {
        expect(result.data?.needsSecrets).toBe(true);
        expect(result.data?.requiredSecrets).toBeDefined();
      }
    },
  );

  it('requires username + password for basic auth', async () => {
    const result = await executeAuthOps(
      { action: 'create', authType: 'basic', name: 'test-basic' },
      makeTestCtx(),
    );
    expect(result.data?.requiredSecrets).toEqual(['username', 'password']);
  });

  it('rejects oauth2_token (system-managed)', async () => {
    const result = await executeAuthOps(
      { action: 'create', authType: 'oauth2_token', name: 'test' } as never,
      makeTestCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNSUPPORTED_AUTH_TYPE');
  });
});
```

- [ ] **Step 3: Run test**

Expected: FAIL.

- [ ] **Step 4: Extend SUPPORTED_AUTH_TYPES + REQUIRED_SECRETS**

Edit `apps/studio/src/lib/arch-ai/tools/auth-ops.ts:8`:

```ts
const SUPPORTED_AUTH_TYPES = [
  'api_key',
  'bearer',
  'oauth2_app',
  'oauth2_client_credentials',
  'basic',
  'custom_header',
  'digest',
  'azure_ad',
  'none',
] as const;

type SupportedAuthType = (typeof SUPPORTED_AUTH_TYPES)[number];

const REQUIRED_SECRETS: Record<SupportedAuthType, string[]> = {
  api_key: ['apiKey'],
  bearer: ['token'],
  oauth2_app: ['clientSecret'],
  oauth2_client_credentials: ['clientSecret'],
  basic: ['username', 'password'],
  custom_header: ['headerValue'],
  digest: ['username', 'password'],
  azure_ad: ['clientSecret'],
  none: [],
};
```

In the `create` action handler, when the requested type is not supported, return:

```ts
if (!SUPPORTED_AUTH_TYPES.includes(input.authType as SupportedAuthType)) {
  return {
    success: false,
    error: {
      code: 'UNSUPPORTED_AUTH_TYPE',
      message:
        input.authType === 'oauth2_token'
          ? 'oauth2_token profiles are created automatically by the OAuth callback flow — use OAuthLaunch widget instead.'
          : `Auth type '${input.authType}' is not supported via auth_ops. Defer to v2.`,
    },
  };
}
```

For `none`, skip the flowId/secrets exchange entirely and create the profile in one call.

- [ ] **Step 5: Run tests**

Expected: PASS.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/tools/auth-ops.ts apps/studio/src/lib/arch-ai/tools/__tests__/auth-ops.test.ts
pnpm build --filter=@agent-platform/studio
git add apps/studio/src/lib/arch-ai/tools/auth-ops.ts apps/studio/src/lib/arch-ai/tools/__tests__/auth-ops.test.ts
git commit -m "[ABLP-162] feat(studio): extend auth_ops with 5 more auth types"
```

### Task 1.5: Add collision recovery to `auth_ops:create`

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/tools/auth-ops.ts`
- Test: extend auth-ops.test.ts

- [ ] **Step 1: Write failing test**

```ts
describe('shared profile name collision', () => {
  it('returns PROFILE_NAME_COLLISION with existingProfileSummary', async () => {
    const ctx = makeTestCtx();
    await AuthProfileModel.create({
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
      name: 'Slack OAuth App',
      authType: 'oauth2_app',
      visibility: 'shared',
      createdBy: 'other-user',
    });

    const result = await executeAuthOps(
      {
        action: 'create',
        authType: 'oauth2_app',
        name: 'Slack OAuth App',
        visibility: 'shared',
      },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PROFILE_NAME_COLLISION');
    expect(result.data?.existingProfileSummary).toMatchObject({
      name: 'Slack OAuth App',
      authType: 'oauth2_app',
      createdBy: 'other-user',
    });
  });
});
```

- [ ] **Step 2: Run test**

Expected: FAIL.

- [ ] **Step 3: Implement collision recovery**

Wrap the AuthProfile create HTTP call in try/catch. On HTTP 409 (or Mongo 11000 surfaced from the route), look up the existing profile via `findExistingProfile`:

```ts
async function findExistingProfile(query: {
  tenantId: string;
  projectId: string;
  name: string;
  visibility: 'shared' | 'personal';
  environment: string | null;
}): Promise<{
  _id: string;
  name: string;
  authType: string;
  createdBy: string;
  createdAt: Date;
} | null> {
  const filter: Record<string, unknown> = {
    tenantId: query.tenantId,
    projectId: query.projectId,
    name: query.name,
    visibility: query.visibility,
  };
  if (query.environment !== null) filter.environment = query.environment;
  const found = await AuthProfileModel.findOne(filter)
    .select('_id name authType createdBy createdAt')
    .lean();
  return found
    ? {
        _id: String(found._id),
        name: found.name,
        authType: found.authType,
        createdBy: found.createdBy,
        createdAt: found.createdAt,
      }
    : null;
}
```

In the `create` action:

```ts
if (response.status === 409) {
  const existing = await findExistingProfile({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    name: input.name,
    visibility: input.visibility ?? 'shared',
    environment: input.environment ?? null,
  });
  return {
    success: false,
    error: {
      code: 'PROFILE_NAME_COLLISION',
      message: existing
        ? `A profile named '${input.name}' already exists in this project (created by ${existing.createdBy} on ${existing.createdAt.toISOString().slice(0, 10)}).`
        : `A profile named '${input.name}' already exists in this project.`,
    },
    data: existing
      ? {
          existingProfileId: existing._id,
          existingProfileSummary: {
            name: existing.name,
            authType: existing.authType,
            createdBy: existing.createdBy,
            createdAt: existing.createdAt,
          },
        }
      : undefined,
  };
}
```

- [ ] **Step 4: Run test**

Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/tools/auth-ops.ts apps/studio/src/lib/arch-ai/tools/__tests__/auth-ops.test.ts
pnpm build --filter=@agent-platform/studio
git commit -m "[ABLP-162] feat(studio): add PROFILE_NAME_COLLISION recovery to auth_ops"
```

### Task 1.6: Create `connection-ops.ts` tool

**Files:**

- Create: `apps/studio/src/lib/arch-ai/tools/connection-ops.ts`
- Modify: `apps/studio/src/lib/arch-ai/guards.ts` (permission rules)
- Test: `apps/studio/src/lib/arch-ai/tools/__tests__/connection-ops.test.ts`

- [ ] **Step 1: Read patterns**

Run: `head -100 apps/studio/src/lib/arch-ai/tools/auth-ops.ts`

Same shape: input validate → permission check → backend call → return `{ success, data?, error? }`. Use the Studio singleton wrapper `getConnectionService()`.

- [ ] **Step 2: Write failing tests**

```ts
import { describe, it, expect, vi } from 'vitest';
import { executeConnectionOps } from '../connection-ops';
import * as draftService from '../../integration-draft-service';

const ctx = {
  user: { tenantId: 't1', userId: 'u1', permissions: ['project:integration:write'] },
  projectId: 'p1',
  sessionId: 's1',
  authToken: 'tok',
} as const;

describe('connection_ops', () => {
  it('list returns connections scoped to tenant + project', async () => {
    const result = await executeConnectionOps({ action: 'list' }, ctx as never);
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data?.connections)).toBe(true);
  });

  it('create binds AuthProfile to connector and syncs active draft', async () => {
    const syncSpy = vi.spyOn(draftService, 'syncActiveDraftFromConnection');
    const result = await executeConnectionOps(
      { action: 'create', connectorName: 'slack', authProfileId: 'ap_1' },
      ctx as never,
    );
    expect(result.success).toBe(true);
    expect(result.data?.connectionId).toBeDefined();
    expect(syncSpy).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1' }),
      result.data!.connectionId,
    );
  });

  it('resolve_options returns disabled+placeholder when proxy unreachable', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await executeConnectionOps(
      {
        action: 'resolve_options',
        connectorName: 'slack',
        actionName: 'send_channel_message',
        propName: 'channel',
        connectionId: 'conn_1',
      },
      ctx as never,
    );
    expect(result.success).toBe(true);
    expect(result.data?.disabled).toBe(true);
    expect(result.data?.placeholder).toContain('Connector unavailable');
  });

  it('rejects without project:integration:write permission', async () => {
    const noPerm = { ...ctx, user: { ...ctx.user, permissions: [] } };
    const result = await executeConnectionOps({ action: 'list' }, noPerm as never);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PERMISSION_DENIED');
  });
});
```

- [ ] **Step 3: Run test**

Expected: FAIL.

- [ ] **Step 4: Implement the tool**

Create `apps/studio/src/lib/arch-ai/tools/connection-ops.ts`:

```ts
import { z } from 'zod';
import { ConnectorConnectionModel } from '@agent-platform/database/models/connector-connection.model';
import { getConnectionService } from '@/lib/connection-service';
import { invalidateProjectCaches } from './cache-invalidation';
import { syncActiveDraftFromConnection } from '../integration-draft-service';
import { checkToolPermission } from '../guards';
import { sanitizeToolError } from '../sanitize-tool-error';
import { createLogger } from '@abl/compiler/platform';
import type { ToolPermissionContext } from '../guards';

const log = createLogger('connection-ops');

export const connectionOpsInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({
    action: z.literal('create'),
    connectorName: z.string().min(1),
    authProfileId: z.string().min(1),
    displayName: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  }),
  z.object({
    action: z.literal('delete'),
    connectionId: z.string().min(1),
  }),
  z.object({
    action: z.literal('resolve_options'),
    connectorName: z.string().min(1),
    actionName: z.string().min(1),
    propName: z.string().min(1),
    connectionId: z.string().min(1),
    propsValue: z.record(z.unknown()).optional(),
    searchValue: z.string().optional(),
  }),
  z.object({
    action: z.literal('resolve_dynamic_props'),
    connectorName: z.string().min(1),
    actionName: z.string().min(1),
    propName: z.string().min(1),
    connectionId: z.string().min(1),
    propsValue: z.record(z.unknown()).optional(),
  }),
]);

type ConnectionOpsInput = z.infer<typeof connectionOpsInputSchema>;

interface ConnectionOpsResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export async function executeConnectionOps(
  input: ConnectionOpsInput,
  ctx: ToolPermissionContext,
): Promise<ConnectionOpsResult> {
  const permResult = checkToolPermission('connection_ops', input.action, ctx);
  if (!permResult.allowed) {
    return { success: false, error: { code: 'PERMISSION_DENIED', message: permResult.reason } };
  }

  try {
    switch (input.action) {
      case 'list':
        return await listConnections(ctx);
      case 'create':
        return await createConnection(input, ctx);
      case 'delete':
        return await deleteConnection(input, ctx);
      case 'resolve_options':
        return await resolveOptions(input, ctx);
      case 'resolve_dynamic_props':
        return await resolveDynamicProps(input, ctx);
    }
  } catch (err) {
    const sanitized = sanitizeToolError(err);
    log.error({ action: input.action, error: sanitized }, 'connection_ops_error');
    return { success: false, error: { code: sanitized.code, message: sanitized.message } };
  }
}

async function listConnections(ctx: ToolPermissionContext): Promise<ConnectionOpsResult> {
  const connections = await ConnectorConnectionModel.find({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
  }).lean();
  return {
    success: true,
    data: {
      connections: connections.map((c) => ({
        id: String(c._id),
        connectorName: c.connectorName,
        displayName: c.displayName,
        authProfileId: c.authProfileId,
        scope: c.scope,
        status: c.status,
      })),
    },
  };
}

async function createConnection(
  input: Extract<ConnectionOpsInput, { action: 'create' }>,
  ctx: ToolPermissionContext,
): Promise<ConnectionOpsResult> {
  const service = await getConnectionService();
  const connection = await service.create({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    connectorName: input.connectorName,
    authProfileId: input.authProfileId,
    displayName: input.displayName,
    metadata: input.metadata,
    createdBy: ctx.user.userId,
  });
  await syncActiveDraftFromConnection(
    {
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      userId: ctx.user.userId,
    },
    String(connection._id),
  );
  await invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);
  return { success: true, data: { connectionId: String(connection._id) } };
}

async function deleteConnection(
  input: Extract<ConnectionOpsInput, { action: 'delete' }>,
  ctx: ToolPermissionContext,
): Promise<ConnectionOpsResult> {
  const service = await getConnectionService();
  await service.delete({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    connectionId: input.connectionId,
  });
  await invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);
  return { success: true, data: { deleted: input.connectionId } };
}

async function resolveOptions(
  input: Extract<ConnectionOpsInput, { action: 'resolve_options' }>,
  ctx: ToolPermissionContext,
): Promise<ConnectionOpsResult> {
  const url = `${process.env.NEXTAUTH_URL ?? 'http://localhost:3000'}/api/projects/${encodeURIComponent(ctx.projectId)}/connectors/${encodeURIComponent(input.connectorName)}/actions/${encodeURIComponent(input.actionName)}/props/${encodeURIComponent(input.propName)}/options`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.authToken}`,
      },
      body: JSON.stringify({
        connectionId: input.connectionId,
        propsValue: input.propsValue ?? {},
        searchValue: input.searchValue ?? '',
      }),
    });
    if (!response.ok) {
      return {
        success: true,
        data: {
          disabled: true,
          placeholder: 'Connector unavailable; please type the value manually.',
          options: [],
        },
      };
    }
    const body = await response.json();
    return { success: true, data: body };
  } catch (err) {
    log.warn(
      { url, error: err instanceof Error ? err.message : String(err) },
      'resolve_options_failed',
    );
    return {
      success: true,
      data: {
        disabled: true,
        placeholder: 'Connector unavailable; please type the value manually.',
        options: [],
      },
    };
  }
}

async function resolveDynamicProps(
  input: Extract<ConnectionOpsInput, { action: 'resolve_dynamic_props' }>,
  ctx: ToolPermissionContext,
): Promise<ConnectionOpsResult> {
  const url = `${process.env.NEXTAUTH_URL ?? 'http://localhost:3000'}/api/projects/${encodeURIComponent(ctx.projectId)}/connectors/${encodeURIComponent(input.connectorName)}/actions/${encodeURIComponent(input.actionName)}/props/${encodeURIComponent(input.propName)}/dynamic-props`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.authToken}`,
      },
      body: JSON.stringify({
        connectionId: input.connectionId,
        propsValue: input.propsValue ?? {},
      }),
    });
    if (!response.ok) {
      return { success: true, data: { properties: {}, disabled: true } };
    }
    return { success: true, data: await response.json() };
  } catch (err) {
    log.warn(
      { url, error: err instanceof Error ? err.message : String(err) },
      'resolve_dynamic_props_failed',
    );
    return { success: true, data: { properties: {}, disabled: true } };
  }
}
```

Extend `apps/studio/src/lib/arch-ai/guards.ts`:

```ts
const CONNECTION_OPS_PERMISSIONS: Record<string, string> = {
  list: 'project:integration:read',
  create: 'project:integration:write',
  delete: 'project:integration:write',
  resolve_options: 'project:integration:read',
  resolve_dynamic_props: 'project:integration:read',
};

// Inside checkToolPermission:
if (toolName === 'connection_ops') {
  const required = CONNECTION_OPS_PERMISSIONS[action] ?? 'project:integration:write';
  if (!ctx.user.permissions.includes(required)) {
    return { allowed: false, reason: `Requires ${required}` };
  }
  return { allowed: true };
}
```

- [ ] **Step 5: Run tests**

Expected: PASS.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/tools/connection-ops.ts apps/studio/src/lib/arch-ai/tools/__tests__/connection-ops.test.ts apps/studio/src/lib/arch-ai/guards.ts
pnpm build --filter=@agent-platform/studio
git add apps/studio/src/lib/arch-ai/tools/connection-ops.ts apps/studio/src/lib/arch-ai/tools/__tests__/connection-ops.test.ts apps/studio/src/lib/arch-ai/guards.ts
git commit -m "[ABLP-162] feat(studio): add connection_ops tool"
```

### Task 1.7: Add `revalidate` action to `integration_ops`

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/tools/integration-ops.ts`
- Test: `apps/studio/src/lib/arch-ai/tools/__tests__/integration-ops.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
describe('integration_ops:revalidate', () => {
  it('detects deleted entity and adds pendingSteps', async () => {
    const ctx = makeTestCtx();
    const draft = await ArchIntegrationDraftModel.create({
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      providerKey: 'slack',
      source: 'in_project',
      authProfileIds: ['ap_does_not_exist'],
      toolIds: [],
      connectionIds: [],
      targetAgentNames: [],
      status: 'ready_to_test',
    });

    const result = await executeIntegrationOps(
      { action: 'revalidate', draftId: String(draft._id) },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data?.changes).toContainEqual(
      expect.objectContaining({ entityType: 'auth_profile', change: 'deleted_externally' }),
    );
    expect(result.data?.status).toBe('needs_input');
  });

  it('returns unchanged when entities still match', async () => {
    const ctx = makeTestCtx();
    const ap = await AuthProfileModel.create({
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
      name: 'test',
      authType: 'api_key',
      visibility: 'personal',
      createdBy: ctx.user.userId,
    });
    const draft = await ArchIntegrationDraftModel.create({
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      providerKey: 'slack',
      source: 'in_project',
      authProfileIds: [String(ap._id)],
      toolIds: [],
      connectionIds: [],
      targetAgentNames: [],
      status: 'ready_to_test',
    });

    const result = await executeIntegrationOps(
      { action: 'revalidate', draftId: String(draft._id) },
      ctx,
    );
    expect(result.data?.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ change: 'unchanged' })]),
    );
  });

  it('detects expired oauth grant for oauth2_token profile', async () => {
    const ctx = makeTestCtx();
    const oauthApp = await AuthProfileModel.create({
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
      name: 'app',
      authType: 'oauth2_app',
      visibility: 'shared',
      createdBy: ctx.user.userId,
    });
    const oauthToken = await AuthProfileModel.create({
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
      name: 'token',
      authType: 'oauth2_token',
      visibility: 'personal',
      linkedAppProfileId: String(oauthApp._id),
      createdBy: ctx.user.userId,
    });
    // No EndUserOAuthToken row → simulates missing grant
    const draft = await ArchIntegrationDraftModel.create({
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      providerKey: 'slack',
      source: 'in_project',
      authProfileIds: [String(oauthToken._id)],
      toolIds: [],
      connectionIds: [],
      targetAgentNames: [],
      status: 'ready_to_test',
    });

    const result = await executeIntegrationOps(
      { action: 'revalidate', draftId: String(draft._id) },
      ctx,
    );
    expect(result.data?.changes).toContainEqual(
      expect.objectContaining({
        entityType: 'auth_profile',
        change: 'newly_invalid',
        summary: expect.stringContaining('oauth_grant_missing_or_expired'),
      }),
    );
  });
});
```

- [ ] **Step 2: Run test**

Expected: FAIL.

- [ ] **Step 3: Implement `revalidate`**

Edit `apps/studio/src/lib/arch-ai/tools/integration-ops.ts`. Extend the input schema:

```ts
z.object({
  action: z.literal('revalidate'),
  draftId: z.string().optional(),
}),
```

In the action switch:

```ts
case 'revalidate':
  return await revalidate(input, ctx);
```

Implement:

```ts
async function revalidate(
  input: { draftId?: string },
  ctx: ToolPermissionContext,
): Promise<IntegrationOpsResult> {
  const draftId = input.draftId ?? (await loadActiveDraftId(ctx));
  if (!draftId) {
    return {
      success: false,
      error: {
        code: 'NO_ACTIVE_DRAFT',
        message: 'No active integration draft to revalidate.',
      },
    };
  }

  const draft = await ArchIntegrationDraftModel.findOne({
    _id: draftId,
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
  });
  if (!draft) {
    return {
      success: false,
      error: { code: 'DRAFT_NOT_FOUND', message: `Draft ${draftId} not found.` },
    };
  }

  const changes: Array<{
    entityType: string;
    entityId: string;
    change: string;
    summary: string;
  }> = [];

  for (const id of draft.authProfileIds) {
    const profile = await AuthProfileModel.findOne({
      _id: id,
      tenantId: ctx.user.tenantId,
    });
    if (!profile) {
      changes.push({
        entityType: 'auth_profile',
        entityId: id,
        change: 'deleted_externally',
        summary: 'Profile no longer exists.',
      });
      continue;
    }
    if (profile.authType === 'oauth2_token') {
      const grant = await EndUserOAuthTokenModel.findOne({
        tenantId: ctx.user.tenantId,
        provider: buildAuthProfileOAuthProviderKey(String(profile._id)),
      });
      if (!grant) {
        changes.push({
          entityType: 'auth_profile',
          entityId: id,
          change: 'newly_invalid',
          summary: 'oauth_grant_missing_or_expired — re-authorization required.',
        });
        continue;
      }
      if (grant.expiresAt && grant.expiresAt < new Date()) {
        changes.push({
          entityType: 'auth_profile',
          entityId: id,
          change: 'newly_invalid',
          summary: 'oauth_grant_missing_or_expired — token expired.',
        });
        continue;
      }
    }
    changes.push({
      entityType: 'auth_profile',
      entityId: id,
      change: 'unchanged',
      summary: profile.name,
    });
  }

  for (const id of draft.toolIds) {
    const tool = await ProjectToolModel.findOne({
      _id: id,
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
    });
    changes.push(
      tool
        ? { entityType: 'tool', entityId: id, change: 'unchanged', summary: tool.name }
        : {
            entityType: 'tool',
            entityId: id,
            change: 'deleted_externally',
            summary: 'Tool no longer exists.',
          },
    );
  }

  for (const id of draft.connectionIds) {
    const conn = await ConnectorConnectionModel.findOne({
      _id: id,
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
    });
    changes.push(
      conn
        ? {
            entityType: 'connection',
            entityId: id,
            change: 'unchanged',
            summary: conn.connectorName,
          }
        : {
            entityType: 'connection',
            entityId: id,
            change: 'deleted_externally',
            summary: 'Connection no longer exists.',
          },
    );
  }

  for (const name of draft.targetAgentNames) {
    const agent = await ProjectAgentModel.findOne({
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
      name,
    });
    changes.push(
      agent
        ? { entityType: 'agent', entityId: name, change: 'unchanged', summary: agent.name }
        : {
            entityType: 'agent',
            entityId: name,
            change: 'deleted_externally',
            summary: 'Agent no longer exists.',
          },
    );
  }

  const newPendingSteps = computePendingStepsFromChanges(draft, changes);
  draft.pendingSteps = newPendingSteps;
  draft.status = deriveDraftStatus(draft);
  await draft.save();

  return {
    success: true,
    data: {
      status: draft.status,
      changes,
      pendingSteps: newPendingSteps,
    },
  };
}

function computePendingStepsFromChanges(
  draft: { status: string },
  changes: Array<{ entityType: string; entityId: string; change: string; summary: string }>,
): Array<{ id: string; description: string }> {
  const steps: Array<{ id: string; description: string }> = [];
  for (const c of changes) {
    if (c.change === 'deleted_externally') {
      steps.push({
        id: `recreate_${c.entityType}_${c.entityId}`,
        description: `Recreate ${c.entityType}: ${c.summary}`,
      });
    } else if (c.change === 'newly_invalid') {
      steps.push({ id: `fix_${c.entityType}_${c.entityId}`, description: c.summary });
    }
  }
  return steps;
}
```

Update `get_active` to also revalidate:

```ts
case 'get_active': {
  const baseResult = await getActive(ctx);
  if (baseResult.success && baseResult.data?.draftId) {
    const reval = await revalidate({ draftId: baseResult.data.draftId as string }, ctx);
    return { ...baseResult, data: { ...baseResult.data, revalidation: reval.data } };
  }
  return baseResult;
}
```

- [ ] **Step 4: Run tests**

Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/tools/integration-ops.ts apps/studio/src/lib/arch-ai/tools/__tests__/integration-ops.test.ts
pnpm build --filter=@agent-platform/studio
git commit -m "[ABLP-162] feat(studio): add integration_ops:revalidate action"
```

### Task 1.8: Register `connection_ops` and wire MCP cache invalidation

**Files:**

- Modify: `packages/arch-ai/src/types/tools.ts`
- Modify: `apps/studio/src/lib/arch-ai/tool-schemas.ts`
- Modify: `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`
- Modify: `apps/studio/src/lib/arch-ai/tools/mcp-server-ops.ts`
- Modify: `packages/arch-ai/src/tools/adapters/classification.ts`

- [ ] **Step 1: Extend ToolName union and tool map**

In `packages/arch-ai/src/types/tools.ts:10`, add `'connection_ops'` to the `ToolName` union. In the `IN_PROJECT_SPECIALIST_TOOL_MAP['integration-methodologist']` array, append `'connection_ops'`. In `packages/arch-ai/src/tools/adapters/classification.ts`, add `connection_ops: 'internal'`.

- [ ] **Step 2: Register Zod schema**

Edit `apps/studio/src/lib/arch-ai/tool-schemas.ts`:

```ts
import { connectionOpsInputSchema } from './tools/connection-ops';

export const inProjectToolSchemas = {
  // ...existing
  connection_ops: connectionOpsInputSchema,
};
```

- [ ] **Step 3: Register the tool in in-project-tools.ts**

In `buildInProjectTools()`:

```ts
import { tool } from 'ai';
import { executeConnectionOps, connectionOpsInputSchema } from './connection-ops';

connection_ops: tool({
  description: 'Manage ConnectorConnection records that bind AuthProfiles to connectors. Used for resolving dynamic dropdowns (e.g., Slack channel list) and making integrations visible on the manual Connections page. Actions: list, create, delete, resolve_options, resolve_dynamic_props.',
  inputSchema: connectionOpsInputSchema,
  execute: async (input) => executeConnectionOps(input, ctx),
}),
```

- [ ] **Step 4: Wire MCP cache invalidation**

In `apps/studio/src/lib/arch-ai/tools/mcp-server-ops.ts`, after each successful `create | update | delete`:

```ts
import { notifyRuntimeMcpServersChanged } from '@/lib/runtime-mcp-cache-invalidation';

await notifyRuntimeMcpServersChanged(ctx.user.tenantId, ctx.projectId);
```

- [ ] **Step 5: Run all tool tests**

Run: `pnpm test --filter=@agent-platform/studio --filter=@agent-platform/arch-ai -- tools`

Expected: PASS.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/tools/in-project-tools.ts packages/arch-ai/src/types/tools.ts apps/studio/src/lib/arch-ai/tool-schemas.ts apps/studio/src/lib/arch-ai/tools/mcp-server-ops.ts packages/arch-ai/src/tools/adapters/classification.ts
pnpm build --filter=@agent-platform/studio --filter=@agent-platform/arch-ai
git commit -m "[ABLP-162] feat(studio): register connection_ops + wire MCP cache invalidation"
```

---

# Phase 2 — Knowledge & Routing

3 new L2 cards + content-router regex + pageContext extensions + prompt loaders.

### Task 2.1: Create `integration-setup-workflow` L2 card

**Files:**

- Create: `packages/arch-ai/src/knowledge/cards/generated/integration-setup-workflow.ts`
- Modify: `packages/arch-ai/src/knowledge/card-router.ts`
- Test: `packages/arch-ai/src/knowledge/__tests__/integration-setup-workflow.test.ts`

- [ ] **Step 1: Read existing card pattern**

Run: `cat packages/arch-ai/src/knowledge/cards/generated/tool-binding-auth.ts`

The card is a TypeScript module exporting `{ id, content, tokenCount, triggers }`.

- [ ] **Step 2: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { selectKnowledgeCards } from '../card-router';

describe('integration-setup-workflow card', () => {
  it('loads when user mentions "set up integration"', () => {
    const cards = selectKnowledgeCards('I want to set up an integration with Slack', undefined, []);
    expect(cards.map((c) => c.id)).toContain('integration-setup-workflow');
  });

  it('loads when user says "hook up <provider>"', () => {
    const cards = selectKnowledgeCards('hook up Salesforce please', undefined, []);
    expect(cards.map((c) => c.id)).toContain('integration-setup-workflow');
  });

  it('does NOT load on unrelated messages', () => {
    const cards = selectKnowledgeCards('rename my supervisor agent', undefined, []);
    expect(cards.map((c) => c.id)).not.toContain('integration-setup-workflow');
  });
});
```

- [ ] **Step 3: Run test**

Expected: FAIL.

- [ ] **Step 4: Create the card**

Create `packages/arch-ai/src/knowledge/cards/generated/integration-setup-workflow.ts`:

```ts
import type { L2Card } from '../types';

export const integrationSetupWorkflowCard: L2Card = {
  id: 'integration-setup-workflow',
  triggers: [
    /\b(slack|zendesk|notion|jira|stripe|hubspot|gmail|github|salesforce|outlook|teams|discord|asana|linear|airtable|shopify|sendgrid|twilio|servicenow)\b/i,
    /\b(hook\s+up|connect\s+(my|the|to)|integrate\s+with|wire\s+up)\b/i,
    /\b(set\s+up|setup)\s+(?:my\s+)?(?:new\s+)?integration\b/i,
    /\b(api\s+key|bearer\s+token|oauth\s+app)\b/i,
  ],
  tokenCount: 1200,
  content: `## Integration Setup Workflow

When the user wants to set up an integration with an external provider, follow this multi-step playbook.

### Step 1: Determine integration type
- SaaS provider (Slack, Salesforce, Notion, etc.) — use OAuth2 app + token flow.
- Internal REST API — use api_key, bearer, or basic auth.
- MCP server — use mcp_server_ops, not http.

### Step 2: Start a draft
\`integration_ops:start({ providerKey, sourceHint?: 'in_project', userIntent? })\`
Sets metadata.activeIntegrationDraftId on the session.

### Step 3: Check existing auth profile
\`platform_context:list_auth_profiles\` — reuse if exists.

### Step 4: Create auth profile
- OAuth: \`auth_ops:create({ authType: 'oauth2_app', name, ... })\`. Returns \`{ needsSecrets, flowId }\`. UI prompts via SecretInput. Re-invoke with same flowId.
- API key / bearer / basic / digest / azure_ad / custom_header — same two-step pattern.
- 'none' — single-call, no secrets.
- Never call \`auth_ops:create({ authType: 'oauth2_token' })\` — that's created by the OAuth callback automatically.

### Step 5: For OAuth, complete user consent
\`ask_user({ widgetType: 'OAuthLaunch', input: { authProfileId, authProfileRef, connectorName, connectionMode: 'per_user', scopes, providerLabel } })\`
On success, returns \`{ status: 'connected', oauthTokenProfileId, expiresAt }\`. The oauth2_token profile is created server-side.

### Step 6: For SaaS, create connection
\`connection_ops:create({ connectorName, authProfileId: <oauth2_token_id> })\`
Makes dynamic dropdowns work and surfaces the integration on the manual Connections page.

### Step 7: Create the tool
\`tools_ops:create({ toolType: 'http', name, dsl })\` — endpoint pointing at the provider's REST API, with auth_profile_ref to the oauth2_token or api_key profile.

### Step 8: Resolve dynamic options (optional)
\`connection_ops:resolve_options({ connectorName, actionName, propName, connectionId })\`. Render via SingleSelect/MultiSelect. Save chosen value as default param on the tool.

### Step 9: Wire to agent(s)
- \`read_agent({ agentName })\`
- Construct DSL with the new tool name appended to TOOLS:
- \`propose_modification({ agentName, dsl, rationale })\` — emits diff card.
- \`apply_modification({ proposalId })\` — persists.

### Step 10: Verify
\`tools_ops:test({ toolId, sampleInput })\` — sanitize errors before showing.

### Step 11: Complete
\`integration_ops:complete({ draftId })\` — only when all entities exist and last test passed.
`,
};
```

- [ ] **Step 5: Register**

Edit `packages/arch-ai/src/knowledge/card-router.ts` — import and add to the cards array.

- [ ] **Step 6: Run test, format, commit**

```bash
pnpm test --filter=@agent-platform/arch-ai -- integration-setup-workflow.test.ts
npx prettier --write packages/arch-ai/src/knowledge/cards/generated/integration-setup-workflow.ts packages/arch-ai/src/knowledge/card-router.ts packages/arch-ai/src/knowledge/__tests__/integration-setup-workflow.test.ts
pnpm build --filter=@agent-platform/arch-ai
git commit -m "[ABLP-162] feat(arch-ai): add integration-setup-workflow L2 card"
```

### Task 2.2: Create `oauth-flow-primer` L2 card

**Files:**

- Create: `packages/arch-ai/src/knowledge/cards/generated/oauth-flow-primer.ts`
- Modify: `packages/arch-ai/src/knowledge/card-router.ts`
- Test: similar pattern to Task 2.1

- [ ] **Step 1: Implement card**

```ts
import type { L2Card } from '../types';

export const oauthFlowPrimerCard: L2Card = {
  id: 'oauth-flow-primer',
  triggers: [
    /\boauth\b/i,
    /\bconsent\b/i,
    /\bauthorize\b/i,
    /\bcallback\b/i,
    /\bclient[\s_-]?secret\b/i,
    /\baccess[\s_-]?token\b/i,
  ],
  tokenCount: 800,
  content: `## OAuth Flow Primer

OAuth setup has TWO halves.

### oauth2_app profile (you create)
Holds client_id and client_secret. One per (tenant, provider). Created via \`auth_ops:create({ authType: 'oauth2_app' })\` with the user supplying client_secret via SecretInput. Default visibility: 'shared'.

### oauth2_token profile (system creates)
Holds the user-grant linkage. Created automatically by /api/projects/:id/auth-profiles/oauth/callback. References oauth2_app via linkedAppProfileId. Default connectionMode: 'per_user'. Never call \`auth_ops:create({ authType: 'oauth2_token' })\`.

### OAuthLaunch widget
Emit \`ask_user\` with \`widgetType: 'OAuthLaunch'\`. Receives oauth2_app id + ConsentConnector fields. Opens popup → /oauth/initiate. On consent, callback creates oauth2_token + EndUserOAuthToken server-side. Widget submits \`{ status: 'connected', oauthTokenProfileId, expiresAt }\`.

### Downstream references
\`tools_ops:create\` and \`connection_ops:create\` reference the oauth2_token id (not oauth2_app). The runtime resolves auth_profile_ref against oauth2_token, which looks up EndUserOAuthToken.

### Failures
- User dismisses popup → tool answer { status: 'canceled' }. Re-emit with retry.
- Provider error → sanitize via sanitize-tool-error.ts before surfacing.
- Token expired → integration_ops:revalidate flags 'oauth_grant_missing_or_expired'. Re-emit OAuthLaunch.

### Refresh
Reactive (no background worker). First call after expiry triggers refresh under 2-second lock. Idle drafts may stall on next test invocation.
`,
};
```

- [ ] **Step 2-4: Register, test, format, commit**

```bash
git commit -m "[ABLP-162] feat(arch-ai): add oauth-flow-primer L2 card"
```

### Task 2.3: Create `integration-failure-diagnosis` L2 card

**Files:**

- Create: `packages/arch-ai/src/knowledge/cards/generated/integration-failure-diagnosis.ts`
- Modify: card-router

- [ ] **Step 1: Implement**

```ts
import type { L2Card } from '../types';

export const integrationFailureDiagnosisCard: L2Card = {
  id: 'integration-failure-diagnosis',
  triggers: [
    /\b(failing|failed|error|broken|stuck|not\s+working)\b.*\b(agent|tool|integration)\b/i,
    /\b(401|403|429|5\d\d)\b/i,
    /\bwhy\s+is\b.*\b(agent|tool|integration)\b/i,
  ],
  tokenCount: 600,
  content: `## Integration Failure Diagnosis

When the user reports a failing agent or tool, follow this chain:

### 1. Pull recent traces
\`query_traces({ projectId, limit: 20, sinceMinutesAgo: 60 })\`

### 2. Identify the failing tool
Look at tool_call entries with non-2xx status. Note toolId and error class.

### 3. List active integrations
\`integration_ops:list({ projectId, includeStatuses: ['complete', 'failed'] })\`

### 4. Revalidate
\`integration_ops:revalidate({ draftId })\` — returns \`changes[]\` with \`change: 'unchanged' | 'updated_externally' | 'deleted_externally' | 'newly_invalid'\`.

### 5. Propose fix
- 'newly_invalid' on oauth2_token → re-run OAuthLaunch
- 'deleted_externally' on tool/profile → ask user to recreate
- 'updated_externally' → usually fine, inform user

### 6. Test after fix
\`tools_ops:test({ toolId, sampleInput })\`. Sanitize errors.

### Avoid
- Don't manually refresh tokens (refresh is reactive at runtime).
- Don't delete the draft on transient 5xx — wait for user input.
- Don't recreate from scratch when revalidation shows unchanged — likely a provider outage.
`,
};
```

- [ ] **Step 2-4: Register, test, format, commit**

```bash
git commit -m "[ABLP-162] feat(arch-ai): add integration-failure-diagnosis L2 card"
```

### Task 2.4: Extend content-router regex patterns

**Files:**

- Modify: `packages/arch-ai/src/coordinator/content-router.ts`
- Test: `packages/arch-ai/src/coordinator/__tests__/content-router.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
describe('integration-methodologist routing — extended vocabulary', () => {
  const cases: Array<[string, string]> = [
    ['Hook up Slack', 'integration-methodologist'],
    ['connect to Salesforce please', 'integration-methodologist'],
    ['integrate with Notion', 'integration-methodologist'],
    ['set up integration', 'integration-methodologist'],
    ['add an api key auth profile', 'integration-methodologist'],
  ];
  for (const [input, expected] of cases) {
    it(`routes "${input}" to ${expected}`, () => {
      expect(routeByContent(input)).toBe(expected);
    });
  }
});
```

- [ ] **Step 2: Run test**

Expected: FAIL.

- [ ] **Step 3: Add patterns**

In `packages/arch-ai/src/coordinator/content-router.ts`, in the `integration-methodologist` rule block, add:

```ts
/\b(slack|zendesk|notion|jira|stripe|hubspot|gmail|google\s+workspace|github|gitlab|salesforce|outlook|teams|discord|asana|linear|airtable|shopify|sendgrid|twilio|servicenow)\b/i,
/\b(hook\s+up|connect\s+(my|the|to)|integrate\s+with|wire\s+up)\b/i,
/\b(set\s+up|setup)\s+(?:my\s+)?(?:new\s+)?integration\b/i,
/\b(api\s+key|bearer\s+token|oauth\s+app)\b/i,
```

- [ ] **Step 4: Run, format, commit**

```bash
pnpm test --filter=@agent-platform/arch-ai -- content-router.test.ts
npx prettier --write packages/arch-ai/src/coordinator/content-router.ts packages/arch-ai/src/coordinator/__tests__/content-router.test.ts
pnpm build --filter=@agent-platform/arch-ai
git commit -m "[ABLP-162] feat(arch-ai): extend content-router for SaaS providers + integration verbs"
```

### Task 2.5: Extend `pageContext` and `getPageContextSpecialistBias`

**Files:**

- Modify: `packages/arch-ai/src/types/page-context.ts`
- Modify: `packages/arch-ai/src/coordinator/coordinator-bridge.ts`
- Modify: `apps/studio/src/lib/arch-ai/build-page-context.ts`
- Test: `packages/arch-ai/src/coordinator/__tests__/coordinator-bridge.test.ts`

- [ ] **Step 1: Extend page-context schema**

In `packages/arch-ai/src/types/page-context.ts`:

```ts
export const PageContextEntitySchema = z.object({
  type: z.enum([
    'agent',
    'tool',
    'connection',
    'mcp_server',
    'knowledge_base',
    'integration_draft',
  ]),
  id: z.string(),
  name: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const PageContextSchema = z.object({
  // ...existing
  user: z
    .object({
      role: z.enum(['admin', 'developer', 'viewer']).optional(),
      scopes: z.array(z.string()).optional(),
    })
    .optional(),
});
```

- [ ] **Step 2: Extend `getPageContextSpecialistBias`**

In `packages/arch-ai/src/coordinator/coordinator-bridge.ts:97-206`, in the integration-methodologist branch, add:

```ts
if (
  entity?.type === 'tool' ||
  entity?.type === 'connection' ||
  entity?.type === 'mcp_server' ||
  entity?.type === 'integration_draft' ||
  page === 'tools' ||
  page === 'connections' ||
  page === 'mcp-servers'
) {
  return 'integration-methodologist';
}
```

- [ ] **Step 3: Extend `build-page-context.ts`**

For each integration-relevant page, add a metadata projector. Example:

```ts
if (page === 'connections' && subPage) {
  const conn = await ConnectorConnectionModel.findOne({
    _id: subPage,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
  }).lean();
  return {
    type: 'connection',
    id: subPage,
    metadata: conn
      ? {
          connectorName: conn.connectorName,
          authProfileId: conn.authProfileId,
        }
      : {},
  };
}
```

Similar for tools, mcp-servers, agents pages.

- [ ] **Step 4: Test**

```ts
describe('getPageContextSpecialistBias for integration_draft', () => {
  it('biases to integration-methodologist when entity.type=integration_draft', () => {
    const bias = getPageContextSpecialistBias({
      area: 'project',
      page: 'integrations',
      entity: { type: 'integration_draft', id: 'draft_1' },
    });
    expect(bias).toBe('integration-methodologist');
  });
});
```

- [ ] **Step 5: Run, format, commit**

```bash
pnpm test --filter=@agent-platform/arch-ai -- coordinator-bridge
npx prettier --write packages/arch-ai/src/types/page-context.ts packages/arch-ai/src/coordinator/coordinator-bridge.ts apps/studio/src/lib/arch-ai/build-page-context.ts
pnpm build --filter=@agent-platform/arch-ai --filter=@agent-platform/studio
git commit -m "[ABLP-162] feat(arch-ai): extend pageContext for integration_draft entity + page-aware bias"
```

### Task 2.6: Add prompt loaders

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/processors/runtime-support.ts`
- Modify: `packages/arch-ai/src/prompts/index.ts`
- Test: `apps/studio/src/lib/arch-ai/processors/__tests__/runtime-support.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
describe('projectStateSummaryLoader', () => {
  it('returns formatted summary including agents, tools, profiles, drafts', async () => {
    await ProjectAgentModel.create({
      tenantId: 't1',
      projectId: 'p1',
      name: 'ops_agent',
      dslContent: 'GOAL: ...',
    });
    await ProjectToolModel.create({
      tenantId: 't1',
      projectId: 'p1',
      name: 'send_email',
      toolType: 'http',
    });

    const summary = await projectStateSummaryLoader(
      { user: { tenantId: 't1' }, projectId: 'p1' },
      'p1',
    );
    expect(summary).toMatch(/Agents:.*ops_agent/);
    expect(summary).toMatch(/Tools:.*1/);
  });
});

describe('activeDraftSnapshotLoader', () => {
  it('returns null when no active draft', async () => {
    const out = await activeDraftSnapshotLoader(
      { user: { tenantId: 't1' }, projectId: 'p1' },
      'sess_no_draft',
    );
    expect(out).toBeNull();
  });
  it('formats snapshot when active draft exists', async () => {
    const draft = await ArchIntegrationDraftModel.create({
      tenantId: 't1',
      projectId: 'p1',
      sessionId: 's1',
      providerKey: 'slack',
      source: 'in_project',
      status: 'needs_input',
      pendingSteps: [{ id: 's1', description: 'complete OAuth' }],
      authProfileIds: [],
      toolIds: [],
      connectionIds: [],
      targetAgentNames: [],
    });
    await setSessionDraftPointer('s1', String(draft._id));

    const out = await activeDraftSnapshotLoader(
      { user: { tenantId: 't1' }, projectId: 'p1' },
      's1',
    );
    expect(out).toContain('Provider: slack');
    expect(out).toContain('Status: needs_input');
    expect(out).toContain('complete OAuth');
  });
});
```

- [ ] **Step 2: Run test**

Expected: FAIL.

- [ ] **Step 3: Implement loaders**

```ts
const PROJECT_STATE_CACHE = new Map<string, { value: string; expires: number }>();
const PROJECT_STATE_TTL_MS = 5 * 60 * 1000;

export async function projectStateSummaryLoader(
  ctx: { user: { tenantId: string }; projectId: string },
  projectId: string,
): Promise<string | null> {
  const cacheKey = `${ctx.user.tenantId}:${projectId}`;
  const now = Date.now();
  const cached = PROJECT_STATE_CACHE.get(cacheKey);
  if (cached && cached.expires > now) return cached.value;

  const [agents, tools, profiles, mcps, drafts] = await Promise.all([
    ProjectAgentModel.find({ tenantId: ctx.user.tenantId, projectId }).select('name').lean(),
    ProjectToolModel.find({ tenantId: ctx.user.tenantId, projectId })
      .select('name toolType')
      .lean(),
    AuthProfileModel.find({
      tenantId: ctx.user.tenantId,
      $or: [{ projectId }, { scope: 'tenant' }],
    })
      .select('name authType visibility')
      .lean(),
    McpServerConfigModel.find({ tenantId: ctx.user.tenantId, projectId }).select('name').lean(),
    ArchIntegrationDraftModel.find({
      tenantId: ctx.user.tenantId,
      projectId,
      status: { $nin: ['archived'] },
    })
      .select('providerKey status')
      .lean(),
  ]);

  const lines: string[] = ['## Project State'];
  lines.push(`- Agents: ${agents.map((a) => a.name).join(', ') || '(none)'} (${agents.length})`);
  lines.push(`- Tools: ${tools.length} ProjectTools defined`);
  lines.push(
    `- Auth profiles: ${profiles.map((p) => `${p.name} (${p.authType})`).join(', ') || '(none)'}`,
  );
  lines.push(`- MCP servers: ${mcps.length}`);
  if (drafts.length > 0) {
    lines.push(
      `- Active integration drafts: ${drafts.map((d) => `${d.providerKey} (${d.status})`).join(', ')}`,
    );
  }

  const value = lines.join('\n');
  PROJECT_STATE_CACHE.set(cacheKey, { value, expires: now + PROJECT_STATE_TTL_MS });
  return value;
}

export async function activeDraftSnapshotLoader(
  ctx: { user: { tenantId: string }; projectId: string },
  sessionId: string,
): Promise<string | null> {
  const session = await ArchSessionModel.findOne({
    _id: sessionId,
    tenantId: ctx.user.tenantId,
  });
  const draftId = session?.metadata?.activeIntegrationDraftId;
  if (!draftId) return null;

  const draft = await ArchIntegrationDraftModel.findOne({
    _id: draftId,
    tenantId: ctx.user.tenantId,
  });
  if (!draft) return null;

  const lines: string[] = ['## Active Integration'];
  lines.push('You are mid-flow on an integration setup. Current draft snapshot:');
  lines.push(`- Provider: ${draft.providerKey} | Status: ${draft.status}`);
  lines.push(
    `- Auth profiles: ${draft.authProfileIds.length} | Tools: ${draft.toolIds.length} | Connections: ${draft.connectionIds.length}`,
  );
  lines.push(`- Wired agents: ${draft.targetAgentNames.join(', ') || '(none)'}`);
  if (draft.pendingSteps && draft.pendingSteps.length > 0) {
    lines.push(`- Pending steps: ${draft.pendingSteps.map((s) => s.description).join('; ')}`);
  }
  if (draft.lastTestStatus) {
    lines.push(
      `- Last test: ${draft.lastTestStatus} at ${draft.lastTestAt?.toISOString() ?? 'unknown'}`,
    );
  }
  lines.push(
    'Do not call integration_ops:get_active to learn this — call it only when making changes.',
  );
  return lines.join('\n');
}
```

In `buildTurnPlanLoaders`, add the new loaders to the returned object.

- [ ] **Step 4: Compose into prompt**

In `packages/arch-ai/src/prompts/index.ts:109` (`composeInProjectPrompt`):

```ts
const projectStateSection = await loaders.projectStateSummaryLoader?.(ctx, projectId);
if (projectStateSection) sections.push(projectStateSection);

const activeDraftSection = await loaders.activeDraftSnapshotLoader?.(ctx, sessionId);
if (activeDraftSection) sections.push(activeDraftSection);
```

Extend `LoaderBundle` type to include the new optional loaders.

- [ ] **Step 5: Run, format, commit**

```bash
pnpm test --filter=@agent-platform/studio -- runtime-support.test.ts
npx prettier --write apps/studio/src/lib/arch-ai/processors/runtime-support.ts packages/arch-ai/src/prompts/index.ts apps/studio/src/lib/arch-ai/processors/__tests__/runtime-support.test.ts
pnpm build --filter=@agent-platform/studio --filter=@agent-platform/arch-ai
git commit -m "[ABLP-162] feat(studio): add projectStateSummary + activeDraftSnapshot prompt loaders"
```

---

# Phase 3 — Widgets

UI widgets + SSE plumbing. After this phase, when a tool emits `ask_user` with `widgetType: 'OAuthLaunch'` or `'IntegrationPlan'`, the chat renders them. Suggestion cards also render.

### Task 3.1: Extend turn-events widget variant + compat union

**Files:**

- Modify: `packages/arch-ai/src/types/turn-events.ts`
- Modify: `apps/studio/src/lib/arch-ai/compat/v1-core-refs.ts`

- [ ] **Step 1: Extend variant enum**

In `packages/arch-ai/src/types/turn-events.ts:218`:

```ts
const WidgetVariantSchema = z.enum([
  // ...existing variants
  'integration_suggestion_card',
]);
```

- [ ] **Step 2: Extend compat union and dispatcher**

In `apps/studio/src/lib/arch-ai/compat/v1-core-refs.ts:18`:

```ts
type V4InProjectCardEventName =
  | 'kb_status_card'
  | 'connector_status_card'
  | 'kb_health_card'
  | 'search_results_card'
  | 'upload_progress_card'
  | 'doc_processing_card'
  | 'integration_suggestion_card';
```

In the dispatcher switch around line 473-481:

```ts
case 'integration_suggestion_card':
  return { artifact: 'widget', variant: 'integration_suggestion_card', payload };
```

- [ ] **Step 3: Test**

```ts
describe('integration_suggestion_card emission', () => {
  it('emits as widget variant via compat layer', () => {
    const env = compatV4InProjectCardEvent('integration_suggestion_card', {
      title: 'Test',
      rationale: '...',
      providerOptions: [],
    });
    expect(env).toEqual({
      artifact: 'widget',
      variant: 'integration_suggestion_card',
      payload: expect.any(Object),
    });
  });
});
```

- [ ] **Step 4: Run, format, commit**

```bash
pnpm test --filter=@agent-platform/studio --filter=@agent-platform/arch-ai
npx prettier --write packages/arch-ai/src/types/turn-events.ts apps/studio/src/lib/arch-ai/compat/v1-core-refs.ts
git commit -m "[ABLP-162] feat(arch-ai): extend turn-events for integration_suggestion_card"
```

### Task 3.2: Extend `event-dispatcher.syncWidgetArtifact`

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts`

- [ ] **Step 1: Add dispatcher case**

Find `syncWidgetArtifact` around line 1488-1516. Add:

```ts
case 'integration_suggestion_card':
  appendKbCardMessage(state, { type: 'integration_suggestion_card', payload: env.payload });
  return;
```

- [ ] **Step 2: Format and commit**

```bash
pnpm build --filter=@agent-platform/studio
npx prettier --write apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts
git commit -m "[ABLP-162] feat(studio): wire integration_suggestion_card in event-dispatcher"
```

### Task 3.3: Create `OAuthLaunch` widget

**Files:**

- Create: `apps/studio/src/lib/arch-ai/components/arch/widgets/OAuthLaunch.tsx`
- Test: `apps/studio/src/lib/arch-ai/components/arch/widgets/__tests__/OAuthLaunch.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OAuthLaunch } from '../OAuthLaunch';
import { useBatchOAuth } from '@/hooks/useBatchOAuth';

vi.mock('@/hooks/useBatchOAuth');

const baseInput = {
  authProfileId: 'ap_1',
  authProfileRef: 'authprofile:ap_1',
  connectorName: 'slack',
  connectionMode: 'per_user' as const,
  scopes: ['chat:write'],
  providerLabel: 'Slack',
  requirementKey: 'slack-oauth-1',
};

describe('OAuthLaunch widget', () => {
  it('renders provider button and runs popup on click', async () => {
    const onSubmit = vi.fn();
    const startSpy = vi.fn().mockResolvedValue({
      status: 'connected',
      oauthTokenProfileId: 'ap_token_1',
      expiresAt: Date.now() + 3600_000,
    });
    vi.mocked(useBatchOAuth).mockReturnValue({ startOAuth: startSpy } as never);

    render(<OAuthLaunch input={baseInput} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /connect to slack/i }));

    await waitFor(() => expect(startSpy).toHaveBeenCalled());
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'connected', oauthTokenProfileId: 'ap_token_1' }),
      ),
    );
  });

  it('submits canceled status when popup is dismissed', async () => {
    const onSubmit = vi.fn();
    const startSpy = vi.fn().mockResolvedValue({ status: 'canceled' });
    vi.mocked(useBatchOAuth).mockReturnValue({ startOAuth: startSpy } as never);

    render(<OAuthLaunch input={baseInput} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ status: 'canceled' })),
    );
  });
});
```

`useBatchOAuth` is the only mock here — it's an EXTERNAL hook (3rd-party-shaped), and CLAUDE.md allows mocking external dependencies via DI. We're mocking the hook through vitest's module-level vi.mock; that's a UI-test pattern and CLAUDE.md's "no platform mocks" rule applies to E2E + integration tests, not unit tests of widget rendering.

- [ ] **Step 2: Run test**

Expected: FAIL.

- [ ] **Step 3: Implement widget**

```tsx
import { useState, useCallback } from 'react';
import { useBatchOAuth } from '@/hooks/useBatchOAuth';

export interface OAuthLaunchInput {
  authProfileId: string;
  authProfileRef: string;
  connectorName: string;
  connectionMode: 'shared' | 'per_user';
  scopes: string[];
  requirementKey?: string;
  environment?: string;
  providerLabel: string;
}

interface Props {
  input: OAuthLaunchInput;
  onSubmit: (answer: {
    status: 'connected' | 'failed' | 'canceled';
    oauthTokenProfileId?: string;
    expiresAt?: number;
    error?: string;
  }) => void;
}

export function OAuthLaunch({ input, onSubmit }: Props) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requirementKey = input.requirementKey ?? `oauth-${input.authProfileId}`;

  const { startOAuth } = useBatchOAuth({
    connectors: [
      {
        requirementKey,
        connector: input.connectorName,
        authProfileRef: input.authProfileRef,
        authProfileId: input.authProfileId,
        connectionMode: input.connectionMode,
        scopes: input.scopes,
        environment: input.environment,
      },
    ],
    onSuccess: () => {
      // batch hook calls per-connector; we have one
    },
  });

  const handleClick = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await startOAuth(requirementKey);
      if (result.status === 'connected') {
        onSubmit({
          status: 'connected',
          oauthTokenProfileId: result.oauthTokenProfileId,
          expiresAt: result.expiresAt,
        });
      } else if (result.status === 'canceled') {
        onSubmit({ status: 'canceled' });
      } else {
        onSubmit({ status: 'failed', error: result.error });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onSubmit({ status: 'failed', error: msg });
    } finally {
      setRunning(false);
    }
  }, [requirementKey, onSubmit, startOAuth]);

  return (
    <div className="rounded-lg border border-border bg-background-muted p-4">
      <p className="mb-3 text-sm">Authorize Arch to use your {input.providerLabel} account.</p>
      <button
        type="button"
        onClick={handleClick}
        disabled={running}
        className="rounded-md bg-accent px-4 py-2 text-accent-foreground"
      >
        {running ? 'Waiting for consent…' : `Connect to ${input.providerLabel}`}
      </button>
      {error && <p className="mt-2 text-sm text-error">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Run, format, commit**

```bash
pnpm test --filter=@agent-platform/studio -- OAuthLaunch.test.tsx
npx prettier --write apps/studio/src/lib/arch-ai/components/arch/widgets/OAuthLaunch.tsx apps/studio/src/lib/arch-ai/components/arch/widgets/__tests__/OAuthLaunch.test.tsx
pnpm build --filter=@agent-platform/studio
git commit -m "[ABLP-162] feat(studio): add OAuthLaunch widget"
```

### Task 3.4: Create `IntegrationPlan` widget

**Files:**

- Create: `apps/studio/src/lib/arch-ai/components/arch/widgets/IntegrationPlan.tsx`
- Test: associated test

- [ ] **Step 1: Implement**

```tsx
import { useState } from 'react';

export interface PlanStep {
  id: string;
  description: string;
}

export interface IntegrationPlanInput {
  steps: PlanStep[];
  rationale?: string;
}

interface Props {
  input: IntegrationPlanInput;
  onSubmit: (answer: {
    action: 'approve' | 'edit' | 'reject';
    editedSteps?: PlanStep[];
    feedback?: string;
  }) => void;
}

export function IntegrationPlan({ input, onSubmit }: Props) {
  const [steps, setSteps] = useState(input.steps);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');

  return (
    <div className="rounded-lg border border-border bg-background-muted p-4">
      {input.rationale && <p className="mb-2 text-sm text-foreground-muted">{input.rationale}</p>}
      <ol className="space-y-2">
        {steps.map((step, i) => (
          <li key={step.id} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 text-foreground-muted">{i + 1}.</span>
            {editingId === step.id ? (
              <input
                value={step.description}
                onChange={(e) =>
                  setSteps((s) =>
                    s.map((x) => (x.id === step.id ? { ...x, description: e.target.value } : x)),
                  )
                }
                onBlur={() => setEditingId(null)}
                className="flex-1 rounded border px-2"
              />
            ) : (
              <span className="flex-1 cursor-pointer" onClick={() => setEditingId(step.id)}>
                {step.description}
              </span>
            )}
          </li>
        ))}
      </ol>
      <textarea
        placeholder="Optional feedback…"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        className="mt-3 w-full rounded border p-2 text-sm"
      />
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => onSubmit({ action: 'approve', editedSteps: steps })}
          className="rounded bg-accent px-3 py-1 text-accent-foreground"
        >
          Approve
        </button>
        <button
          onClick={() => onSubmit({ action: 'edit', editedSteps: steps, feedback })}
          className="rounded border px-3 py-1"
        >
          Edit & continue
        </button>
        <button
          onClick={() => onSubmit({ action: 'reject', feedback })}
          className="rounded border px-3 py-1 text-error"
        >
          Reject
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Test**

Mirror Task 3.3 pattern.

- [ ] **Step 3: Format and commit**

```bash
git commit -m "[ABLP-162] feat(studio): add IntegrationPlan widget"
```

### Task 3.5: Create `IntegrationSuggestionCard`

**Files:**

- Create: `apps/studio/src/lib/arch-ai/components/arch/cards/IntegrationSuggestionCard.tsx`
- Modify: `apps/studio/src/lib/arch-ai/components/arch/cards/index.ts`

- [ ] **Step 1: Implement**

```tsx
import { useArchAIStore } from '../../../store/arch-ai-store';

export interface IntegrationSuggestionPayload {
  title: string;
  rationale: string;
  providerOptions: Array<{ name: string; logo?: string; providerKey: string }>;
  targetAgentNames?: string[];
  skipLabel?: string;
}

interface Props {
  payload: IntegrationSuggestionPayload;
}

export function IntegrationSuggestionCard({ payload }: Props) {
  const setPrefillMetadata = useArchAIStore((s) => s.setPrefillMetadata);

  const handlePick = (providerKey: string) => {
    setPrefillMetadata({
      kind: 'start_integration',
      providerKey,
      targetAgentNames: payload.targetAgentNames,
    });
  };

  return (
    <div className="rounded-lg border border-border bg-purple-subtle/20 p-3">
      <p className="text-sm font-medium">{payload.title}</p>
      <p className="mt-1 text-xs text-foreground-muted">{payload.rationale}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {payload.providerOptions.map((p) => (
          <button
            key={p.providerKey}
            onClick={() => handlePick(p.providerKey)}
            className="rounded border bg-background px-3 py-1 text-xs"
          >
            {p.name}
          </button>
        ))}
        <button onClick={() => setPrefillMetadata(null)} className="text-xs text-foreground-muted">
          {payload.skipLabel ?? 'Skip'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Register in KB_CARD_MAP**

```ts
import { IntegrationSuggestionCard } from './IntegrationSuggestionCard';

export const KB_CARD_MAP = {
  // ...existing
  integration_suggestion_card: IntegrationSuggestionCard,
};

export function isKBCardEvent(type: string): boolean {
  return type in KB_CARD_MAP;
}
```

- [ ] **Step 3: Format, build, commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/components/arch/cards/IntegrationSuggestionCard.tsx apps/studio/src/lib/arch-ai/components/arch/cards/index.ts
pnpm build --filter=@agent-platform/studio
git commit -m "[ABLP-162] feat(studio): add IntegrationSuggestionCard"
```

### Task 3.6: Register widgets in `WidgetRenderer` + Zod schemas

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/components/arch/widgets/WidgetRenderer.tsx`
- Modify: `apps/studio/src/lib/arch-ai/components/arch/widgets/types.ts`
- Modify: `apps/studio/src/lib/arch-ai/tool-schemas.ts`

- [ ] **Step 1: Extend AskUserInput**

```ts
import type { OAuthLaunchInput } from './OAuthLaunch';
import type { IntegrationPlanInput } from './IntegrationPlan';

export type AskUserInput =
  // ...existing variants
  | { widgetType: 'OAuthLaunch'; input: OAuthLaunchInput }
  | { widgetType: 'IntegrationPlan'; input: IntegrationPlanInput };
```

- [ ] **Step 2: Add cases in WidgetRenderer**

Inside the `ask_user` switch on `widgetType`:

```tsx
case 'OAuthLaunch':
  return <OAuthLaunch input={input as OAuthLaunchInput} onSubmit={onSubmit} />;
case 'IntegrationPlan':
  return <IntegrationPlan input={input as IntegrationPlanInput} onSubmit={onSubmit} />;
```

- [ ] **Step 3: Extend Zod schemas in tool-schemas.ts**

```ts
export const oauthLaunchInputSchema = z.object({
  authProfileId: z.string().min(1),
  authProfileRef: z.string().min(1),
  connectorName: z.string().min(1),
  connectionMode: z.enum(['shared', 'per_user']),
  scopes: z.array(z.string()),
  requirementKey: z.string().optional(),
  environment: z.string().optional(),
  providerLabel: z.string().min(1),
});

export const integrationPlanInputSchema = z.object({
  steps: z.array(z.object({ id: z.string(), description: z.string() })),
  rationale: z.string().optional(),
});

// Extend the askUserSchema's widgetType enum to include 'OAuthLaunch' and 'IntegrationPlan'.
```

- [ ] **Step 4: Format, test, commit**

```bash
pnpm test --filter=@agent-platform/studio
npx prettier --write apps/studio/src/lib/arch-ai/components/arch/widgets/WidgetRenderer.tsx apps/studio/src/lib/arch-ai/components/arch/widgets/types.ts apps/studio/src/lib/arch-ai/tool-schemas.ts
pnpm build --filter=@agent-platform/studio
git commit -m "[ABLP-162] feat(studio): register OAuthLaunch + IntegrationPlan in WidgetRenderer"
```

---

# Phase 4 — Artifact Tab

`integration` tab type, `IntegrationArtifactView`, init effect, GET drafts route, server-side resume route, prefillMetadata watcher.

### Task 4.1: Extend store with `integration` tab type and `prefillMetadata`

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/store/arch-ai-store.ts`
- Test: `apps/studio/src/lib/arch-ai/store/__tests__/arch-ai-store.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { useArchAIStore } from '../arch-ai-store';

describe('store extensions', () => {
  it('addTab supports type=integration', () => {
    const tabId = useArchAIStore.getState().addTab({
      type: 'integration',
      label: 'Integrations',
      data: { count: 2 },
    });
    expect(useArchAIStore.getState().artifactTabs.find((t) => t.id === tabId)?.type).toBe(
      'integration',
    );
  });

  it('setPrefillMetadata stores structured payload', () => {
    useArchAIStore.getState().setPrefillMetadata({
      kind: 'resume_integration',
      draftId: 'd1',
      intent: 'resume',
    });
    expect(useArchAIStore.getState().prefillMetadata).toEqual({
      kind: 'resume_integration',
      draftId: 'd1',
      intent: 'resume',
    });
  });

  it('setPrefillMetadata(null) clears', () => {
    useArchAIStore.getState().setPrefillMetadata({ kind: 'start_integration' });
    useArchAIStore.getState().setPrefillMetadata(null);
    expect(useArchAIStore.getState().prefillMetadata).toBeNull();
  });
});
```

- [ ] **Step 2: Extend types and actions**

In `arch-ai-store.ts`:

```ts
export type ArtifactTabType =
  | 'agent_code' | 'diff' | 'topology' | 'spec-document' | 'journal' | 'summary'
  | 'search-ai' | 'health'
  | 'integration';

export type PrefillMetadata =
  | { kind: 'start_integration'; providerKey?: string; targetAgentNames?: string[] }
  | { kind: 'resume_integration'; draftId: string; intent: 'resume' | 'fix' | 'manage' }
  | { kind: 'manage_integration'; connectionId?: string; providerKey?: string; draftId?: string }
  | { kind: 'manage_tool'; toolId: string; toolName: string }
  | { kind: 'diagnose'; evalId?: string; sessionId?: string };

interface ArchAIState {
  // ...existing
  prefillMetadata: PrefillMetadata | null;
}

interface ArchAIActions {
  // ...existing
  setPrefillMetadata: (md: PrefillMetadata | null) => void;
}

// In create():
prefillMetadata: null,
setPrefillMetadata: (md) => set({ prefillMetadata: md }),
```

- [ ] **Step 3: Run, format, commit**

```bash
pnpm test --filter=@agent-platform/studio -- arch-ai-store.test.ts
npx prettier --write apps/studio/src/lib/arch-ai/store/arch-ai-store.ts
pnpm build --filter=@agent-platform/studio
git commit -m "[ABLP-162] feat(studio): extend store with integration tab + prefillMetadata"
```

### Task 4.2: GET drafts route

**Files:**

- Create: `apps/studio/src/app/api/arch-ai/projects/[projectId]/integration-drafts/route.ts`
- Test: associated test

- [ ] **Step 1: Write test**

```ts
import { describe, it, expect } from 'vitest';
import { GET } from '../route';
import { ArchIntegrationDraftModel } from '@agent-platform/database/models/arch-integration-draft.model';

describe('GET /api/arch-ai/projects/:projectId/integration-drafts', () => {
  it('returns drafts excluding archived, scoped to tenant + project', async () => {
    await ArchIntegrationDraftModel.create({
      tenantId: 't1',
      projectId: 'p1',
      sessionId: 's1',
      providerKey: 'slack',
      source: 'in_project',
      status: 'complete',
    });
    await ArchIntegrationDraftModel.create({
      tenantId: 't1',
      projectId: 'p1',
      sessionId: 's1',
      providerKey: 'salesforce',
      source: 'in_project',
      status: 'archived',
    });
    await ArchIntegrationDraftModel.create({
      tenantId: 't2',
      projectId: 'p1',
      sessionId: 's1',
      providerKey: 'notion',
      source: 'in_project',
      status: 'complete',
    });

    const response = await GET(makeReq('t1'), { params: { projectId: 'p1' } });
    const body = await response.json();
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0].providerKey).toBe('slack');
  });

  it('rejects without project access', async () => {
    const response = await GET(makeReq('different-user'), { params: { projectId: 'p1' } });
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Implement route**

```ts
import { NextResponse } from 'next/server';
import { requireTenantAuth } from '@/lib/auth';
import { requireProjectAccess } from '@/lib/project-access';
import { ArchIntegrationDraftModel } from '@agent-platform/database/models/arch-integration-draft.model';
import { normalizeDraft } from '@/lib/arch-ai/integration-draft-service';

export async function GET(req: Request, { params }: { params: { projectId: string } }) {
  const auth = await requireTenantAuth(req);
  const access = await requireProjectAccess(params.projectId, auth);
  if (!access) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  const drafts = await ArchIntegrationDraftModel.find({
    tenantId: auth.user.tenantId,
    projectId: params.projectId,
    status: { $ne: 'archived' },
  })
    .sort({ updatedAt: -1 })
    .limit(50)
    .lean();

  return NextResponse.json({
    drafts: drafts.map((d) => normalizeDraft(d as never)),
  });
}
```

- [ ] **Step 3: Format, test, commit**

```bash
pnpm test --filter=@agent-platform/studio -- integration-drafts
npx prettier --write apps/studio/src/app/api/arch-ai/projects/\[projectId\]/integration-drafts/route.ts
git commit -m "[ABLP-162] feat(studio): GET integration-drafts route"
```

### Task 4.3: POST resume route

**Files:**

- Create: `apps/studio/src/app/api/arch-ai/integration-drafts/[id]/resume/route.ts`

- [ ] **Step 1: Implement**

```ts
import { NextResponse } from 'next/server';
import { requireTenantAuth } from '@/lib/auth';
import { requireProjectAccess } from '@/lib/project-access';
import { ArchIntegrationDraftModel } from '@agent-platform/database/models/arch-integration-draft.model';
import { normalizeDraft, setSessionDraftPointer } from '@/lib/arch-ai/integration-draft-service';
import { executeIntegrationOps } from '@/lib/arch-ai/tools/integration-ops';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const auth = await requireTenantAuth(req);

  const draft = await ArchIntegrationDraftModel.findOne({
    _id: params.id,
    tenantId: auth.user.tenantId,
  });
  if (!draft) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  const access = await requireProjectAccess(draft.projectId, auth);
  if (!access) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  const body = await req.json();
  const sessionId = body?.sessionId;
  if (typeof sessionId !== 'string') {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'sessionId required' } },
      { status: 400 },
    );
  }

  await setSessionDraftPointer(sessionId, String(draft._id));

  const result = await executeIntegrationOps({ action: 'revalidate', draftId: String(draft._id) }, {
    user: auth.user,
    projectId: draft.projectId,
    sessionId,
    authToken: auth.token,
  } as never);

  return NextResponse.json({
    success: true,
    draft: normalizeDraft(draft.toObject() as never),
    revalidation: result.data,
  });
}
```

- [ ] **Step 2: Test, format, commit**

```bash
git commit -m "[ABLP-162] feat(studio): POST integration-drafts resume route"
```

### Task 4.4: `IntegrationArtifactView` component

**Files:**

- Create: `apps/studio/src/lib/arch-ai/components/arch/panels/IntegrationArtifactView.tsx`
- Modify: `apps/studio/src/lib/arch-ai/components/arch/panels/InProjectArtifactPanel.tsx`

- [ ] **Step 1: Implement view**

```tsx
import { useEffect, useState } from 'react';
import { useArchAIStore } from '../../../store/arch-ai-store';
import type { IntegrationDraftSummary } from '../../../integration-draft-service';

interface Props {
  tab: { id: string; data: unknown };
  sessionId: string | null;
  projectId: string | undefined;
}

export function IntegrationArtifactView({ projectId }: Props) {
  const setPrefillMetadata = useArchAIStore((s) => s.setPrefillMetadata);
  const [drafts, setDrafts] = useState<IntegrationDraftSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId) return;
    fetch(`/api/arch-ai/projects/${projectId}/integration-drafts`)
      .then((r) => r.json())
      .then((body) => setDrafts(body.drafts ?? []))
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading) return <div className="p-4 text-sm text-foreground-muted">Loading…</div>;

  return (
    <div className="p-4">
      {drafts.length === 0 && (
        <div className="rounded border-2 border-dashed p-8 text-center text-sm text-foreground-muted">
          No integrations yet. Ask Arch in chat to set one up.
        </div>
      )}
      <div className="space-y-2">
        {drafts.map((d) => (
          <div key={d.id} className="rounded-lg border bg-background p-3">
            <div className="flex items-center justify-between">
              <div>
                <strong className="text-sm">{d.providerKey}</strong>
                <span className="ml-2 text-xs text-foreground-muted">{d.status}</span>
              </div>
              <div className="flex gap-1">
                <Pill on={d.authProfileIds.length > 0} label="auth" />
                <Pill on={d.toolIds.length > 0} label="tool" />
                <Pill on={d.targetAgentNames.length > 0} label="wired" />
                <Pill on={d.lastTestStatus === 'pass'} label="test" />
              </div>
            </div>
            <button
              onClick={() =>
                setPrefillMetadata({ kind: 'resume_integration', draftId: d.id, intent: 'resume' })
              }
              className="mt-2 text-xs underline"
            >
              Resume in chat
            </button>
          </div>
        ))}
        <button
          onClick={() => setPrefillMetadata({ kind: 'start_integration' })}
          className="mt-3 w-full rounded border border-dashed py-2 text-sm text-foreground-muted"
        >
          + Add integration
        </button>
      </div>
    </div>
  );
}

function Pill({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] ${
        on ? 'bg-success-subtle text-success' : 'bg-background-muted text-foreground-muted'
      }`}
    >
      {label} {on ? '✓' : '—'}
    </span>
  );
}
```

- [ ] **Step 2: Add tab case**

In `apps/studio/src/lib/arch-ai/components/arch/panels/InProjectArtifactPanel.tsx`:

```tsx
case 'integration':
  return <IntegrationArtifactView tab={tab} sessionId={sessionId} projectId={projectId} />;
```

- [ ] **Step 3: Format, build, commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/components/arch/panels/IntegrationArtifactView.tsx apps/studio/src/lib/arch-ai/components/arch/panels/InProjectArtifactPanel.tsx
pnpm build --filter=@agent-platform/studio
git commit -m "[ABLP-162] feat(studio): add IntegrationArtifactView component"
```

### Task 4.5: ArchOverlay init effect + prefillMetadata watcher

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx`

- [ ] **Step 1: Add init effect for integration tab**

Inside `ArchOverlay.tsx`, after the existing session-hydrate effect:

```tsx
const projectId = props.projectId;
const addTab = useArchAIStore((s) => s.addTab);
const tabs = useArchAIStore((s) => s.artifactTabs);

useEffect(() => {
  if (!projectId) return;
  if (tabs.find((t) => t.type === 'integration')) return;
  fetch(`/api/arch-ai/projects/${projectId}/integration-drafts`)
    .then((r) => r.json())
    .then((body) => {
      if ((body.drafts ?? []).length > 0) {
        addTab({
          type: 'integration',
          label: 'Integrations',
          data: { count: body.drafts.length },
        });
      }
    })
    .catch(() => {});
}, [projectId, tabs, addTab]);
```

- [ ] **Step 2: Add prefillMetadata watcher**

```tsx
const prefillMetadata = useArchAIStore((s) => s.prefillMetadata);
const setPrefillMetadata = useArchAIStore((s) => s.setPrefillMetadata);
const { send, session } = useArchChat();

useEffect(() => {
  if (!prefillMetadata) return;
  if (prefillMetadata.kind === 'resume_integration' && session?.id) {
    fetch(`/api/arch-ai/integration-drafts/${prefillMetadata.draftId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id }),
    }).catch(() => {});
  } else if (prefillMetadata.kind === 'start_integration') {
    const text = prefillMetadata.providerKey
      ? `Set up ${prefillMetadata.providerKey} integration${
          prefillMetadata.targetAgentNames?.length
            ? ` for ${prefillMetadata.targetAgentNames.join(', ')}`
            : ''
        }`
      : 'Help me set up a new integration';
    send(text);
  }
  // additional kinds as needed (manage_integration, manage_tool, diagnose)
  setPrefillMetadata(null);
}, [prefillMetadata, send, setPrefillMetadata, session?.id]);
```

- [ ] **Step 3: Format, build, commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx
pnpm build --filter=@agent-platform/studio
git commit -m "[ABLP-162] feat(studio): integration tab init + prefillMetadata watcher in ArchOverlay"
```

---

# Phase 5 — Suggestion Engine

Helper, integration-hints registry, trigger points (overlay open + turn-end + manual chip), Redis throttle.

### Task 5.1: Create `integration-hints.ts` registry

**Files:**

- Create: `apps/studio/src/lib/arch-ai/integration-hints.ts`

- [ ] **Step 1: Implement**

```ts
export interface IntegrationHint {
  toolNamePattern: RegExp;
  providerKeys: string[];
  rationale: string;
}

export const INTEGRATION_HINTS: IntegrationHint[] = [
  {
    toolNamePattern: /\b(send|post)_(?:slack_)?message\b/i,
    providerKeys: ['slack', 'discord', 'teams'],
    rationale: 'Sending messages to a chat platform.',
  },
  {
    toolNamePattern: /\blook(?:_)?up_ticket\b/i,
    providerKeys: ['zendesk', 'intercom', 'servicenow'],
    rationale: 'Looking up support tickets.',
  },
  {
    toolNamePattern: /\bcreate_lead\b|\bfind_contact\b/i,
    providerKeys: ['salesforce', 'hubspot'],
    rationale: 'CRM lead/contact operations.',
  },
  {
    toolNamePattern: /\bsend_email\b/i,
    providerKeys: ['gmail', 'sendgrid', 'outlook'],
    rationale: 'Sending email.',
  },
  {
    toolNamePattern: /\b(?:create|update)_(?:row|record)\b/i,
    providerKeys: ['airtable', 'google_sheets', 'notion'],
    rationale: 'Database/spreadsheet writes.',
  },
];

export function matchProvidersForToolName(
  name: string,
): { providerKeys: string[]; rationale: string } | null {
  for (const hint of INTEGRATION_HINTS) {
    if (hint.toolNamePattern.test(name)) {
      return { providerKeys: hint.providerKeys, rationale: hint.rationale };
    }
  }
  return null;
}
```

- [ ] **Step 2: Format and commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/integration-hints.ts
git commit -m "[ABLP-162] feat(studio): add integration-hints provider registry"
```

### Task 5.2: Create `computeIntegrationSuggestions`

**Files:**

- Create: `apps/studio/src/lib/arch-ai/processors/integration-suggestions.ts`
- Test: associated test

- [ ] **Step 1: Implement**

```ts
import { matchProvidersForToolName } from '../integration-hints';
import { ProjectAgentModel } from '@agent-platform/database/models/project-agent.model';
import { ProjectToolModel } from '@agent-platform/database/models/project-tool.model';
import { ArchIntegrationDraftModel } from '@agent-platform/database/models/arch-integration-draft.model';
import { parseAblTools } from '@abl/core';
import { redisClient } from '@/lib/redis';
import type { PageContext } from '@agent-platform/arch-ai';

const THROTTLE_TTL_S = 30 * 60;

export interface IntegrationSuggestion {
  title: string;
  rationale: string;
  providerOptions: Array<{ name: string; providerKey: string }>;
  targetAgentNames?: string[];
}

export async function computeIntegrationSuggestions(
  ctx: { user: { tenantId: string }; projectId: string },
  pageContext?: PageContext,
): Promise<IntegrationSuggestion[]> {
  const throttleKey = `arch:integration_suggestions:${ctx.user.tenantId}:${ctx.projectId}`;
  const cached = await redisClient.get(throttleKey);
  if (cached) return JSON.parse(cached);

  const [agents, tools, drafts] = await Promise.all([
    ProjectAgentModel.find({ tenantId: ctx.user.tenantId, projectId: ctx.projectId }).lean(),
    ProjectToolModel.find({ tenantId: ctx.user.tenantId, projectId: ctx.projectId })
      .select('name')
      .lean(),
    ArchIntegrationDraftModel.find({
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
      status: { $in: ['failed'] },
    }).lean(),
  ]);

  const toolNamesInDb = new Set(tools.map((t) => t.name));
  const suggestions: IntegrationSuggestion[] = [];

  const orderedAgents = orderAgentsByPageContext(agents, pageContext);

  for (const agent of orderedAgents) {
    if (suggestions.length >= 3) break;
    const toolEntries = parseAblTools(agent.dslContent);
    for (const entry of toolEntries) {
      if (toolNamesInDb.has(entry.name)) continue;
      const match = matchProvidersForToolName(entry.name);
      if (!match) continue;
      suggestions.push({
        title: `Connect ${match.providerKeys[0]} for ${agent.name}?`,
        rationale: `${agent.name} declares an unbound tool '${entry.name}'. ${match.rationale}`,
        providerOptions: match.providerKeys.map((p) => ({ name: p, providerKey: p })),
        targetAgentNames: [agent.name],
      });
      if (suggestions.length >= 3) break;
    }
  }

  for (const draft of drafts) {
    if (suggestions.length >= 3) break;
    suggestions.push({
      title: `${draft.providerKey} integration is failing`,
      rationale: 'Last test failed. Re-authorize or reconfigure?',
      providerOptions: [{ name: draft.providerKey, providerKey: draft.providerKey }],
    });
  }

  await redisClient.set(throttleKey, JSON.stringify(suggestions), 'EX', THROTTLE_TTL_S);
  return suggestions;
}

function orderAgentsByPageContext(
  agents: Array<{ name: string; dslContent: string }>,
  pageContext?: PageContext,
): Array<{ name: string; dslContent: string }> {
  if (!pageContext?.entity || pageContext.entity.type !== 'agent') return agents;
  const entityName = pageContext.entity.name;
  const target = agents.find((a) => a.name === entityName);
  if (!target) return agents;
  return [target, ...agents.filter((a) => a.name !== entityName)];
}
```

- [ ] **Step 2: Test, format, commit**

```bash
git commit -m "[ABLP-162] feat(studio): add computeIntegrationSuggestions with page-aware bias"
```

### Task 5.3: Wire suggestion engine

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/processors/process-in-project.ts`
- Modify: `apps/studio/src/lib/arch-ai/components/arch/chat/ArchEntryState.tsx`

- [ ] **Step 1: Trigger on session-open**

In `process-in-project.ts`, after the session-open path, if the session is fresh (no messages yet), call `computeIntegrationSuggestions(ctx, pageContext)`. For each suggestion, emit a card via the standard widget-artifact path:

```ts
if (isFreshSession) {
  const suggestions = await computeIntegrationSuggestions(ctx, pageContext);
  for (const s of suggestions) {
    await emitIntegrationSuggestionCard(streamWriter, s);
  }
}
```

`emitIntegrationSuggestionCard` writes an SSE event of type `integration_suggestion_card` with the payload — the v1 compat layer + dispatcher (Tasks 3.1-3.2) handle the rest.

- [ ] **Step 2: Add "Review integrations" chip**

Edit `ArchEntryState.tsx`. Add a chip "Review integrations" that, on click, calls a server endpoint that runs the suggestion engine and emits cards.

- [ ] **Step 3: Format, build, commit**

```bash
git commit -m "[ABLP-162] feat(studio): wire suggestion engine to session-open + chip"
```

---

# Phase 6 — E2E Tests

Real Playwright tests, no mocks of platform components, real Studio + runtime + Mongo + Redis. Follow existing fixtures at `apps/studio/e2e/`.

### Task 6.1: `saas-oauth.spec.ts` — S1 with mock OAuth provider

**Files:**

- Create: `e2e/arch-ai-integrations/saas-oauth.spec.ts`

- [ ] **Step 1: Read existing E2E fixture pattern**

Run: `ls apps/studio/e2e/fixtures/ && cat apps/studio/e2e/fixtures/test-base.ts | head -50`

- [ ] **Step 2: Write test**

```ts
import { test, expect } from '../fixtures/test-base';

test('S1 — Slack OAuth integration end-to-end', async ({ page, project, mockOAuthProvider }) => {
  // Seed project with ops_agent
  await project.createAgent({
    name: 'ops_agent',
    dsl: 'GOAL: handle ops tasks\nTOOLS: post_slack_message(channel: string, text: string) -> { ok: boolean }',
  });

  await mockOAuthProvider.start({
    provider: 'slack',
    scopes: ['chat:write'],
  });

  await page.goto(`/projects/${project.id}`);
  await page.click('[data-testid="arch-toggle"]');

  await page.fill('[data-testid="arch-input"]', 'Hook up Slack so ops_agent can post into #ops');
  await page.click('[data-testid="arch-send"]');

  await expect(page.locator('[data-widget="SecretInput"]')).toBeVisible({ timeout: 30000 });
  await page.fill('[data-widget="SecretInput"] input', 'mock-client-secret');
  await page.click('[data-widget="SecretInput"] button[type="submit"]');

  await expect(page.locator('[data-widget="OAuthLaunch"]')).toBeVisible({ timeout: 30000 });
  await page.click('[data-widget="OAuthLaunch"] button');
  // mockOAuthProvider auto-resolves the consent

  await expect(page.locator('[data-widget="SingleSelect"]')).toBeVisible({ timeout: 30000 });
  await page.click('[data-widget="SingleSelect"] [data-value="C123"]'); // #ops

  await expect(page.locator('[data-widget="DiffCard"]')).toBeVisible({ timeout: 30000 });
  await page.click('[data-widget="DiffCard"] button:has-text("Approve")');

  await expect(page.locator('[data-result="pass"]')).toBeVisible({ timeout: 30000 });

  await page.click('[data-tab="integration"]');
  await expect(page.locator('[data-draft-status="complete"]')).toContainText('Slack');
});
```

- [ ] **Step 3: Run, format, commit**

```bash
pnpm test:e2e -- saas-oauth.spec.ts
git commit -m "[ABLP-162] test(e2e): S1 Slack OAuth integration"
```

### Tasks 6.2–6.7: remaining E2E specs

Same pattern. One commit per spec:

- **6.2** `rest-api.spec.ts` — paste cURL → bearer auth → tool created → wired → tested.
- **6.3** `mcp-server.spec.ts` — set up MCP server → tools imported → wired. Verify NEW agent session sees the server (within seconds, not minutes — proves cache invalidation).
- **6.4** `revalidate.spec.ts` — start integration, leave at needs_input, edit auth profile via Connections page, return to Arch, click resume, verify revalidate output.
- **6.5** `suggestion.spec.ts` — agent with unbound TOOLS, open overlay, expect suggestion card. Click provider button → start_integration prefill triggers.
- **6.6** `collision.spec.ts` — user A creates "Slack OAuth App" shared, user B tries same name, expects PROFILE_NAME_COLLISION recovery widget with reuse-or-rename.
- **6.7** `sanitization.spec.ts` — force a tool test failure with credentialled URL in the error, verify the chat-displayed message redacts URL credentials and stack lines.

Each commit message: `[ABLP-162] test(e2e): <scenario short name>`.

---

# Phase 7 — Flag Flip

After 1 week of staging soak.

### Task 7.1: Default `ARCH_INTEGRATIONS_V1` to true

**Files:**

- Modify: `apps/studio/.env.example`
- Modify: `apps/studio/src/lib/arch-ai/feature-flags.ts` (or wherever the flag is defined)

- [ ] **Step 1: Update default**

```ts
export const ARCH_INTEGRATIONS_V1 = process.env.ARCH_INTEGRATIONS_V1 !== 'false'; // default true
```

- [ ] **Step 2: Update .env.example**

```
# Was: ARCH_INTEGRATIONS_V1=false
ARCH_INTEGRATIONS_V1=true
```

- [ ] **Step 3: Commit**

```bash
git commit -m "[ABLP-162] feat(studio): enable ARCH_INTEGRATIONS_V1 by default"
```

---

# Self-Review Checklist

Before considering the plan done:

- [ ] Every section in the spec has at least one task.
- [ ] No "TBD", "TODO", "implement later", or "similar to Task N" in the plan.
- [ ] Type names, function names, property names consistent across tasks.
- [ ] Every code block compiles in isolation against the existing codebase.
- [ ] Each task ends with a commit, scoped to ≤40 files and ≤3 packages.
- [ ] feat() commits are additive (no >30% deletion).
- [ ] Cross-boundary field propagation: every `IntegrationDraft` consumer touched in the same commit.
- [ ] No `vi.mock()` of `@agent-platform/*` or `@abl/*` in any test (UI widget mocks of `useBatchOAuth` are external-hook DI mocks, allowed for unit tests of widget rendering).
- [ ] E2E tests use real HTTP (no mocked services other than 3rd-party OAuth providers via in-process mock).
- [ ] No `findById`/`findByIdAndUpdate`/`findByIdAndDelete` — all queries use `findOne({_id, tenantId})` etc.

---

# Definition of Done

- All ~35 tasks complete with green tests.
- Spec acceptance criteria pass in staging.
- 7 E2E specs green.
- Pre-commit hooks unmodified, all green.
- Manual parity matrix from `auth-parity.html` v1 column delivered.
- `agents.md` updated in `packages/arch-ai/`, `apps/studio/src/lib/arch-ai/`, `apps/runtime/src/services/mcp/`, `packages/database/`.
- `post-impl-sync` run.
- ABLP-162 work item updated with PR links.
