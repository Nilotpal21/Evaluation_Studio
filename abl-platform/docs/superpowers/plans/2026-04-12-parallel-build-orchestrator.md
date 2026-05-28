# Parallel BUILD Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace sequential single-streamText BUILD phase with parallel orchestrator-workers pattern — one LLM call per agent, deterministic completion widget, conversational modification mode.

**Architecture:** On BUILD entry with missing agents, `runParallelGeneration` spawns N parallel `streamText` calls (one per agent), each with `BUILD_AGENT_PROMPT` + agent spec + 2 tools (`generate_agent`, `compile_abl`). Results are reconciled via `reconcileBuildResults`, then `buildCompletionWidgetPayload` emits a deterministic BuildComplete widget. Widget answers are intercepted in `processMessage` and routed to `handleBuildAction` — never to the LLM.

**Tech Stack:** Vercel AI SDK (`streamText`), existing build-completion/build-orchestrator/build-reconciliation modules, Mongoose for session state.

**Spec:** `docs/superpowers/specs/2026-04-12-parallel-build-orchestrator-design.md`

---

## File Structure

| Action | File                                                            | Responsibility                                                                            |
| ------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Create | `apps/studio/src/lib/arch-ai/build-parallel-gen.ts`             | Parallel worker orchestration: spawn N `streamText`, retries, elapsed tracking, reconcile |
| Modify | `apps/studio/src/app/api/arch-ai/message/route.ts`              | Orchestrator entry, BuildComplete interception, remove legacy gates                       |
| Modify | `packages/arch-ai/src/prompts/phases/build.ts`                  | Update retry count in `BUILD_AGENT_PROMPT`                                                |
| Modify | `apps/studio/src/components/arch-v3/chat/BuildProgressCard.tsx` | Remove gate-era store subscriptions                                                       |
| Create | `apps/studio/src/__tests__/arch-ai/build-parallel-gen.test.ts`  | Tests for parallel generation                                                             |
| Modify | `apps/studio/src/lib/arch-ai/constants.ts`                      | Add `AGENT_TIMEOUT_MS` constant                                                           |

---

### Task 1: Create `runParallelGeneration` module

**Files:**

- Create: `apps/studio/src/lib/arch-ai/build-parallel-gen.ts`
- Modify: `apps/studio/src/lib/arch-ai/constants.ts:52-61`

This is the core new module. It spawns N parallel `streamText` workers, one per agent, with per-worker abort signals and retries.

- [ ] **Step 1: Add timeout constant**

In `apps/studio/src/lib/arch-ai/constants.ts`, add `AGENT_TIMEOUT_MS` to `ARCH_AI_BUILD`:

```ts
export const ARCH_AI_BUILD = {
  AGENT_CONCURRENCY: 5,
  MAX_OUTPUT_TOKENS: 8192,
  AGENT_MAX_STEPS: 6,
  AGENT_TIMEOUT_MS: 60_000,
  AGENT_MAX_RETRIES: 2,
  TEMPERATURE: 0.5,
} as const;
```

- [ ] **Step 2: Create `build-parallel-gen.ts` with types and helper**

Create `apps/studio/src/lib/arch-ai/build-parallel-gen.ts`:

