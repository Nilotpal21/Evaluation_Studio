/**
 * KoreAdapter
 *
 * Agent desktop adapter for Kore SmartAssist.
 * Handles the full transfer lifecycle: pre-checks, transfer
 * initiation, message routing, and session cleanup.
 */
import { createLogger } from '@abl/compiler/platform';
import type { ProviderConfig, SmartAssistConfig } from '../../config/schema.js';
import type {
  TransferPayload,
  TransferResult,
  UserMessage,
  AgentMessageHandler,
  SessionEventHandler,
  TransferChannel,
  OperationResult,
} from '../../types.js';
import {
  buildTransferContextSnapshot,
  buildTransferRoutingContext,
  resolveTransferOwnerId,
} from '../../types.js';
import type { AgentDesktopAdapter, AdapterCapabilities, CsatRatingParams } from '../interface.js';
import { sessionKey } from '../../session/types.js';
import { SmartAssistClient, type CircuitBreakerHandle } from './smartassist-client.js';
import { KoreEventHandler, type XOEvent } from './event-handler.js';

const log = createLogger('kore-adapter');

const MAX_HANDLERS = 10;

function hasAcwData(event: XOEvent): boolean {
  const data = event.data;
  return Boolean(
    data?.isACWEnabled === true || data?.dispositionSets || data?.closeRemarks || data?.closeStatus,
  );
}

function hasPendingAcw(session: Record<string, string> | null): boolean {
  return session?.acwExpected === 'true' && session.acwCompletedEmitted !== 'true';
}

export interface TransferSessionStoreHandle {
  create(params: {
    tenantId: string;
    projectId: string;
    ownerId?: string;
    contactId: string;
    channel: TransferChannel;
    provider: string;
    providerSessionId?: string;
    agentId: string;
    metadata?: Record<string, unknown>;
    providerData?: Record<string, unknown>;
    routing?: TransferPayload['routing'];
    contextSnapshot?: TransferPayload['contextSnapshot'];
    voiceData?: { callSid: string; sipCallId?: string };
  }): Promise<{
    success: boolean;
    sessionKey?: string;
    error?: { code: string; message: string };
  }>;
  get(key: string): Promise<Record<string, string> | null>;
  end(sessionKey: string): Promise<void>;
  extendTTL(sessionKey: string): Promise<void>;
  getByProvider(
    provider: string,
    tenantId: string,
    providerSessionId: string,
  ): Promise<Record<string, string> | null>;
  addProviderAlias?(
    provider: string,
    aliasTenantId: string,
    providerSessionId: string,
    sessionKey: string,
    ttl?: number,
  ): Promise<void>;
}

export class KoreAdapter implements AgentDesktopAdapter {
  readonly name = 'kore';
  readonly capabilities: AdapterCapabilities = {
    supportsPreChecks: true,
    supportsPostAgentDialog: true,
    supportsFileUpload: true,
    supportsTranslation: false,
    transportType: 'webhook',
    authType: 'internal_key',
  };

  private client: SmartAssistClient | null = null;
  private sessionStore: TransferSessionStoreHandle | null = null;
  private readonly eventHandler = new KoreEventHandler();
  private readonly sessionEventHandlers: SessionEventHandler[] = [];
  private onOrgIdResolved?: (orgId: string, accountId?: string) => Promise<void>;

  constructor(
    private smartAssistConfig?: SmartAssistConfig,
    sessionStore?: TransferSessionStoreHandle,
    circuitBreaker?: CircuitBreakerHandle,
  ) {
    if (smartAssistConfig) {
      this.client = new SmartAssistClient(smartAssistConfig, circuitBreaker);
    }
    if (sessionStore) {
      this.sessionStore = sessionStore;
    }
  }

