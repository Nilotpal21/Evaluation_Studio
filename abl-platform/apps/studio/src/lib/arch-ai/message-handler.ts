/**
 * handleArchMessage — archived message route handler for the turn engine.
 *
 * Source of truth: docs/superpowers/specs/2026-04-17-arch-ai-orchestration-redesign-design.md §6.3
 * Plan: docs/plans/2026-04-17-arch-ai-orchestration-redesign-impl-plan.md Phase 4 + 6.3
 *
 * Lifecycle:
 *   1. Auth + parse (same pattern as v1 handleV1)
 *   2. Load session (scoped by tenant + user)
 *   3. Classify request via classifyRequestForQueue
 *   4. reject → return JSON error
 *   5. route_direct → minimal interactive-response handler (tool_answer, gate, proposal)
 *   6. queue → attempt Redis turn lock
 *      - locked → enqueue into session.queue[], return 202
 *      - acquired → streamTurn dispatch via TurnEngine, release lock on completion
 */

import type { NextRequest } from 'next/server';
import { uuidv7 } from '@agent-platform/database/mongo';
import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  MessageRequestSchema,
  checkExitCriteria,
  classifyMutationScope,
  getNextPhase,
} from '@agent-platform/arch-ai';
import { getSourceArchitectureContractFromMetadata } from '@agent-platform/arch-ai/blueprint';
import {
  classifyRequestForQueue,
  resolveTurnPlan,
  TurnBuffer,
} from '@agent-platform/arch-ai/engine';
import {
  acquireTurnLock,
  releaseTurnLock,
  createSessionStore,
  publishTurnEvent,
  LearningMemoryService,
  SCHEMA_VERSION_V2,
} from '@agent-platform/arch-ai/session';
import type {
  ArchContentBlock,
  MessageRequest,
  ArchPhase,
  ArchSession,
  ArchSSEEvent,
  ArchSessionV2,
  StoredMessageV2,
  TurnEvent,
  PendingInteractiveV2,
} from '@agent-platform/arch-ai';
import type { LLMMessage as V2LLMMessage } from '@agent-platform/arch-ai/engine';
import { ArchSession as ArchSessionModel } from '@agent-platform/database/models';
import type { Model } from 'mongoose';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { errorJson } from '@/lib/api-response';
import { getRedisClient } from '@/lib/redis-client';
import { createProductionTurnEngine, buildServiceBagForTurn } from './engine-factory';
import { createV1ToV2EmitAdapter } from './build-emit-adapter';
import {
  renderManagedBehaviorProfileFilesForReferences,
  renderManagedBehaviorProfileFilesForTopology,
  renderSourceBehaviorProfileFiles,
} from './managed-behavior-profiles';

const log = createLogger('api:arch-ai:message:v2');

// SessionStoreOptions declares Model<unknown> to avoid coupling to IArchSession.
// ArchSession is Model<IArchSession> with _id: string (not ObjectId), so the
// Mongoose generic variance doesn't align. The cast is safe — createSessionStore
// only calls findOne/updateOne/deleteMany which are structurally compatible.
const sessionStore = createSessionStore({
  ArchSessions: ArchSessionModel as unknown as Model<unknown>,
});

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Map stored messages to the turn engine's LLMMessage shape.
 * Stored messages are user/assistant/system with string or ContentBlock content.
 * The engine expects {role, content: string, toolCalls?, toolCallId?}.
 * For the initial wiring, we flatten content to string and skip tool messages
 * (they are internal to a turn and not persisted across turns).
 */
function mapStoredMessagesToLlm(messages: StoredMessageV2[]): V2LLMMessage[] {
  const result: V2LLMMessage[] = [];
  for (const m of messages) {
    // Only map user/assistant — system prompts are composed by the coordinator bridge.
    if (m.role === 'system') continue;

    const content =
      typeof m.content === 'string'
        ? m.content
        : m.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('\n');

    result.push({ role: m.role, content });
  }
  return result;
}

/**
 * Stream TurnEngine events as SSE to the HTTP response.
 * Returns a Response with `text/event-stream` content type.
 */
