import { createLogger } from '@abl/compiler/platform';
import { ArchSessionModel } from './models/index.js';
import { SessionService } from './session/index.js';
import {
  CompleteSpecificationSchema,
  createDefaultSpecification,
  type Specification,
} from './types/specification.js';
import type { ArchSession, ArchSSEEvent, MessageRequest } from './types/index.js';
import type { TopologyOutput, TopologyAgent } from './types/blueprint.js';
import { classifyTopologyPattern, synthesizePatternTopology } from './coordinator/index.js';
import { decideNextEvent, MAX_DISPATCH_ITERATIONS, type DispatchResult } from './dispatcher.js';
import { processMessage } from './processors/process-message.js';

const log = createLogger('arch-ai:system-agent-driver');

export interface ArchSystemAgentDriverContext {
  tenantId: string;
  userId: string;
  permissions?: string[];
  projectId: string;
}

export interface ArchSystemAgentSpecInput {
  projectName: string;
  description: string;
  channels?: string[];
  language?: string;
}

export type ArchSystemAgentTraceEvent = {
  type: string;
  data: Record<string, unknown>;
};

export interface ArchSystemAgentDriverOptions {
  correlationId?: string;
  onTraceEvent?: (event: ArchSystemAgentTraceEvent) => void;
  emit?: (event: ArchSSEEvent) => void;
  sessionService?: SessionService;
}

export type ArchSystemAgentDriverOutcome =
  | {
      success: true;
      data: {
        projectId: string;
        agents: TopologyAgent[];
        topology: TopologyOutput;
      };
      correlationId: string;
      sessionId: string;
      iterations: number;
      events: ArchSSEEvent[];
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
      correlationId: string;
      sessionId?: string;
      retryable?: boolean;
    };

const defaultSessionService = new SessionService(ArchSessionModel);
const MAX_REPEATED_DISPATCH_EVENTS = 5;

function buildSpecification(spec: ArchSystemAgentSpecInput): Specification {
  return {
    ...createDefaultSpecification(),
    version: 1,
    projectName: spec.projectName,
    description: spec.description,
    channels: spec.channels ?? [],
    language: spec.language ?? 'English',
    uploadedFiles: [],
    conversationNotes: [],
  };
}

function buildSpecText(spec: ArchSystemAgentSpecInput): string {
  const parts = [`Project: ${spec.projectName}`, `Description: ${spec.description}`];
  if (spec.channels?.length) {
    parts.push(`Channels: ${spec.channels.join(', ')}`);
  }
  if (spec.language) {
    parts.push(`Language: ${spec.language}`);
  }
  return parts.join('\n\n');
}

async function persistTopology(params: {
  ctx: ArchSystemAgentDriverContext;
  session: ArchSession;
  topology: TopologyOutput;
  pattern: string;
  reasoning: string;
}): Promise<void> {
  const { ctx, session, topology, pattern, reasoning } = params;
  await ArchSessionModel.updateOne(
    {
      _id: session.id,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      'metadata.projectId': ctx.projectId,
      state: { $ne: 'ARCHIVED' },
    },
    {
      $set: {
        'metadata.phase': 'BLUEPRINT',
        'metadata.topology': topology,
        'metadata.draftTopology': topology,
        'metadata.lockedTopology': topology,
        'metadata.topologyApproved': true,
        'metadata.blueprintStage': 'topology_locked',
        'metadata.blueprintContextSummary': reasoning,
        'metadata.systemAgentInvocation': {
          source: 'runtime',
          pattern,
          updatedAt: new Date().toISOString(),
        },
      },
    },
  );
}

function isProcessMessageRequest(event: DispatchResult): event is MessageRequest {
  return event.type !== 'done' && event.type !== 'error';
}

async function prepareFreshOnboardingSession(params: {
  ctx: ArchSystemAgentDriverContext;
  sessionService: SessionService;
  validation: Specification;
  topology: TopologyOutput;
  pattern: string;
  reasoning: string;
  specText: string;
}): Promise<ArchSession> {
  const { ctx, sessionService, validation, topology, pattern, reasoning, specText } = params;
  const sessionCtx = { tenantId: ctx.tenantId, userId: ctx.userId };

  const existing = await sessionService.getCurrent(sessionCtx, 'ONBOARDING');
  if (existing) {
    await sessionService.archive(sessionCtx, existing.id);
  }

  const session = await sessionService.create(sessionCtx);
  await sessionService.updateSpecification(sessionCtx, session.id, validation);
  await sessionService.updatePhase(sessionCtx, session.id, 'BLUEPRINT');
  await ArchSessionModel.updateOne(
    {
      _id: session.id,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      state: { $ne: 'ARCHIVED' },
    },
    {
      $set: {
        'metadata.projectId': ctx.projectId,
        'metadata.systemAgentInvocation.specText': specText,
      },
    },
  );

  const blueprintSession = (await sessionService.getById(sessionCtx, session.id)) ?? session;
  await persistTopology({
    ctx,
    session: blueprintSession,
    topology,
    pattern,
    reasoning,
  });

  return (await sessionService.getById(sessionCtx, session.id)) ?? session;
}