  async initialize(config: ProviderConfig): Promise<void> {
    // Merge connection credentials (from UI) over .env config.
    // Priority: connection credentials first, then smartAssistConfig (loaded from .env at startup),
    // then process.env directly (handles the case where only SMARTASSIST_API_KEY is set but not
    // SMARTASSIST_API_URL, which prevents the env block from loading into smartAssistConfig).
    const auth = config.auth as Record<string, unknown> | undefined;
    if (auth && (auth.baseUrl || auth.apiKey || auth.koreApiKey)) {
      const merged: SmartAssistConfig = {
        baseUrl: (auth.baseUrl as string) || this.smartAssistConfig?.baseUrl || '',
        apiKey:
          (auth.apiKey as string) ||
          this.smartAssistConfig?.apiKey ||
          process.env.SMARTASSIST_API_KEY ||
          '',
        timeoutMs: (auth.timeoutMs as number) || this.smartAssistConfig?.timeoutMs || 5000,
        webhookSecret: (auth.webhookSecret as string) || this.smartAssistConfig?.webhookSecret,
        appId: (auth.appId as string) || this.smartAssistConfig?.appId,
        hoursId: (auth.hoursId as string) || this.smartAssistConfig?.hoursId,
        orgId: (auth.orgId as string) || undefined,
        accountId: (auth.accountId as string) || undefined,
        koreAccountId: (auth.koreAccountId as string) || this.smartAssistConfig?.koreAccountId,
        botSIPURI: (auth.botSIPURI as string) || this.smartAssistConfig?.botSIPURI,
        csatVoicePrompt:
          (auth.csatVoicePrompt as string) ||
          this.smartAssistConfig?.csatVoicePrompt ||
          'Please rate your experience with our agent. Press 1 for poor, 2 for fair, 3 for good, 4 for very good, or 5 for excellent. Press 0 to skip.',
        csatVoiceThankYou:
          (auth.csatVoiceThankYou as string) ||
          this.smartAssistConfig?.csatVoiceThankYou ||
          'Thank you for your feedback. Goodbye.',
        koreHost: (auth.koreHost as string) || this.smartAssistConfig?.koreHost,
        koreApiKey:
          (auth.koreApiKey as string) ||
          this.smartAssistConfig?.koreApiKey ||
          process.env.KORE_INTERNAL_API_KEY,
        ablWebhookBaseUrl:
          (auth.ablWebhookBaseUrl as string) || this.smartAssistConfig?.ablWebhookBaseUrl,
        initTransferPath: this.smartAssistConfig?.initTransferPath,
        eventHandlePath: this.smartAssistConfig?.eventHandlePath,
        circuitBreaker: this.smartAssistConfig?.circuitBreaker ?? {
          failureThreshold: 5,
          resetTimeoutMs: 30000,
          halfOpenMax: 3,
        },
        retry: this.smartAssistConfig?.retry ?? {
          maxAttempts: 2,
          backoffMs: 500,
          backoffMultiplier: 2,
        },
      };
      this.smartAssistConfig = merged;
      this.client = new SmartAssistClient(merged);
      log.info('KoreAdapter re-initialized with connection credentials', {
        provider: config.name,
        hasAppId: !!merged.appId,
        hasAccountId: !!merged.accountId,
      });
    } else if (!this.client && this.smartAssistConfig) {
      this.client = new SmartAssistClient(this.smartAssistConfig);
    }
    log.info('KoreAdapter initialized', { provider: config.name });
  }

  /** Get the underlying SmartAssistClient (for tools that need direct API access). */
  getSmartAssistClient(): SmartAssistClient | null {
    return this.client;
  }

  /** Get the resolved Kore orgId (may have been fetched lazily via getAccountIdByBotId). */
  getOrgId(): string | undefined {
    return this.smartAssistConfig?.orgId || this.smartAssistConfig?.accountId;
  }

  /** Set a callback invoked when orgId is lazily resolved from KoreServer,
   *  allowing the caller to persist orgId and accountId back to the connection DB. */
  setOnOrgIdResolved(cb: (orgId: string, accountId?: string) => Promise<void>): void {
    this.onOrgIdResolved = cb;
  }