function createTurnSSEResponse(
  engineIter: AsyncIterable<TurnEvent>,
  cleanup: () => Promise<void>,
  signal: AbortSignal,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of engineIter) {
          if (signal.aborted) break;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } catch (err: unknown) {
        log.error('SSE stream error during turn', {
          error: err instanceof Error ? err.message : String(err),
        });
        // Try to enqueue an error event before closing.
        try {
          const errorEvent = {
            type: 'error',
            error: {
              code: 'STREAM_ERROR',
              message: 'An error occurred during streaming.',
              retryable: false,
            },
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
        } catch {
          // Controller may already be closed; ignore.
        }
      } finally {
        await cleanup();
        try {
          controller.close();
        } catch {
          // Already closed; ignore.
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ─── Helpers: v2→v1 session bridge ─────────────────────────────────────

/**
 * Bridge a v2 session to the v1 ArchSession shape expected by the coordinator's
 * `checkExitCriteria` / `transitionPhase`. v1 functions read `session.metadata.phase`,
 * `session.metadata.specification`, etc. v2 stores phase at top level and metadata
 * is a flat bag. This constructs a compatible view without duplicating the full type.
 */
function bridgeToV1Session(session: ArchSessionV2): ArchSession {
  return {
    id: session.id,
    tenantId: session.tenantId,
    userId: session.userId,
    state: session.state.toUpperCase() as ArchSession['state'],
    metadata: {
      // Spread v1 metadata fields (topologyApproved, buildProgress, files, etc.)
      // needed by exit criteria, then overlay required v1 fields.
      ...(session.metadata ?? {}),
      phase: session.phase as ArchPhase,
      mode: session.mode === 'in-project' ? 'IN_PROJECT' : 'ONBOARDING',
      specification: session.metadata?.specification ?? {},
      pendingInteraction: null,
      messages: [],
      projectId: session.projectId,
    } as unknown as ArchSession['metadata'],
    createdAt: String(session.createdAt),
    updatedAt: String(session.lastActiveAt),
  };
}

/**
 * Build a minimal TurnEvent envelope for non-LLM handlers (phase advance, gate
 * accept/reject). These events bypass the TurnEngine and are emitted directly.
 */
function makeEnvelope(
  sessionId: string,
  turnId: string,
  seq: number,
): {
  eventId: string;
  schemaVersion: 2;
  sessionId: string;
  turnId: string;
  seq: number;
  timestamp: number;
} {
  return {
    eventId: uuidv7(),
    schemaVersion: 2 as const,
    sessionId,
    turnId,
    seq,
    timestamp: Date.now(),
  };
}

// ─── Main handler ───────────────────────────────────────────────────────

export async function handleArchMessage(request: NextRequest): Promise<Response> {
  try {
    // ── 1. Auth ────────────────────────────────────────────────────────
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;

    // ── 2. Parse ───────────────────────────────────────────────────────
    const body = await request.json();
    const parsed = MessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      return errorJson(parsed.error.errors.map((e) => e.message).join(', '), 400, 'INVALID_INPUT');
    }
    const msg = parsed.data as MessageRequest;

    // ── 3. Load session ────────────────────────────────────────────────
    const ctx = { tenantId: auth.tenantId, userId: auth.id };
    const session = await sessionStore.getSession(ctx, msg.sessionId);
    if (!session) {
      return errorJson('Session not found', 404, 'SESSION_NOT_FOUND');
    }
    if (session.state === 'archived') {
      return errorJson('Cannot operate on an archived session', 409, 'SESSION_ARCHIVED');
    }

    // ── 3a. Continue → phase advance (C3) ──────────────────────────────
    // Intercept before classify — continue is deterministic, no LLM needed.
    if (msg.type === 'continue') {
      return handleContinuePhaseAdvance(request, auth, session);
    }

    // ── 3b. GATE_PENDING bypass (I7) ───────────────────────────────────
    // When a user sends a new message while the session is gate_pending,
    // clear the pending gate and transition to active. The new message
    // takes priority over the stale gate.
    if (msg.type === 'message' && session.state === ('gate_pending' as ArchSessionV2['state'])) {
      log.info('GATE_PENDING bypass: clearing pending gate for new message', {
        sessionId: session.id,
        tenantId: auth.tenantId,
      });
      await ArchSessionModel.updateOne(
        {
          _id: session.id,
          tenantId: auth.tenantId,
          userId: auth.id,
          schemaVersion: SCHEMA_VERSION_V2,
        },
        {
          $set: { state: 'active', pendingInteractive: null },
        },
      );
      // Update local copy so downstream handlers see the correct state.
      (session as { state: string }).state = 'active';
      (session as { pendingInteractive?: unknown }).pendingInteractive = undefined;
    }

    // ── 3c. BUILD→BLUEPRINT backtrack on LARGE mutation (I6) ──────────
    // When a user sends a message during BUILD that requests a topology-
    // altering change (add agent, remove agent, redesign, etc.), backtrack
    // the phase to BLUEPRINT so the architect re-plans the topology.
    if (
      msg.type === 'message' &&
      session.phase === 'BUILD' &&
      session.metadata?.topology !== undefined &&
      msg.text
    ) {
      const scope = classifyMutationScope(msg.text);
      if (scope === 'LARGE') {
        log.info('v2 BUILD → BLUEPRINT backtrack (LARGE mutation)', {
          sessionId: session.id,
          messagePreview: msg.text.slice(0, 80),
          tenantId: auth.tenantId,
        });

        await ArchSessionModel.updateOne(
          {
            _id: session.id,
            tenantId: auth.tenantId,
            userId: auth.id,
            schemaVersion: SCHEMA_VERSION_V2,
          },
          {
            $set: {
              phase: 'BLUEPRINT',
              'metadata.topologyApproved': false,
              // Clear stale buildProgress so BUILD re-entry initializes fresh
              'metadata.buildProgress': null,
            },
          },
        );

        // Update local session copy so the remaining handler runs with BLUEPRINT.
        (session as { phase: string }).phase = 'BLUEPRINT';

        // The backtrack is transparent to the LLM — the message still goes to
        // the queue path but the BLUEPRINT specialist and prompt will be selected
        // by the turn plan resolver because session.phase is now BLUEPRINT.
        // No separate phase_transition event is emitted here — the turn engine
        // will emit it as part of the next turn's artifacts.
      }
    }

    // ── 4. Classify ────────────────────────────────────────────────────
    const classification = classifyRequestForQueue(msg);

    if (classification.action === 'reject') {
      return errorJson(
        `Request type "${msg.type}" rejected`,
        classification.status,
        classification.code,
      );
    }

    if (classification.action === 'route_direct') {
      // CREATE messages are routed_direct but dispatched to a dedicated handler.
      if (msg.type === 'create') {
        return handleCreateProject(request, auth, session);
      }
      return handleInteractiveResponse(request, auth, session, msg);
    }

    // ── 5. Queue path: attempt turn lock ───────────────────────────────
    return handleQueuePath(request, auth, session, msg);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('v2 message handler error', { error: message });
    return errorJson('An unexpected error occurred. Please try again.', 500, 'INTERNAL_ERROR');
  }
}

// ─── Continue → phase advance handler (C3) ─────────────────────────────

async function handleContinuePhaseAdvance(
  _request: NextRequest,
  auth: { tenantId: string; id: string },
  session: ArchSessionV2,
): Promise<Response> {
  const redis = getRedisClient();
  if (!redis) {
    return errorJson('Service temporarily unavailable', 503, 'REDIS_UNAVAILABLE');
  }

  const workerId = `worker_${uuidv7()}`;
  const lockResult = await acquireTurnLock(redis, session.id, workerId);

  if (!lockResult.acquired) {
    return Response.json(
      {
        success: false,
        error: {
          code: 'SESSION_BUSY',
          message: 'A turn is already in progress. Please wait before continuing.',
        },
      },
      { status: 409 },
    );
  }

  try {
    // Bridge v2 session to v1 shape for phase-machine functions.
    const v1Session = bridgeToV1Session(session);

    // Check exit criteria for the current phase.
    if (!checkExitCriteria(v1Session)) {
      return errorJson('Exit criteria not met for current phase.', 400, 'EXIT_CRITERIA_NOT_MET');
    }

    // Determine next phase.
    const currentPhase = session.phase as ArchPhase;
    const nextPhase = getNextPhase(currentPhase);

    if (!nextPhase) {
      // Final phase — nothing to advance to. Stream a single turn_ended.
      const turnId = `turn_${uuidv7()}`;
      const encoder = new TextEncoder();
      const endEvent: TurnEvent = {
        ...makeEnvelope(session.id, turnId, 0),
        type: 'turn_ended',
        reason: 'natural',
      };
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(endEvent)}\n\n`));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    // Perform the phase transition: update DB, emit events, end turn.
    const turnId = `turn_${uuidv7()}`;
    let seq = 0;

    // Build the SSE event sequence.
    const events: TurnEvent[] = [];

    // 1. phase_transition event (durable)
    const ptEvent: TurnEvent = {
      ...makeEnvelope(session.id, turnId, seq++),
      type: 'phase_transition',
      from: currentPhase,
      to: nextPhase,
      reason: 'Exit criteria met, user clicked Continue',
    };
    events.push(ptEvent);

    // 2. turn_committed event
    const tcEvent: TurnEvent = {
      ...makeEnvelope(session.id, turnId, seq++),
      type: 'turn_committed',
      phase: nextPhase,
    };
    events.push(tcEvent);

    // 3. turn_ended event
    const teEvent: TurnEvent = {
      ...makeEnvelope(session.id, turnId, seq++),
      type: 'turn_ended',
      reason: 'natural',
    };
    events.push(teEvent);

    // Apply DB updates: phase transition + state back to idle.
    await ArchSessionModel.updateOne(
      {
        _id: session.id,
        tenantId: auth.tenantId,
        userId: auth.id,
        schemaVersion: SCHEMA_VERSION_V2,
      },
      {
        $set: {
          phase: nextPhase,
          state: 'idle',
          lastActiveAt: Date.now(),
        },
      },
    );

    // Publish phase_transition event via fan-out for SSE subscribers.
    await publishTurnEvent(redis, session.id, ptEvent).catch((err: unknown) => {
      log.warn('Failed to publish phase_transition via fan-out', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    log.info('v2 phase advance', {
      sessionId: session.id,
      from: currentPhase,
      to: nextPhase,
      tenantId: auth.tenantId,
    });

    // Stream the events as SSE.
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } finally {
    await releaseTurnLock(redis, session.id, workerId).catch((err: unknown) => {
      log.warn('Failed to release turn lock after phase advance', {
        sessionId: session.id,
        workerId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

// ─── CREATE project handler (C2) ──────────────────────────────────────────

/**
 * Handle the `create` message: promote a BUILD-complete session into a real
 * Project + ProjectAgents, then archive the session. Mirrors v1's
 * process-message.ts:527-986 CREATE flow as closely as possible.
 *
 * Lifecycle:
 *   1. Guard: session must be in BUILD phase with topology + compiled agents
 *   2. Acquire turn lock
 *   3. Resolve project name, deduplicate
 *   4. Create Project + ProjectAgents + entry agent + tools
 *   5. Link journal + spec doc to project
 *   6. Extract project memories
 *   7. Transition session to archived
 *   8. Emit project / turn_committed / turn_ended events
 */
async function handleCreateProject(
  _request: NextRequest,
  auth: { tenantId: string; id: string },
  session: ArchSessionV2,
): Promise<Response> {
  const ctx = { tenantId: auth.tenantId, userId: auth.id };

  // ── Guard: session must be in a create-ready state ────────────────────
  const meta = session.metadata as Record<string, unknown>;
  const agentFiles = (meta.files ?? {}) as Record<string, { path: string; content: string }>;
  const agentNames = Object.keys(agentFiles);

  if (session.phase !== 'BUILD' || agentNames.length === 0) {
    return errorJson(
      'Session is not ready for project creation. BUILD phase with compiled agents is required.',
      409,
      'SESSION_NOT_READY_FOR_CREATE',
    );
  }

  // ── Acquire turn lock ─────────────────────────────────────────────────
  const redis = getRedisClient();
  if (!redis) {
    return errorJson('Service temporarily unavailable', 503, 'REDIS_UNAVAILABLE');
  }

  const workerId = `worker_${uuidv7()}`;
  const lockResult = await acquireTurnLock(redis, session.id, workerId);

  if (!lockResult.acquired) {
    return Response.json(
      {
        success: false,
        error: {
          code: 'SESSION_BUSY',
          message: 'A turn is already in progress. Please wait before creating the project.',
        },
      },
      { status: 409 },
    );
  }

  const turnId = `turn_${uuidv7()}`;
  let seq = 0;
  const encoder = new TextEncoder();
  const events: TurnEvent[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let project: { id: string; name?: string } | undefined;
  const spec = (meta.specification ?? {}) as Record<string, unknown>;
  let projectName = (spec.projectName as string) ?? 'Untitled';

  try {
    const { createProject, projectExistsByName, addAgentToProject, updateProject } =
      await import('@/services/project-service');

    // ── Deduplicate project name ──────────────────────────────────────
    if (await projectExistsByName(projectName, auth.tenantId)) {
      let suffix = 2;
      while (await projectExistsByName(`${projectName} (${suffix})`, auth.tenantId)) {
        suffix++;
      }
      projectName = `${projectName} (${suffix})`;
    }

    // ── Extract channels + language from spec ─────────────────────────
    const { normalizeChannels } = await import('@/lib/arch-ai/helpers/normalize-channels');
    const channels = normalizeChannels(spec.channels);
    const language = typeof spec.language === 'string' ? spec.language.trim() : undefined;

    // ── Create project (with race condition retry) ────────────────────
    try {
      project = await createProject({
        name: projectName,
        description: (spec.description as string) ?? '',
        tenantId: auth.tenantId,
        ownerId: auth.id,
        channels: channels.length > 0 ? channels : undefined,
        language: language || undefined,
      });
    } catch (createErr: unknown) {
      const isDuplicate =
        createErr instanceof Error &&
        'code' in createErr &&
        (createErr as { code: number }).code === 11000;
      if (isDuplicate) {
        const suffixed = `${projectName} (${Date.now() % 10000})`;
        log.info('Project name collision, retrying with suffix', {
          original: projectName,
          suffixed,
        });
        project = await createProject({
          name: suffixed,
          description: (spec.description as string) ?? '',
          tenantId: auth.tenantId,
          ownerId: auth.id,
          channels: channels.length > 0 ? channels : undefined,
          language: language || undefined,
        });
      } else {
        throw createErr;
      }
    }

    if (!project) {
      throw new Error('Project creation failed unexpectedly');
    }

    // ── Link arch session to created project ──────────────────────────
    await ArchSessionModel.updateOne(
      {
        _id: session.id,
        tenantId: auth.tenantId,
        userId: auth.id,
        schemaVersion: SCHEMA_VERSION_V2,
      },
      { $set: { 'metadata.projectId': String(project.id) } },
    );

    // ── Persist behavior profiles before agent definitions ────────────
    const sourceContract = getSourceArchitectureContractFromMetadata(meta);
    const managedProfileDomain = {
      channels,
      universalRules: sourceContract?.universalRules ?? [],
      channelRules: sourceContract?.channelRules?.map((rule) => ({
        channel: rule.channel,
        ...(rule.responseMaxWords !== undefined ? { responseMaxWords: rule.responseMaxWords } : {}),
        ...(rule.abbreviationPolicy ? { abbreviationPolicy: rule.abbreviationPolicy } : {}),
        ...(rule.toolLatencyBridge !== undefined
          ? { toolLatencyBridge: rule.toolLatencyBridge }
          : {}),
        rules: [...rule.rules],
      })),
    };
    const managedBehaviorProfiles = {
      ...renderManagedBehaviorProfileFilesForTopology(
        (meta.topology ?? null) as Parameters<
          typeof renderManagedBehaviorProfileFilesForTopology
        >[0],
        managedProfileDomain,
      ),
      ...renderManagedBehaviorProfileFilesForReferences(agentFiles, managedProfileDomain),
      ...renderSourceBehaviorProfileFiles(sourceContract),
    };
    if (Object.keys(managedBehaviorProfiles).length > 0) {
      const { ProjectConfigVariable } = await import('@agent-platform/database/models');
      const { behaviorProfileNameToConfigKey } = await import('@agent-platform/project-io');
      for (const [profileName, file] of Object.entries(managedBehaviorProfiles)) {
        await ProjectConfigVariable.findOneAndUpdate(
          {
            tenantId: auth.tenantId,
            projectId: project.id,
            key: behaviorProfileNameToConfigKey(profileName),
          },
          {
            $set: {
              value: file.content,
              updatedBy: auth.id,
            },
            $setOnInsert: {
              tenantId: auth.tenantId,
              projectId: project.id,
              key: behaviorProfileNameToConfigKey(profileName),
              description: null,
              createdBy: auth.id,
            },
          },
          { upsert: true },
        );
      }
      log.info('Persisted managed behavior profiles for archived Arch project creation path', {
        projectId: project.id,
        profileCount: Object.keys(managedBehaviorProfiles).length,
      });
    }

    // ── Save agent definitions ────────────────────────────────────────
    for (const agentName of agentNames) {
      const file = agentFiles[agentName];
      if (!file) {
        log.warn('Expected agent file missing during project creation', {
          agentName,
          projectId: project.id,
        });
        continue;
      }
      const goalMatch =
        file.content.match(/^GOAL:\s*"([^"]+)"/m) ||
        file.content.match(/^GOAL:\s*'([^']+)'/m) ||
        file.content.match(/^GOAL:\s*\|\s*\n\s+(.+)/m);
      const description = goalMatch?.[1]?.trim() ?? null;

      await addAgentToProject({
        projectId: project.id,
        tenantId: auth.tenantId,
        name: agentName,
        dslContent: file.content,
        description: description ?? undefined,
        ownerId: auth.id,
      });
    }

    // ── Detect and set entry agent ────────────────────────────────────
    const { detectEntryAgent } = await import('@/lib/arch-ai/project-entry-agent');
    const entryAgent = detectEntryAgent(
      agentNames.map((name) => ({
        name,
        ablContent: agentFiles[name]?.content,
      })),
    );
    await updateProject(project.id, { entryAgentName: entryAgent }, auth.tenantId);

    // ── Persist tools (toolDsls + inline extraction) ──────────────────
    try {
      const { collectInlineSeedTools } = await import('@agent-platform/database/seed-inline-tools');
      const { createToolFromDsl } = await import('@/lib/tool-creation-service');

      const toolDsls = meta.toolDsls as Record<string, string> | undefined;
      const toolDslNames = new Set<string>();

      if (toolDsls && Object.keys(toolDsls).length > 0) {
        for (const [toolName, dslContent] of Object.entries(toolDsls)) {
          toolDslNames.add(toolName);
          try {
            await createToolFromDsl({
              tenantId: auth.tenantId,
              projectId: project.id,
              toolName,
              dslContent,
              createdBy: auth.id,
              templateUrlsAllowed: true,
            });
          } catch (toolDslErr: unknown) {
            const isDup =
              toolDslErr instanceof Error &&
              'code' in toolDslErr &&
              ((toolDslErr as { code: number | string }).code === 11000 ||
                (toolDslErr as { code: number | string }).code === 'NAME_CONFLICT');
            if (!isDup) {
              log.warn('Failed to persist toolDsl-generated tool', {
                projectId: project.id,
                tool: toolName,
                error: toolDslErr instanceof Error ? toolDslErr.message : String(toolDslErr),
              });
            }
          }
        }
      }

      const agentSpecs = agentNames
        .map((name) => ({
          name,
          dslContent: agentFiles[name]?.content ?? null,
        }))
        .filter((s): s is { name: string; dslContent: string } => s.dslContent !== null);

      const extractedTools = collectInlineSeedTools(agentSpecs);
      for (const extractedTool of extractedTools) {
        if (toolDslNames.has(extractedTool.name)) continue;
        try {
          await createToolFromDsl({
            tenantId: auth.tenantId,
            projectId: project.id,
            toolName: extractedTool.name,
            dslContent: extractedTool.dslContent,
            createdBy: auth.id,
            templateUrlsAllowed: true,
          });
        } catch (toolErr: unknown) {
          const isDuplicate =
            toolErr instanceof Error &&
            'code' in toolErr &&
            ((toolErr as { code: number | string }).code === 11000 ||
              (toolErr as { code: number | string }).code === 'NAME_CONFLICT');
          if (!isDuplicate) {
            log.warn('Failed to persist extracted tool', {
              projectId: project.id,
              tool: extractedTool.name,
              error: toolErr instanceof Error ? toolErr.message : String(toolErr),
            });
          }
        }
      }
    } catch (extractErr: unknown) {
      log.warn('Tool extraction failed — project created without tool records', {
        projectId: project.id,
        error: extractErr instanceof Error ? extractErr.message : String(extractErr),
      });
    }

    // ── Link journal + spec doc to project, extract memories, archive ─
    // Use v1 singleton services from message-services.ts to avoid
    // re-instantiating (they need Mongoose models + connection).
    try {
      const { journalService, specDocumentService, projectMemoryService } =
        await import('@/lib/arch-ai/message-services');

      // Link journal to project
      try {
        await journalService.linkToProject(ctx, session.id, String(project.id), {
          unsafeProjectScope: true,
        });
      } catch (linkErr: unknown) {
        log.warn('Failed to link journal to project', {
          sessionId: session.id,
          projectId: String(project.id),
          error: linkErr instanceof Error ? linkErr.message : String(linkErr),
        });
      }

      // Link spec document to project
      try {
        await specDocumentService.linkToProject(ctx, session.id, String(project.id));
      } catch (linkErr: unknown) {
        log.warn('Failed to link spec document to project', {
          sessionId: session.id,
          projectId: String(project.id),
          error: linkErr instanceof Error ? linkErr.message : String(linkErr),
        });
      }

      // Extract project memories
      try {
        const journalEntries = await journalService.query(ctx, {
          sessionId: session.id,
        });
        const v1SessionForMemory = bridgeToV1Session(session);
        await projectMemoryService.extractMemoriesFromSession(
          ctx,
          String(project.id),
          v1SessionForMemory,
          journalEntries,
        );
      } catch (memErr: unknown) {
        log.warn('Failed to extract project memories from onboarding session', {
          sessionId: session.id,
          projectId: String(project.id),
          error: memErr instanceof Error ? memErr.message : String(memErr),
        });
      }

      // Archive journal entries
      try {
        await journalService.archiveSession(ctx, session.id);
      } catch (archiveErr: unknown) {
        log.warn('Failed to archive journal entries', {
          sessionId: session.id,
          error: archiveErr instanceof Error ? archiveErr.message : String(archiveErr),
        });
      }
    } catch (serviceErr: unknown) {
      log.warn('Failed to load message services for post-creation linking', {
        sessionId: session.id,
        projectId: String(project.id),
        error: serviceErr instanceof Error ? serviceErr.message : String(serviceErr),
      });
    }

    // ── Transition session to archived ────────────────────────────────
    await ArchSessionModel.updateOne(
      {
        _id: session.id,
        tenantId: auth.tenantId,
        userId: auth.id,
        schemaVersion: SCHEMA_VERSION_V2,
      },
      {
        $set: {
          state: 'archived',
          'metadata.projectId': String(project.id),
          lastActiveAt: Date.now(),
        },
      },
    );

    const finalProjectName = project.name ?? projectName;

    log.info('v2 project created successfully', {
      sessionId: session.id,
      projectId: String(project.id),
      projectName: finalProjectName,
      agentCount: agentNames.length,
      tenantId: auth.tenantId,
    });

    // ── Emit SSE events ───────────────────────────────────────────────
    events.push({
      ...makeEnvelope(session.id, turnId, seq++),
      type: 'artifact_updated',
      update: {
        artifact: 'project',
        payload: {
          projectId: String(project.id),
          name: finalProjectName,
          stats: { agentCount: agentNames.length },
        },
      },
    });

    events.push({
      ...makeEnvelope(session.id, turnId, seq++),
      type: 'turn_committed',
      phase: 'COMPLETE',
    });

    events.push({
      ...makeEnvelope(session.id, turnId, seq++),
      type: 'turn_ended',
      reason: 'natural',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('v2 project creation failed', {
      error: message,
      sessionId: session.id,
      projectId: project?.id ?? null,
      tenantId: auth.tenantId,
    });

    // ── Rollback partial project if one was created ───────────────────
    if (project?.id) {
      try {
        const { Project, ProjectAgent: ProjectAgentModel } =
          await import('@agent-platform/database/models');
        await Project.deleteOne({ _id: project.id, tenantId: auth.tenantId });
        await ProjectAgentModel.deleteMany({ projectId: project.id, tenantId: auth.tenantId });
        log.info('Rolled back partial project', { projectId: project.id });
      } catch (cleanupErr: unknown) {
        log.warn('Failed to cleanup partial project', {
          projectId: project.id,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      }
    }

    // Clear projectId from session if it was set
    try {
      await ArchSessionModel.updateOne(
        {
          _id: session.id,
          tenantId: auth.tenantId,
          userId: auth.id,
          schemaVersion: SCHEMA_VERSION_V2,
        },
        { $unset: { 'metadata.projectId': '' } },
      );
    } catch (sessionCleanupErr: unknown) {
      log.warn('Failed to clear rolled-back project from session metadata', {
        sessionId: session.id,
        error:
          sessionCleanupErr instanceof Error
            ? sessionCleanupErr.message
            : String(sessionCleanupErr),
      });
    }

    // Emit error events
    events.push({
      ...makeEnvelope(session.id, turnId, seq++),
      type: 'error',
      error: {
        code: 'CREATE_FAILED',
        message: 'Project creation failed. Please try again.',
        retryable: true,
      },
    });

    events.push({
      ...makeEnvelope(session.id, turnId, seq++),
      type: 'turn_ended',
      reason: 'error',
    });
  } finally {
    // Release the turn lock
    await releaseTurnLock(redis, session.id, workerId).catch((releaseErr: unknown) => {
      log.warn('Failed to release turn lock after project creation', {
        sessionId: session.id,
        workerId,
        error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    });

    // Publish events via fan-out for multi-tab subscribers
    for (const event of events) {
      await publishTurnEvent(redis, session.id, event).catch((pubErr: unknown) => {
        log.warn('Failed to publish create event via fan-out', {
          sessionId: session.id,
          eventType: event.type,
          error: pubErr instanceof Error ? pubErr.message : String(pubErr),
        });
      });
    }
  }

  // Stream events as SSE
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ─── Interactive response handler (I1, I8) ──────────────────────────────

async function handleInteractiveResponse(
  request: NextRequest,
  auth: { tenantId: string; id: string },
  session: ArchSessionV2,
  msg: MessageRequest,
): Promise<Response> {
  // ── tool_answer: always synthesize as user input ─────────────────────
  if (msg.type === 'tool_answer') {
    const answer = msg.answer;
    const userInput = typeof answer === 'string' ? answer : JSON.stringify(answer ?? '');
    return acquireLockAndStreamTurn(request, auth, session, userInput);
  }

  // ── gate_response: dispatch by gate type (I1) ───────────────────────
  if (msg.type === 'gate_response') {
    return handleGateResponse(request, auth, session, msg);
  }

  // ── proposal_response: apply / dismiss / modify (I8) ────────────────
  if (msg.type === 'proposal_response') {
    return handleProposalResponse(request, auth, session, msg);
  }

  return Response.json(
    {
      success: false,
      error: {
        code: 'INTERACTIVE_RESPONSE_UNKNOWN_TYPE',
        message: `Unhandled interactive response type: ${msg.type}`,
      },
    },
    { status: 501 },
  );
}

// ─── Gate response handler (I1) ─────────────────────────────────────────

async function handleGateResponse(
  request: NextRequest,
  auth: { tenantId: string; id: string },
  session: ArchSessionV2,
  msg: MessageRequest & { type: 'gate_response' },
): Promise<Response> {
  const action = msg.action ?? 'accept';
  const feedback = msg.feedback ?? '';
  const pending = session.pendingInteractive as PendingInteractiveV2 | undefined;
  const gatePayload = pending?.payload as Record<string, unknown> | undefined;
  const gateType = gatePayload?.gateType as string | undefined;

  // For 'modify' — always fall through to LLM with the feedback as user input.
  if (action === 'modify') {
    const userInput = feedback ? `[Gate response: modify] ${feedback}` : '[Gate response: modify]';

    // Clear the pending interactive state before the LLM turn.
    await ArchSessionModel.updateOne(
      {
        _id: session.id,
        tenantId: auth.tenantId,
        userId: auth.id,
        schemaVersion: SCHEMA_VERSION_V2,
      },
      { $set: { state: 'active', pendingInteractive: null } },
    );

    return acquireLockAndStreamTurn(request, auth, session, userInput);
  }

  // For 'accept' and 'reject' — handle per gate type deterministically.
  // These do NOT require an LLM call.
  const redis = getRedisClient();
  if (!redis) {
    return errorJson('Service temporarily unavailable', 503, 'REDIS_UNAVAILABLE');
  }

  const turnId = `turn_${uuidv7()}`;
  let seq = 0;
  const events: TurnEvent[] = [];

  if (gateType === 'topology_approval') {
    if (action === 'accept') {
      // Mark topology as approved in session metadata.
      await ArchSessionModel.updateOne(
        {
          _id: session.id,
          tenantId: auth.tenantId,
          userId: auth.id,
          schemaVersion: SCHEMA_VERSION_V2,
        },
        {
          $set: {
            state: 'idle',
            pendingInteractive: null,
            'metadata.topologyApproved': true,
          },
        },
      );

      // Emit topology artifact event.
      events.push({
        ...makeEnvelope(session.id, turnId, seq++),
        type: 'artifact_updated',
        update: {
          artifact: 'topology',
          payload: { approved: true },
        },
      });
    } else {
      // reject — clear topology and approval flag.
      await ArchSessionModel.updateOne(
        {
          _id: session.id,
          tenantId: auth.tenantId,
          userId: auth.id,
          schemaVersion: SCHEMA_VERSION_V2,
        },
        {
          $set: {
            state: 'idle',
            pendingInteractive: null,
            'metadata.topologyApproved': false,
            'metadata.topology': null,
          },
        },
      );

      events.push({
        ...makeEnvelope(session.id, turnId, seq++),
        type: 'artifact_updated',
        update: {
          artifact: 'topology',
          payload: { rejected: true },
        },
      });
    }
  } else if (gateType === 'agent_review') {
    const agentName = gatePayload?.agentName as string | undefined;

    if (action === 'accept' && agentName) {
      // Add agent to approved list.
      await ArchSessionModel.updateOne(
        {
          _id: session.id,
          tenantId: auth.tenantId,
          userId: auth.id,
          schemaVersion: SCHEMA_VERSION_V2,
        },
        {
          $set: { state: 'idle', pendingInteractive: null },
          $addToSet: { 'metadata.approvedAgents': agentName },
        },
      );

      // TODO: Full pickNextGate logic to auto-advance to next agent review.
      // For now, accept clears the gate and returns to idle.
    } else if (action === 'reject' && agentName) {
      // Remove agent file and unapprove.
      await ArchSessionModel.updateOne(
        {
          _id: session.id,
          tenantId: auth.tenantId,
          userId: auth.id,
          schemaVersion: SCHEMA_VERSION_V2,
        },
        {
          $set: { state: 'idle', pendingInteractive: null },
          $unset: { [`metadata.files.${agentName}`]: '' },
          $pull: { 'metadata.approvedAgents': agentName },
        } as unknown as Record<string, unknown>,
      );
    } else {
      // Fallback — clear gate, go idle.
      await ArchSessionModel.updateOne(
        {
          _id: session.id,
          tenantId: auth.tenantId,
          userId: auth.id,
          schemaVersion: SCHEMA_VERSION_V2,
        },
        { $set: { state: 'idle', pendingInteractive: null } },
      );
    }
  } else if (gateType === 'tool_generation') {
    // Accept or reject — clear the gate and return to idle.
    // TODO: Full tool generation dispatch (accept → generate selected tools,
    // reject → skip tool generation). For now, just clear the gate.
    await ArchSessionModel.updateOne(
      {
        _id: session.id,
        tenantId: auth.tenantId,
        userId: auth.id,
        schemaVersion: SCHEMA_VERSION_V2,
      },
      { $set: { state: 'idle', pendingInteractive: null } },
    );
  } else {
    // Unknown gate type — fall back to LLM turn with synthesized input.
    log.warn('gate_response for unknown gate type, falling back to LLM', {
      sessionId: session.id,
      gateType,
      action,
    });
    const userInput = feedback
      ? `[Gate response: ${action}] ${feedback}`
      : `[Gate response: ${action}]`;

    await ArchSessionModel.updateOne(
      {
        _id: session.id,
        tenantId: auth.tenantId,
        userId: auth.id,
        schemaVersion: SCHEMA_VERSION_V2,
      },
      { $set: { state: 'active', pendingInteractive: null } },
    );

    return acquireLockAndStreamTurn(request, auth, session, userInput);
  }

  // Emit turn_committed + turn_ended for deterministic gate responses.
  events.push({
    ...makeEnvelope(session.id, turnId, seq++),
    type: 'turn_committed',
    phase: session.phase,
  });
  events.push({
    ...makeEnvelope(session.id, turnId, seq++),
    type: 'turn_ended',
    reason: 'natural',
  });

  log.info('v2 gate_response handled', {
    sessionId: session.id,
    gateType,
    action,
    tenantId: auth.tenantId,
  });

  // Stream events as SSE.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ─── Proposal response handler (I8) ─────────────────────────────────────

async function handleProposalResponse(
  request: NextRequest,
  auth: { tenantId: string; id: string },
  session: ArchSessionV2,
  msg: MessageRequest & { type: 'proposal_response' },
): Promise<Response> {
  const action = msg.action ?? 'accept';
  const feedback = msg.feedback ?? '';

  // Load pending mutation from v2 top-level field or v1 metadata fallback.
  const pendingMutation =
    session.pendingMutation ??
    (session.metadata?.pendingMutation as ArchSessionV2['pendingMutation'] | undefined);

  if (action === 'modify') {
    // Clear pending mutation, feed feedback to LLM for revised proposal.
    await ArchSessionModel.updateOne(
      {
        _id: session.id,
        tenantId: auth.tenantId,
        userId: auth.id,
        schemaVersion: SCHEMA_VERSION_V2,
      },
      {
        $set: {
          state: 'active',
          pendingInteractive: null,
          pendingMutation: null,
          'metadata.pendingMutation': null,
        },
      },
    );

    const userInput = feedback
      ? `[Proposal response: modify] ${feedback}`
      : '[Proposal response: modify]';
    return acquireLockAndStreamTurn(request, auth, session, userInput);
  }

  if (!pendingMutation) {
    return errorJson('No pending proposal found in this session.', 400, 'NO_PENDING_PROPOSAL');
  }

  const targetAgent =
    pendingMutation.targetAgent ??
    ((pendingMutation as unknown as Record<string, unknown>).target as string | undefined);

  if (action === 'accept') {
    // TODO: Full mutation application (write updated code to ProjectAgent collection
    // via applyProjectAgentModification). For now, clear the mutation and emit the
    // applied artifact event. The actual write requires the v1 helper which lives
    // in apps/studio — will be wired in a follow-up batch.
    await ArchSessionModel.updateOne(
      {
        _id: session.id,
        tenantId: auth.tenantId,
        userId: auth.id,
        schemaVersion: SCHEMA_VERSION_V2,
      },
      {
        $set: {
          state: 'idle',
          pendingInteractive: null,
          pendingMutation: null,
          'metadata.pendingMutation': null,
        },
      },
    );

    log.info('v2 proposal_response accept', {
      sessionId: session.id,
      targetAgent,
      tenantId: auth.tenantId,
    });

    const turnId = `turn_${uuidv7()}`;
    let seq = 0;
    const events: TurnEvent[] = [];

    events.push({
      ...makeEnvelope(session.id, turnId, seq++),
      type: 'artifact_updated',
      update: {
        artifact: 'diff',
        diffId: pendingMutation.proposalId ?? `proposal_${uuidv7()}`,
        status: 'applied',
        payload: { targetAgent },
      },
    });
    events.push({
      ...makeEnvelope(session.id, turnId, seq++),
      type: 'turn_committed',
      phase: session.phase,
    });
    events.push({
      ...makeEnvelope(session.id, turnId, seq++),
      type: 'turn_ended',
      reason: 'natural',
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  if (action === 'reject') {
    // Dismiss — clear mutation and end turn.
    await ArchSessionModel.updateOne(
      {
        _id: session.id,
        tenantId: auth.tenantId,
        userId: auth.id,
        schemaVersion: SCHEMA_VERSION_V2,
      },
      {
        $set: {
          state: 'idle',
          pendingInteractive: null,
          pendingMutation: null,
          'metadata.pendingMutation': null,
        },
      },
    );

    log.info('v2 proposal_response reject (dismiss)', {
      sessionId: session.id,
      targetAgent,
      tenantId: auth.tenantId,
    });

    const turnId = `turn_${uuidv7()}`;
    let seq = 0;
    const events: TurnEvent[] = [];

    events.push({
      ...makeEnvelope(session.id, turnId, seq++),
      type: 'artifact_updated',
      update: {
        artifact: 'diff',
        diffId: pendingMutation.proposalId ?? `proposal_${uuidv7()}`,
        status: 'rejected',
        payload: { targetAgent },
      },
    });
    events.push({
      ...makeEnvelope(session.id, turnId, seq++),
      type: 'turn_committed',
      phase: session.phase,
    });
    events.push({
      ...makeEnvelope(session.id, turnId, seq++),
      type: 'turn_ended',
      reason: 'natural',
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  // Unexpected action — return error.
  return errorJson(`Unhandled proposal action: ${action}`, 400, 'INVALID_PROPOSAL_ACTION');
}

// ─── Shared lock+stream helper ──────────────────────────────────────────

async function acquireLockAndStreamTurn(
  request: NextRequest,
  auth: { tenantId: string; id: string },
  session: ArchSessionV2,
  userInput: string,
  fileRefs?: Array<{ blobId: string }>,
): Promise<Response> {
  const redis = getRedisClient();
  if (!redis) {
    return errorJson('Service temporarily unavailable', 503, 'REDIS_UNAVAILABLE');
  }

  const workerId = `worker_${uuidv7()}`;
  const lockResult = await acquireTurnLock(redis, session.id, workerId);

  if (!lockResult.acquired) {
    return Response.json(
      {
        success: false,
        error: {
          code: 'SESSION_BUSY',
          message:
            'A turn is already in progress. Your response will be processed after it completes.',
        },
      },
      { status: 409 },
    );
  }

  return streamTurn(
    request,
    auth,
    session,
    userInput,
    redis,
    workerId,
    lockResult.fencingToken,
    fileRefs,
  );
}

// ─── Queue path ─────────────────────────────────────────────────────────

async function handleQueuePath(
  request: NextRequest,
  auth: { tenantId: string; id: string },
  session: ArchSessionV2,
  msg: MessageRequest,
): Promise<Response> {
  const redis = getRedisClient();
  if (!redis) {
    log.error('Redis unavailable — cannot acquire turn lock', {
      sessionId: session.id,
      tenantId: auth.tenantId,
    });
    return errorJson('Service temporarily unavailable', 503, 'REDIS_UNAVAILABLE');
  }

  const workerId = `worker_${uuidv7()}`;
  const lockResult = await acquireTurnLock(redis, session.id, workerId);

  if (!lockResult.acquired) {
    // Turn already in progress — enqueue into session.queue[]
    const queueEntryId = `qe_${uuidv7()}`;
    const { sessionId: _sessionId, ...payloadWithoutSessionId } = msg;

    await ArchSessionModel.updateOne(
      {
        _id: session.id,
        tenantId: auth.tenantId,
        schemaVersion: SCHEMA_VERSION_V2,
      },
      {
        $push: {
          queue: {
            id: queueEntryId,
            payload: payloadWithoutSessionId,
            enqueuedAt: new Date(),
            enqueuedBy: auth.id,
          },
        },
      },
    );

    log.info('message enqueued', {
      sessionId: session.id,
      queueEntryId,
      tenantId: auth.tenantId,
      userId: auth.id,
      messageType: msg.type,
    });

    return Response.json({ success: true, queued: true, queueId: queueEntryId }, { status: 202 });
  }

  // Lock acquired — dispatch turn.
  // Only 'message' type has a text field; other queue-eligible types ('continue', 'create')
  // don't carry user text.
  const userInput = msg.type === 'message' ? msg.text : '';
  const fileRefs = msg.type === 'message' ? msg.fileRefs : undefined;
  return streamTurn(
    request,
    auth,
    session,
    userInput,
    redis,
    workerId,
    lockResult.fencingToken,
    fileRefs,
  );
}

// ─── Core stream turn ───────────────────────────────────────────────────

async function streamTurn(
  request: NextRequest,
  auth: { tenantId: string; id: string },
  session: ArchSessionV2,
  userInput: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redis: any,
  workerId: string,
  fencingToken: number,
  /** I2: Optional file references from the original message request. */
  fileRefs?: Array<{ blobId: string }>,
): Promise<Response> {
  // If anything fails before streaming starts, release the lock.
  try {
    // ── BUILD-phase parallel generation intercept (C5) ──────────────
    // Before entering the LLM engine, check if the session is in BUILD
    // phase with missing agents. If so, run the v1 parallel generation
    // pipeline and stream results as v2 TurnEvents. The LLM engine turn
    // is skipped — the build orchestrator handles everything.
    if (session.phase === 'BUILD' && session.mode === 'onboarding') {
      const buildResult = await maybeRunV2BuildOrchestration(
        session,
        auth,
        userInput,
        redis,
        workerId,
        request.signal,
      );
      if (buildResult) {
        return buildResult;
      }
      // No missing agents — fall through to normal LLM turn.
    }

    // Build engine + registry for this tenant.
    const { engine, toolRegistry } = await createProductionTurnEngine(auth.tenantId);

    // Build the turn buffer for atomic commit.
    const turnId = `turn_${uuidv7()}`;
    const buffer = new TurnBuffer({
      sessionId: session.id,
      tenantId: auth.tenantId,
      userId: auth.id,
      turnId,
      fencingToken,
      ArchSessions: ArchSessionModel as unknown as Model<unknown>,
    });

    // Build the turn plan (specialist, system prompt, allowed tools).
    // M5/M6/M7: Wire optional context loaders from Studio-side services.
    const ctx = { tenantId: auth.tenantId, userId: auth.id };
    const plan = await resolveTurnPlan({
      session: {
        _id: session.id,
        metadata: {
          phase: session.phase as ArchPhase,
          mode: session.mode,
          specification: session.metadata?.specification,
          projectId: session.projectId,
        },
      },
      userInput,
      registry: toolRegistry,

      // M5: Spec document loader
      specDocumentLoader: async (sessionId: string) => {
        const { specDocumentService } = await import('@/lib/arch-ai/message-services');
        const doc = await specDocumentService.getBySession(ctx, sessionId);
        return doc ? (doc as unknown as Record<string, unknown>) : null;
      },

      // M6: Journal decision loader — returns formatted bullet list
      journalDecisionLoader: async (sessionId: string) => {
        const { journalService } = await import('@/lib/arch-ai/message-services');
        const decisions = await journalService.getRecentDecisions(ctx, sessionId, 10);
        if (decisions.length === 0) return null;
        const bullets = decisions
          .map((d) => {
            const c = d.content as { summary?: string; rationale?: string };
            return `- [${d.phase}] ${c.summary ?? d.type}${c.rationale ? ` (${c.rationale})` : ''}`;
          })
          .join('\n');
        return `Key decisions so far:\n${bullets}`;
      },

      // M7: Learning memory loader
      learningMemoryLoader: async () => {
        const { ArchLearningMemory } = await import('@agent-platform/database/models');
        const learningService = new LearningMemoryService(ArchLearningMemory);
        const spec = session.metadata?.specification as { description?: string | null } | undefined;
        const learningContext: { domain?: string; phase?: string } = {
          phase: session.phase,
        };
        if (spec?.description) {
          learningContext.domain = spec.description;
        }
        const learnings = await learningService.getRelevantLearnings(learningContext);
        return learningService.formatLearningsForPrompt(learnings);
      },
    });

    // Map stored messages to LLM message format.
    const history = mapStoredMessagesToLlm(session.messages ?? []);

    // Create the abort signal from the request.
    const abortController = new AbortController();
    request.signal.addEventListener('abort', () => abortController.abort(), { once: true });

    // Build the per-turn service bag (buffered proxies for atomic commit).
    const serviceBag = buildServiceBagForTurn(buffer);

    // ── I2: Build content blocks when fileRefs are present ────────────
    let userContent: ArchContentBlock[] | undefined;
    if (fileRefs && fileRefs.length > 0) {
      const blocks: ArchContentBlock[] = [];
      if (userInput.trim().length > 0) {
        blocks.push({ type: 'text', text: userInput });
      }
      // Resolve file metadata from the file store service.
      try {
        const { fileStoreService } = await import('@/lib/arch-ai/message-services');
        for (const ref of fileRefs) {
          try {
            const file = await fileStoreService.getByBlobId(ctx, session.id, ref.blobId);
            const isImage = file.mediaType.startsWith('image/');
            blocks.push(
              isImage
                ? {
                    type: 'image_ref',
                    blobId: ref.blobId,
                    name: file.name,
                    mediaType: file.mediaType,
                    width: file.metadata.width ?? 0,
                    height: file.metadata.height ?? 0,
                    tokenCost: file.metadata.tokenEstimate,
                  }
                : {
                    type: 'file_ref',
                    blobId: ref.blobId,
                    name: file.name,
                    mediaType: file.mediaType,
                    tokenCost: file.metadata.tokenEstimate,
                  },
            );
          } catch (fileErr: unknown) {
            log.warn('v2 streamTurn: failed to resolve fileRef for persistence', {
              blobId: ref.blobId,
              sessionId: session.id,
              error: fileErr instanceof Error ? fileErr.message : String(fileErr),
            });
          }
        }
        if (blocks.length > 0) {
          userContent = blocks;
        }
      } catch (importErr: unknown) {
        log.warn('v2 streamTurn: failed to import fileStoreService for attachment resolution', {
          sessionId: session.id,
          error: importErr instanceof Error ? importErr.message : String(importErr),
        });
      }
    }

    // Run the engine turn. The service bag is injected via RunTurnInput.services
    // so the engine can attach it to TurnContext.services for internal tools.
    const turnIter = engine.runTurn({
      sessionId: session.id,
      tenantId: auth.tenantId,
      userId: auth.id,
      turnId,
      phase: session.phase,
      mode: session.mode,
      projectId: session.projectId,
      history,
      systemPrompt: plan.systemPrompt,
      userInput,
      userContent,
      allowedTools: toolRegistry,
      buffer,
      signal: abortController.signal,
      specialist: plan.specialist,
      routing: plan.routing,
      services: serviceBag as unknown as Record<string, unknown>,
    });

    // Stream cleanup: release the turn lock.
    const cleanup = async () => {
      try {
        await releaseTurnLock(redis, session.id, workerId);
      } catch (releaseErr: unknown) {
        log.warn('Failed to release turn lock after stream', {
          sessionId: session.id,
          workerId,
          error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        });
      }
    };

    return createTurnSSEResponse(turnIter, cleanup, abortController.signal);
  } catch (err: unknown) {
    // Release lock on setup failure.
    try {
      await releaseTurnLock(redis, session.id, workerId);
    } catch (releaseErr: unknown) {
      log.warn('Failed to release turn lock after setup failure', {
        sessionId: session.id,
        workerId,
        error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    }

    const message = err instanceof Error ? err.message : String(err);
    log.error('v2 streamTurn setup failed', {
      sessionId: session.id,
      tenantId: auth.tenantId,
      error: message,
    });
    const isModelConfigError = (err as { code?: string } | null)?.code === 'MODEL_CONFIG_ERROR';
    const userMessage = isModelConfigError ? message : 'Failed to initialize turn engine.';
    const errorCode = isModelConfigError ? 'MODEL_CONFIG_ERROR' : 'ENGINE_INIT_FAILED';
    return errorJson(userMessage, isModelConfigError ? 422 : 500, errorCode);
  }
}

// ─── BUILD phase parallel generation (C5) ──────────────────────────────

/**
 * Compute which agents from the topology are not yet generated.
 * Returns an empty array if all agents are present (or no topology exists).
 */
function computeMissingAgents(session: ArchSessionV2): string[] {
  const topology = session.metadata?.topology as { agents?: Array<{ name: string }> } | undefined;
  const topologyAgents = topology?.agents ?? [];
  if (topologyAgents.length === 0) return [];

  const files = (session.metadata?.files ?? {}) as Record<string, unknown>;
  const generatedNames = new Set(Object.keys(files));

  return topologyAgents.map((a) => a.name).filter((name) => !generatedNames.has(name));
}

/**
 * If the session is in BUILD phase with missing agents, run the v1 parallel
 * generation pipeline and stream the results as v2 TurnEvents.
 *
 * Returns a Response if the build was executed (caller should return it),
 * or null if no build was needed (caller should fall through to LLM turn).
 */
async function maybeRunV2BuildOrchestration(
  session: ArchSessionV2,
  auth: { tenantId: string; id: string },
  _userInput: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redis: any,
  workerId: string,
  requestSignal: AbortSignal,
): Promise<Response | null> {
  const missingAgents = computeMissingAgents(session);
  if (missingAgents.length === 0) return null;

  log.info('v2 BUILD orchestration: missing agents detected, running parallel generation', {
    sessionId: session.id,
    missingCount: missingAgents.length,
    missingAgents,
    tenantId: auth.tenantId,
  });

  const turnId = `turn_${uuidv7()}`;
  const encoder = new TextEncoder();
  const ctx = { tenantId: auth.tenantId, userId: auth.id };

  // Resolve the LLM model for generation (same resolution as v1).
  const { resolveArchVercelModel } = await import('@/lib/arch-llm');
  const resolution = await resolveArchVercelModel(auth.tenantId);
  if (!resolution.model) {
    log.warn('v2 BUILD orchestration: LLM unavailable', {
      sessionId: session.id,
      error: resolution.error,
    });
    return errorJson(
      resolution.error ?? 'No LLM configured for build generation.',
      503,
      'LLM_UNAVAILABLE',
    );
  }

  // Bridge v2 session to v1 ArchSession shape for runParallelGeneration.
  const v1Session = bridgeToV1Session(session);

  // Create the v1→v2 emit adapter. Events are collected into an array
  // and streamed as SSE frames.
  const collectedEvents: Array<{ data: string }> = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

  const pushEvent = (event: TurnEvent) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    if (streamController) {
      try {
        streamController.enqueue(encoder.encode(frame));
      } catch {
        // Controller may be closed; collect for later.
        collectedEvents.push({ data: frame });
      }
    } else {
      collectedEvents.push({ data: frame });
    }

    // Also publish to fan-out for multi-tab subscribers.
    publishTurnEvent(redis, session.id, event).catch((err: unknown) => {
      log.warn('v2 BUILD fan-out publish failed (non-fatal)', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const v1Emit = createV1ToV2EmitAdapter({
    sessionId: session.id,
    turnId,
    publishLive: pushEvent,
    publishDurable: pushEvent,
  });

  // Create the SSE response stream.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;

      // Emit turn_started before kicking off the build.
      const startEvent: TurnEvent = {
        ...makeEnvelope(session.id, turnId, 0),
        type: 'turn_started',
        specialist: 'build_orchestrator',
        userMessageId: `build_${uuidv7()}`,
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(startEvent)}\n\n`));
      publishTurnEvent(redis, session.id, startEvent).catch((err: unknown) => {
        log.warn('v2 BUILD fan-out start publish failed (non-fatal)', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      // Flush any events collected before controller was set.
      for (const ev of collectedEvents) {
        controller.enqueue(encoder.encode(ev.data));
      }
      collectedEvents.length = 0;

      // Run the build in the background — the stream stays open.
      runBuildAndClose(controller);
    },
  });

  async function runBuildAndClose(controller: ReadableStreamDefaultController<Uint8Array>) {
    try {
      const { runParallelGeneration } = await import('@/lib/arch-ai/build-parallel-gen');
      const { buildCompletionSummary, buildCompletionWidgetPayload } =
        await import('@/lib/arch-ai/build-completion');

      const buildRunId = crypto.randomUUID().slice(0, 12);
      const results = await runParallelGeneration(
        missingAgents,
        ctx,
        v1Session,
        v1Emit,
        resolution.model!,
        requestSignal,
        { buildRunId, trigger: 'v2_build_orchestration' },
      );

      log.info('v2 BUILD orchestration completed', {
        sessionId: session.id,
        buildRunId,
        total: results.length,
        compiled: results.filter((r) => r.status === 'compiled').length,
        warnings: results.filter((r) => r.status === 'warning').length,
        errors: results.filter((r) => r.status === 'error').length,
      });

      // Emit completion summary as text delta.
      const summary = buildCompletionSummary(results);
      v1Emit({ type: 'text_delta', delta: summary + '\n\n' } as ArchSSEEvent);

      // Emit BuildComplete widget via the adapter.
      const widgetPayload = buildCompletionWidgetPayload(
        results,
        (session.metadata?.specification as Record<string, unknown> | undefined)?.projectName as
          | string
          | undefined,
      );
      const toolCallId = `build-complete-${crypto.randomUUID().slice(0, 8)}`;
      v1Emit({
        type: 'tool_call',
        toolCallId,
        toolName: 'ask_user',
        input: widgetPayload as unknown as Record<string, unknown>,
      } as ArchSSEEvent);

      // Persist the assistant message and pending interaction.
      await ArchSessionModel.updateOne(
        {
          _id: session.id,
          tenantId: auth.tenantId,
          userId: auth.id,
          schemaVersion: SCHEMA_VERSION_V2,
        },
        {
          $set: {
            state: 'idle',
            pendingInteractive: {
              kind: 'tool',
              toolCallId,
              tool: 'ask_user',
              payload: widgetPayload,
              createdAt: new Date(),
            },
          },
          $push: {
            messages: {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: summary,
              timestamp: Date.now(),
              specialist: 'build_orchestrator',
              toolCalls: [{ toolCallId, toolName: 'ask_user', input: widgetPayload }],
            },
          },
        },
      );

      // Emit turn_ended.
      v1Emit({ type: 'done' } as ArchSSEEvent);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('v2 BUILD orchestration failed', {
        sessionId: session.id,
        error: msg,
      });

      // Emit error event.
      const errEvent: TurnEvent = {
        ...makeEnvelope(session.id, turnId, 999),
        type: 'error',
        error: {
          code: 'BUILD_ORCHESTRATION_FAILED',
          message: 'Build generation encountered an error. Please try again.',
          retryable: true,
        },
      };
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errEvent)}\n\n`));
      } catch {
        // Stream may already be closed.
      }
    } finally {
      // Release the turn lock.
      try {
        await releaseTurnLock(redis, session.id, workerId);
      } catch (releaseErr: unknown) {
        log.warn('Failed to release turn lock after v2 BUILD', {
          sessionId: session.id,
          workerId,
          error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        });
      }

      try {
        controller.close();
      } catch {
        // Already closed; ignore.
      }
    }
  }

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
