/**
 * RuntimeExecutorLLM — LiveKit LLM Adapter
 *
 * Bridges LiveKit's agent framework LLM interface with our RuntimeExecutor.
 * When LiveKit's voice pipeline finishes STT, it calls this adapter's chat() method.
 * We forward the transcribed text to RuntimeExecutor.executeMessage() and stream
 * the response back as an LLM completion.
 *
 * Security:
 * - Tenant-guarded project lookup (S2)
 * - tenantId is server-authoritative from token, not from participant metadata (S3/S4)
 *
 * Performance:
 * - Per-project DSL cache avoids re-fetching on every adapter init (P7)
 * - Chat timeout prevents indefinite hangs (P3)
 */

import { DEFAULT_MESSAGES } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import {
  getRuntimeExecutor,
  compileToResolvedAgent,
  resolveProjectTools,
} from '../../runtime-executor.js';
import { isDatabaseAvailable } from '../../../db/index.js';
import { DeploymentResolver, type ResolvedAgent } from '../../deployment-resolver.js';
import { buildProductionSessionLocator } from '../../session/execution-scope.js';
import { resolveRequiredContactProductionScope } from '../../session/production-contact-scope.js';
import { getSessionService } from '../../session/session-service.js';
import {
  createAndLinkDBSession,
  resolveEnvironmentLabel,
  resolveSessionTimeouts,
} from '../../../channels/pipeline/session-factory.js';
import { handleDisconnect } from '../../../channels/pipeline/lifecycle-manager.js';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import { buildOutcomeTraceEvent, type ChannelOutcome } from '../../channel/outcome.js';
import type { ResponseMessageMetadata } from '../../channel/response-provenance.js';
import { getChannelAdapterRegistry } from '../../channel/channel-adapter.js';
import { recordSyntheticTraceEvent } from '../../channel-trace-utils.js';
import {
  buildSessionLocalizationCatalog,
  resolveLocalizedAgentMessage,
  storeRuntimeSessionLocalizationCatalog,
} from '../../execution/localized-messages.js';
import {
  resolveConversationBehaviorVoiceRuntimeConfig,
  type ConversationBehaviorVoiceRuntimeConfig,
} from '../../execution/conversation-behavior-resolver.js';
import { resolvePersistedAgentVersion } from '../../execution/agent-version-utils.js';
import type { CallerContext } from '@agent-platform/shared-auth';
import { buildCallerContext } from '../../identity/artifact-hasher.js';
import { executeVoiceTurn } from '../voice-turn-coordinator.js';

const log = createLogger('livekit-llm-adapter');
type ResolvedRuntimeAgentIR = NonNullable<
  import('../../execution/types.js').RuntimeSession['agentIR']
>;

function getResolvedAgentLifecycle(resolved: ResolvedAgent) {
  const entryAgent =
    resolved.agents[resolved.entryAgent] ?? Object.values(resolved.agents)[0] ?? undefined;
  return entryAgent?.execution?.sessionLifecycle;
}
// =============================================================================
// TYPES
// =============================================================================

export interface LLMAdapterOptions {
  sessionId: string;
  projectId: string;
  agentName?: string;
  tenantId?: string;
  deploymentId?: string;
  callerContext?: CallerContext;
  sessionMetadata?: Record<string, unknown>;
}

export interface ChatResponse {
  text: string;
  sessionId: string;
  tokensIn: number;
  tokensOut: number;
  voiceConfig?: import('@abl/compiler').VoiceConfigIR;
  responseMetadata?: ResponseMessageMetadata;
}

// =============================================================================
// DSL CACHE — avoids re-querying the same project's DSLs per room (P7)
// =============================================================================

interface CachedProjectDSLs {
  dsls: string[];
  entryAgentName: string;
  fetchedAt: number;
}

const projectDSLCache = new Map<string, CachedProjectDSLs>();
const DSL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DSL_CACHE_MAX_SIZE = 500;

/** @internal Test-only: clear the DSL cache between test runs */
export function _clearDSLCacheForTesting(): void {
  projectDSLCache.clear();
}