  async execute(payload: TransferPayload): Promise<TransferResult> {
    if (!this.client) {
      return {
        success: false,
        status: 'failed',
        error: {
          code: 'ADAPTER_NOT_CONFIGURED',
          message: 'SmartAssist client not configured',
        },
      };
    }

    await this.resolveOrgId();

    const preCheckResult = await this.runPreChecks(payload);
    if (preCheckResult && !preCheckResult.success) {
      return preCheckResult;
    }

    const routing = buildTransferRoutingContext({
      runtimeSessionId: payload.routing?.runtimeSessionId ?? payload.sessionId,
      conversationSessionId: payload.routing?.conversationSessionId,
      resolvedContactId: payload.routing?.resolvedContactId ?? payload.contactId,
      channel: payload.channel,
      sourceChannelType: payload.routing?.sourceChannelType ?? payload.channel,
      channelConnectionId: payload.routing?.channelConnectionId,
      externalSessionKey: payload.routing?.externalSessionKey,
      voice:
        payload.routing?.voice ??
        (payload.voiceData
          ? {
              callSid: payload.voiceData.callSid,
              sipCallId: payload.voiceData.sipCallId,
            }
          : undefined),
    });
    const contextSnapshot =
      payload.contextSnapshot ??
      buildTransferContextSnapshot({
        contact: payload.contact,
        interactionContext: payload.language ? { language: payload.language } : undefined,
      });
    const ownerId = resolveTransferOwnerId({
      runtimeSessionId: routing.runtimeSessionId,
      contactId: payload.contactId,
    });

    // Create synthetic user in KoreServer before transfer initiation.
    // This provides a valid KoreServer userId (u-xxxx) for the conversations API
    // instead of ABL's internal contactId.
    let contactIdForTransfer = payload.contactId;
    const syntheticUserResult = await this.client.createSyntheticUser(payload.contactId);
    if (syntheticUserResult.success && syntheticUserResult.data?.userId) {
      contactIdForTransfer = syntheticUserResult.data.userId;
      log.info('Using synthetic userId for transfer', {
        originalContactId: payload.contactId,
        syntheticUserId: contactIdForTransfer,
      });
    } else {
      log.warn('Synthetic user creation failed — falling back to contactId', {
        contactId: payload.contactId,
        error: syntheticUserResult.error,
      });
    }

    const result = await this.client.initTransfer({
      agentId: payload.agentId,
      contactId: contactIdForTransfer,
      tenantId: payload.tenantId,
      projectId: payload.projectId,
      channel: routing.normalizedTransferChannel,
      queue: payload.queue,
      skills: payload.skills,
      priority: payload.priority,
      language: payload.language,
      conversationHistory: payload.conversationHistory,
      conversationSummaryForAgentTransfer: payload.conversationSummaryForAgentTransfer,
      metadata: payload.metadata,
      sourceAgentId: payload.sourceAgentId,
      customData: payload.customData,
      contact: payload.contact,
      voiceData: payload.voiceData,
    });

    if (!result.success) {
      return result;
    }

    log.info('Transfer initiated, creating session', {
      providerSessionId: result.providerSessionId,
      channel: routing.normalizedTransferChannel,
      tenantId: payload.tenantId,
      contactId: payload.contactId,
      ownerId,
    });

    if (this.sessionStore) {
      const sessionResult = await this.sessionStore.create({
        tenantId: payload.tenantId,
        projectId: payload.projectId,
        ownerId,
        contactId: payload.contactId,
        channel: routing.normalizedTransferChannel,
        provider: 'smartassist',
        providerSessionId: result.providerSessionId,
        agentId: payload.agentId,
        routing,
        contextSnapshot,
        metadata: {
          postAgentAction: result.csatSurveyRequired ? 'csat' : (payload.postAgentAction ?? 'end'),
          conversationSessionId: payload.sessionId,
          sourceAgentId: payload.sourceAgentId,
          parentAgentId: payload.parentAgentId,
        },
        providerData: {
          syntheticUserId: contactIdForTransfer,
          orgId:
            this.smartAssistConfig?.orgId || this.smartAssistConfig?.accountId || payload.tenantId,
          botId: this.smartAssistConfig?.appId || payload.agentId,
          ...(result.csatSurveyRequired
            ? { csatSurveyRequired: true, csatSurveyType: result.csatSurveyType ?? 'csat' }
            : {}),
          ...(payload.voiceData
            ? {
                callSid: payload.voiceData.callSid,
                sipCallId: payload.voiceData.sipCallId,
                caller: payload.voiceData.caller,
                called: payload.voiceData.called,
              }
            : {}),
        },
        ...(payload.voiceData
          ? {
              voiceData: {
                callSid: payload.voiceData.callSid,
                sipCallId: payload.voiceData.sipCallId,
              },
            }
          : {}),
      });

      if (!sessionResult.success) {
        log.error('Failed to create transfer session', {
          tenantId: payload.tenantId,
          contactId: payload.contactId,
          error: sessionResult.error,
        });
      } else {
        // Create an additional provider index keyed by Kore orgId so that
        // inbound webhooks (which carry the Kore orgId, not the ABL tenantId)
        // can locate the session via getByProvider().
        const koreOrgId = this.smartAssistConfig?.orgId || this.smartAssistConfig?.accountId;
        if (
          koreOrgId &&
          koreOrgId !== payload.tenantId &&
          sessionResult.sessionKey &&
          this.sessionStore.addProviderAlias
        ) {
          await this.sessionStore.addProviderAlias(
            'smartassist',
            koreOrgId,
            result.providerSessionId ?? '',
            sessionResult.sessionKey,
          );
          log.info('Created provider alias index for Kore orgId', {
            koreOrgId,
            ablTenantId: payload.tenantId,
            providerSessionId: result.providerSessionId,
          });
        }
      }
    }

    return {
      ...result,
      sessionId: sessionKey(payload.tenantId, ownerId, routing.normalizedTransferChannel),
    };
  }