```ts
/**
 * Parallel BUILD generation — spawns one streamText worker per agent.
 *
 * Each worker gets BUILD_AGENT_PROMPT + agent spec + 2 tools (generate_agent,
 * compile_abl). Workers run concurrently via Promise.allSettled. Failed workers
 * auto-retry up to ARCH_AI_BUILD.AGENT_MAX_RETRIES times. Results are reconciled
 * via reconcileBuildResults into a full AgentGenResult[] for every topology agent.
 */

import { createLogger } from '@abl/compiler/platform';
import { streamText } from 'ai';
import type { ArchSession, ArchSSEEvent } from '@agent-platform/arch-ai';
import type { AgentGenResult, BuildActionContext } from './build-completion';
import { ARCH_AI_BUILD } from './constants';

const log = createLogger('arch-ai:parallel-gen');

interface WorkerResult {
  agentName: string;
  status: 'compiled' | 'warning' | 'error';
  warnings: string[];
  errors: string[];
  elapsed: number;
}

interface ParallelGenInput {
  agentNames: string[];
  ctx: BuildActionContext;
  session: ArchSession;
  emit: (event: ArchSSEEvent) => void;
  model: Parameters<typeof streamText>[0]['model'];
  requestSignal?: AbortSignal;
}

/**
 * Run a single agent worker with retries.
 * Returns the worker result after up to AGENT_MAX_RETRIES retries.
 */
async function runAgentWorker(
  agentName: string,
  agentSpec: { role: string; executionMode: string; description: string },
  siblingNames: string[],
  projectContext: { name: string; description: string },
  input: Omit<ParallelGenInput, 'agentNames'>,
): Promise<WorkerResult> {
  const { ctx, session, emit, model, requestSignal } = input;
  const maxRetries = ARCH_AI_BUILD.AGENT_MAX_RETRIES;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const start = Date.now();

    // Clear stale artifacts on retry
    if (attempt > 0) {
      const { clearStaleArtifacts } = await import('./build-orchestrator');
      await clearStaleArtifacts([agentName], session.id, ctx);
    }

    // Per-worker abort: timeout OR parent request abort
    const signals: AbortSignal[] = [AbortSignal.timeout(ARCH_AI_BUILD.AGENT_TIMEOUT_MS)];
    if (requestSignal) signals.push(requestSignal);
    const workerSignal = AbortSignal.any(signals);

    try {
      // Build worker tools — reuse buildBuildTools for DB side effects
      const { buildWorkerTools } = await import('./build-worker-tools');
      const tools = buildWorkerTools(ctx, session.id);

      const { BUILD_AGENT_PROMPT } = await import('@agent-platform/arch-ai');

      const userMessage = [
        `Generate the agent: ${agentName}`,
        `Role: ${agentSpec.role}`,
        `Execution mode: ${agentSpec.executionMode}`,
        `Description: ${agentSpec.description}`,
        '',
        `Sibling agents (for HANDOFF targets): ${siblingNames.join(', ')}`,
        '',
        `Project context:`,
        `- Name: ${projectContext.name}`,
        `- Description: ${projectContext.description}`,
      ].join('\n');

      const result = await streamText({
        model,
        system: BUILD_AGENT_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
        tools,
        stopWhen: (await import('ai')).stepCountIs(ARCH_AI_BUILD.AGENT_MAX_STEPS),
        maxOutputTokens: ARCH_AI_BUILD.MAX_OUTPUT_TOKENS,
        temperature: ARCH_AI_BUILD.TEMPERATURE,
        abortSignal: workerSignal,
      });

      // Consume the full stream to trigger tool execution
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _part of result.fullStream) {
        // Tools auto-execute via the AI SDK — we just need to consume the stream
      }

      const elapsed = Date.now() - start;

      // Read the result from DB (generate_agent + compile_abl wrote there)
      const mongoose = (await import('mongoose')).default;
      const db = mongoose.connection.db;
      if (!db) throw new Error('Database not connected');

      const sessionDoc = await db.collection('arch_sessions').findOne({
        _id: session.id,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
      } as Record<string, unknown>);

      const files = (sessionDoc?.metadata?.files ?? {}) as Record<string, { content?: string }>;
      const statuses = (sessionDoc?.metadata?.buildProgress?.agentStatuses ?? {}) as Record<
        string,
        string
      >;

      const agentStatus = statuses[agentName] ?? 'error';
      const hasFile = agentName in files;

      if (hasFile && (agentStatus === 'compiled' || agentStatus === 'warning')) {
        // Normalize the source before declaring success
        const { normalizeBuildAgentSource } = await import('./build-source-normalization');
        const fileContent = files[agentName]?.content ?? '';
        const normalized = await normalizeBuildAgentSource(fileContent);

        // Write normalized code back if repairs were made
        if (normalized.repairs.length > 0 && db) {
          await db
            .collection('arch_sessions')
            .updateOne(
              { _id: session.id, tenantId: ctx.tenantId, userId: ctx.userId } as Record<
                string,
                unknown
              >,
              { $set: { [`metadata.files.${agentName}.content`]: normalized.code } },
            );
        }

        emit({
          type: 'file_changed',
          path: `agents/${agentName}.abl.yaml`,
          action: 'create',
          content: normalized.code,
        });
        emit({
          type: 'compile_result',
          agent: agentName,
          status: agentStatus === 'warning' ? 'warning' : 'pass',
          errors: [],
          warnings: normalized.repairs,
        });

        log.info('Worker completed', { agentName, status: agentStatus, attempt, elapsed });

        return {
          agentName,
          status: agentStatus as 'compiled' | 'warning',
          warnings: normalized.repairs,
          errors: [],
          elapsed,
        };
      }

      // Agent didn't compile — if retries remain, continue
      if (attempt < maxRetries) {
        log.warn('Worker failed, retrying', { agentName, attempt, agentStatus });
        continue;
      }

      return {
        agentName,
        status: 'error',
        warnings: [],
        errors: ['Compilation failed after retries'],
        elapsed,
      };
    } catch (err: unknown) {
      const elapsed = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);

      if (attempt < maxRetries) {
        log.warn('Worker error, retrying', { agentName, attempt, error: message });
        continue;
      }

      log.error('Worker failed after all retries', { agentName, error: message });
      return { agentName, status: 'error', warnings: [], errors: [message], elapsed };
    }
  }

  // Unreachable but TypeScript requires it
  return { agentName, status: 'error', warnings: [], errors: ['Max retries exceeded'], elapsed: 0 };
}

/**
 * Run parallel generation for the given agent names.
 * Returns full reconciled AgentGenResult[] for EVERY topology agent.
 */
export async function runParallelGeneration(
  agentNames: string[],
  ctx: BuildActionContext,
  session: ArchSession,
  emit: (event: ArchSSEEvent) => void,
  model: Parameters<typeof streamText>[0]['model'],
  requestSignal?: AbortSignal,
): Promise<AgentGenResult[]> {
  const topology = session.metadata.topology as {
    agents: Array<{ name: string; role: string; executionMode: string; description: string }>;
    edges: Array<{ from: string; to: string; type: string }>;
  };
  const spec = session.metadata.specification;
  const allAgentNames = topology.agents.map((a) => a.name);

  // Mark generating
  const mongoose = (await import('mongoose')).default;
  const db = mongoose.connection.db;
  if (db) {
    const statusUpdate: Record<string, string> = {};
    for (const name of agentNames)
      statusUpdate[`metadata.buildProgress.agentStatuses.${name}`] = 'pending';
    await db
      .collection('arch_sessions')
      .updateOne(
        { _id: session.id, tenantId: ctx.tenantId, userId: ctx.userId } as Record<string, unknown>,
        { $set: { 'metadata.buildProgress.stage': 'generating', ...statusUpdate } },
      );
  }

  emit({
    type: 'text_delta',
    delta: `Building ${agentNames.length} agent${agentNames.length > 1 ? 's' : ''} in parallel...\n\n`,
  });

  const projectContext = {
    name: (spec?.projectName as string) ?? 'Untitled',
    description: (spec?.description as string) ?? '',
  };

  // Spawn workers
  const workerPromises = agentNames.map((name) => {
    const agentSpec = topology.agents.find((a) => a.name === name);
    if (!agentSpec) {
      return Promise.resolve<WorkerResult>({
        agentName: name,
        status: 'error',
        warnings: [],
        errors: [`Agent '${name}' not found in topology`],
        elapsed: 0,
      });
    }

    const siblings = allAgentNames.filter((n) => n !== name);
    return runAgentWorker(name, agentSpec, siblings, projectContext, {
      ctx,
      session,
      emit,
      model,
      requestSignal,
    });
  });

  const settled = await Promise.allSettled(workerPromises);
  const rawResults: WorkerResult[] = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : {
          agentName: agentNames[i],
          status: 'error' as const,
          warnings: [],
          errors: [String(s.reason)],
          elapsed: 0,
        },
  );

  // Emit activity summary
  const compiled = rawResults.filter(
    (r) => r.status === 'compiled' || r.status === 'warning',
  ).length;
  const errors = rawResults.filter((r) => r.status === 'error').length;
  emit({
    type: 'text_delta',
    delta: `Generation complete: ${compiled} compiled, ${errors} error${errors !== 1 ? 's' : ''}.\n\n`,
  });

  // Post-gen cross-agent validation with real topology edges
  const freshSession = await db?.collection('arch_sessions').findOne({
    _id: session.id,
    tenantId: ctx.tenantId,
    userId: ctx.userId,
  } as Record<string, unknown>);
  const agentFiles = (freshSession?.metadata?.files ?? {}) as Record<string, { content?: string }>;
  const persistedStatuses = (freshSession?.metadata?.buildProgress?.agentStatuses ?? {}) as Record<
    string,
    string
  >;

  // Reconcile: merge raw results + persisted state for ALL topology agents
  const { reconcileBuildResults } = await import('./build-result-reconciliation');
  const reconciled = await reconcileBuildResults({
    topologyAgents: topology.agents.map((a) => ({
      name: a.name,
      role: a.role,
      executionMode: a.executionMode,
    })),
    topologyEdges: topology.edges.map((e) => ({ from: e.from, to: e.to, type: e.type })),
    rawResults: rawResults.map((r) => ({
      agentName: r.agentName,
      status: r.status,
      warnings: r.warnings,
      errors: r.errors,
    })),
    persistedStatuses: persistedStatuses as Record<
      string,
      import('@agent-platform/arch-ai').BuildAgentStatus
    >,
    agentFiles,
  });

  // Update buildProgress with reconciled statuses
  if (db) {
    await db
      .collection('arch_sessions')
      .updateOne(
        { _id: session.id, tenantId: ctx.tenantId, userId: ctx.userId } as Record<string, unknown>,
        {
          $set: {
            'metadata.buildProgress.stage': errors > 0 ? 'agents_complete' : 'complete',
            'metadata.buildProgress.agentStatuses': reconciled.agentStatuses,
          },
        },
      );
  }

  // Map to AgentGenResult[] with elapsed
  const elapsedByAgent = new Map(rawResults.map((r) => [r.agentName, r.elapsed]));
  return reconciled.results.map((r) => ({
    ...r,
    elapsed: elapsedByAgent.get(r.agentName) ?? 0,
  }));
}
```