function getCachedDSLs(projectId: string): CachedProjectDSLs | null {
  const cached = projectDSLCache.get(projectId);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > DSL_CACHE_TTL_MS) {
    projectDSLCache.delete(projectId);
    return null;
  }
  return cached;
}

function getRuntimeAgentName(
  agentIR: import('../../execution/types.js').RuntimeSession['agentIR'],
  fallbackAgentName: string,
): string {
  const resolvedAgentIR = agentIR as ResolvedRuntimeAgentIR | null;
  const runtimeAgentName =
    typeof resolvedAgentIR?.metadata?.name === 'string'
      ? resolvedAgentIR.metadata.name.trim()
      : undefined;
  return runtimeAgentName && runtimeAgentName.length > 0 ? runtimeAgentName : fallbackAgentName;
}

function findFuzzyAgentMatch(
  availableAgents: string[],
  candidateNames: Array<string | undefined | null>,
): string | null {
  const findUniqueMatch = (matches: string[]): string | null => {
    if (matches.length === 1) {
      return matches[0];
    }
    return null;
  };

  for (const candidateName of candidateNames) {
    if (!candidateName) {
      continue;
    }

    const normalizedCandidate = candidateName.toLowerCase();
    const exactMatch = findUniqueMatch(
      availableAgents.filter((key) => key.toLowerCase() === normalizedCandidate),
    );
    if (exactMatch) {
      return exactMatch;
    }

    const underscoredSuffixMatch = findUniqueMatch(
      availableAgents.filter((key) => key.toLowerCase().endsWith(`_${normalizedCandidate}`)),
    );
    if (underscoredSuffixMatch) {
      return underscoredSuffixMatch;
    }

    const suffixMatch = findUniqueMatch(
      availableAgents.filter(
        (key) =>
          !key.toLowerCase().endsWith(`_${normalizedCandidate}`) &&
          key.toLowerCase().endsWith(normalizedCandidate),
      ),
    );
    if (suffixMatch) {
      return suffixMatch;
    }
  }

  return null;
}

