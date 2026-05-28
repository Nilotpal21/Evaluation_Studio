/**
 * Agent Transfer Boot Service
 *
 * Initializes the agent-transfer subsystem: session store, adapter registry,
 * KoreAdapter, and session recovery. All components share the runtime's
 * existing Redis client — no new connections are created.
 *
 * Exports singleton accessors for use by the execution pipeline and webhook routes.
 */

import type { RedisClient } from '@agent-platform/redis';
import { createSubscriber } from '@agent-platform/redis';
import { getRedisHandle } from '../redis/redis-client.js';
import {
  TransferSessionStore,
  AdapterRegistry,
  KoreAdapter,
  Five9Adapter,
  SessionRecoveryService,
  type AgentTransferConfig,
  type SmartAssistClient,
  type TransferSessionStoreHandle,
  type TraceEventEmitter,
  TenantScopedSessionEncryptor,
  type SessionFieldEncryptor,
  type AgentEventType,
  type TransferChannel,
  normalizeTransferChannel,
  resolveTransferSessionOwnerId,
  sessionKey,
  ACTIVE_SESSIONS_SET,
  CsatHandler,
  type SessionStoreHandle as CsatSessionStoreHandle,
  type UpdateTransferSessionFields,
} from '@agent-platform/agent-transfer';
import {
  encryptForTenantAuto,
  decryptForTenantAuto,
  isTenantEncryptionReady,
} from '@agent-platform/shared/encryption';
import { createLogger } from '@abl/compiler/platform';
import { hostname } from 'os';
import { initializeMessageBridge, getMessageBridge } from './message-bridge.js';
import { runVoiceCsatFlow } from './voice-csat.js';
import { createEventStoreTraceAdapter } from './eventstore-trace-adapter.js';
import {
  extractAgentDisconnectedFields,
  parseAcwMessageFields,
} from './lifecycle-event-helpers.js';
import { getTraceStore } from '../trace-store.js';
import {
  createSessionTimeoutQueue,
  closeSessionTimeoutQueue,
  type SessionTimeoutQueueComponents,
} from './timeout-queue-factory.js';
import {
  createEventQueue,
  closeEventQueue,
  type EventQueueComponents,
} from './event-queue-factory.js';
import { SessionRuntimePolicyService } from '../session-lifecycle/runtime-policy-service.js';
import { buildProductionSessionLocator } from '../session/execution-scope.js';

const log = createLogger('agent-transfer');
const sessionRuntimePolicyService = new SessionRuntimePolicyService();
const TRANSFER_CHANNELS: TransferChannel[] = ['chat', 'email', 'voice', 'messaging', 'campaign'];

function getDefaultVoiceCsatPrompt(surveyType: 'csat' | 'nps' | 'likeDislike'): string {
  if (surveyType === 'likeDislike') {
    return 'Please rate your experience with our agent. Press 1 if it was helpful, or 0 if it was not helpful.';
  }

  return 'Please rate your experience. Press 1 for poor through 5 for excellent. Press 0 to skip.';
}

// ── Singletons ──────────────────────────────────────────────────────────────

let transferSessionStore: TransferSessionStore | null = null;
let adapterRegistry: AdapterRegistry | null = null;
let sessionRecoveryService: SessionRecoveryService | null = null;
let transferTraceEmitter: TraceEventEmitter | null = null;
let storedConfig: AgentTransferConfig | null = null;
let timeoutQueueComponents: SessionTimeoutQueueComponents | null = null;
let eventQueueComponents: EventQueueComponents | null = null;
let keyspaceSubscriber: RedisClient | null = null;
let initialized = false;
let initPromise: Promise<void> | null = null;
const TRANSFER_FLAG_CLEAR_MAX_ATTEMPTS = 3;

function isTransferChannel(value: string): value is TransferChannel {
  return TRANSFER_CHANNELS.includes(value as TransferChannel);
}

function resolvePostAgentAction(session: {
  postAgentConfig?: { action?: string };
  metadata?: Record<string, unknown>;
}): string {
  const structuredAction = session.postAgentConfig?.action;
  if (typeof structuredAction === 'string' && structuredAction.length > 0) {
    return structuredAction;
  }

  const metadataAction = session.metadata?.postAgentAction;
  return typeof metadataAction === 'string' && metadataAction.length > 0 ? metadataAction : 'end';
}