- [ ] **Step 3: Create `build-worker-tools.ts` — minimal tools for workers**

Create `apps/studio/src/lib/arch-ai/build-worker-tools.ts`:

```ts
/**
 * Minimal tool set for parallel BUILD workers.
 * Only generate_agent + compile_abl — no ask_user, no proceed, no propose.
 * Reuses the same DB write logic as buildBuildTools.
 */

import { z } from 'zod';
import { tool } from 'ai';

const AGENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function buildWorkerTools(ctx: { tenantId: string; userId: string }, sessionId: string) {
  return {
    generate_agent: tool({
      description: 'Generate a complete ABL YAML agent definition.',
      inputSchema: z.object({
        agentName: z.string().describe('Name of the agent'),
        code: z.string().describe('Complete ABL YAML code'),
      }),
      execute: async (input) => {
        if (!AGENT_NAME_PATTERN.test(input.agentName)) {
          return `Error: invalid agent name "${input.agentName}".`;
        }
        const mongoose = (await import('mongoose')).default;
        const db = mongoose.connection.db;
        if (!db) return 'Error: database not connected';
        const filePath = `agents/${input.agentName}.abl.yaml`;

        await db.collection('arch_sessions').updateOne(
          {
            _id: sessionId,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            'metadata.files': null,
          } as Record<string, unknown>,
          { $set: { 'metadata.files': {} } },
        );

        await db
          .collection('arch_sessions')
          .updateOne(
            { _id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId } as Record<
              string,
              unknown
            >,
            {
              $set: {
                [`metadata.files.${input.agentName}`]: { path: filePath, content: input.code },
                [`metadata.buildProgress.agentStatuses.${input.agentName}`]: 'generated',
              },
            },
          );

        return `Agent ${input.agentName} generated: ${input.code.split('\n').length} lines`;
      },
    }),
    compile_abl: tool({
      description: 'Validate ABL YAML code against the ABL compiler.',
      inputSchema: z.object({
        code: z.string().describe('ABL YAML code to validate'),
        agentName: z.string().describe('Agent name for error context'),
      }),
      execute: async (input) => {
        const { parseAgentBasedABL } = await import('@abl/core');
        const result = parseAgentBasedABL(input.code);

        const errors = (result.errors ?? []).map(
          (e: { line?: number; message: string }) => `Line ${e.line ?? '?'}: ${e.message}`,
        );
        const warnings = (result.warnings ?? []).map(
          (w: { line?: number; message: string }) => `Line ${w.line ?? '?'}: ${w.message}`,
        );

        const mongoose = (await import('mongoose')).default;
        const db = mongoose.connection.db;

        if (errors.length > 0 || !result.document) {
          if (db && AGENT_NAME_PATTERN.test(input.agentName)) {
            await db
              .collection('arch_sessions')
              .updateOne(
                { _id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId } as Record<
                  string,
                  unknown
                >,
                { $set: { [`metadata.buildProgress.agentStatuses.${input.agentName}`]: 'error' } },
              );
          }
          return {
            status: 'fail',
            errors: errors.length > 0 ? errors : ['No AGENT: or SUPERVISOR: declaration found.'],
            warnings,
            hint: 'ABL uses UPPERCASE constructs: AGENT:, GOAL:, PERSONA:, HANDOFF:, etc.',
          };
        }

        // Quality floor checks
        const qualityWarnings: string[] = [];
        const isSupervisor = /^\s*SUPERVISOR\s*:/m.test(input.code);
        if (!/GUARDRAILS:/m.test(input.code)) qualityWarnings.push('Missing GUARDRAILS section');
        if (!/MEMORY:/m.test(input.code)) qualityWarnings.push('Missing MEMORY section');
        if (!isSupervisor && !/TOOLS:/m.test(input.code))
          qualityWarnings.push('Specialist missing TOOLS section');
        if (isSupervisor && !/WHEN:\s*["']true["']/m.test(input.code))
          qualityWarnings.push('SUPERVISOR missing catch-all HANDOFF');

        const compileStatus = qualityWarnings.length > 0 ? 'warning' : 'compiled';
        if (db && AGENT_NAME_PATTERN.test(input.agentName)) {
          await db
            .collection('arch_sessions')
            .updateOne(
              { _id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId } as Record<
                string,
                unknown
              >,
              {
                $set: {
                  [`metadata.buildProgress.agentStatuses.${input.agentName}`]: compileStatus,
                },
              },
            );
        }

        return { status: 'pass', errors: [], warnings, qualityWarnings };
      },
    }),
  };
}
```