  async sendUserMessage(sessionId: string, message: UserMessage): Promise<void> {
    if (!this.client) {
      throw new Error('SmartAssist client not configured');
    }

    const session = await this.resolveSession(sessionId);
    if (!session) {
      log.warn('Cannot forward user message — no active session', { sessionId });
      return;
    }

    const conversationId = session.providerSessionId;
    if (!conversationId) {
      log.warn('Cannot forward user message — no conversationId', { sessionId });
      return;
    }

    // Use synthetic userId (u-xxxx) as author — this matches the user
    // that was created in KoreServer and used to initiate the conversation.
    const authorId = session.syntheticUserId || session.contactId;

    // `experience` + `language` are hard-required by SmartAssist's
    // validateAgenticRequest (koreagentassist.js:7983). Missing them
    // short-circuits /execute with "Missing required keys".
    const eventPayload = {
      eventName: 'start_kore_agent_chat_message_for_agent' as const,
      payload: {
        conversationId,
        author: { id: authorId, type: 'USER' as const },
        orgId: session.orgId,
        botId: session.botId,
        type: 'text',
        value: message.content,
        event: 'user_message',
        experience: 'chat',
        language: 'en',
        attachments: message.attachments?.map((a) => ({
          url: a.url,
          name: a.name,
          mimeType: a.mimeType,
          size: a.size,
        })),
      },
      queryFields: { sid: sessionId, cId: conversationId },
    };

    log.info('Sending user message to SmartAssist', {
      sessionId,
      conversationId,
      contactId: session.contactId,
      contentLength: message.content.length,
      payload: JSON.stringify(eventPayload),
    });

    const result = await this.client.sendEvent(sessionId, conversationId, eventPayload);

    if (result.success) {
      log.info('User message sent to SmartAssist successfully', {
        sessionId,
        conversationId,
      });
    } else {
      log.error('Failed to forward user message to SmartAssist', {
        sessionId,
        conversationId,
        error: result.error,
      });
    }

    if (this.sessionStore) {
      await this.sessionStore.extendTTL(sessionId);
    }
  }