async function resumeForSyntheticEvent(params: {
  ctx: { tenantId: string; userId: string };
  session: ArchSession;
  sessionService: SessionService;
  event: MessageRequest;
}): Promise<ArchSession> {
  const { ctx, session, sessionService, event } = params;
  if (event.type === 'tool_answer' || event.type === 'gate_response') {
    const resumed = await sessionService.resumeFromInteractiveTool(ctx, session.id);
    if (resumed) {
      return resumed;
    }
  }

  if (
    session.state === 'IDLE' &&
    (event.type === 'message' ||
      event.type === 'continue' ||
      event.type === 'create' ||
      event.type === 'tool_answer' ||
      event.type === 'gate_response' ||
      event.type === 'proposal_response')
  ) {
    try {
      return await sessionService.transitionState(ctx, session.id, 'IDLE', 'ACTIVE');
    } catch {
      return (await sessionService.getById(ctx, session.id)) ?? session;
    }
  }

  return session;
}

function describeDispatchEvent(event: DispatchResult): string {
  if (event.type === 'tool_answer') {
    return `tool_answer:${event.toolCallId}`;
  }
  if (event.type === 'gate_response' || event.type === 'proposal_response') {
    return `${event.type}:${event.action}`;
  }
  if (event.type === 'error') {
    return `error:${event.reason}`;
  }
  return event.type;
}

/**
 * Drive the Arch system agent in-process for runtime delegate calls.
 *
 * This uses the same Arch Mongo session contract as Studio's multi-turn
 * surfaces: sessions are scoped by tenant + user + project, and `getOrCreate`
 * resumes an existing non-terminal Arch session before creating a replacement.
 */