- [ ] **Step 4: Run `pnpm build --filter=@agent-platform/studio` to verify types compile**

Expected: successful build.

- [ ] **Step 5: Commit**

```bash
git add apps/studio/src/lib/arch-ai/build-parallel-gen.ts apps/studio/src/lib/arch-ai/build-worker-tools.ts apps/studio/src/lib/arch-ai/constants.ts
git commit -m "[ABLP-162] feat(studio): add parallel BUILD generation module with per-agent workers"
```

---

### Task 2: Wire orchestrator entry in `processMessage`

**Files:**

- Modify: `apps/studio/src/app/api/arch-ai/message/route.ts`

The orchestrator replaces the single `streamText` call when BUILD phase has missing agents. The existing `processMessage` detects "phase === BUILD" and falls through to the LLM. We intercept earlier.

- [ ] **Step 1: Add the `buildProgress.stage === 'generating'` concurrency guard**

At the top of `processMessage`, after the phase variable is read (~line 3530), add:

```ts
// Guard: reject messages while parallel generation is running
if (phase === 'BUILD' && msg.type === 'message') {
  const bp = (session.metadata as unknown as Record<string, unknown>)?.buildProgress as
    | { stage?: string }
    | undefined;
  if (bp?.stage === 'generating') {
    emit({
      type: 'error',
      code: 'BUILD_IN_PROGRESS',
      message: 'Agents are being generated. Please wait for the build to complete.',
      retryable: true,
    });
    emit({ type: 'done' });
    close();
    return;
  }
}
```

