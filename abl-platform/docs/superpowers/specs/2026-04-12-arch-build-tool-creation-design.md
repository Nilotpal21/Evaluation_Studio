# Arch AI: Build Phase Tool Creation & In-Project Tool Lifecycle

**Date:** 2026-04-12
**Status:** IMPLEMENTED (v3 — all 6 LLD phases complete, review approved)
**Branch:** arch/knowledge

## Problem Statement

The Arch AI BUILD phase generates agent ABL code with `TOOLS:` sections referencing external tools. A BUILD:TOOLS sub-phase exists (`buildSubPhase: 'TOOLS'`, `metadata.toolDsls`, `extractAllTools`, `collectInlineSeedTools`) that extracts tool names and routes the LLM to integration-methodologist. However:

1. **`handleBuildAction('tools')` is stubbed** (`build-completion.ts:839`) — users reaching it via BuildComplete get a no-op. The working BUILD:TOOLS path is only reachable via the gate flow.
2. **No write path for `toolDsls`** — `metadata.toolDsls` is initialized to `{}` (route.ts:4782) and read for context injection (route.ts:5098) and completion detection (route.ts:5853), but no tool in `buildBuildTools()` (route.ts:1661-2037) writes to it. The integration-methodologist has no `save_tool_dsl` tool, so BUILD:TOOLS completion check can never converge.
3. **`tools_ops.create` and `tools_ops.update` produce invalid DSL** — both use `JSON.stringify(config)`.
4. **`tools_ops` is not wired** into `buildInProjectTools()` or `IN_PROJECT_SPECIALIST_TOOL_MAP`.
5. **`tools_ops` is missing from `ToolName` type and `IN_PROJECT_TOOLS` list** — prompt contract (`in-project.ts:10`) and type registry (`tools.ts:10`) don't include it.
6. **Tool diagnosis is shallow** — `diagnose_project focus:'tools'` doesn't check env var resolution, orphan tools, or missing records.

## Existing Infrastructure (Do Not Duplicate)

| Component                       | Location                                             | What It Does                                                                 | Gap                                             |
| ------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- |
| `extractAllTools()`             | `packages/arch-ai/src/mock-server/tool-extractor.ts` | Parses TOOLS from ABL (3 formats). Exported from `@agent-platform/arch-ai`.  | None — use as-is                                |
| `collectInlineSeedTools()`      | `packages/database/seed-inline-tools.ts`             | Extracts tools from agent DSL, produces `SeedProjectTool[]` with DSL + hash. | Only finds inline tools, not standalone DSLs    |
| `metadata.toolDsls`             | `session.ts:166`                                     | Session field for tool DSL strings.                                          | Initialized and read, **never written**         |
| `metadata.buildSubPhase`        | route.ts:4781                                        | State: `null` → `'TOOLS'` → `'COMPLETE'`. Routes to methodologist.           | State machine works, LLM tools don't write DSLs |
| BUILD:TOOLS completion check    | route.ts:5850                                        | Checks `toolDsls` keys vs extracted tool names.                              | Can never converge because toolDsls stays empty |
| CREATE-time persistence         | route.ts:4163-4204                                   | Calls `collectInlineSeedTools()`, persists as ProjectTool.                   | Only inline tools; misses standalone toolDsls   |
| `handleBuildAction()` call site | route.ts:4951-4977                                   | `await handleBuildAction(...); return;` — returns immediately.               | Cannot fall through to LLM after state update   |
| Tool route invariants           | tools/route.ts:62-104                                | Sandbox gate, SSRF, name conflict, max 500 limit, namespace                  | Must be replicated in shared service            |
| `ToolPermissionContext`         | guards.ts:94-100                                     | `user: { permissions: string[]; tenantId: string; userId: string }`          | tools_ops registration must pass `permissions`  |

## Design Decisions