function shouldCleanupTransferSessionAfterAcw(session: {
  state: string;
  postAgentConfig?: { action?: string };
  metadata?: Record<string, unknown>;
}): boolean {
  return session.state === 'ended' || resolvePostAgentAction(session) === 'end';
}

async function persistRuntimeTransferFlagsCleared(params: {
  runtimeSessionId: string;
  tenantId: string;
  projectId?: string;
}): Promise<boolean> {
  const { getSessionService } = await import('../session/session-service.js');
  const sessionService = getSessionService();
  const locator = buildProductionSessionLocator({
    tenantId: params.tenantId,
    projectId: params.projectId,
    sessionId: params.runtimeSessionId,
  });

  for (let attempt = 1; attempt <= TRANSFER_FLAG_CLEAR_MAX_ATTEMPTS; attempt += 1) {
    const runtimeSession = locator
      ? await sessionService.loadSessionScoped(locator)
      : await sessionService.loadSession(params.runtimeSessionId);

    if (!runtimeSession) {
      log.warn('Runtime session not found while clearing transfer flags after disconnect', {
        sessionId: params.runtimeSessionId,
        tenantId: params.tenantId,
        attempt,
      });
      return false;
    }

    runtimeSession.transferInitiated = false;
    runtimeSession.isEscalated = false;
    runtimeSession.escalationReason = undefined;
    runtimeSession.recentTransferEndedAt = Date.now();
    if (
      Array.isArray(runtimeSession.threads) &&
      runtimeSession.activeThreadIndex >= 0 &&
      runtimeSession.activeThreadIndex < runtimeSession.threads.length
    ) {
      const activeThread = runtimeSession.threads[runtimeSession.activeThreadIndex];
      if (activeThread?.status === 'escalated') {
        activeThread.status = 'active';
      }
    }

    const saved = await sessionService.saveSession(runtimeSession);
    if (saved) {
      return true;
    }

    log.warn('Version conflict while clearing runtime transfer flags after disconnect', {
      sessionId: params.runtimeSessionId,
      tenantId: params.tenantId,
      attempt,
      maxAttempts: TRANSFER_FLAG_CLEAR_MAX_ATTEMPTS,
    });
  }

  return false;
}

// ── Public Accessors ────────────────────────────────────────────────────────

export function getTransferSessionStore(): TransferSessionStore | null {
  return transferSessionStore;
}

export function getAdapterRegistry(): AdapterRegistry | null {
  return adapterRegistry;
}

export function getSessionRecoveryService(): SessionRecoveryService | null {
  return sessionRecoveryService;
}

export function getTransferTraceEmitter(): TraceEventEmitter | null {
  return transferTraceEmitter;
}

export function isAgentTransferInitialized(): boolean {
  return initialized;
}

export function getAgentTransferConfig(): AgentTransferConfig | null {
  return storedConfig;
}

/**
 * Get the SmartAssistClient from the registered Kore adapter.
 * Returns null if not configured or not initialized.
 */
export function getSmartAssistClient(): SmartAssistClient | null {
  if (!adapterRegistry) return null;
  const koreAdapter = adapterRegistry.get('smartassist') as KoreAdapter | undefined;
  return koreAdapter?.getSmartAssistClient() ?? null;
}

// ── Initialization ──────────────────────────────────────────────────────────