- [ ] **Step 2: Add orchestrator entry point before the `streamText` call**

Before the `streamText` call in `processMessage` (around the current line that selects `phaseTools`), add the orchestrator branch. When `phase === 'BUILD'` and agents are missing, call `runParallelGeneration` instead of falling through to `streamText`:

```ts
// ─── BUILD: parallel orchestrator entry ─────────────────────────────
// When entering BUILD with missing agents, use parallel generation
// instead of the single streamText call.
if (phase === 'BUILD' && !isInProject) {
  const topoForOrch = (freshSession?.metadata as unknown as Record<string, unknown>)?.topology as
    | {
        agents: Array<{ name: string; role: string; executionMode: string; description: string }>;
        edges: Array<{ from: string; to: string; type: string }>;
      }
    | undefined;
  const filesForOrch = (freshSession?.metadata?.files ?? {}) as Record<string, unknown>;
  const topologyAgentNames = topoForOrch?.agents?.map((a) => a.name) ?? [];
  const generatedNames = new Set(Object.keys(filesForOrch));
  const missingAgents = topologyAgentNames.filter((n) => !generatedNames.has(n));

  if (missingAgents.length > 0 && topoForOrch) {
    // Parallel generation path
    const { runParallelGeneration } = await import('@/lib/arch-ai/build-parallel-gen');
    const { buildCompletionSummary, buildCompletionWidgetPayload } =
      await import('@/lib/arch-ai/build-completion');

    const results = await runParallelGeneration(
      missingAgents,
      ctx,
      freshSession ?? session,
      emit,
      resolution.model!,
      abortSignal,
    );

    // Emit completion summary as chat text
    const summary = buildCompletionSummary(results);
    emit({ type: 'text_delta', delta: summary + '\n\n' });

    // Emit deterministic BuildComplete widget
    const widgetPayload = buildCompletionWidgetPayload(
      results,
      (freshSession?.metadata?.specification?.projectName as string) ?? undefined,
    );
    const toolCallId = `build-complete-${crypto.randomUUID().slice(0, 8)}`;
    emit({ type: 'tool_call', toolCallId, toolName: 'ask_user', input: widgetPayload });

    // Persist
    await sessionService.appendMessage(ctx, session.id, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: summary,
      timestamp: new Date().toISOString(),
      specialist: display.name,
      toolCalls: [{ toolCallId, toolName: 'ask_user', input: widgetPayload }],
      phase,
    });
    await sessionService.setPendingInteraction(ctx, session.id, {
      kind: 'widget',
      id: toolCallId,
      payload: widgetPayload,
      createdAt: new Date().toISOString(),
    });

    await transitionSessionToIdle(ctx, session.id, 'build_parallel_complete');
    emit({ type: 'done' });
    close();
    return;
  }

  // If no agents missing, fall through to conversational mode (streamText)
}
```

