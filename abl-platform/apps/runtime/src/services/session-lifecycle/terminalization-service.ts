import crypto from 'crypto';
import { createLogger } from '@abl/compiler/platform';
import type {
  CanonicalSessionDisposition,
  CanonicalSessionStatus,
  Channel,
  SessionEndHookConfig,
  SessionTerminalSource,
} from '@abl/compiler/platform/core/types';
import type { ResolvedSessionLifecyclePolicy } from './policy-service.js';
import type { EventBus, PlatformEvent, SessionEndedPayload } from '../event-bus/types.js';
import { getRuntimeEventBus } from '../event-bus/runtime-bus-accessor.js';
import { getRuntimeExecutor } from '../runtime-executor.js';
import { getTraceStore } from '../trace-store.js';
import {
  findSessionById,
  findSessionByRuntimeId,
  updateSession,
} from '../../repos/session-repo.js';
import { normalizeTerminalDisposition, SessionDispositionService } from './disposition-service.js';
import { SessionEndHookRunner, type SessionEndHookRunInput } from './end-hook-runner.js';
import { SessionRuntimePolicyService } from './runtime-policy-service.js';

const log = createLogger('session-terminalization-service');

const TERMINAL_SESSION_STATUSES = new Set([
  'ended',
  'completed',
  'escalated',
  'abandoned',
  'archived',
]);
const LIFECYCLE_CHANNELS = new Set<Channel>([
  'voice',
  'web_chat',
  'web_debug',
  'whatsapp',
  'sms',
  'email',
  'api',
  'http_async',
]);
const DEFAULT_END_HOOK_CONFIG: SessionEndHookConfig = { mode: 'ignore' };
const runtimePolicyService = new SessionRuntimePolicyService();
const endHookRunner = new SessionEndHookRunner();

interface RuntimeThreadLike {
  agentName?: string;
}

interface RuntimeSessionLike {
  id: string;
  tenantId?: string;
  projectId?: string;
  agentName?: string;
  channelType?: string;
  turnCount?: number;
  createdAt?: Date;
  threads?: RuntimeThreadLike[];
}

interface RuntimeExecutorLike {
  getSession(sessionId: string): RuntimeSessionLike | undefined;
  endSession(sessionId: string): void;
}

interface TraceStoreLike {
  finalizeSession?(sessionId: string): void | Promise<void>;
  removeSession(sessionId: string): void;
}

export interface StoredSessionTerminalizationRecord {
  id: string;
  tenantId?: string;
  projectId?: string;
  currentAgent?: string;
  channel?: string | null;
  status?: string;
  disposition?: string | null;
  startedAt?: Date | null;
  lastActivityAt?: Date | null;
  endedAt?: Date | null;
  messageCount?: number | null;
  runtimeSessionId?: string | null;
}

export interface TerminateConversationSessionInput {
  tenantId: string;
  projectId: string;
  sessionId: string;
  agentName?: string;
  channel?: string;
  disposition: CanonicalSessionDisposition;
  source: SessionTerminalSource;
  explicitOverrides?: Partial<ResolvedSessionLifecyclePolicy>;
  transferMetadata?: {
    reason?: string;
    metadata?: Record<string, unknown>;
    dispositionCode?: string;
    wrapUpNotes?: string;
  };
  hook?: {
    sendResponse?: (message: string) => Promise<void>;
  };
}

export interface TerminateConversationSessionResult {
  sessionId: string;
  disposition: CanonicalSessionDisposition;
  status: CanonicalSessionStatus;
  endedAt: string;
  eventEmitted: boolean;
  eventId?: string;
  hook: {
    attempted: boolean;
    mode?: 'ignore' | 'respond';
    outcome?: 'ignored' | 'sent' | 'skipped' | 'failed';
    error?: string;
  };
  runtimeEnded: boolean;
  dbUpdated: boolean;
  artifactSessionIds: string[];
}