| Decision             | Choice                                                      | Rationale                                                                       |
| -------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| State field          | Extend existing `toolDsls`                                  | One source of truth. Already used by completion check and context injection.    |
| Tool extraction      | Existing `extractAllTools()`                                | Already used at route.ts:4680, :5860. No third extractor.                       |
| SSRF validation      | Shared service preserving ALL route invariants              | Sandbox gate, name conflict, max limit, SSRF, namespace, audit.                 |
| `ask_user` resume    | Existing `buildSubPhase: 'TOOLS'` + `tool_answer` machinery | Already handles pending interactions and multi-turn resume.                     |
| Persistence          | Extend CREATE-time to also consume `toolDsls`               | `collectInlineSeedTools` only finds inline tools; `toolDsls` covers standalone. |
| Route re-entry       | `handleBuildAction` signals caller to continue, NOT return  | New return value tells route.ts to fall through to LLM instead of returning.    |
| Duplicate tool names | First-write wins, diagnostic T-06 flags conflict            | Same as `collectInlineSeedTools` (line 342).                                    |

## Architecture

### Files Changed

| File                                                                    | Change Type | Description                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/lib/arch-ai/build-completion.ts`                       | MODIFY      | Wire `case 'tools'`: set `buildSubPhase='TOOLS'`, return `{ continueToLLM: true }` signal                                                                                                                                                                                                                                                                               |
| `apps/studio/src/app/api/arch-ai/message/route.ts`                      | MODIFY      | (1) Handle `continueToLLM` return from `handleBuildAction` — don't return, fall through to LLM. (2) Add `save_tool_dsl` tool to `buildBuildTools()` that writes to `toolDsls`. (3) Register `tools_ops` in `buildInProjectTools()` with full `ToolPermissionContext`. (4) Add `tools_ops` to specialist maps. (5) Extend CREATE-time persistence to consume `toolDsls`. |
| `apps/studio/src/lib/tool-creation-service.ts`                          | NEW         | Shared service with ALL route invariants: sandbox gate, SSRF, name conflict, max 500 limit, namespace, audit.                                                                                                                                                                                                                                                           |
| `apps/studio/src/lib/arch-ai/tools/tools-ops.ts`                        | MODIFY      | Fix `create` AND `update` to delegate to shared service.                                                                                                                                                                                                                                                                                                                |
| `apps/studio/src/lib/arch-ai/tools/diagnose-project.ts`                 | MODIFY      | Enhanced `focus:'tools'` with T-01 through T-06.                                                                                                                                                                                                                                                                                                                        |
| `packages/arch-ai/src/prompts/specialists/integration-methodologist.ts` | MODIFY      | Add `tools_ops` CRUD guidance + `save_tool_dsl` guidance for BUILD:TOOLS                                                                                                                                                                                                                                                                                                |
| `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts`      | MODIFY      | Brief `tools_ops` note                                                                                                                                                                                                                                                                                                                                                  |
| `packages/arch-ai/src/types/tools.ts`                                   | MODIFY      | Add `tools_ops` and `save_tool_dsl` to `ToolName` union. Add `tools_ops` to `IN_PROJECT_TOOLS`.                                                                                                                                                                                                                                                                         |
| `packages/arch-ai/src/prompts/phases/in-project.ts`                     | MODIFY      | Add `tools_ops` to available tools list in prompt                                                                                                                                                                                                                                                                                                                       |

## Detailed Design

### 1. Route Re-Entry: `handleBuildAction` → LLM Flow

**Problem:** `route.ts:4977` does `await handleBuildAction(...); return;` — the `return` means no LLM turn can follow.

**Solution:** Change `handleBuildAction` return type from `Promise<void>` to `Promise<{ continueToLLM: boolean }>`. The `'tools'` case returns `{ continueToLLM: true }` after setting state. The call site checks and skips the `return`.

**In `build-completion.ts`:**

```typescript
// Return type change
export async function handleBuildAction(
  action: string, ...
): Promise<{ continueToLLM: boolean }> {

  switch (action) {
    case 'tools': {
      const { extractAllTools } = await import('@agent-platform/arch-ai');
      const typedFiles = (session.metadata.files ?? {}) as Record<string, { path: string; content: string }>;
      const allTools = extractAllTools(typedFiles);

      if (allTools.length === 0) {
        emit({ type: 'text_delta', delta: 'No external tool integrations detected...\n' });
        // Re-emit widget without tools option, close
        emit({ type: 'done' });
        close();
        return { continueToLLM: false };
      }

      // Deduplicate tool names
      const toolAgentMap = new Map<string, string[]>();
      for (const t of allTools) {
        const existing = toolAgentMap.get(t.toolName) ?? [];
        if (!existing.includes(t.agentName)) existing.push(t.agentName);
        toolAgentMap.set(t.toolName, existing);
      }

      // Set BUILD:TOOLS state (same as gate flow at route.ts:4780)
      const mongoose = (await import('mongoose')).default;
      const db = mongoose.connection.db;
      if (!db) {
        emit({ type: 'error', code: 'DB_UNAVAILABLE', message: 'Database connection lost.', retryable: true });
        close();
        return { continueToLLM: false };
      }

      await db.collection('arch_sessions').updateOne(
        { _id: session.id, tenantId: ctx.tenantId, userId: ctx.userId },
        {
          $set: {
            'metadata.buildSubPhase': 'TOOLS',
            'metadata.toolDsls': {},
            'metadata.selectedTools': null,
          },
        },
      );

      emit({
        type: 'text_delta',
        delta: `Found ${toolAgentMap.size} tool${toolAgentMap.size > 1 ? 's' : ''} across your agents. Generating configurations...\n\n`,
      });

      return { continueToLLM: true };  // Signal caller to continue to LLM
    }

    case 'create':
      // ... existing code, returns { continueToLLM: false }
    // ... other cases return { continueToLLM: false }
  }
}
```

**In `route.ts` call site (~line 4951-4977):**

```typescript
const buildResult = await handleBuildAction(
  answer,
  ctx,
  session,
  results,
  emit,
  close,
  deps,
  projectName,
);