- [ ] **Step 3: Build and verify**

```bash
pnpm build --filter=@agent-platform/studio
```

- [ ] **Step 4: Commit**

```bash
git add apps/studio/src/app/api/arch-ai/message/route.ts
git commit -m "[ABLP-162] feat(studio): wire parallel BUILD orchestrator into processMessage"
```

---

### Task 3: Wire BuildComplete widget interception

**Files:**

- Modify: `apps/studio/src/app/api/arch-ai/message/route.ts`

When the user answers the BuildComplete widget, route to `handleBuildAction` instead of the LLM.

- [ ] **Step 1: Add BuildComplete interception in the `tool_answer` handler**

In the `tool_answer` handler at ~line 4847, BEFORE the code falls through to the LLM resolution, add:

```ts
// ─── BuildComplete widget interception ──────────────────────────────
// When the user answers a BuildComplete widget, route deterministically
// to handleBuildAction — never fall through to the LLM.
if (msg.type === 'tool_answer') {
  const pending = session.metadata.pendingInteraction;
  const widgetPayload = pending?.payload as Record<string, unknown> | undefined;

  if (widgetPayload?.widgetType === 'BuildComplete') {
    const answer = typeof msg.answer === 'string' ? msg.answer : String(msg.answer);
    const { handleBuildAction, buildCompletionWidgetPayload } =
      await import('@/lib/arch-ai/build-completion');
    const { runParallelGeneration } = await import('@/lib/arch-ai/build-parallel-gen');

    // Recover results from the persisted widget payload
    const { extractBuildResultsFromPendingWidgetPayload } =
      await import('@/lib/arch-ai/build-result-reconciliation');
    const results = extractBuildResultsFromPendingWidgetPayload(widgetPayload);

    const journalFn = async (summary: string, rationale: string, spec: string, ph: string) => {
      await journalAppendAndEmit(
        ctx,
        {
          sessionId: session.id,
          type: 'decision',
          content: {
            type: 'decision',
            summary,
            rationale,
            specialist: spec,
            source: 'specialist_recommendation' as const,
          },
          specialist: spec,
          phase: ph,
        },
        emit,
      );
    };

    await handleBuildAction(
      answer,
      ctx,
      session,
      results,
      emit,
      close,
      {
        sessionService,
        journalFn,
        runParallelGeneration: async (agentNames, actionCtx, actionSession, actionEmit) => {
          return runParallelGeneration(
            agentNames,
            actionCtx,
            actionSession,
            actionEmit,
            resolution.model!,
            abortSignal,
          );
        },
      },
      (session.metadata.specification?.projectName as string) ?? undefined,
    );

    return; // Do NOT fall through to LLM
  }
}
```

- [ ] **Step 2: Build and verify**

```bash
pnpm build --filter=@agent-platform/studio
```

- [ ] **Step 3: Commit**

```bash
git add apps/studio/src/app/api/arch-ai/message/route.ts
git commit -m "[ABLP-162] feat(studio): intercept BuildComplete widget answers with handleBuildAction"
```

---

### Task 4: Remove legacy gate emissions

**Files:**

- Modify: `apps/studio/src/app/api/arch-ai/message/route.ts`

Remove the remaining `tool_generation` gate in the allDone handler and clean up the legacy gate code that's now dead.

- [ ] **Step 1: Remove `tool_generation` gate emission from the allDone handler**

Find the `if (allDone)` block in the agent_review accept handler (~line 4405). The `tool_generation` gate emission inside this block (starting at the tool extraction + gate emit around line 4425-4478) should be replaced with a comment noting it's handled by `handleBuildAction('tools')`.

Replace the tool_generation gate emission block with:

```ts
if (allDone) {
  // Gate-free: tool generation is handled by handleBuildAction('tools')
  // via the deterministic BuildComplete widget. No gate emission needed.
  emit({ type: 'text_delta', delta: 'All agents approved!\n\n' });
  await transitionSessionToIdle(ctx, session.id, 'build_all_done');
  emit({ type: 'done' });
  close();
  return;
}
```

- [ ] **Step 2: Build and verify**

```bash
pnpm build --filter=@agent-platform/studio
```

- [ ] **Step 3: Commit**

```bash
git add apps/studio/src/app/api/arch-ai/message/route.ts
git commit -m "[ABLP-162] refactor(studio): remove tool_generation gate — handled by BuildComplete widget"
```