export function initializeAgentTransfer(
  redis: RedisClient,
  config: AgentTransferConfig,
): Promise<void> {
  if (initialized) {
    log.warn('Agent transfer already initialized, skipping');
    return Promise.resolve();
  }
  // Mutex: if init is already in progress, return the same promise
  if (initPromise) return initPromise;
  initPromise = doInitializeAgentTransfer(redis, config).catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

async function doInitializeAgentTransfer(
  redis: RedisClient,
  config: AgentTransferConfig,
): Promise<void> {
  log.info('Initializing agent transfer subsystem');

  storedConfig = config;

  // 1. Session store (Redis-backed) with required field-level encryption
  let encryptor: SessionFieldEncryptor | undefined;
  if (!isTenantEncryptionReady()) {
    throw new Error('Tenant DEK encryption is not initialized for agent transfer.');
  }
  encryptor = new TenantScopedSessionEncryptor({
    encryptForTenant: (plaintext, tenantId) =>
      encryptForTenantAuto(plaintext, tenantId, '_tenant', '_tenant'),
    decryptForTenant: (ciphertext, tenantId) => decryptForTenantAuto(ciphertext, tenantId),
  });
  log.info('Session field encryption enabled');
  transferSessionStore = new TransferSessionStore(redis, encryptor);

  // 2. Adapter registry
  adapterRegistry = new AdapterRegistry();

  // 3. Shared session store handle — used by both KoreAdapter and Five9Adapter
  const storeHandle: TransferSessionStoreHandle = {
    create: async (params) => {
      const normalizedChannel = normalizeTransferChannel(
        params.routing?.sourceChannelType ?? params.channel,
      );
      const ttlPolicy = await sessionRuntimePolicyService.resolveTransferSessionTtl({
        tenantId: params.tenantId,
        projectId: params.projectId,
        channel: normalizedChannel,
      });

      return transferSessionStore!.create({
        tenantId: params.tenantId,
        ownerId: params.ownerId,
        contactId: params.contactId,
        channel: normalizedChannel,
        provider: params.provider,
        providerSessionId: params.providerSessionId ?? '',
        agentId: params.agentId,
        projectId: params.projectId,
        ownerPod: hostname(),
        ttl: ttlPolicy.ttlSeconds,
        metadata: params.metadata,
        providerData: params.providerData,
        routing: params.routing,
        contextSnapshot: params.contextSnapshot,
        voiceData: params.voiceData,
      });
    },
    get: async (key) => {
      const session = await transferSessionStore!.get(key);
      if (!session) return null;
      return Object.fromEntries(
        Object.entries(session).map(([k, v]) => [
          k,
          typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v),
        ]),
      );
    },
    end: async (key) => {
      await transferSessionStore!.end(key);
    },
    extendTTL: async (key) => {
      const session = await transferSessionStore!.get(key);
      if (!session || !isTransferChannel(session.channel)) {
        await transferSessionStore!.extendTTL(key);
        return;
      }

      const ttlPolicy = await sessionRuntimePolicyService.resolveTransferSessionTtl({
        tenantId: session.tenantId,
        projectId: session.projectId,
        channel: session.channel,
      });

      await transferSessionStore!.extendTTL(key, ttlPolicy.ttlSeconds, session.channel);
    },
    getByProvider: async (provider, tenantId, providerSessionId) => {
      const session = await transferSessionStore!.getByProvider(
        provider,
        tenantId,
        providerSessionId,
      );
      if (!session) return null;
      // Return as Record<string, string> for the adapter interface.
      // Preserve object fields as JSON strings instead of coercing to "[object Object]".
      return Object.fromEntries(
        Object.entries(session).map(([k, v]) => [
          k,
          typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v),
        ]),
      );
    },
    addProviderAlias: async (provider, aliasTenantId, providerSessionId, sessionKey, ttl) => {
      await transferSessionStore!.addProviderAlias(
        provider,
        aliasTenantId,
        providerSessionId,
        sessionKey,
        ttl,
      );
    },
  };

  // Register KoreAdapter (SmartAssist)
  const koreAdapter = new KoreAdapter(config.smartassist, storeHandle);

  // Initialize with provider config if smartassist is configured
  if (config.smartassist) {
    await koreAdapter.initialize({
      name: 'kore',
      enabled: true,
      auth: { type: 'internal_key', apiKey: config.smartassist.apiKey },
      options: { baseUrl: config.smartassist.baseUrl },
      circuitBreaker: config.smartassist.circuitBreaker,
      timeoutMs: config.smartassist.timeoutMs,
    });
  }

  adapterRegistry.register('smartassist', koreAdapter);

  // Wire message bridge — routes agent events to user channels
  const bridge = initializeMessageBridge();
  const bridgeHandle = getRedisHandle();
  if (bridgeHandle) {
    await bridge.startCrossPodRelay(bridgeHandle);
  }
  koreAdapter.onAgentMessage(async (event) => {
    // Resolve the ABL session key from the SmartAssist conversationId
    const session = await transferSessionStore!.getByProvider(
      'smartassist',
      event.tenantId,
      event.sessionId,
    );
    if (!session) {
      log.warn('No session found for agent message — dropping event', {
        tenantId: event.tenantId,
        providerSessionId: event.sessionId,
      });
      return;
    }
    const ownerId = resolveTransferSessionOwnerId(session);
    const runtimeSessionId = session.routing?.runtimeSessionId ?? ownerId;
    const ablKey = sessionKey(session.tenantId, ownerId, session.channel);

    if (event.type === 'agent:connected' && session.channel === 'voice') {
      try {
        if (session.state === 'pending' || session.state === 'queued') {
          const agentSipURI = event.data?.agentSipURI as string | undefined;
          const voiceUpdate = session.voiceData
            ? { ...session.voiceData, ...(agentSipURI ? { agentSipURI } : {}) }
            : undefined;
          await transferSessionStore!.update(ablKey, {
            state: 'active',
            ...(voiceUpdate ? { voiceData: voiceUpdate } : {}),
          });
        }
      } catch (err) {
        log.error('Failed to update voice session on agent:connected', {
          sessionId: ablKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // For non-voice channels: transition to active on first agent:connected so
    // subsequent synthesized events (from agentInfo messages) are suppressed.
    if (event.type === 'agent:connected' && session.channel !== 'voice') {
      if (session.state === 'pending' || session.state === 'queued') {
        try {
          await transferSessionStore!.update(ablKey, { state: 'active' });
        } catch (err) {
          log.error('Failed to update non-voice session state on agent:connected', {
            sessionId: ablKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (event.type === 'agent:connected' && transferTraceEmitter) {
      // Guard against duplicate agent_connected traces: only emit when the session
      // is transitioning to active for the first time. Covers both real events
      // (assign_kore_agent_for_user) and synthesized ones from agentInfo messages.
      const isFirstConnect = session.state === 'pending' || session.state === 'queued';
      if (isFirstConnect) {
        void Promise.resolve(
          transferTraceEmitter.emit({
            type: 'agent_transfer.agent_connected',
            timestamp: Date.now(),
            data: {
              tenantId: session.tenantId,
              projectId: session.projectId ?? '',
              contactId: session.contactId || resolveTransferSessionOwnerId(session),
              provider: session.provider,
              channel: session.channel,
              runtimeSessionId,
              agentName:
                typeof event.data?.agentName === 'string' ? event.data.agentName : undefined,
              waitTimeMs:
                typeof event.data?.waitTimeMs === 'number' ? event.data.waitTimeMs : undefined,
            },
          }),
        ).catch((err) =>
          log.warn('Failed to emit agent_connected trace', {
            sessionId: runtimeSessionId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    if (event.type === 'agent:call_status' && session.channel === 'voice') {
      try {
        const callStatus = event.data?.callStatus as string;
        if (
          ['agent_hangup', 'user_hangup', 'failed', 'busy', 'no_answer'].includes(callStatus) &&
          session.voiceData?.callSid
        ) {
          const disconnectReason =
            (event.data?.disconnectReason as string | undefined) ?? callStatus;
          await transferSessionStore!.update(ablKey, {
            state: 'ended',
            voiceData: {
              ...session.voiceData,
              disconnectReason,
            },
          });
        }
      } catch (err) {
        log.error('Failed to update voice session on agent:call_status', {
          sessionId: ablKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await bridge.routeAgentEvent(ablKey, { ...event, sessionId: ablKey });

    // On agent disconnect, reset the runtime session's transfer flags so
    // subsequent user messages go back to the AI agent instead of the
    // (now-ended) human agent session.
    if (event.type === 'agent:disconnected') {
      try {
        const existingTransferSession = await transferSessionStore!.get(ablKey);
        if (existingTransferSession) {
          const eventData = event.data as Record<string, unknown> | undefined;
          const isVoice = existingTransferSession.channel === 'voice';

          // State management differs by channel. Chat transitions through post_agent
          // (ACW window); voice transitions directly to ended (or CSAT runner handles it).
          // For voice, post_agent means the CSAT runner has already taken ownership —
          // treat it as "already processed" to block the SmartAssist triple-disconnect.
          const isFirstDisconnect = isVoice
            ? existingTransferSession.state !== 'post_agent' &&
              existingTransferSession.state !== 'ended'
            : existingTransferSession.state !== 'post_agent';

          const disconnectFields = extractAgentDisconnectedFields(eventData);

          if (!isVoice) {
            const sessionUpdate: UpdateTransferSessionFields = {};
            if (isFirstDisconnect) {
              sessionUpdate.state = 'post_agent';
              if (disconnectFields.isACWEnabled) {
                sessionUpdate.acwExpected = true;
              }
            }
            if (Object.keys(sessionUpdate).length > 0) {
              await transferSessionStore!.update(ablKey, sessionUpdate);
            }
          } else {
            // For voice, the CSAT runner owns state transitions when csatRequired=true
            // (post_agent → ended via csatHandler). For all other cases — no CSAT, or
            // session never reached active — end the session so it doesn't accumulate.
            const csatRequired = eventData?.csatRequired === true;
            const sessionUpdate: UpdateTransferSessionFields = {};

            if (!csatRequired && existingTransferSession.state !== 'ended') {
              sessionUpdate.state = 'ended';
            }

            // Mark ACW expected so csatStoreHandle.end() defers session deletion
            // until after the wrap-up form arrives from the agent desktop.
            if (isFirstDisconnect && disconnectFields.isACWEnabled) {
              sessionUpdate.acwExpected = true;
            }

            if (Object.keys(sessionUpdate).length > 0) {
              await transferSessionStore!.update(ablKey, sessionUpdate);
            }
          }

          if (transferTraceEmitter && isFirstDisconnect) {
            const baseData = {
              tenantId: session.tenantId,
              projectId: session.projectId ?? '',
              contactId: session.contactId || resolveTransferSessionOwnerId(session),
              provider: session.provider,
              channel: session.channel,
              runtimeSessionId,
            };

            void Promise.resolve(
              transferTraceEmitter.emit({
                type: 'agent_transfer.agent_disconnected',
                timestamp: Date.now(),
                data: { ...baseData, ...disconnectFields },
              }),
            ).catch((err) =>
              log.warn('Failed to emit agent_disconnected trace', {
                sessionId: runtimeSessionId,
                error: err instanceof Error ? err.message : String(err),
              }),
            );

            void Promise.resolve(
              transferTraceEmitter.emit({
                type: 'agent_transfer.transfer_completed',
                timestamp: Date.now(),
                data: { ...baseData, status: 'completed' },
              }),
            ).catch((err) =>
              log.warn('Failed to emit transfer_completed trace', {
                sessionId: runtimeSessionId,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        }

        const flagsCleared = await persistRuntimeTransferFlagsCleared({
          runtimeSessionId,
          tenantId: session.tenantId,
          projectId: session.projectId,
        });
        if (flagsCleared) {
          log.info('Runtime session transfer flags cleared after agent disconnect', {
            sessionId: runtimeSessionId,
            tenantId: session.tenantId,
          });
        } else {
          log.warn('Failed to persist runtime session transfer flag reset after disconnect', {
            sessionId: runtimeSessionId,
            tenantId: session.tenantId,
          });
        }
      } catch (err) {
        log.error('Failed to reset runtime session transfer flags', {
          sessionId: runtimeSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ACW data arrives as an agent:message after disconnect, once the human agent
    // submits their wrap-up form or the ACW timer expires on the desktop.
    // For voice, ACW and CSAT run in parallel — ACW may arrive while CSAT is still
    // running (state = post_agent) or after CSAT completes (state = ended).
    if (event.type === 'agent:message') {
      const msgData = event.data as Record<string, unknown> | undefined;
      const isAcwMessage = msgData?.isACWEnabled === true;

      if (isAcwMessage) {
        try {
          const transferSession = await transferSessionStore!.get(ablKey);
          if (
            transferSession &&
            (transferSession.state === 'post_agent' || transferSession.state === 'ended') &&
            !transferSession.acwCompletedEmitted
          ) {
            const { dispositionCode, wrapUpNotes, acwTimedOut, acwCloseReason, acwEventTimestamp } =
              parseAcwMessageFields(msgData);

            const acwMarked = await transferSessionStore!.completeAcwIfPending(ablKey, {
              acwTimedOut,
              acwCloseReason,
              acwEndedAt: Date.now(),
              ...(dispositionCode !== undefined ? { dispositionCode } : {}),
              ...(wrapUpNotes !== undefined ? { wrapUpNotes } : {}),
            });

            if (!acwMarked) {
              return;
            }

            if (transferTraceEmitter) {
              void Promise.resolve(
                transferTraceEmitter.emit({
                  type: 'agent_transfer.acw_completed',
                  timestamp: Date.now(),
                  data: {
                    tenantId: session.tenantId,
                    projectId: session.projectId ?? '',
                    contactId: session.contactId || resolveTransferSessionOwnerId(session),
                    provider: session.provider,
                    channel: session.channel,
                    runtimeSessionId,
                    acwCloseReason,
                    acwTimedOut,
                    dispositionCode,
                    reason: wrapUpNotes,
                    transferSessionId: ablKey,
                    timestamp: acwEventTimestamp,
                  },
                }),
              ).catch((err) =>
                log.warn('Failed to emit acw_completed trace', {
                  sessionId: runtimeSessionId,
                  error: err instanceof Error ? err.message : String(err),
                }),
              );
            }

            // Session was held alive (state=ended, not deleted) to wait for this
            // ACW message. Now that ACW is processed, clean it up.
            if (shouldCleanupTransferSessionAfterAcw(transferSession)) {
              transferSessionStore!.end(ablKey).catch((cleanupErr) => {
                log.warn('Failed to clean up transfer session after ACW processing', {
                  sessionId: ablKey,
                  error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
                });
              });
            }
          }
        } catch (err) {
          log.error('Failed to process ACW data message', {
            sessionId: runtimeSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  });
  koreAdapter.onSessionEvent(async (event) => {
    await bridge.routeAgentEvent(event.sessionId, event);
  });

  log.info('KoreAdapter registered with message bridge', {
    smartassistConfigured: !!config.smartassist,
  });

  // 3a-csat. Wire voice CSAT runner on the message bridge.
  // CsatHandler wraps the transfer session store to manage post-agent state transitions.
  const csatStoreHandle: CsatSessionStoreHandle = {
    get: async (key) => {
      const session = await transferSessionStore!.get(key);
      if (!session) return null;
      return Object.fromEntries(
        Object.entries(session).map(([k, v]) => [
          k,
          typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v),
        ]),
      );
    },
    update: async (key, fields) => {
      await transferSessionStore!.update(key, fields as UpdateTransferSessionFields);
    },
    end: async (key) => {
      // When ACW is expected but not yet received, keep the session hash and
      // provider alias alive by only updating the state. The ACW handler will
      // call end() once it processes the wrap-up form.
      const session = await transferSessionStore!.get(key);
      if (session?.acwExpected && !session?.acwCompletedEmitted) {
        await transferSessionStore!.update(key, { state: 'ended' });
        return;
      }
      await transferSessionStore!.end(key);
    },
  };
  const csatHandler = new CsatHandler(csatStoreHandle);

  const activeCsatSessions = new Set<string>();

  bridge.setVoiceCsatRunner(async (sessionId, event, voiceSession) => {
    if (activeCsatSessions.has(sessionId)) {
      log.info('[VOICE-CSAT] CSAT already active for session, skipping duplicate trigger', {
        sessionId,
      });
      return;
    }
    activeCsatSessions.add(sessionId);
    try {
      const transferSession = await transferSessionStore!.get(sessionId);
      const csatRuntimeSessionId =
        transferSession?.routing?.runtimeSessionId ?? transferSession?.ownerId ?? '';
      const csatProjectId = transferSession?.projectId ?? '';

      const csatData = {
        userId: (event.data?.userId as string) ?? '',
        conversationId: (event.data?.conversationId as string) ?? '',
        channel: (event.data?.source as string) ?? 'voice',
        surveyType: ((event.data?.csatSurveyType as string) ?? 'csat') as
          | 'csat'
          | 'nps'
          | 'likeDislike',
        botId: event.data?.iId as string | undefined,
        orgId: event.data?.orgId as string | undefined,
      };

      const prompt =
        config.smartassist?.csatVoicePrompt ?? getDefaultVoiceCsatPrompt(csatData.surveyType);
      const thankYouMessage =
        config.smartassist?.csatVoiceThankYou ?? 'Thank you for your feedback. Goodbye.';

      const sessionData = {
        tenantId: event.tenantId,
        contactId: csatData.userId,
        channel: csatData.channel,
      };
      await csatHandler.handleAgentClosed(sessionId, sessionData, {
        action: 'csat',
        surveyType: 'inline',
      });

      await runVoiceCsatFlow({
        sessionId,
        voiceSession,
        csatData,
        prompt,
        thankYouMessage,
        submitRating: async (score, surveyType) => {
          const result = await koreAdapter.submitCsatRating({
            userId: csatData.userId,
            channel: csatData.channel,
            botId: csatData.botId ?? '',
            score,
            surveyType: surveyType as 'csat' | 'nps' | 'likeDislike',
          });
          if (!result.success) {
            log.error('[VOICE-CSAT] Rating submission failed', {
              sessionId,
              score,
              error: result.error?.message ?? 'unknown',
              code: result.error?.code,
            });
          }
        },
        onComplete: (score) => {
          csatHandler.completeCsat(sessionId, sessionData, score).catch((err) => {
            log.error('CSAT completeCsat failed', {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          });

          if (transferTraceEmitter) {
            void Promise.resolve(
              transferTraceEmitter.emit({
                type: 'agent_transfer.csat_completed',
                timestamp: Date.now(),
                data: {
                  tenantId: event.tenantId,
                  projectId: csatProjectId,
                  contactId: csatData.userId,
                  provider: (event.data?.provider as string) ?? 'smartassist',
                  channel: csatData.channel,
                  runtimeSessionId: csatRuntimeSessionId,
                  score: typeof score === 'number' ? score : undefined,
                },
              }),
            ).catch((err) =>
              log.warn('Failed to emit csat_completed trace', {
                sessionId,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        },
        onSkip: (reason) => {
          csatHandler.skipCsat(sessionId, sessionData, reason).catch((err) => {
            log.error('CSAT skipCsat failed', {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        },
      });
    } finally {
      activeCsatSessions.delete(sessionId);
    }
  });

  log.info('Voice CSAT runner wired to message bridge');

  // 3b. Register Five9Adapter
  // Five9Adapter.initialize() is called lazily on first execute() —
  // it needs per-connection config which is only available at transfer time.
  // Unlike Kore (which has global smartassist config), Five9 credentials are
  // per-connection.
  const five9Adapter = new Five9Adapter(undefined, storeHandle);
  adapterRegistry.register('five9', five9Adapter);

  five9Adapter.onAgentMessage(async (event) => {
    const session = await transferSessionStore!.getByProvider(
      'five9',
      event.tenantId,
      event.sessionId,
    );
    if (!session) {
      log.warn('No session found for Five9 agent message — dropping event', {
        tenantId: event.tenantId,
        providerSessionId: event.sessionId,
      });
      return;
    }
    const ablKey = sessionKey(
      session.tenantId,
      resolveTransferSessionOwnerId(session),
      session.channel,
    );
    await bridge.routeAgentEvent(ablKey, { ...event, sessionId: ablKey });
  });
  five9Adapter.onSessionEvent(async (event) => {
    await bridge.routeAgentEvent(event.sessionId, event);
  });

  log.info('Five9Adapter registered with message bridge');

  // 4. Session recovery service
  sessionRecoveryService = new SessionRecoveryService(
    redis,
    hostname(),
    transferSessionStore,
    adapterRegistry,
  );
  await sessionRecoveryService.start();
  log.info('Session recovery service started', { hostname: hostname() });

  // 5. Wire trace events to platform TraceStore
  try {
    const traceStore = getTraceStore();
    transferTraceEmitter = createEventStoreTraceAdapter(traceStore);
    log.info('Transfer trace emitter wired to TraceStore');
  } catch (err) {
    log.warn('Failed to wire transfer trace emitter — trace events will not be persisted', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 6. Wire session timeout scheduler (BullMQ)
  try {
    timeoutQueueComponents = createSessionTimeoutQueue(getRedisHandle()!, async (sessionKey) => {
      log.info('Session timeout — ending session', { sessionKey });
      await transferSessionStore!.end(sessionKey);
    });
    log.info('Session timeout scheduler wired');
  } catch (err) {
    log.warn('Failed to create session timeout queue', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 7. Wire durable event queue (BullMQ)
  try {
    const messageBridge = getMessageBridge();
    eventQueueComponents = createEventQueue(getRedisHandle()!, async (job) => {
      if (messageBridge) {
        // Map AgentDesktopEventType (underscore) to AgentEventType (colon)
        const eventTypeMap: Record<string, string> = {
          agent_message: 'agent:message',
          agent_connected: 'agent:connected',
          agent_disconnected: 'agent:disconnected',
          agent_call_status: 'agent:call_status',
          agent_waiting_message: 'agent:waiting_message',
          agent_typing: 'agent:typing',
          session_closed: 'agent:disconnected',
        };
        const mappedType = eventTypeMap[job.eventType];
        if (!mappedType) {
          log.warn('Unmapped agent desktop event type — passing through as-is', {
            eventType: job.eventType,
            sessionKey: job.sessionKey,
          });
        }

        await messageBridge.routeAgentEvent(job.sessionKey, {
          type: (mappedType ?? job.eventType) as AgentEventType,
          sessionId: job.sessionKey,
          tenantId: job.tenantId,
          contactId: job.contactId,
          channel: job.channel as TransferChannel,
          timestamp: new Date(job.timestamp).toISOString(),
          data: job.payload,
        });
      }
    });
    log.info('Durable event queue wired');
  } catch (err) {
    log.warn('Failed to create durable event queue', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 8. Subscribe to Redis keyspace notifications for expired session keys.
  // When a session hash expires (TTL), SREM it from at_active_sessions to prevent unbounded growth.
  try {
    // Use a dedicated subscriber connection (psubscribe blocks the connection).
    // Cluster-aware via createSubscriber(handle); falls back to redis.duplicate()
    // when running in test mode without an initialized handle.
    const handle = getRedisHandle();
    keyspaceSubscriber = handle
      ? createSubscriber(handle)
      : // eslint-disable-next-line no-restricted-syntax -- test-only fallback; production uses createSubscriber(handle)
        (redis as { duplicate(): RedisClient }).duplicate();
    // Enable expired-event notifications if not already configured.
    // NOTE: CONFIG SET may fail on managed Redis services (e.g. AWS ElastiCache,
    // Azure Cache) where CONFIG is disabled. In that case, set
    // notify-keyspace-events=Ex via the cloud provider's parameter group/config.
    await (redis as unknown as { config(...args: string[]): Promise<unknown> }).config(
      'SET',
      'notify-keyspace-events',
      'Ex',
    );
    // NOTE: In Redis Cluster, keyspace notifications are node-local — each shard
    // emits events only for keys it owns. createSubscriber(handle) subscribes to
    // all masters, so expired events from any shard are received. The psubscribe
    // pattern covers all DBs (db0 is the only one used in cluster mode).
    const pattern = '__keyevent@*__:expired';
    await keyspaceSubscriber.psubscribe(pattern);
    keyspaceSubscriber.on('pmessage', (_pattern: string, _channel: string, expiredKey: string) => {
      if (expiredKey.startsWith('agent_transfer:')) {
        redis.srem(ACTIVE_SESSIONS_SET, expiredKey).catch((err) => {
          log.error('Failed to SREM expired session from active set', {
            key: expiredKey,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    });
    log.info('Subscribed to Redis keyspace expired events for session cleanup');
  } catch (err) {
    log.warn(
      'Failed to subscribe to keyspace notifications — at_active_sessions may grow unbounded',
      {
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }

  initialized = true;
  log.info('Agent transfer subsystem initialized');
}

// ── Shutdown ────────────────────────────────────────────────────────────────

export async function shutdownAgentTransfer(): Promise<void> {
  if (!initialized) return;

  log.info('Shutting down agent transfer subsystem');

  // 1. Stop accepting new work
  if (sessionRecoveryService) {
    await sessionRecoveryService.stop();
    sessionRecoveryService = null;
  }

  // 2. Drain queue workers BEFORE closing adapters — in-flight jobs may
  //    still need adapter connections to deliver messages.
  if (timeoutQueueComponents) {
    await closeSessionTimeoutQueue(timeoutQueueComponents);
    timeoutQueueComponents = null;
  }

  if (eventQueueComponents) {
    await closeEventQueue(eventQueueComponents);
    eventQueueComponents = null;
  }

  // 3. Close adapters (drains HTTP connection pools) then unregister
  if (adapterRegistry) {
    for (const name of adapterRegistry.listNames()) {
      const adapter = adapterRegistry.get(name);
      if (adapter?.close) {
        try {
          await adapter.close();
          log.info('Adapter closed', { name });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn('Adapter close failed', { name, error: message });
        }
      }
      adapterRegistry.unregister(name);
    }
    adapterRegistry = null;
  }

  // 4. Stop cross-pod relay
  const bridge = getMessageBridge();
  if (bridge) {
    await bridge.stopCrossPodRelay();
  }

  // 5. Disconnect keyspace subscriber
  if (keyspaceSubscriber) {
    try {
      await keyspaceSubscriber.punsubscribe();
      keyspaceSubscriber.disconnect();
    } catch (err) {
      log.warn('Failed to disconnect keyspace subscriber', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    keyspaceSubscriber = null;
  }

  transferSessionStore = null;
  transferTraceEmitter = null;
  storedConfig = null;
  initialized = false;
  initPromise = null;
  log.info('Agent transfer subsystem shut down');
}