function resolveVoiceAgentName(params: {
  requestedEntryAgent: string;
  compilationEntryAgent?: string;
  resolvedAgents: ResolvedAgent['agents'];
  runtimeAgentIR: import('../../execution/types.js').RuntimeSession['agentIR'];
}): {
  agentName: string;
  resolvedBy: 'runtime_session' | 'requested' | 'compilation_entry' | 'single_agent' | 'fuzzy';
} | null {
  const runtimeAgentName = getRuntimeAgentName(params.runtimeAgentIR, '').trim();
  const availableAgents = Object.keys(params.resolvedAgents || {});

  if (runtimeAgentName && params.resolvedAgents[runtimeAgentName]) {
    return {
      agentName: runtimeAgentName,
      resolvedBy: runtimeAgentName === params.requestedEntryAgent ? 'requested' : 'runtime_session',
    };
  }

  if (params.resolvedAgents[params.requestedEntryAgent]) {
    return {
      agentName: params.requestedEntryAgent,
      resolvedBy: 'requested',
    };
  }

  if (params.compilationEntryAgent && params.resolvedAgents[params.compilationEntryAgent]) {
    return {
      agentName: params.compilationEntryAgent,
      resolvedBy: 'compilation_entry',
    };
  }

  if (availableAgents.length === 1) {
    return {
      agentName: availableAgents[0],
      resolvedBy: 'single_agent',
    };
  }

  const fuzzyMatch = findFuzzyAgentMatch(availableAgents, [
    runtimeAgentName,
    params.requestedEntryAgent,
    params.compilationEntryAgent,
  ]);
  if (fuzzyMatch) {
    return {
      agentName: fuzzyMatch,
      resolvedBy: 'fuzzy',
    };
  }

  return null;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default timeout for chat() calls — prevents indefinite hangs (P3) */
const CHAT_TIMEOUT_MS = 30_000;

function recordOutcomeTrace(params: {
  sessionId: string;
  session?: Pick<import('../../execution/types.js').RuntimeSession, 'tracer'> | undefined;
  outcome: ChannelOutcome;
}): void {
  if (params.outcome.status === 'ok') {
    return;
  }

  recordSyntheticTraceEvent({
    sessionId: params.sessionId,
    session: params.session,
    event: buildOutcomeTraceEvent(params.outcome),
  });
}

// =============================================================================
// RUNTIME LLM ADAPTER
// =============================================================================

/**
 * Manages the bridge between LiveKit agent framework and RuntimeExecutor.
 *
 * The agent worker creates one adapter per room participant.
 * On each user utterance, LiveKit calls `chat()` which delegates to executeMessage().
 */
export class RuntimeLLMAdapter {
  private options: LLMAdapterOptions;
  private sessionId: string | null = null;
  private dbSessionId: string | null = null;
  private dbSessionCreating: Promise<string | null> | null = null;
  private initialized = false;
  private createdAt = Date.now();
  /** Cached info for deferred DB session creation (set during initialize, consumed in ensureDbSession) */
  private pendingDbInfo: {
    agentName: string;
    agentVersion: string;
    environment: string;
    deploymentId?: string;
  } | null = null;

  constructor(options: LLMAdapterOptions) {
    this.options = options;
  }

  private getCallerContext(): CallerContext | undefined {
    if (this.options.callerContext) {
      return this.options.callerContext;
    }

    if (!this.options.tenantId) {
      return undefined;
    }

    const fallbackCallerContext = buildCallerContext({
      tenantId: this.options.tenantId,
      channel: 'voice_livekit',
      anonymousId: `livekit:${this.options.sessionId}`,
      identityTier: 0,
      verificationMethod: 'none',
    });
    this.options.callerContext = fallbackCallerContext;
    return fallbackCallerContext;
  }

  private async resolveExecutionScope(
    environment: string,
  ): Promise<Awaited<ReturnType<typeof resolveRequiredContactProductionScope>>> {
    const callerContext = this.getCallerContext();
    const scopeInput = await resolveRequiredContactProductionScope({
      tenantId: this.options.tenantId,
      projectId: this.options.projectId,
      sessionId: this.options.sessionId,
      channelId: callerContext?.channelId ?? 'voice_livekit',
      environment,
      source: 'livekit_voice',
      authType: 'livekit_room',
      callerContext,
      channelType: callerContext?.channel,
      fallbackAnonymousId: `livekit:${this.options.sessionId}`,
    });
    this.options.callerContext = scopeInput.callerContext;
    return scopeInput;
  }

  /**
   * Initialize the runtime session (loads project agents, compiles DSL, etc.)
   * Must be called once before chat().
   *
   * When deploymentId is available, uses DeploymentResolver for pre-compiled IR.
   * Otherwise falls back to DSL cache + fresh compile.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const executor = getRuntimeExecutor();
    if (!executor.isConfigured()) {
      throw new AppError('RuntimeExecutor not configured', { ...ErrorCodes.SERVICE_UNAVAILABLE });
    }

    // =======================================================================
    // DEPLOYMENT-AWARE PATH: Use DeploymentResolver when deploymentId exists
    // =======================================================================
    if (this.options.deploymentId && this.options.tenantId) {
      try {
        let configVariables: Record<string, string> | undefined;
        try {
          const { loadConfigVariablesMap } = await import('../../../repos/project-repo.js');
          const loaded = await loadConfigVariablesMap(
            this.options.projectId,
            this.options.tenantId,
          );
          if (Object.keys(loaded).length > 0) {
            configVariables = loaded;
          }
        } catch (err) {
          log.warn('Failed to load config variables for LiveKit deployment session', {
            projectId: this.options.projectId,
            tenantId: this.options.tenantId,
            deploymentId: this.options.deploymentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        const resolver = new DeploymentResolver(getSessionService());
        const resolved = await resolver.resolve({
          projectId: this.options.projectId,
          tenantId: this.options.tenantId,
          deploymentId: this.options.deploymentId,
          agentName: this.options.agentName,
        });

        const voiceSessionTimeouts = await resolveSessionTimeouts(
          this.options.tenantId,
          this.options.projectId,
          getResolvedAgentLifecycle(resolved),
        );
        const scopeInput = await this.resolveExecutionScope(resolved.versionInfo.environment);
        const session = executor.createSessionFromResolved(resolved, {
          channelType: 'voice_livekit',
          deploymentId: this.options.deploymentId,
          metadata: this.options.sessionMetadata,
          scope: scopeInput.scope,
          ...voiceSessionTimeouts,
        });
        storeRuntimeSessionLocalizationCatalog(
          session,
          buildSessionLocalizationCatalog(configVariables),
        );

        this.sessionId = session.id;
        this.initialized = true;
        const resolvedVoiceAgent = resolveVoiceAgentName({
          requestedEntryAgent: resolved.entryAgent,
          compilationEntryAgent: resolved.compilationOutput?.entry_agent,
          resolvedAgents: resolved.agents,
          runtimeAgentIR: session.agentIR,
        });
        const runtimeAgentName =
          resolvedVoiceAgent?.agentName ??
          getRuntimeAgentName(session.agentIR, resolved.entryAgent);

        if (resolvedVoiceAgent && resolvedVoiceAgent.agentName !== resolved.entryAgent) {
          log.warn('LiveKit voice entry agent mismatch resolved', {
            requestedEntryAgent: resolved.entryAgent,
            resolvedEntryAgent: resolvedVoiceAgent.agentName,
            compilationEntryAgent: resolved.compilationOutput?.entry_agent,
            resolvedBy: resolvedVoiceAgent.resolvedBy,
            availableAgents: Object.keys(resolved.agents || {}),
          });
        } else if (!resolvedVoiceAgent) {
          log.warn('LiveKit voice entry agent mismatch unresolved; using requested fallback', {
            requestedEntryAgent: resolved.entryAgent,
            runtimeAgentName: getRuntimeAgentName(session.agentIR, ''),
            compilationEntryAgent: resolved.compilationOutput?.entry_agent,
            availableAgents: Object.keys(resolved.agents || {}),
          });
        }

        log.info('LiveKit LLM adapter initialized (deployment-resolved)', {
          optionsSessionId: this.options.sessionId,
          sessionId: session.id,
          deploymentId: this.options.deploymentId,
          projectId: this.options.projectId,
          tenantId: this.options.tenantId,
          entryAgent: runtimeAgentName,
        });

        // Defer DB session creation until first chat() — prevents ghost sessions
        const envMap: Record<string, 'dev' | 'staging' | 'prod' | 'test'> = {
          dev: 'dev',
          staging: 'staging',
          production: 'prod',
          prod: 'prod',
          test: 'test',
        };
        this.pendingDbInfo = {
          agentName: runtimeAgentName,
          agentVersion: resolvePersistedAgentVersion(resolved.versionInfo, runtimeAgentName),
          environment: envMap[resolved.versionInfo.environment] || resolved.versionInfo.environment,
          deploymentId: this.options.deploymentId,
        };
        return;
      } catch (err) {
        // 410 = retired deployment — do NOT fall through to legacy compile
        if ((err as any).statusCode === 410) {
          throw err;
        }
        log.warn('DeploymentResolver failed in LiveKit adapter, falling back to DSL compile', {
          error: err instanceof Error ? err.message : String(err),
          deploymentId: this.options.deploymentId,
        });
        // Fall through to legacy path
      }
    }

    // =======================================================================
    // LEGACY PATH: DSL cache + fresh compile
    // =======================================================================
    let dsls: string[];
    let entryAgentName: string;

    // Cache key includes tenantId to prevent cross-tenant cache leaks
    const cacheKey = `${this.options.tenantId || '_'}:${this.options.projectId}`;

    const cached = getCachedDSLs(cacheKey);
    if (cached) {
      dsls = cached.dsls;
      entryAgentName = this.options.agentName || cached.entryAgentName;
    } else {
      const fetched = await this.fetchProjectDSLs();
      dsls = fetched.dsls;
      entryAgentName = this.options.agentName || fetched.entryAgentName;

      // Evict oldest entry if cache is full
      if (projectDSLCache.size >= DSL_CACHE_MAX_SIZE) {
        const oldest = projectDSLCache.keys().next().value;
        if (oldest) projectDSLCache.delete(oldest);
      }
      // Populate cache
      projectDSLCache.set(cacheKey, {
        dsls,
        entryAgentName: fetched.entryAgentName,
        fetchedAt: Date.now(),
      });
    }

    // Resolve tool implementations from DB before compilation (baked into IR)
    const resolvedTools =
      this.options.tenantId && this.options.projectId
        ? await resolveProjectTools(this.options.tenantId, this.options.projectId, dsls)
        : undefined;
    let configVariables: Record<string, string> | undefined;
    if (this.options.tenantId && this.options.projectId) {
      try {
        const { loadConfigVariablesMap } = await import('../../../repos/project-repo.js');
        const loaded = await loadConfigVariablesMap(this.options.projectId, this.options.tenantId);
        if (Object.keys(loaded).length > 0) {
          configVariables = loaded;
        }
      } catch (err) {
        log.warn('Failed to load config variables for LiveKit compile path', {
          projectId: this.options.projectId,
          tenantId: this.options.tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const resolved = compileToResolvedAgent(
      dsls,
      entryAgentName,
      configVariables,
      resolvedTools,
      'dev',
    );
    const voiceSessionTimeouts = await resolveSessionTimeouts(
      this.options.tenantId,
      this.options.projectId,
      getResolvedAgentLifecycle(resolved),
    );
    const scopeInput = await this.resolveExecutionScope('dev');
    const session = executor.createSessionFromResolved(resolved, {
      channelType: 'voice_livekit',
      metadata: this.options.sessionMetadata,
      scope: scopeInput.scope,
      ...voiceSessionTimeouts,
    });
    storeRuntimeSessionLocalizationCatalog(
      session,
      buildSessionLocalizationCatalog(configVariables),
    );

    this.sessionId = session.id;
    this.initialized = true;
    const resolvedVoiceAgent = resolveVoiceAgentName({
      requestedEntryAgent: resolved.entryAgent,
      compilationEntryAgent: resolved.compilationOutput?.entry_agent,
      resolvedAgents: resolved.agents,
      runtimeAgentIR: session.agentIR,
    });
    const runtimeAgentName =
      resolvedVoiceAgent?.agentName ?? getRuntimeAgentName(session.agentIR, entryAgentName);

    if (resolvedVoiceAgent && resolvedVoiceAgent.agentName !== entryAgentName) {
      log.warn('LiveKit voice entry agent mismatch resolved', {
        requestedEntryAgent: entryAgentName,
        resolvedEntryAgent: resolvedVoiceAgent.agentName,
        compilationEntryAgent: resolved.compilationOutput?.entry_agent,
        resolvedBy: resolvedVoiceAgent.resolvedBy,
        availableAgents: Object.keys(resolved.agents || {}),
      });
    } else if (!resolvedVoiceAgent) {
      log.warn('LiveKit voice entry agent mismatch unresolved; using requested fallback', {
        requestedEntryAgent: entryAgentName,
        runtimeAgentName: getRuntimeAgentName(session.agentIR, ''),
        compilationEntryAgent: resolved.compilationOutput?.entry_agent,
        availableAgents: Object.keys(resolved.agents || {}),
      });
    }

    log.info('LiveKit LLM adapter initialized', {
      optionsSessionId: this.options.sessionId,
      sessionId: session.id,
      projectId: this.options.projectId,
      tenantId: this.options.tenantId,
      entryAgent: runtimeAgentName,
    });

    // Defer DB session creation until first chat() — prevents ghost sessions
    this.pendingDbInfo = {
      agentName: runtimeAgentName,
      agentVersion: '1.0',
      environment: 'dev',
    };
  }

  /**
   * Fetch project DSLs from database with tenant guard (S2).
   */
  private async fetchProjectDSLs(): Promise<{ dsls: string[]; entryAgentName: string }> {
    const { findProjectWithAgents } = await import('../../../repos/project-repo.js');
    if (!this.options.tenantId) {
      throw new AppError(`Tenant context required for project lookup: ${this.options.projectId}`, {
        ...ErrorCodes.UNAUTHORIZED,
      });
    }
    const project = await findProjectWithAgents(this.options.projectId, this.options.tenantId);

    if (!project) {
      throw new AppError(
        this.options.tenantId
          ? `Project not found or access denied: ${this.options.projectId} (tenant: ${this.options.tenantId})`
          : `Project not found: ${this.options.projectId}`,
        { ...ErrorCodes.NOT_FOUND },
      );
    }

    const agentsWithDSL = (project.agents || []).filter((agent: any) => agent.dslContent);

    if (agentsWithDSL.length === 0) {
      throw new AppError(`No agent DSLs found for project: ${this.options.projectId}`, {
        ...ErrorCodes.NOT_FOUND,
      });
    }

    return {
      dsls: agentsWithDSL.map((agent: any) => agent.dslContent as string),
      entryAgentName: agentsWithDSL[0].name || 'default',
    };
  }

  /**
   * Process a user utterance through the agent runtime.
   * Called by the LiveKit agent pipeline after STT completes.
   *
   * @param userText - Transcribed text from STT
   * @param onChunk - Optional streaming callback for partial responses
   * @returns The agent's full text response
   */
  /**
   * Lazily create the DB session on first voice interaction.
   * Prevents ghost sessions from agent spawns that never receive audio.
   */
  private async ensureDbSession(): Promise<void> {
    if (this.dbSessionId || !this.pendingDbInfo || !isDatabaseAvailable()) return;
    if (this.dbSessionCreating) {
      await this.dbSessionCreating;
      return;
    }

    this.dbSessionCreating = (async () => {
      if (this.dbSessionId) return this.dbSessionId;
      const info = this.pendingDbInfo;
      if (!info) return null;
      try {
        const callerContext = this.getCallerContext();
        const runtimeSess = getRuntimeExecutor().getSession(this.sessionId!);
        const { dbSessionId } = await createAndLinkDBSession({
          sessionId: this.sessionId!,
          channel: 'voice',
          agentName: info.agentName,
          agentVersion: info.agentVersion,
          environment: resolveEnvironmentLabel(info.environment),
          projectId: this.options.projectId,
          tenantId: this.options.tenantId,
          initiatedById: callerContext?.initiatedById,
          deploymentId: info.deploymentId,
          customerId: callerContext?.customerId,
          anonymousId: callerContext?.sessionPrincipalId || callerContext?.anonymousId,
          contactId: callerContext?.contactId,
          channelArtifact: callerContext?.channelArtifact,
          channelArtifactType: callerContext?.channelArtifactType,
          identityTier: callerContext?.identityTier,
          verificationMethod: callerContext?.verificationMethod,
          channelId: callerContext?.channelId,
          experimentId: runtimeSess?.experimentId,
          experimentGroup: runtimeSess?.experimentGroup,
          metadata: {
            voiceMetadata: { provider: 'livekit' },
            ...(callerContext?.authScope ? { authScope: callerContext.authScope } : {}),
          },
        });
        this.dbSessionId = dbSessionId;
        this.pendingDbInfo = null;
        return dbSessionId;
      } catch (err) {
        log.warn('Failed to create DB session for voice', {
          sessionId: this.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      } finally {
        this.dbSessionCreating = null;
      }
    })();
    await this.dbSessionCreating;
  }

  async chat(userText: string, onChunk?: (chunk: string) => void): Promise<ChatResponse> {
    if (!this.initialized || !this.sessionId) {
      await this.initialize();
    }
    // Create DB session on first actual voice interaction (not on agent spawn)
    await this.ensureDbSession();

    const executor = getRuntimeExecutor();
    const startTime = Date.now();
    const sessionLocator = buildProductionSessionLocator({
      tenantId: this.options.tenantId,
      projectId: this.options.projectId,
      sessionId: this.sessionId!,
    });

    log.debug('Processing utterance via RuntimeExecutor', {
      sessionId: this.sessionId,
      textLength: userText.length,
    });

    // Accumulate token metrics from trace events
    let tokensIn = 0;
    let tokensOut = 0;
    const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
      if (event.type === 'llm_call' && event.data) {
        tokensIn += (event.data.tokensIn as number) || 0;
        tokensOut += (event.data.tokensOut as number) || 0;
      }
      // Forward filler status messages to the TTS stream as text chunks.
      // LiveKit's agent-worker consumes onChunk via ReadableStream → TTS pipeline.
      if (event.type === 'status_update' && typeof event.data.text === 'string') {
        onChunk?.(event.data.text);
      }
    };

    const coordinatorResult = await executeVoiceTurn({
      channelType: 'voice_livekit',
      executor,
      sessionId: this.sessionId!,
      utterance: userText,
      timeoutMs: CHAT_TIMEOUT_MS,
      promptProfile: 'pipeline',
      onChunk,
      onTraceEvent,
      executeOptions: {
        ...(sessionLocator ? { sessionLocator } : {}),
      },
    });
    const outcome = coordinatorResult.outcome;
    const runtimeSession = coordinatorResult.runtimeSession;
    recordOutcomeTrace({
      sessionId: this.sessionId!,
      session: runtimeSession ?? undefined,
      outcome,
    });
    const voiceText = getChannelAdapterRegistry().resolve(
      { text: outcome.responseText, voiceConfig: outcome.voiceConfig },
      { channelType: 'voice_livekit' },
    );

    if (outcome.status !== 'ok' && voiceText) {
      onChunk?.(voiceText);
    }

    const durationMs = Date.now() - startTime;

    log.debug('RuntimeExecutor response', {
      sessionId: this.sessionId,
      responseLength: voiceText.length,
      action: outcome.action?.type,
      outcomeStatus: outcome.status,
      durationMs,
      tokensIn,
      tokensOut,
    });

    return {
      text: voiceText,
      sessionId: this.sessionId!,
      tokensIn,
      tokensOut,
      voiceConfig: outcome.voiceConfig,
      responseMetadata: outcome.responseMetadata,
    };
  }

  async resolveSystemMessage(messageKey: string, fallbackMessage?: string): Promise<string> {
    if (!this.initialized || !this.sessionId) {
      await this.initialize();
    }

    const resolvedFallback =
      fallbackMessage ?? DEFAULT_MESSAGES[messageKey as keyof typeof DEFAULT_MESSAGES] ?? '';
    const executor = getRuntimeExecutor();
    const runtimeSession =
      executor.getSession(this.sessionId!) ?? (await executor.rehydrateSession(this.sessionId!));

    if (!runtimeSession) {
      return resolvedFallback;
    }

    return resolveLocalizedAgentMessage({
      session: runtimeSession,
      messageKey,
      fallbackMessage: resolvedFallback,
    });
  }

  /** Get the underlying session ID. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  getConversationBehaviorVoiceRuntimeConfig(): ConversationBehaviorVoiceRuntimeConfig {
    if (!this.sessionId) {
      return {};
    }

    const runtimeSession = getRuntimeExecutor().getSession(this.sessionId);
    return resolveConversationBehaviorVoiceRuntimeConfig(
      runtimeSession?._effectiveConfig?.conversationBehavior,
    );
  }

  /** Get the database session ID (for message persistence). */
  getDbSessionId(): string | null {
    return this.dbSessionId;
  }

  /** Get the tenant ID (for message persistence). */
  getTenantId(): string | undefined {
    return this.options.tenantId;
  }

  /** Get the project ID (for message persistence + retention). */
  getProjectId(): string {
    return this.options.projectId;
  }

  /** Get session duration in ms (for shutdown logging). */
  getSessionDurationMs(): number {
    return Date.now() - this.createdAt;
  }

  /**
   * Clean up when the room/session ends.
   */
  async dispose(): Promise<void> {
    if (this.sessionId) {
      try {
        await handleDisconnect({
          channel: 'voice',
          sessionId: this.sessionId,
          dbSessionId: this.dbSessionId ?? undefined,
          tenantId: this.options.tenantId,
        });
        log.info('RuntimeLLMAdapter disposed', {
          sessionId: this.sessionId,
          optionsSessionId: this.options.sessionId,
          dbSessionId: this.dbSessionId,
          durationMs: this.getSessionDurationMs(),
        });
      } catch (error) {
        log.warn('Error disposing runtime session', {
          sessionId: this.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.sessionId = null;
    this.initialized = false;
  }
}