---

### Task 5: Update BUILD_AGENT_PROMPT and clean BuildProgressCard

**Files:**

- Modify: `packages/arch-ai/src/prompts/phases/build.ts:125-144`
- Modify: `apps/studio/src/components/arch-v3/chat/BuildProgressCard.tsx`

- [ ] **Step 1: Update retry count in BUILD_AGENT_PROMPT**

In `packages/arch-ai/src/prompts/phases/build.ts`, change line 128:

```
**Process:** Call generate_agent with the full ABL YAML, then call compile_abl to validate. If compilation fails, fix errors and retry (max 1 retry).
```

to:

```
**Process:** Call generate_agent with the full ABL YAML, then call compile_abl to validate. If compilation fails, fix errors and retry (max 2 retries).
```

- [ ] **Step 2: Clean BuildProgressCard — remove gate-era state**

In `apps/studio/src/components/arch-v3/chat/BuildProgressCard.tsx`:

Remove the `approved` and `reviewing` store subscriptions (lines 164-165):

```ts
// REMOVE these lines:
const approved = useArchAIStore((s) => s.approvedAgents);
const reviewing = useArchAIStore((s) => s.currentReviewAgent);
```

Simplify `deriveStatus` to derive only from `file.compileStatus`:

```ts
type RowStatus = 'pending' | 'generating' | 'ok' | 'warning' | 'error';

function deriveStatus(file: FilePanelFile | undefined): RowStatus {
  if (!file) return 'pending';
  switch (file.compileStatus) {
    case 'compiling':
    case 'fixing':
      return 'generating';
    case 'success':
      return 'ok';
    case 'warning':
      return 'warning';
    case 'error':
      return 'error';
    default:
      return 'pending';
  }
}
```

Update the row derivation in the `useMemo` to remove `isApproved`/`isReviewing` args.

- [ ] **Step 3: Build both packages**

```bash
pnpm build --filter=@agent-platform/arch-ai --filter=@agent-platform/studio
```

- [ ] **Step 4: Commit**

```bash
git add packages/arch-ai/src/prompts/phases/build.ts apps/studio/src/components/arch-v3/chat/BuildProgressCard.tsx
git commit -m "[ABLP-162] refactor(studio): update BUILD_AGENT_PROMPT retry count, clean BuildProgressCard gate state"
```

---

### Task 6: Post-modification widget re-emission

**Files:**

- Modify: `apps/studio/src/app/api/arch-ai/message/route.ts`

After a conversational LLM turn in BUILD that modifies agents, re-emit the BuildComplete widget.

- [ ] **Step 1: Track `agentsModifiedThisTurn` alongside `agentsGeneratedThisTurn`**

In the stream processing loop where `agentsGeneratedThisTurn` is tracked, also track modifications. After the existing `generate_agent` tracking (~line 5355), add tracking for `propose_modification`:

```ts
if (toolName === 'propose_modification') {
  const name = (input as { agentName?: string }).agentName;
  if (name && !agentsModifiedThisTurn.includes(name)) {
    agentsModifiedThisTurn.push(name);
  }
}
```

Declare `agentsModifiedThisTurn` alongside `agentsGeneratedThisTurn`:

```ts
const agentsModifiedThisTurn: string[] = [];
```

- [ ] **Step 2: Add post-stream re-emission logic**

After the existing post-stream BUILD block (where `file_changed` events are emitted), add:

```ts
// ─── BUILD: re-emit BuildComplete after conversational modifications ─
const allModified = [...agentsGeneratedThisTurn, ...agentsModifiedThisTurn];
if (allModified.length > 0 && phase === 'BUILD' && !pendingToolCall) {
  // Re-reconcile and re-emit the completion widget
  const latestForReemit = await sessionService.getById(ctx, session.id);
  const reemitFiles = (latestForReemit?.metadata?.files ?? {}) as Record<
    string,
    { content?: string }
  >;
  const reemitTopo = latestForReemit?.metadata?.topology as
    | {
        agents: Array<{ name: string; role?: string; executionMode?: string }>;
        edges: Array<{ from: string; to: string; type?: string }>;
      }
    | undefined;
  const reemitStatuses = (latestForReemit?.metadata?.buildProgress?.agentStatuses ?? {}) as Record<
    string,
    string
  >;
  const reemitMissing = (reemitTopo?.agents ?? [])
    .map((a) => a.name)
    .filter((n) => !(n in reemitFiles));

  // Only re-emit widget if all agents have files
  if (reemitMissing.length === 0 && reemitTopo) {
    const { reconcileBuildResults } = await import('@/lib/arch-ai/build-result-reconciliation');
    const { buildCompletionWidgetPayload } = await import('@/lib/arch-ai/build-completion');

    const reconciled = await reconcileBuildResults({
      topologyAgents: reemitTopo.agents.map((a) => ({
        name: a.name,
        role: a.role,
        executionMode: a.executionMode,
      })),
      topologyEdges: reemitTopo.edges?.map((e) => ({ from: e.from, to: e.to, type: e.type })),
      rawResults: [],
      persistedStatuses: reemitStatuses as Record<
        string,
        import('@agent-platform/arch-ai').BuildAgentStatus
      >,
      agentFiles: reemitFiles,
    });

    const widgetPayload = buildCompletionWidgetPayload(
      reconciled.results,
      (latestForReemit?.metadata?.specification?.projectName as string) ?? undefined,
    );
    const toolCallId = `build-complete-${crypto.randomUUID().slice(0, 8)}`;
    emit({ type: 'tool_call', toolCallId, toolName: 'ask_user', input: widgetPayload });

    await sessionService.setPendingInteraction(ctx, session.id, {
      kind: 'widget',
      id: toolCallId,
      payload: widgetPayload,
      createdAt: new Date().toISOString(),
    });
  }
}
```