interface SessionTerminalizationServiceDeps {
  getRuntimeExecutor?: () => RuntimeExecutorLike;
  getTraceStore?: () => TraceStoreLike;
  findSessionById?: (
    sessionId: string,
    tenantId: string,
  ) => Promise<StoredSessionTerminalizationRecord | null>;
  findSessionByRuntimeId?: (
    runtimeSessionId: string,
    tenantId: string,
  ) => Promise<StoredSessionTerminalizationRecord | null>;
  updateSession?: (
    id: string,
    data: Record<string, unknown>,
    tenantId: string,
  ) => Promise<StoredSessionTerminalizationRecord | null>;
  getEventBus?: () => EventBus | null;
  releaseSessionSlot?: (tenantId: string, sessionId: string) => Promise<void>;
  resolveEndHook?: (input: { tenantId: string; projectId: string; channel?: Channel }) => Promise<{
    config?: SessionEndHookConfig;
    source?: string;
  }>;
  runEndHook?: (
    input: SessionEndHookRunInput,
  ) => Promise<TerminateConversationSessionResult['hook']>;
  createEventId?: () => string;
  now?: () => Date;
}

async function releaseSessionSlotDefault(tenantId: string, sessionId: string): Promise<void> {
  const { releaseSessionSlot } = await import('../../middleware/rate-limiter.js');
  await releaseSessionSlot(tenantId, sessionId);
}

function resolveStoredRuntimeSessionId(
  session: StoredSessionTerminalizationRecord,
  fallbackId: string,
): string {
  if (typeof session.runtimeSessionId === 'string' && session.runtimeSessionId.trim().length > 0) {
    return session.runtimeSessionId;
  }

  if (typeof session.id === 'string' && session.id.trim().length > 0) {
    return session.id;
  }

  return fallbackId;
}

function uniqueAgentsUsed(
  storedSession: StoredSessionTerminalizationRecord | null,
  runtimeSession: RuntimeSessionLike | undefined,
  fallbackAgentName?: string,
): string[] {
  const agents = new Set<string>();

  if (runtimeSession?.threads) {
    for (const thread of runtimeSession.threads) {
      if (typeof thread.agentName === 'string' && thread.agentName.length > 0) {
        agents.add(thread.agentName);
      }
    }
  }

  if (typeof storedSession?.currentAgent === 'string' && storedSession.currentAgent.length > 0) {
    agents.add(storedSession.currentAgent);
  }

  if (typeof runtimeSession?.agentName === 'string' && runtimeSession.agentName.length > 0) {
    agents.add(runtimeSession.agentName);
  }

  if (typeof fallbackAgentName === 'string' && fallbackAgentName.length > 0) {
    agents.add(fallbackAgentName);
  }

  return Array.from(agents);
}

function normalizeLifecycleChannel(channel?: string): Channel | undefined {
  if (!channel || !LIFECYCLE_CHANNELS.has(channel as Channel)) {
    return undefined;
  }

  return channel as Channel;
}

function resolveStoredTerminalOutcome(
  session: StoredSessionTerminalizationRecord,
  fallback: {
    disposition: CanonicalSessionDisposition;
    status: CanonicalSessionStatus;
  },
): {
  disposition: CanonicalSessionDisposition;
  status: CanonicalSessionStatus;
} {
  const normalizedDisposition = normalizeTerminalDisposition(session.disposition);
  if (normalizedDisposition) {
    return normalizedDisposition;
  }

  if (session.status === 'completed') {
    return {
      disposition: 'completed',
      status: 'completed',
    };
  }

  if (session.status === 'escalated') {
    return {
      disposition: 'transferred',
      status: 'escalated',
    };
  }

  if (session.status === 'abandoned') {
    return {
      disposition: 'abandoned',
      status: 'abandoned',
    };
  }

  return fallback;
}

export function buildTransferEndMetadata(params: {
  disposition: CanonicalSessionDisposition;
  endedAt: Date;
  source: SessionTerminalSource;
  transferMetadata?: TerminateConversationSessionInput['transferMetadata'];
}): Record<string, unknown> {
  const details = params.transferMetadata?.metadata;
  const transferEnd: Record<string, unknown> = {
    source: params.source,
    disposition: params.disposition,
    endedAt: params.endedAt.toISOString(),
  };

  if (typeof params.transferMetadata?.reason === 'string') {
    transferEnd.reason = params.transferMetadata.reason;
  }

  if (typeof params.transferMetadata?.dispositionCode === 'string') {
    transferEnd.dispositionCode = params.transferMetadata.dispositionCode;
  }

  if (typeof params.transferMetadata?.wrapUpNotes === 'string') {
    transferEnd.wrapUpNotes = params.transferMetadata.wrapUpNotes;
  }

  if (details && Object.keys(details).length > 0) {
    transferEnd.details = details;
  }

  return transferEnd;
}