if (!buildResult.continueToLLM) {
  return; // Action handled, stream closed
}

// Fall through to LLM — the existing code below will detect
// buildSubPhase='TOOLS' and route to integration-methodologist
// (route.ts:3622-3626 already does this)
```

### 2. `save_tool_dsl` — The Missing Write Path

**Problem:** BUILD:TOOLS sub-phase reads `toolDsls` for completion detection but nothing writes to it. The integration-methodologist LLM has no tool to persist generated DSLs.

**Solution:** Add `save_tool_dsl` to `buildBuildTools()` in route.ts. This tool writes a single tool's DSL to `metadata.toolDsls[toolName]`.

```typescript
// Added to buildBuildTools() — available when buildSubPhase === 'TOOLS'
save_tool_dsl: tool({
  description:
    'Save a generated tool DSL configuration. Call this after producing the DSL for a tool. ' +
    'The DSL should be a complete tool definition with signature, description, type, and binding.',
  inputSchema: z.object({
    toolName: z.string().min(1)
      .describe('Tool name — validated by AGENT_NAME_PATTERN in execute (see LLD D-9)'),
    dslContent: z.string().min(1)
      .describe('Complete tool DSL content'),
  }),
  execute: async (input) => {
    if (!AGENT_NAME_PATTERN.test(input.toolName)) {
      return `Error: invalid tool name "${input.toolName}".`;
    }

    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;
    if (!db) return 'Error: database not connected';

    await db.collection('arch_sessions').updateOne(
      { _id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId } as Record<string, unknown>,
      {
        $set: {
          [`metadata.toolDsls.${input.toolName}`]: input.dslContent,
        },
      },
    );

    return `Tool DSL saved: ${input.toolName} (${input.dslContent.split('\n').length} lines)`;
  },
}),
```

**Gating:** Only include `save_tool_dsl` in the tool set when `buildSubPhase === 'TOOLS'`. The existing `buildBuildTools()` function receives `sessionId` — extend it to also receive `buildSubPhase` and conditionally include tool DSL tools.

**Integration-methodologist prompt update** — add guidance:

```
## BUILD:TOOLS Phase
When in the BUILD:TOOLS sub-phase, generate tool DSL for each tool in the "Tools to Generate" list.
For each tool:
1. Generate a complete DSL with signature, description, type, and HTTP/MCP/Sandbox binding
2. Use {{env.TOOL_URL}} and {{secrets.TOOL_KEY}} placeholder patterns
3. Call save_tool_dsl(toolName, dslContent) to persist each tool
4. After all tools, summarize with an environment variable checklist
```

### 3. Shared Tool Creation Service — ALL Route Invariants

**File:** `apps/studio/src/lib/tool-creation-service.ts` (new)

Extracts the complete validation pipeline from `POST /api/projects/:id/tools` and `PUT /api/projects/:id/tools/:toolId` so that `tools_ops`, onboarding persistence, and the API routes all get identical treatment.

**Invariants preserved (from tools/route.ts:62-104 and tools/[toolId]/route.ts:49-85):**

| #   | Invariant             | Source                                                                                             |
| --- | --------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | Sandbox feature gate  | `isCodeToolsEnabled(tenantId)` — blocks sandbox tool creation when disabled                        |
| 2   | SSRF validation       | `validateUrlWithPlaceholders(endpoint, tenantId, projectId)` — resolves `{{env.X}}` then validates |
| 3   | Name uniqueness       | `findProjectToolByName(tenantId, projectId, name)` — 409 on conflict                               |
| 4   | Max 500 tools/project | `countProjectToolsByProject(tenantId, projectId)` — blocks at limit                                |
| 5   | Default namespace     | Auto-creates and assigns default `VariableNamespace`                                               |
| 6   | Audit logging         | `logAuditEvent(AuditActions.TOOL_CREATED/UPDATED)`                                                 |
| 7   | Lambda deployment     | Async trigger for sandbox tools when `SANDBOX_BACKEND === 'lambda'`                                |
| 8   | Source hash           | `computeSourceHash(dslContent)`                                                                    |
| 9   | Slug immutability     | Handled by DB schema (pre-save hook), but service must not attempt slug changes on update          |

**SSRF strategy for `{{env.X}}` placeholders:**

- Call `validateUrlWithPlaceholders()` which already handles template resolution: it resolves `{{env.X}}` against the project's variable namespaces, then validates the resolved URL
- If resolution fails (env var doesn't exist yet), `validateUrlWithPlaceholders` returns `{ safe: false }` — but this is an onboarding scenario where env vars haven't been configured
- Add a `templateUrlsAllowed: boolean` parameter: when `true` and resolution fails because the env var doesn't exist yet (not because the resolved URL is unsafe), allow creation with a logged warning
- When `false` (normal API route behavior), strict validation applies

```typescript
import { serializeToolFormToDsl, computeSourceHash } from '@agent-platform/shared';
import type { ProjectToolFormData } from '@agent-platform/shared';
import {
  createProjectTool,
  findProjectToolByName,
  countProjectToolsByProject,
  updateProjectTool,
} from '@agent-platform/shared/repos';
import { validateUrlWithPlaceholders } from '@/lib/resolve-and-validate-url';
import { isCodeToolsEnabled } from '@/lib/feature-gates';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('tool-creation-service');