export async function runArchSystemAgentInProcess(
  ctx: ArchSystemAgentDriverContext,
  spec: ArchSystemAgentSpecInput,
  options: ArchSystemAgentDriverOptions = {},
): Promise<ArchSystemAgentDriverOutcome> {
  const correlationId = options.correlationId ?? crypto.randomUUID();
  const sessionService = options.sessionService ?? defaultSessionService;
  const events: ArchSSEEvent[] = [];
  const emit = (event: ArchSSEEvent) => {
    events.push(event);
    options.emit?.(event);
    options.onTraceEvent?.({
      type: 'arch_ai_progress',
      data: {
        correlationId,
        sessionId: typeof event === 'object' ? (event as { sessionId?: string }).sessionId : null,
        eventType: (event as { type?: string }).type,
        event,
      },
    });
  };

  const validation = CompleteSpecificationSchema.safeParse(buildSpecification(spec));
  if (!validation.success) {
    return {
      success: false,
      error: { code: 'INCOMPLETE_SPEC', message: 'Specification validation failed' },
      correlationId,
    };
  }

  const sessionCtx = { tenantId: ctx.tenantId, userId: ctx.userId };

  try {
    const specText = buildSpecText(spec);
    const classification = classifyTopologyPattern(validation.data);
    const topology = synthesizePatternTopology(validation.data, classification.pattern);
    const session = await prepareFreshOnboardingSession({
      ctx,
      sessionService,
      validation: validation.data,
      topology,
      pattern: classification.pattern,
      reasoning: classification.reasoning,
      specText,
    });
    const abortController = new AbortController();
    let iterations = 0;
    let previousDispatchDescription: string | null = null;
    let repeatedDispatchCount = 0;

    options.onTraceEvent?.({
      type: 'arch_ai_session',
      data: {
        correlationId,
        sessionId: session.id,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        phase: session.metadata.phase,
        state: session.state,
        resumed: false,
      },
    });

    emit({
      type: 'activity',
      label: 'Generated project topology',
      detail: classification.reasoning,
    } as ArchSSEEvent);

    const { createSystemAgentProcessMessageDeps } = await import('./system-agent-process-deps.js');
    const deps = createSystemAgentProcessMessageDeps(ctx.projectId);

    for (; iterations < MAX_DISPATCH_ITERATIONS; iterations += 1) {
      const currentSession = (await sessionService.getById(sessionCtx, session.id)) ?? session;
      const nextEvent = decideNextEvent(currentSession, specText);
      const dispatchDescription = describeDispatchEvent(nextEvent);

      if (dispatchDescription === previousDispatchDescription) {
        repeatedDispatchCount += 1;
      } else {
        previousDispatchDescription = dispatchDescription;
        repeatedDispatchCount = 1;
      }

      options.onTraceEvent?.({
        type: 'arch_ai_dispatch',
        data: {
          correlationId,
          sessionId: session.id,
          dispatchType: nextEvent.type,
          dispatchDescription,
          phase: currentSession.metadata.phase,
          state: currentSession.state,
          iteration: iterations + 1,
        },
      });

      if (nextEvent.type === 'done') {
        const finalSession =
          (await sessionService.getById(sessionCtx, session.id)) ?? currentSession;
        log.info('arch_system_agent.completed', {
          correlationId,
          sessionId: session.id,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          phase: finalSession.metadata.phase,
          state: finalSession.state,
          agentCount: topology.agents.length,
          edgeCount: topology.edges.length,
          iterations,
        });

        return {
          success: true,
          data: {
            projectId: ctx.projectId,
            agents: topology.agents,
            topology,
          },
          correlationId,
          sessionId: session.id,
          iterations,
          events,
        };
      }

      if (nextEvent.type === 'error') {
        await sessionService.archive(sessionCtx, session.id).catch((archiveErr: unknown) => {
          log.warn('arch_system_agent.archive_after_dispatch_error_failed', {
            correlationId,
            sessionId: session.id,
            error: archiveErr instanceof Error ? archiveErr.message : String(archiveErr),
          });
        });
        return {
          success: false,
          error: { code: 'PIPELINE_ERROR', message: nextEvent.reason },
          correlationId,
          sessionId: session.id,
          retryable: true,
        };
      }

      if (repeatedDispatchCount > MAX_REPEATED_DISPATCH_EVENTS) {
        await sessionService.archive(sessionCtx, session.id).catch((archiveErr: unknown) => {
          log.warn('arch_system_agent.archive_after_repeated_dispatch_failed', {
            correlationId,
            sessionId: session.id,
            dispatchDescription,
            error: archiveErr instanceof Error ? archiveErr.message : String(archiveErr),
          });
        });
        return {
          success: false,
          error: {
            code: 'PIPELINE_LOOP',
            message: `Arch system agent repeated ${dispatchDescription} too many times`,
          },
          correlationId,
          sessionId: session.id,
          retryable: true,
        };
      }

      if (!isProcessMessageRequest(nextEvent)) {
        continue;
      }

      const eventSession = await resumeForSyntheticEvent({
        ctx: sessionCtx,
        session: currentSession,
        sessionService,
        event: nextEvent,
      });

      await processMessage(
        ctx,
        eventSession,
        nextEvent,
        emit,
        () => undefined,
        abortController.signal,
        undefined,
        undefined,
        undefined,
        deps,
      );

      const postTurnSession = await sessionService.getById(sessionCtx, session.id);
      if (
        postTurnSession?.state === 'ACTIVE' &&
        postTurnSession.metadata.pendingInteraction == null
      ) {
        await sessionService
          .transitionState(sessionCtx, session.id, 'ACTIVE', 'IDLE')
          .catch((transitionErr: unknown) => {
            log.warn('arch_system_agent.active_to_idle_failed', {
              correlationId,
              sessionId: session.id,
              error: transitionErr instanceof Error ? transitionErr.message : String(transitionErr),
            });
          });
      }
    }

    await sessionService.archive(sessionCtx, session.id).catch((archiveErr: unknown) => {
      log.warn('arch_system_agent.archive_after_iteration_limit_failed', {
        correlationId,
        sessionId: session.id,
        error: archiveErr instanceof Error ? archiveErr.message : String(archiveErr),
      });
    });
    return {
      success: false,
      error: {
        code: 'PIPELINE_TIMEOUT',
        message: `Arch system agent exceeded ${MAX_DISPATCH_ITERATIONS} iterations`,
      },
      correlationId,
      sessionId: session.id,
      retryable: true,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('arch_system_agent.failed', {
      correlationId,
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      error: message,
    });
    return {
      success: false,
      error: { code: 'PIPELINE_ERROR', message: 'Arch system agent failed' },
      correlationId,
      retryable: true,
    };
  }
}