- [ ] **Step 3: Build and verify**

```bash
pnpm build --filter=@agent-platform/studio
```

- [ ] **Step 4: Commit**

```bash
git add apps/studio/src/app/api/arch-ai/message/route.ts
git commit -m "[ABLP-162] feat(studio): re-emit BuildComplete widget after conversational BUILD modifications"
```

---

### Task 7: Tests

**Files:**

- Create: `apps/studio/src/__tests__/arch-ai/build-parallel-gen.test.ts`

- [ ] **Step 1: Write test for merged retry result contract**

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@agent-platform/shared-observability', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('runParallelGeneration return contract', () => {
  it('returns results for ALL topology agents, not just retried subset', async () => {
    // This test verifies the P1 finding: retry must return merged results.
    // When retrying only agent A in a 3-agent topology, the result must
    // include A (retried) + B,C (from persisted state).
    //
    // Full integration test requires LLM mocking — covered in E2E.
    // This unit test validates the reconciliation contract.

    const { reconcileBuildResults } = await import('../../lib/arch-ai/build-result-reconciliation');

    const result = await reconcileBuildResults({
      topologyAgents: [
        { name: 'A', role: 'triage' },
        { name: 'B', role: 'billing' },
        { name: 'C', role: 'support' },
      ],
      rawResults: [{ agentName: 'A', status: 'compiled', warnings: [], errors: [] }],
      persistedStatuses: { A: 'error', B: 'compiled', C: 'compiled' },
      agentFiles: {
        A: { content: 'AGENT: A\nGOAL: test\n' },
        B: { content: 'AGENT: B\nGOAL: test\n' },
        C: { content: 'AGENT: C\nGOAL: test\n' },
      },
    });

    // Must have results for ALL 3 agents
    expect(result.results).toHaveLength(3);
    const names = result.results.map((r) => r.agentName).sort();
    expect(names).toEqual(['A', 'B', 'C']);
  });
});
```

- [ ] **Step 2: Write test for add-agent scope classification**

```ts
describe('classifyMutationScope for topology changes', () => {
  it('classifies "add a new agent" as LARGE', async () => {
    const { classifyMutationScope } = await import('@agent-platform/arch-ai');
    expect(classifyMutationScope('Add a security audit agent')).toBe('LARGE');
  });

  it('classifies "change the persona" as SMALL', async () => {
    const { classifyMutationScope } = await import('@agent-platform/arch-ai');
    expect(classifyMutationScope('Change the persona of the triage agent')).toBe('SMALL');
  });

  it('classifies "remove the escalation handler" as LARGE', async () => {
    const { classifyMutationScope } = await import('@agent-platform/arch-ai');
    expect(classifyMutationScope('Remove the escalation handler agent')).toBe('LARGE');
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd packages/arch-ai && pnpm vitest run src/__tests__/build-gate-queue.test.ts src/__tests__/phase-machine.test.ts src/__tests__/session-service.test.ts
cd apps/studio && pnpm vitest run src/__tests__/arch-ai/build-parallel-gen.test.ts
```

Expected: all pass.

- [ ] **Step 4: Full build verification**

```bash
pnpm build --filter=@agent-platform/arch-ai --filter=@agent-platform/studio
```

- [ ] **Step 5: Commit**

```bash
git add apps/studio/src/__tests__/arch-ai/build-parallel-gen.test.ts
git commit -m "[ABLP-162] test(studio): add parallel BUILD generation tests — retry contract, scope classification"
```