interface CreateToolInput {
  tenantId: string;
  projectId: string;
  formData: ProjectToolFormData;
  createdBy: string;
  /** Allow {{env.X}} template URLs that can't be resolved yet (onboarding) */
  templateUrlsAllowed?: boolean;
}

export async function createToolViaService(input: CreateToolInput) {
  const { tenantId, projectId, formData, createdBy } = input;

  // 1. Sandbox feature gate
  if (formData.toolType === 'sandbox') {
    const enabled = await isCodeToolsEnabled(tenantId);
    if (!enabled) {
      throw new ToolServiceError(
        'Code tools are not enabled for this workspace',
        'CODE_TOOLS_DISABLED',
      );
    }
  }

  // 2. SSRF validation for HTTP tools
  if (formData.toolType === 'http' && 'endpoint' in formData && formData.endpoint) {
    const ssrf = await validateUrlWithPlaceholders(formData.endpoint, tenantId, projectId);
    if (!ssrf.safe) {
      // If templateUrlsAllowed and failure is due to unresolvable placeholders, warn but allow
      const hasUnresolvable = /\{\{env\.\w+\}\}/.test(formData.endpoint);
      if (input.templateUrlsAllowed && hasUnresolvable) {
        log.warn('Tool created with unresolvable template URL — will validate at execution time', {
          toolName: formData.name,
          endpoint: formData.endpoint,
          projectId,
        });
      } else {
        throw new ToolServiceError(
          ssrf.reason || 'Endpoint blocked by SSRF protection',
          'SSRF_BLOCKED',
        );
      }
    }
  }

  // 3. Name uniqueness
  const existing = await findProjectToolByName(tenantId, projectId, formData.name);
  if (existing) {
    throw new ToolServiceError(
      `A tool named "${formData.name}" already exists in this project`,
      'NAME_CONFLICT',
    );
  }

  // 4. Max 500 tools/project
  const toolCount = await countProjectToolsByProject(tenantId, projectId);
  if (toolCount >= 500) {
    throw new ToolServiceError('Maximum of 500 tools per project reached', 'MAX_TOOLS_REACHED');
  }

  // 5. Serialize and hash
  const dslContent = serializeToolFormToDsl(formData);
  const sourceHash = computeSourceHash(dslContent);

  // 6. Default namespace
  const namespaceIds = await getOrCreateDefaultNamespace(tenantId, projectId, createdBy);

  // 7. Persist
  const tool = await createProjectTool({
    tenantId,
    projectId,
    name: formData.name,
    slug: formData.name,
    toolType: formData.toolType,
    description: formData.description ?? null,
    dslContent,
    sourceHash,
    variableNamespaceIds: namespaceIds,
    createdBy,
  });

  // 8. Lambda deployment for sandbox
  if (formData.toolType === 'sandbox' && process.env.SANDBOX_BACKEND === 'lambda') {
    import('@/services/lambda-deploy-trigger')
      .then(({ triggerLambdaDeployment }) =>
        triggerLambdaDeployment(
          tenantId,
          (formData as { runtime?: string }).runtime || 'javascript',
        ),
      )
      .catch((err: unknown) => {
        log.warn('Lambda deploy trigger failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // 9. Audit
  logAuditEvent({
    userId: createdBy,
    tenantId,
    action: AuditActions.TOOL_CREATED,
    metadata: { toolId: tool.id, toolName: formData.name, toolType: formData.toolType, projectId },
  }).catch((err: unknown) => {
    log.warn('Audit log failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return tool;
}

/**
 * Create a tool from raw DSL content (onboarding toolDsls).
 * Parses DSL to infer toolType, then delegates to createToolViaService.
 */
export async function createToolFromDsl(input: {
  tenantId: string;
  projectId: string;
  toolName: string;
  dslContent: string;
  createdBy: string;
  templateUrlsAllowed?: boolean;
}) {
  const { parseDslToToolForm } = await import('@agent-platform/shared/tools');

  // Infer toolType from DSL content
  const toolType = inferToolTypeFromDsl(input.dslContent);
  const formData = parseDslToToolForm(input.dslContent, toolType);

  if (!formData) {
    // DSL is not form-parseable — still enforce ALL invariants inline.
    // Cannot delegate to createToolViaService (requires ProjectToolFormData),
    // so replicate every check here to avoid bypassing the shared contract.

    // Invariant 1: Sandbox feature gate
    if (toolType === 'sandbox') {
      const enabled = await isCodeToolsEnabled(input.tenantId);
      if (!enabled) {
        throw new ToolServiceError('Code tools are not enabled', 'CODE_TOOLS_DISABLED');
      }
    }

    // Invariant 2: SSRF — best-effort regex extraction from raw DSL
    const endpointMatch = input.dslContent.match(/endpoint:\s*"?([^\n"]+)"?/);
    if (toolType === 'http' && endpointMatch) {
      const endpoint = endpointMatch[1].trim();
      const ssrf = await validateUrlWithPlaceholders(endpoint, input.tenantId, input.projectId);
      if (!ssrf.safe) {
        const isEnvVarMissing = ssrf.reason?.startsWith('Environment variable');
        if (!(input.templateUrlsAllowed && isEnvVarMissing)) {
          throw new ToolServiceError(ssrf.reason || 'SSRF blocked', 'SSRF_BLOCKED');
        }
        log.warn('Fallback path: unresolvable template URL', { toolName: input.toolName });
      }
    }

    // Invariant 3: Name uniqueness
    const existing = await findProjectToolByName(input.tenantId, input.projectId, input.toolName);
    if (existing) {
      throw new ToolServiceError(`Tool "${input.toolName}" already exists`, 'NAME_CONFLICT');
    }

    // Invariant 4: Max 500 tools/project
    const toolCount = await countProjectToolsByProject(input.tenantId, input.projectId);
    if (toolCount >= 500) {
      throw new ToolServiceError('Max 500 tools reached', 'MAX_TOOLS_REACHED');
    }

    // Invariant 5+9: Hash
    const sourceHash = computeSourceHash(input.dslContent);

    // Invariant 6: Default namespace (inline — getOrCreateDefaultNamespace not available in studio)
    const { VariableNamespace } = await import('@agent-platform/database/models');
    let defaultNs = await VariableNamespace.findOne({
      tenantId: input.tenantId,
      projectId: input.projectId,
      isDefault: true,
    }).lean();
    if (!defaultNs) {
      defaultNs = (
        await VariableNamespace.create({
          tenantId: input.tenantId,
          projectId: input.projectId,
          name: 'default',
          displayName: 'Default',
          description: 'Default variable namespace',
          isDefault: true,
          order: 0,
          createdBy: input.createdBy,
        })
      ).toObject();
    }
    const namespaceIds = defaultNs ? [String(defaultNs._id)] : [];

    // Persist
    const tool = await createProjectTool({
      tenantId: input.tenantId,
      projectId: input.projectId,
      name: input.toolName,
      slug: input.toolName,
      toolType,
      description: null,
      dslContent: input.dslContent,
      sourceHash,
      variableNamespaceIds: namespaceIds,
      createdBy: input.createdBy,
    });

    // Invariant 7: Audit
    logAuditEvent({
      userId: input.createdBy,
      tenantId: input.tenantId,
      action: AuditActions.TOOL_CREATED,
      metadata: { toolId: tool.id, toolName: input.toolName, toolType, projectId: input.projectId },
    }).catch((err: unknown) => {
      log.warn('Audit failed in fallback path (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Invariant 8: Lambda trigger
    if (toolType === 'sandbox' && process.env.SANDBOX_BACKEND === 'lambda') {
      import('@/services/lambda-deploy-trigger')
        .then(({ triggerLambdaDeployment }) =>
          triggerLambdaDeployment(input.tenantId, 'javascript'),
        )
        .catch((err: unknown) => {
          log.warn('Lambda trigger failed in fallback path (non-fatal)', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    return tool;
  }

  return createToolViaService({
    ...input,
    formData: { ...formData, name: input.toolName },
  });
}

// Similarly: updateToolViaService with same invariants (SSRF, audit, no slug change)

function inferToolTypeFromDsl(dsl: string): 'http' | 'mcp' | 'sandbox' {
  if (/\btype:\s*http\b/i.test(dsl) || /\bendpoint:/i.test(dsl)) return 'http';
  if (/\btype:\s*mcp\b/i.test(dsl) || /\bserver:/i.test(dsl)) return 'mcp';
  return 'sandbox';
}

class ToolServiceError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'ToolServiceError';
  }
}
```

### 4. Fix `tools_ops` DSL Serialization (Create AND Update)

**File:** `apps/studio/src/lib/arch-ai/tools/tools-ops.ts`

**Both `createTool` (line 107) and `updateTool` (line 130)** delegate to the shared service:

```typescript
// createTool
async function createTool(projectId, toolName, config, tenantId, userId): Promise<ToolsOpsResult> {
  const { createToolViaService } = await import('@/lib/tool-creation-service');
  const formData = buildFormDataFromConfig(toolName, config);
  try {
    const tool = await createToolViaService({
      tenantId,
      projectId,
      formData,
      createdBy: userId,
    });
    return { success: true, data: { created: true, id: tool.id, name: tool.name } };
  } catch (err) {
    if (err instanceof Error && 'code' in err) {
      return {
        success: false,
        error: { code: (err as { code: string }).code, message: err.message },
      };
    }
    throw err;
  }
}

// updateTool — same JSON.stringify bug, same fix
async function updateTool(projectId, toolId, config, tenantId, userId): Promise<ToolsOpsResult> {
  const { updateToolViaService } = await import('@/lib/tool-creation-service');
  const { findProjectToolById } = await import('@agent-platform/shared/repos');
  const existing = await findProjectToolById(toolId, tenantId, projectId);
  if (!existing)
    return { success: false, error: { code: 'NOT_FOUND', message: `Tool "${toolId}" not found` } };

  const formData = buildFormDataFromConfig(existing.name, config);
  const updated = await updateToolViaService({
    tenantId,
    projectId,
    toolId,
    formData,
    updatedBy: userId,
  });
  return { success: true, data: updated };
}
```

`buildFormDataFromConfig()` converts the LLM's config object to `ProjectToolFormData` (discriminated union by toolType). Full implementation in Section 5A of v2 spec — no changes needed.

### 5. Wire `tools_ops` into In-Project LLM Tools

**Registration with full `ToolPermissionContext`:**

```typescript
// In buildInProjectTools() — note: ctx already has permissions from the auth middleware
tools_ops: tool({
  description: 'Manage project tool configurations — create, read, update, test, or delete tools.',
  inputSchema: z.object({
    action: z.enum(['read', 'list', 'create', 'update', 'test', 'delete']),
    toolId: z.string().optional(),
    toolName: z.string().optional(),
    config: z.record(z.unknown()).optional(),
    testInput: z.record(z.unknown()).optional(),
    confirmed: z.boolean().optional(),
  }),
  execute: async (input) => {
    const { executeToolsOps } = await import('@/lib/arch-ai/tools/tools-ops');
    return executeToolsOps(input, {
      projectId,
      user: {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        permissions: ctx.permissions ?? [],  // From auth middleware
      },
      authToken,  // For runtime API calls (tool testing)
    });
  },
}),
```

**Specialist tool maps:**

```typescript
'integration-methodologist': [
  'read_agent', 'propose_modification', 'apply_modification',
  'dismiss_proposal', 'compile_abl', 'ask_user',
  'tools_ops',  // NEW
],
'abl-construct-expert': [
  'read_agent', 'propose_modification', 'apply_modification',
  'dismiss_proposal', 'compile_abl', 'read_topology', 'health_check', 'ask_user',
  'tools_ops',  // NEW
],
```

**Package-level type/prompt updates:**

In `packages/arch-ai/src/types/tools.ts`:

```typescript
export type ToolName =
  | ... existing ...
  | 'tools_ops'           // In-project tool CRUD
  | 'save_tool_dsl';      // BUILD:TOOLS DSL persistence

export const IN_PROJECT_TOOLS: readonly ToolName[] = [
  ... existing ...,
  'tools_ops',  // NEW
] as const;
```

In `packages/arch-ai/src/prompts/phases/in-project.ts`:

```
**Available tools:** ..., tools_ops, ask_user
```

Add to capabilities list:

```
- Manage tool configurations (tools_ops) — create, read, update, test, delete project tools
```

### 6. CREATE-Time Persistence Enhancement

**Existing path** (route.ts:4163-4204): `collectInlineSeedTools()` extracts tools from agent ABL `TOOLS:` sections — catches inline HTTP/Sandbox bindings.

**Gap:** Tools generated by the integration-methodologist during BUILD:TOOLS are in `metadata.toolDsls` as standalone DSL strings, NOT inline in agent files.

**Enhancement:** After the existing `collectInlineSeedTools()` loop, add:

```typescript
// Persist LLM-generated tool DSLs from BUILD:TOOLS sub-phase
const toolDsls = (session.metadata as Record<string, unknown>)?.toolDsls as
  | Record<string, string>
  | undefined;

if (toolDsls && Object.keys(toolDsls).length > 0) {
  const { createToolFromDsl } = await import('@/lib/tool-creation-service');
  const alreadyPersisted = new Set(/* tool names from collectInlineSeedTools above */);

  for (const [toolName, dslContent] of Object.entries(toolDsls)) {
    if (alreadyPersisted.has(toolName)) continue;
    try {
      await createToolFromDsl({
        tenantId: ctx.tenantId,
        projectId: project.id,
        toolName,
        dslContent,
        createdBy: ctx.userId,
        templateUrlsAllowed: true, // Onboarding — env vars may not exist yet
      });
      persistedCount++;
    } catch (err: unknown) {
      const isDuplicate =
        err instanceof Error && 'code' in err && (err as { code: number | string }).code === 11000;
      if (!isDuplicate) {
        log.warn('Failed to persist toolDsl-generated tool (non-fatal)', {
          projectId: project.id,
          tool: toolName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
```

### 7. Enhanced Tool Diagnosis

| Code   | Severity | Check                                                                   |
| ------ | -------- | ----------------------------------------------------------------------- |
| `T-01` | warning  | `{{env.X}}` placeholder where `X` doesn't exist in linked namespaces    |
| `T-02` | info     | ProjectTool exists but no agent references it (orphan)                  |
| `T-03` | error    | Agent references tool name but no ProjectTool record exists             |
| `T-04` | warning  | HTTP tool with `auth: none` on URL containing `/api/` or `/v1/`         |
| `T-05` | warning  | Tool DSL fails `parseDslToToolForm()` round-trip — corrupt DSL          |
| `T-06` | warning  | Two agents reference same tool name with different parameter signatures |

### 8. Error Handling & Edge Cases

| Scenario                             | Handling                                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| No tools detected in agents          | Message + re-emit BuildComplete without tools option                                                                                            |
| `handleBuildAction` signals continue | Route.ts checks `continueToLLM`, skips return, falls through to LLM                                                                             |
| `save_tool_dsl` invalid name         | Returns error string, LLM self-corrects                                                                                                         |
| `ask_user` mid BUILD:TOOLS           | Stream ends, `pendingInteraction` persisted, resumes via `tool_answer`                                                                          |
| All toolDsls written                 | Completion check (route.ts:5850) transitions to `COMPLETE`                                                                                      |
| Duplicate tool at CREATE             | Duplicate key (11000) caught, skipped, logged as non-fatal                                                                                      |
| SSRF with `{{env.X}}`                | `templateUrlsAllowed: true` permits unresolvable templates at onboarding; strict at API route                                                   |
| `tools_ops.update` with JSON         | Fixed via shared service — same as `create`                                                                                                     |
| Sandbox gate blocks creation         | `ToolServiceError('CODE_TOOLS_DISABLED')` returned to LLM/caller                                                                                |
| Max 500 tools reached                | `ToolServiceError('MAX_TOOLS_REACHED')` returned                                                                                                |
| `extractAllTools` dedup              | `extractAllTools` returns per-agent entries; dedup happens via `Map<toolName, agentNames[]>` in call sites (route.ts:5084, build-completion.ts) |

## Open Questions — Resolved

**Q: Should `toolConfigs` replace `toolDsls`?**
A: No new field. Extend `toolDsls` and keep one field.

**Q: Should onboarding tools go through a shared service?**
A: Yes. `tool-creation-service.ts` preserves all 9 route invariants.

**Q: What when two agents reference same tool name with different signatures?**
A: First-write wins. Diagnostic T-06 flags the conflict.

## Out of Scope

- Tool testing during BUILD phase (requires env vars)
- MCP server discovery
- Tool marketplace/templates
- SearchAI tool creation (separate KB flow)
- Variable namespace management beyond default assignment

## Testing Strategy

- **Unit tests:** `tool-creation-service.ts` — all 9 invariants: sandbox gate, SSRF, name conflict, max limit, namespace, audit, hash, lambda trigger, slug
- **Unit tests:** `tools-ops.ts` — `create` AND `update` produce valid DSL via `parseDslToToolForm()` round-trip
- **Unit tests:** `save_tool_dsl` tool — validates name, writes to `toolDsls`, error on invalid name
- **Unit tests:** `handleBuildAction('tools')` — returns `{ continueToLLM: true }`, sets `buildSubPhase`, calls `extractAllTools`
- **Unit tests:** `diagnose-project.ts` — each diagnostic code T-01 through T-06
- **Unit tests:** `tools_ops` registration — verify `permissions` field passed in `ToolPermissionContext`
- **Unit tests:** Specialist tool map — verify `tools_ops` in integration-methodologist and abl-construct-expert
- **Integration test:** Full BUILD → tools → TOOLS sub-phase → save_tool_dsl → completion → CREATE → ProjectTool records
- **Integration test:** `ask_user` resume in BUILD:TOOLS — pending interaction round-trip
- **Integration test:** In-project `tools_ops.create` → shared service → valid ProjectTool usable by `loadProjectToolsAsIR`
- **Integration test:** SSRF validation — template URL allowed in onboarding, blocked in API route