  async sendControlEvent(
    sessionId: string,
    eventType: 'typing' | 'stop_typing' | 'close_agent_chat' | 'message_read' | 'message_delivered',
  ): Promise<void> {
    if (!this.client) return;

    const session = await this.resolveSession(sessionId);
    if (!session) return;

    const conversationId = session.providerSessionId;
    if (!conversationId) return;

    const eventName =
      eventType === 'close_agent_chat'
        ? ('close_conversation' as const)
        : ('start_control_message_for_agent' as const);

    const authorId = session.syntheticUserId || session.contactId;

    await this.client.sendEvent(sessionId, conversationId, {
      eventName,
      payload: {
        conversationId,
        author: { id: authorId, type: 'USER' as const },
        event: eventType,
        experience: 'chat',
        language: 'en',
      },
      queryFields: { sid: sessionId, cId: conversationId },
    });
  }

  async endSession(sessionId: string, reason: string): Promise<void> {
    log.info('Ending transfer session', { sessionId, reason });

    // Notify SmartAssist (skip if agent initiated the close)
    if (this.client && reason !== 'agent_closed') {
      await this.sendControlEvent(sessionId, 'close_agent_chat').catch((err) => {
        log.warn('Failed to send close event to SmartAssist', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    if (this.sessionStore) {
      await this.sessionStore.end(sessionId);
    }
  }

  onAgentMessage(handler: AgentMessageHandler): void {
    if (this.eventHandler.handlerCount() >= MAX_HANDLERS) {
      log.warn('Max agent message handlers reached, ignoring', { max: MAX_HANDLERS });
      return;
    }
    this.eventHandler.onAgentMessage(handler);
  }

  onSessionEvent(handler: SessionEventHandler): void {
    if (this.sessionEventHandlers.length >= MAX_HANDLERS) {
      log.warn('Max session event handlers reached, ignoring', { max: MAX_HANDLERS });
      return;
    }
    this.sessionEventHandlers.push(handler);
  }

  async submitCsatRating(params: CsatRatingParams): Promise<OperationResult<{ message?: string }>> {
    if (!this.client) {
      return {
        success: false,
        error: { code: 'CLIENT_NOT_INITIALIZED', message: 'SmartAssist client not initialized' },
      };
    }
    return this.client.submitCsatRating(params);
  }

  async checkHealth(): Promise<boolean> {
    return this.client !== null;
  }

  /**
   * Gracefully close the adapter, draining the HTTP connection pool.
   */
  async close(): Promise<void> {
    log.info('Closing KoreAdapter');
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    this.eventHandler.clear();
    this.sessionEventHandlers.length = 0;
  }

  /**
   * Process an inbound XO event from SmartAssist webhook.
   * This is called by the runtime bridge when SmartAssist posts events.
   * Requires tenantId for tenant-isolated provider lookup.
   */
  async handleInboundEvent(xoEvent: XOEvent, tenantId: string): Promise<void> {
    if (!this.sessionStore) {
      log.warn('No session store configured, cannot resolve event context', {
        conversationId: xoEvent.conversationId,
      });
      return;
    }

    const session = await this.sessionStore.getByProvider(
      'smartassist',
      tenantId,
      xoEvent.conversationId,
    );
    if (!session) {
      log.warn('No active session for inbound event', {
        conversationId: xoEvent.conversationId,
        type: xoEvent.type,
        tenantId,
      });
      return;
    }

    // Extend TTL on every agent event
    let storedRouting: TransferPayload['routing'] | undefined;
    if (session['routing']) {
      try {
        storedRouting = JSON.parse(session['routing']) as TransferPayload['routing'];
      } catch {
        storedRouting = undefined;
      }
    }
    const resolvedKey = sessionKey(
      session['tenantId'],
      resolveTransferOwnerId({
        ownerId: session['ownerId'],
        runtimeSessionId: storedRouting?.runtimeSessionId,
        contactId: session['contactId'],
      }),
      session['channel'],
    );
    await this.sessionStore.extendTTL(resolvedKey);

    const messageText =
      xoEvent.message ||
      (xoEvent.payload?.value as string | undefined) ||
      (xoEvent.data?.value as string | undefined);
    log.info('Processing inbound agent event', {
      type: xoEvent.type,
      conversationId: xoEvent.conversationId,
      tenantId: session['tenantId'],
      contactId: session['contactId'],
      channel: session['channel'],
      message: messageText ? messageText.slice(0, 200) : undefined,
      agentInfo: xoEvent.agentInfo || xoEvent.payload?.agentInfo || undefined,
    });

    // For any agent-disconnect event, inject CSAT data from the session
    // so the frontend can display the survey card without a separate round-trip.
    // SmartAssist fires multiple event types when an agent disconnects — we must
    // inject CSAT data for all of them, not just remove_id_to_acc_identity.
    const DISCONNECT_EVENT_TYPES = new Set([
      'remove_id_to_acc_identity',
      'start_kore_agent_chat_close_for_user',
      'closed',
      'conversation_closed',
      'agent_disconnect',
    ]);
    // SmartAssist sometimes sends the close signal only as a chat message
    // ("X has now closed this conversation") without a dedicated close event.
    // The event handler synthesizes agent:disconnected from that pattern, but
    // it copies the xoEvent.data at that point — so we must inject CSAT data
    // here before processEvent runs, or the synthetic disconnect arrives with
    // no csatRequired flag and the call is hung up before CSAT can run.
    const rawCloseMsg =
      xoEvent.message ||
      (xoEvent.payload?.value as string | undefined) ||
      (xoEvent.data?.value as string | undefined);
    const isCloseMessage =
      typeof rawCloseMsg === 'string' && /has now closed this conversation/i.test(rawCloseMsg);
    let eventToProcess = xoEvent;
    if (DISCONNECT_EVENT_TYPES.has(xoEvent.type) || isCloseMessage) {
      const providerDataStr = session['providerData'];
      if (providerDataStr && providerDataStr !== '[object Object]') {
        try {
          const pd = JSON.parse(providerDataStr) as Record<string, unknown>;
          if (pd?.csatSurveyRequired) {
            eventToProcess = {
              ...xoEvent,
              data: {
                ...xoEvent.data,
                csatRequired: true,
                csatSurveyType: pd.csatSurveyType ?? 'csat',
                userId: session['contactId'],
                iId: pd.botId,
                orgId: pd.orgId,
                conversationId: xoEvent.conversationId,
                source: session['channel'],
              },
            };
          }
        } catch {
          // Proceed with unmodified event if providerData cannot be parsed
        }
      }
    }

    await this.eventHandler.processEvent(eventToProcess, {
      tenantId: session['tenantId'],
      contactId: session['contactId'],
      channel: session['channel'] as TransferChannel,
    });

    // Handle disconnect -> post-agent action
    if (DISCONNECT_EVENT_TYPES.has(xoEvent.type)) {
      let postAction: string = 'end';
      const metadataStr = session['metadata'];
      if (metadataStr && metadataStr !== '[object Object]') {
        try {
          const meta = JSON.parse(metadataStr);
          postAction = meta?.postAgentAction ?? 'end';
        } catch {
          /* use default */
        }
      }
      if (postAction === 'end') {
        const latestSession = await this.sessionStore.get(resolvedKey);
        if (hasAcwData(eventToProcess) || hasPendingAcw(latestSession)) {
          log.info('Deferring transfer session cleanup until ACW data arrives', {
            sessionKey: resolvedKey,
            type: xoEvent.type,
            hasAcwData: hasAcwData(eventToProcess),
            acwExpected: latestSession?.acwExpected,
          });
          return;
        }
        await this.sessionStore.end(resolvedKey);
      }
    }
  }

  /**
   * Resolve session data from the session store by session key.
   */
  private async resolveSession(sessionId: string): Promise<{
    providerSessionId: string;
    contactId: string;
    syntheticUserId?: string;
    orgId?: string;
    botId?: string;
  } | null> {
    if (!this.sessionStore) {
      return null;
    }

    const session = await this.sessionStore.get(sessionId);
    if (!session) {
      return null;
    }

    // providerData is stored as JSON string — parse to extract stored fields
    let syntheticUserId: string | undefined;
    let orgId: string | undefined;
    let botId: string | undefined;
    const providerDataStr = session['providerData'];
    if (providerDataStr && providerDataStr !== '[object Object]') {
      try {
        const pd = JSON.parse(providerDataStr);
        syntheticUserId = pd?.syntheticUserId;
        orgId = pd?.orgId;
        botId = pd?.botId;
      } catch {
        /* ignore parse errors */
      }
    }

    return {
      providerSessionId: session['providerSessionId'] ?? '',
      contactId: session['contactId'] ?? '',
      syntheticUserId,
      orgId,
      botId,
    };
  }

  /**
   * Resolve orgId lazily: if the connection config already has orgId, skip.
   * Otherwise fetch it from KoreServer using appId as streamId and cache
   * on the in-memory config so subsequent calls (prechecks, initTransfer,
   * session creation) use it.
   */
  private async resolveOrgId(): Promise<void> {
    if (this.smartAssistConfig?.orgId || this.smartAssistConfig?.accountId) {
      return;
    }

    const appId = this.smartAssistConfig?.appId;
    if (!appId || !this.client) {
      log.warn('Cannot resolve orgId — appId or client not available');
      return;
    }

    log.info('orgId not configured, fetching from KoreServer', { appId });
    const result = await this.client.getAccountIdByBotId(appId);
    if (result.success && result.data) {
      const { orgId, accountId } = result.data;
      this.smartAssistConfig!.orgId = orgId;
      if (accountId) {
        this.smartAssistConfig!.accountId = accountId;
      }
      log.info('orgId resolved and cached in adapter config', { orgId, accountId });

      if (this.onOrgIdResolved) {
        try {
          await this.onOrgIdResolved(orgId, accountId);
        } catch (err) {
          log.warn('Failed to persist resolved orgId to connection DB', {
            orgId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } else {
      log.warn('Failed to resolve orgId from KoreServer — proceeding without it', {
        appId,
        error: result.error,
      });
    }
  }

  private async runPreChecks(payload: TransferPayload): Promise<TransferResult | null> {
    if (!this.client) return null;

    const hoursId = payload.metadata?.['hoursId'] as string | undefined;
    if (hoursId) {
      const hoursResult = await this.client.checkBusinessHours(hoursId);
      const hoursData = hoursResult.data as Record<string, unknown> | undefined;
      if (!hoursResult.success || !hoursData || hoursData.isValid !== true) {
        return {
          success: false,
          status: 'outside_hours',
          error: hoursResult.error ?? {
            code: 'OUTSIDE_HOURS',
            message: 'Outside business hours',
          },
        };
      }
    }

    // Skip availability check when a queue is specified — the queue
    // will hold the conversation until an agent becomes available.
    if (!payload.queue) {
      const availResult = await this.client.checkAgentAvailability({
        agentId: payload.agentId,
        contactId: payload.contactId,
        tenantId: payload.tenantId,
        projectId: payload.projectId,
        skills: payload.skills,
        queue: payload.queue,
        language: payload.language,
      });
      const availData = availResult.data as Record<string, unknown> | undefined;
      if (!availResult.success || !availData || availData.agentAvailability !== true) {
        return {
          success: false,
          status: 'no_agents',
          error: availResult.error ?? {
            code: 'NO_AGENTS',
            message: 'No agents available',
          },
        };
      }
    }

    if (payload.queue) {
      const queueResult = await this.client.validateQueue(payload.queue);
      const queueData = queueResult.data as Record<string, unknown> | undefined;
      if (!queueResult.success || !queueData || queueData.isValid !== true) {
        return {
          success: false,
          status: 'queue_invalid',
          error: queueResult.error ?? {
            code: 'QUEUE_INVALID',
            message: `Queue '${payload.queue}' is not valid`,
          },
        };
      }
    }

    return null;
  }
}