function buildSessionEndedPayload(params: {
  disposition: CanonicalSessionDisposition;
  status: CanonicalSessionStatus;
  source: SessionTerminalSource;
  endedAt: Date;
  storedSession: StoredSessionTerminalizationRecord | null;
  runtimeSession?: RuntimeSessionLike;
  fallbackAgentName?: string;
}): SessionEndedPayload {
  const startedAt =
    params.storedSession?.startedAt instanceof Date
      ? params.storedSession.startedAt
      : params.runtimeSession?.createdAt instanceof Date
        ? params.runtimeSession.createdAt
        : undefined;
  const durationMs = startedAt ? Math.max(0, params.endedAt.getTime() - startedAt.getTime()) : 0;
  const runtimeTurnCount =
    typeof params.runtimeSession?.turnCount === 'number' ? params.runtimeSession.turnCount : null;
  const storedTurnCount =
    typeof params.storedSession?.messageCount === 'number'
      ? params.storedSession.messageCount
      : null;

  return {
    reason: params.disposition,
    disposition: params.disposition,
    status: params.status,
    terminalSource: params.source,
    durationMs,
    ...(runtimeTurnCount !== null
      ? { turnCount: runtimeTurnCount }
      : storedTurnCount !== null
        ? { turnCount: storedTurnCount }
        : {}),
    agentsUsed: uniqueAgentsUsed(
      params.storedSession,
      params.runtimeSession,
      params.fallbackAgentName,
    ),
  };
}

export function isSessionTerminalizationEnabled(): boolean {
  return process.env.SESSION_TERMINALIZATION_ENABLED === 'true';
}

export class SessionTerminalizationService {
  private readonly dispositionService = new SessionDispositionService();

  private readonly deps: Required<SessionTerminalizationServiceDeps>;

  constructor(deps: SessionTerminalizationServiceDeps = {}) {
    this.deps = {
      getRuntimeExecutor: deps.getRuntimeExecutor ?? getRuntimeExecutor,
      getTraceStore: deps.getTraceStore ?? getTraceStore,
      findSessionById: deps.findSessionById ?? findSessionById,
      findSessionByRuntimeId: deps.findSessionByRuntimeId ?? findSessionByRuntimeId,
      updateSession: deps.updateSession ?? updateSession,
      getEventBus: deps.getEventBus ?? getRuntimeEventBus,
      releaseSessionSlot: deps.releaseSessionSlot ?? releaseSessionSlotDefault,
      resolveEndHook:
        deps.resolveEndHook ??
        ((input) =>
          runtimePolicyService.resolveEndHookPolicy({
            tenantId: input.tenantId,
            projectId: input.projectId,
            channel: input.channel,
          })),
      runEndHook: deps.runEndHook ?? ((input) => endHookRunner.run(input)),
      createEventId: deps.createEventId ?? (() => crypto.randomUUID()),
      now: deps.now ?? (() => new Date()),
    };
  }

  private async findStoredSessionByAnyId(
    sessionId: string,
    tenantId: string,
  ): Promise<StoredSessionTerminalizationRecord | null> {
    const session = await this.deps.findSessionById(sessionId, tenantId);
    if (session) {
      return session;
    }

    return this.deps.findSessionByRuntimeId(sessionId, tenantId);
  }

  private isTerminalStoredSession(
    session: StoredSessionTerminalizationRecord | null | undefined,
  ): boolean {
    if (!session) {
      return false;
    }

    if (session.endedAt instanceof Date) {
      return true;
    }

    return typeof session.status === 'string' && TERMINAL_SESSION_STATUSES.has(session.status);
  }

  private endRuntimeSession(sessionId: string): void {
    this.deps.getRuntimeExecutor().endSession(sessionId);
    try {
      const traceStore = this.deps.getTraceStore();
      if (typeof traceStore.finalizeSession === 'function') {
        void traceStore.finalizeSession(sessionId);
      } else {
        void traceStore.removeSession(sessionId);
      }
    } catch {
      /* best effort */
    }
  }

  private tryEmitSessionEndedEvent(params: {
    tenantId: string;
    projectId: string;
    sessionId: string;
    agentName: string;
    channel: string;
    payload: SessionEndedPayload;
  }): { eventEmitted: boolean; eventId?: string } {
    const bus = this.deps.getEventBus();
    if (!bus) {
      return { eventEmitted: false };
    }

    const eventId = this.deps.createEventId();
    const event: PlatformEvent<'session.ended', SessionEndedPayload> = {
      eventId,
      type: 'session.ended',
      tenantId: params.tenantId,
      projectId: params.projectId,
      sessionId: params.sessionId,
      agentName: params.agentName,
      channel: params.channel,
      timestamp: this.deps.now().toISOString(),
      payload: params.payload,
    };

    try {
      bus.emit(event);
      return { eventEmitted: true, eventId };
    } catch (error) {
      log.warn('session.ended emission failed during terminalization', {
        sessionId: params.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { eventEmitted: false };
    }
  }

  private async runEndHook(params: {
    tenantId: string;
    projectId: string;
    sessionId: string;
    channel?: string;
    disposition: CanonicalSessionDisposition;
    source: SessionTerminalSource;
    sendResponse?: (message: string) => Promise<void>;
  }): Promise<TerminateConversationSessionResult['hook']> {
    try {
      const resolved = await this.deps.resolveEndHook({
        tenantId: params.tenantId,
        projectId: params.projectId,
        channel: normalizeLifecycleChannel(params.channel),
      });

      return this.deps.runEndHook({
        config: resolved.config ?? DEFAULT_END_HOOK_CONFIG,
        sessionId: params.sessionId,
        channel: params.channel,
        disposition: params.disposition,
        source: params.source,
        sendResponse: params.sendResponse,
      });
    } catch (error) {
      log.warn('Session end hook resolution failed; defaulting to ignore', {
        sessionId: params.sessionId,
        tenantId: params.tenantId,
        projectId: params.projectId,
        channel: params.channel,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        attempted: true,
        mode: 'ignore',
        outcome: 'ignored',
      };
    }
  }

  async terminateConversationSession(
    input: TerminateConversationSessionInput,
  ): Promise<TerminateConversationSessionResult | null> {
    const normalized = this.dispositionService.normalize(input.disposition);
    if (!normalized) {
      return null;
    }

    const endedAt = this.deps.now();
    const artifactSessionIds = new Set<string>();
    let runtimeEnded = false;
    let dbUpdated = false;
    let storedSession = await this.findStoredSessionByAnyId(input.sessionId, input.tenantId);
    let runtimeSession = this.deps.getRuntimeExecutor().getSession(input.sessionId);

    if (runtimeSession) {
      const runtimeTenantId = runtimeSession.tenantId ?? null;
      const runtimeProjectId =
        typeof runtimeSession.projectId === 'string' ? runtimeSession.projectId : null;
      if (runtimeTenantId !== input.tenantId || runtimeProjectId !== input.projectId) {
        return null;
      }

      runtimeEnded = true;
      artifactSessionIds.add(runtimeSession.id);
      this.endRuntimeSession(runtimeSession.id);
    }

    if (storedSession) {
      if (storedSession.projectId !== input.projectId) {
        if (!runtimeEnded) {
          return null;
        }
      } else {
        const alreadyTerminal = this.isTerminalStoredSession(storedSession);
        const runtimeSessionId = resolveStoredRuntimeSessionId(storedSession, input.sessionId);

        artifactSessionIds.add(runtimeSessionId);

        if (!runtimeEnded) {
          const storedRuntimeSession = this.deps.getRuntimeExecutor().getSession(runtimeSessionId);
          if (storedRuntimeSession) {
            const runtimeTenantId = storedRuntimeSession.tenantId ?? null;
            const runtimeProjectId =
              typeof storedRuntimeSession.projectId === 'string'
                ? storedRuntimeSession.projectId
                : null;
            if (runtimeTenantId === input.tenantId && runtimeProjectId === input.projectId) {
              runtimeSession = storedRuntimeSession;
              runtimeEnded = true;
              this.endRuntimeSession(runtimeSessionId);
            }
          }
        }

        if (!runtimeEnded && input.source === 'close_api') {
          this.deps.releaseSessionSlot(input.tenantId, input.sessionId).catch((error) =>
            log.warn('Session slot release failed during terminalization', {
              sessionId: input.sessionId,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }

        const persistedEndedAt =
          storedSession.endedAt instanceof Date
            ? storedSession.endedAt
            : alreadyTerminal && storedSession.lastActivityAt instanceof Date
              ? storedSession.lastActivityAt
              : endedAt;
        const terminalOutcome = alreadyTerminal
          ? resolveStoredTerminalOutcome(storedSession, normalized)
          : normalized;

        if (alreadyTerminal) {
          return {
            sessionId: storedSession.id,
            disposition: terminalOutcome.disposition,
            status: terminalOutcome.status,
            endedAt: persistedEndedAt.toISOString(),
            eventEmitted: false,
            hook: {
              attempted: false,
            },
            runtimeEnded,
            dbUpdated,
            artifactSessionIds: Array.from(artifactSessionIds),
          };
        }

        const sessionUpdate: Record<string, unknown> = {
          status: terminalOutcome.status,
          disposition: terminalOutcome.disposition,
          endedAt: persistedEndedAt,
          lastActivityAt: endedAt,
        };

        if (typeof input.transferMetadata?.dispositionCode === 'string') {
          sessionUpdate.dispositionCode = input.transferMetadata.dispositionCode;
        }

        if (input.source === 'transfer_end' || input.transferMetadata !== undefined) {
          sessionUpdate['metadata.transferEnd'] = buildTransferEndMetadata({
            disposition: terminalOutcome.disposition,
            endedAt: persistedEndedAt,
            source: input.source,
            transferMetadata: input.transferMetadata,
          });
        }

        const updatedSession =
          (await this.deps.updateSession(storedSession.id, sessionUpdate, input.tenantId)) ??
          storedSession;

        storedSession = updatedSession;
        dbUpdated = true;

        const payload = buildSessionEndedPayload({
          disposition: terminalOutcome.disposition,
          status: terminalOutcome.status,
          source: input.source,
          endedAt: persistedEndedAt,
          storedSession,
          runtimeSession,
          fallbackAgentName: input.agentName,
        });
        const event = this.tryEmitSessionEndedEvent({
          tenantId: input.tenantId,
          projectId: input.projectId,
          sessionId: storedSession.id,
          agentName:
            storedSession.currentAgent ?? runtimeSession?.agentName ?? input.agentName ?? 'unknown',
          channel:
            storedSession.channel ?? input.channel ?? runtimeSession?.channelType ?? 'unknown',
          payload,
        });
        const hook = await this.runEndHook({
          tenantId: input.tenantId,
          projectId: input.projectId,
          sessionId: storedSession.id,
          channel: storedSession.channel ?? input.channel ?? runtimeSession?.channelType,
          disposition: terminalOutcome.disposition,
          source: input.source,
          sendResponse: input.hook?.sendResponse,
        });

        return {
          sessionId: storedSession.id,
          disposition: terminalOutcome.disposition,
          status: terminalOutcome.status,
          endedAt: persistedEndedAt.toISOString(),
          eventEmitted: event.eventEmitted,
          eventId: event.eventId,
          hook,
          runtimeEnded,
          dbUpdated,
          artifactSessionIds: Array.from(artifactSessionIds),
        };
      }
    }

    if (!runtimeEnded) {
      return null;
    }

    const payload = buildSessionEndedPayload({
      disposition: normalized.disposition,
      status: normalized.status,
      source: input.source,
      endedAt,
      storedSession: null,
      runtimeSession,
      fallbackAgentName: input.agentName,
    });
    const event = this.tryEmitSessionEndedEvent({
      tenantId: input.tenantId,
      projectId: input.projectId,
      sessionId: runtimeSession?.id ?? input.sessionId,
      agentName: runtimeSession?.agentName ?? input.agentName ?? 'unknown',
      channel: input.channel ?? runtimeSession?.channelType ?? 'unknown',
      payload,
    });
    const hook = await this.runEndHook({
      tenantId: input.tenantId,
      projectId: input.projectId,
      sessionId: runtimeSession?.id ?? input.sessionId,
      channel: input.channel ?? runtimeSession?.channelType,
      disposition: normalized.disposition,
      source: input.source,
      sendResponse: input.hook?.sendResponse,
    });

    return {
      sessionId: runtimeSession?.id ?? input.sessionId,
      disposition: normalized.disposition,
      status: normalized.status,
      endedAt: endedAt.toISOString(),
      eventEmitted: event.eventEmitted,
      eventId: event.eventId,
      hook,
      runtimeEnded,
      dbUpdated,
      artifactSessionIds: Array.from(artifactSessionIds),
    };
  }
}
