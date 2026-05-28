/**
 * Five9Adapter
 *
 * Agent desktop adapter for Five9 Virtual Contact Center.
 * Handles the full transfer lifecycle: authentication, conversation
 * creation, message routing, and session cleanup via Five9 REST API.
 *
 * initialize() is called lazily on the first execute(), not at boot —
 * credentials are per-connection config resolved from ProviderConfig.
 */
import { createLogger } from '@abl/compiler/platform';
import { Five9ProviderConfigSchema } from '../../config/schema.js';
import type { ProviderConfig } from '../../config/schema.js';
import type {
  TransferPayload,
  TransferResult,
  UserMessage,
  AgentMessageHandler,
  SessionEventHandler,
  AgentEvent,
  TransferChannel,
} from '../../types.js';
import {
  buildTransferContextSnapshot,
  buildTransferRoutingContext,
  resolveTransferOwnerId,
} from '../../types.js';
import type { AgentDesktopAdapter, AdapterCapabilities } from '../interface.js';
import type { TransferSessionStoreHandle } from '../kore/index.js';
import type { XOEvent } from '../kore/event-handler.js';
import { sessionKey } from '../../session/types.js';
import { Five9Client } from './five9-client.js';
import { Five9EventHandler } from './five9-event-handler.js';
import type { Five9Credentials } from './types.js';

const log = createLogger('five9-adapter');

const MAX_HANDLERS = 10;

export class Five9Adapter implements AgentDesktopAdapter {
  readonly name = 'five9';
  readonly capabilities: AdapterCapabilities = {
    supportsPreChecks: false,
    supportsPostAgentDialog: false,
    supportsFileUpload: false,
    supportsTranslation: false,
    transportType: 'webhook',
    authType: 'bearer',
  };

  private client: Five9Client | null = null;
  private clientCredentials: Five9Credentials | null = null;
  private sessionStore: TransferSessionStoreHandle | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly agentMessageHandlers: AgentMessageHandler[] = [];
  private readonly sessionEventHandlers: SessionEventHandler[] = [];

  constructor(
    private readonly credentials?: Five9Credentials,
    sessionStore?: TransferSessionStoreHandle,
    fetchFn?: typeof fetch,
  ) {
    if (sessionStore) {
      this.sessionStore = sessionStore;
    }
    this.fetchFn = fetchFn ?? fetch;
    if (credentials) {
      this.clientCredentials = credentials;
      this.client = new Five9Client(credentials, this.fetchFn);
    }
  }

  /**
   * Initialize the adapter from a ProviderConfig.
   * Called lazily on first execute(), not at boot — credentials are
   * per-connection config resolved from the provider's auth bag.
   */
  async initialize(config: ProviderConfig): Promise<void> {
    const parsed = Five9ProviderConfigSchema.safeParse(config.auth);
    if (!parsed.success) {
      throw new Error(`Invalid Five9 provider config: ${parsed.error.message}`);
    }

    const creds: Five9Credentials = {
      tenantName: parsed.data.tenantName,
      campaignName: parsed.data.campaignName,
      host: parsed.data.host,
      authMode: parsed.data.authMode,
      username: parsed.data.username,
      password: parsed.data.password,
      callbackUrl: parsed.data.callbackUrl,
    };

    this.clientCredentials = creds;
    this.client = new Five9Client(creds, this.fetchFn);
    log.info('Five9Adapter initialized', {
      provider: config.name,
      tenantName: creds.tenantName,
      campaignName: creds.campaignName,
      host: creds.host,
      authMode: creds.authMode,
      hasUsername: !!creds.username,
      hasPassword: !!creds.password,
      callbackUrl: creds.callbackUrl ?? '(not set)',
    });
  }

  async execute(payload: TransferPayload): Promise<TransferResult> {
    log.info('Five9 execute() request payload', {
      tenantId: payload.tenantId,
      projectId: payload.projectId,
      contactId: payload.contactId,
      sessionId: payload.sessionId,
      channel: payload.channel,
      agentId: payload.agentId,
      queue: payload.queue,
      skills: payload.skills,
      priority: payload.priority,
      postAgentAction: payload.postAgentAction,
      metadata: payload.metadata,
      conversationHistoryLength: payload.conversationHistory?.length ?? 0,
    });

    if (!this.client || !this.clientCredentials) {
      log.error('Five9 execute() failed — adapter not configured', {
        tenantId: payload.tenantId,
        sessionId: payload.sessionId,
        hasClient: !!this.client,
        hasCredentials: !!this.clientCredentials,
      });
      return {
        success: false,
        status: 'failed',
        error: {
          code: 'ADAPTER_NOT_CONFIGURED',
          message: 'Five9 client not configured',
        },
      };
    }

    const routing = buildTransferRoutingContext({
      runtimeSessionId: payload.routing?.runtimeSessionId ?? payload.sessionId,
      conversationSessionId: payload.routing?.conversationSessionId,
      resolvedContactId: payload.routing?.resolvedContactId ?? payload.contactId,
      channel: payload.channel,
      sourceChannelType: payload.routing?.sourceChannelType ?? payload.channel,
      channelConnectionId: payload.routing?.channelConnectionId,
      externalSessionKey: payload.routing?.externalSessionKey,
      voice: payload.routing?.voice,
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

    // Step 1: Authenticate with Five9
    log.info('Five9 step 1: authenticating', {
      tenantId: payload.tenantId,
      sessionId: payload.sessionId,
    });
    let authResult;
    try {
      authResult = await this.client.authenticate();
      log.info('Five9 step 1: authentication succeeded', {
        tenantId: payload.tenantId,
        sessionId: payload.sessionId,
        targetHost: authResult.targetHost,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Five9 step 1: authentication failed', {
        tenantId: payload.tenantId,
        contactId: payload.contactId,
        sessionId: payload.sessionId,
        error: message,
      });
      return {
        success: false,
        status: 'failed',
        error: { code: 'FIVE9_AUTH_FAILED', message },
      };
    }

    // Step 2: Discover metadata to resolve target host
    log.info('Five9 step 2: discovering metadata', {
      tenantId: payload.tenantId,
      sessionId: payload.sessionId,
    });
    let metadata;
    try {
      metadata = await this.client.discoverMetadata(authResult.targetHost, authResult.tokenId);
      log.info('Five9 step 2: metadata discovery succeeded', {
        tenantId: payload.tenantId,
        sessionId: payload.sessionId,
        targetHost: metadata.targetHost,
        farmId: metadata.farmId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Five9 step 2: metadata discovery failed', {
        tenantId: payload.tenantId,
        sessionId: payload.sessionId,
        error: message,
      });
      return {
        success: false,
        status: 'failed',
        error: { code: 'FIVE9_METADATA_FAILED', message },
      };
    }

    // Step 3: Check agent availability before creating conversation
    // Use the original auth host (e.g. app.five9.com) — the metadata-resolved datacenter
    // host (e.g. app-scl.five9.com) may not be ready yet (service migration in progress).
    // Pre-check: log the payloads that will be sent to Five9
    // Build conversation and sendMessage payloads early for visibility
    {
      const preCheckHistoryLines = (payload.conversationHistory ?? [])
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n');
      const preCheckFirstName =
        payload.contact?.firstName ?? payload.contact?.displayName?.split(' ')[0] ?? 'Anonymous';
      const preCheckLastName =
        payload.contact?.lastName ??
        (payload.contact?.displayName?.split(' ').slice(1).join(' ') || null) ??
        'User';
      const lastUserMsg = (payload.conversationHistory ?? [])
        .filter((m) => m.role === 'user')
        .pop()?.content;
      const preCheckQuestion =
        (payload.metadata?.reason ? String(payload.metadata.reason) : null) ??
        lastUserMsg ??
        'I need help';
      const preCheckAttrs: Record<string, string> = { question: preCheckQuestion };
      if (preCheckHistoryLines) preCheckAttrs['Custom.external_history'] = preCheckHistoryLines;
      if (payload.contact?.email) preCheckAttrs['Custom.email'] = payload.contact.email;
      if (payload.contact?.phone) preCheckAttrs['Custom.phone'] = payload.contact.phone;
      if (payload.contact?.customerId)
        preCheckAttrs['Custom.customerId'] = payload.contact.customerId;
      if (payload.contactId) preCheckAttrs['Custom.contactId'] = payload.contactId;

      log.info('Five9 pre-check: createConversation payload preview', {
        tenantId: payload.tenantId,
        sessionId: payload.sessionId,
        conversationPayload: {
          campaignName: this.clientCredentials.campaignName,
          tenantId: metadata.orgId,
          tenantName: this.clientCredentials.tenantName,
          type: 'Generic',
          contact: { firstName: preCheckFirstName, lastName: preCheckLastName },
          attributes: preCheckAttrs,
        },
      });

      log.info('Five9 pre-check: sendMessage payload preview', {
        tenantId: payload.tenantId,
        sessionId: payload.sessionId,
        sendMessagePayload: {
          messageType: 'TEXT',
          message: lastUserMsg ?? '(no user message yet)',
        },
      });
    }

    log.info('Five9 step 3: checking agent availability', {
      tenantId: payload.tenantId,
      sessionId: payload.sessionId,
      campaignName: this.clientCredentials.campaignName,
      authHost: authResult.targetHost,
      metadataHost: metadata.targetHost,
    });
    try {
      let profiles;
      try {
        profiles = await this.client.checkAgentAvailability(
          authResult.targetHost,
          metadata.tokenId,
          [this.clientCredentials.campaignName],
        );
      } catch (firstErr) {
        // If auth host fails, retry on metadata-resolved host
        log.warn(
          'Five9 step 3: availability check failed on auth host, retrying on metadata host',
          {
            authHost: authResult.targetHost,
            metadataHost: metadata.targetHost,
            error: firstErr instanceof Error ? firstErr.message : String(firstErr),
          },
        );
        profiles = await this.client.checkAgentAvailability(metadata.targetHost, metadata.tokenId, [
          this.clientCredentials.campaignName,
        ]);
      }
      const hasAgentLoggedIn = profiles.some((p) => p.agentLoggedIn === true);
      log.info('Five9 step 3: agent availability result', {
        tenantId: payload.tenantId,
        sessionId: payload.sessionId,
        hasAgentLoggedIn,
        profiles: profiles.map((p) => ({
          profileName: p.profileName,
          agentLoggedIn: p.agentLoggedIn,
          openForBusiness: p.openForBusiness,
        })),
      });
      if (!hasAgentLoggedIn) {
        const noServiceMessage =
          'We are currently unable to service your request. Please contact us during normal business hours.';
        log.warn('Five9 step 3: no agents logged in — blocking transfer', {
          tenantId: payload.tenantId,
          sessionId: payload.sessionId,
          campaignName: this.clientCredentials.campaignName,
        });
        return {
          success: false,
          status: 'failed',
          error: {
            code: 'FIVE9_NO_AGENTS_AVAILABLE',
            message: noServiceMessage,
          },
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Five9 step 3: agent availability check failed (proceeding with transfer)', {
        tenantId: payload.tenantId,
        sessionId: payload.sessionId,
        error: message,
      });
      // Non-fatal: proceed with conversation creation even if availability check fails
    }

    // Step 4: Create conversation on Five9
    // Resolve callback URL: explicit config → auto-construct from RUNTIME_BASE_URL
    let callbackUrl = this.clientCredentials.callbackUrl;
    if (!callbackUrl) {
      const runtimeBaseUrl = process.env.RUNTIME_BASE_URL || process.env.BASE_URL;
      if (runtimeBaseUrl) {
        callbackUrl = `${runtimeBaseUrl.replace(/\/+$/, '')}/api/v1/agent-transfer/webhooks/five9?tid=${encodeURIComponent(payload.tenantId)}`;
      }
    }

    log.info('Five9 step 4: creating conversation', {
      tenantId: payload.tenantId,
      sessionId: payload.sessionId,
      campaignName: this.clientCredentials.campaignName,
      callbackUrl: callbackUrl ?? '(not set)',
    });
    // Build conversation history summary for Five9 attributes
    const historyLines = (payload.conversationHistory ?? [])
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');

    // Resolve contact details — use payload contact if available, fallback to defaults
    const contactFirstName =
      payload.contact?.firstName ?? payload.contact?.displayName?.split(' ')[0] ?? 'Anonymous';
    const contactLastName =
      payload.contact?.lastName ??
      (payload.contact?.displayName?.split(' ').slice(1).join(' ') || null) ??
      'User';

    let conversation;
    try {
      // Resolve question: metadata reason → last user message → default
      const lastUserMessage = (payload.conversationHistory ?? [])
        .filter((m) => m.role === 'user')
        .pop()?.content;
      const question =
        (payload.metadata?.reason ? String(payload.metadata.reason) : null) ??
        lastUserMessage ??
        'I need help';
      const attributes: Record<string, string> = { question };
      if (historyLines) attributes['Custom.external_history'] = historyLines;
      if (payload.contact?.email) attributes['Custom.email'] = payload.contact.email;
      if (payload.contact?.phone) attributes['Custom.phone'] = payload.contact.phone;
      if (payload.contact?.customerId) attributes['Custom.customerId'] = payload.contact.customerId;
      if (payload.contactId) attributes['Custom.contactId'] = payload.contactId;

      conversation = await this.client.createConversation(metadata.targetHost, metadata.tokenId, {
        campaignName: this.clientCredentials.campaignName,
        tenantId: metadata.orgId,
        tenantName: this.clientCredentials.tenantName,
        callbackUrl,
        type: 'Generic',
        contact: { firstName: contactFirstName, lastName: contactLastName },
        attributes,
      });
      log.info('Five9 step 4: conversation created', {
        tenantId: payload.tenantId,
        sessionId: payload.sessionId,
        conversationId: conversation.conversationId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Five9 step 4: conversation creation failed', {
        tenantId: payload.tenantId,
        contactId: payload.contactId,
        sessionId: payload.sessionId,
        error: message,
      });
      return {
        success: false,
        status: 'failed',
        error: { code: 'FIVE9_CONVERSATION_CREATE_FAILED', message },
      };
    }

    // Step 5: Store session with providerData
    log.info('Five9 step 5: storing transfer session', {
      tenantId: payload.tenantId,
      sessionId: payload.sessionId,
      conversationId: conversation.conversationId,
    });
    if (this.sessionStore) {
      const sessionResult = await this.sessionStore.create({
        tenantId: payload.tenantId,
        projectId: payload.projectId,
        ownerId,
        contactId: payload.contactId,
        channel: routing.normalizedTransferChannel,
        provider: 'five9',
        providerSessionId: conversation.conversationId,
        agentId: payload.agentId,
        routing,
        contextSnapshot,
        metadata: {
          postAgentAction: payload.postAgentAction ?? 'end',
          conversationSessionId: payload.sessionId,
          sourceAgentId: payload.sourceAgentId,
          parentAgentId: payload.parentAgentId,
        },
        providerData: {
          token: metadata.tokenId,
          targetHost: metadata.targetHost,
          farmId: metadata.farmId,
          orgId: metadata.orgId,
        },
      });

      if (!sessionResult.success) {
        log.error('Five9 step 5: failed to create transfer session', {
          tenantId: payload.tenantId,
          contactId: payload.contactId,
          sessionId: payload.sessionId,
          error: sessionResult.error,
        });
      } else {
        log.info('Five9 step 5: transfer session stored', {
          tenantId: payload.tenantId,
          sessionId: payload.sessionId,
          conversationId: conversation.conversationId,
        });
      }
    } else {
      log.warn('Five9 step 5: no session store configured, skipping session persistence', {
        tenantId: payload.tenantId,
        sessionId: payload.sessionId,
      });
    }

    const transferSessionKey = sessionKey(
      payload.tenantId,
      ownerId,
      routing.normalizedTransferChannel,
    );
    log.info('Five9 transfer completed successfully', {
      tenantId: payload.tenantId,
      projectId: payload.projectId,
      sessionId: payload.sessionId,
      contactId: payload.contactId,
      channel: routing.normalizedTransferChannel,
      conversationId: conversation.conversationId,
      transferSessionKey,
    });

    const result: TransferResult = {
      success: true,
      status: 'transferred',
      sessionId: transferSessionKey,
      providerSessionId: conversation.conversationId,
    };
    log.info('Five9 execute() response result', {
      success: result.success,
      status: result.status,
      sessionId: result.sessionId,
      providerSessionId: result.providerSessionId,
    });
    return result;
  }

  async sendUserMessage(sessionId: string, message: UserMessage): Promise<void> {
    log.info('Five9 sendUserMessage called', { sessionId, contentLength: message.content?.length });

    if (!this.client) {
      log.error('Five9 sendUserMessage failed — client not configured', { sessionId });
      throw new Error('Five9 client not configured');
    }

    if (!this.sessionStore) {
      log.warn('No session store configured, cannot resolve session', { sessionId });
      return;
    }

    const session = await this.sessionStore.get(sessionId);
    if (!session) {
      log.warn('Cannot forward user message — no active session', { sessionId });
      return;
    }

    const providerDataStr = session['providerData'];
    if (!providerDataStr) {
      log.warn('Cannot forward user message — no providerData', { sessionId });
      return;
    }

    let providerData: { token: string; targetHost: string; farmId: string };
    try {
      providerData = JSON.parse(providerDataStr) as {
        token: string;
        targetHost: string;
        farmId: string;
      };
    } catch (err) {
      log.error('Failed to parse providerData', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const conversationId = session['providerSessionId'];
    if (!conversationId) {
      log.warn('Cannot forward user message — no conversationId', { sessionId });
      return;
    }

    try {
      await this.client.sendMessage(
        providerData.targetHost,
        conversationId,
        providerData.token,
        message.content,
        providerData.farmId,
      );
    } catch (err) {
      // Token may have expired — attempt one re-auth retry
      const isAuthError =
        err instanceof Error && (err.message.includes('401') || err.message.includes('403'));
      if (isAuthError) {
        log.info('Five9 token may have expired, re-authenticating', { sessionId });
        try {
          const authResult = await this.client.authenticate();
          await this.client.sendMessage(
            providerData.targetHost,
            conversationId,
            authResult.tokenId,
            message.content,
            providerData.farmId,
          );
        } catch (retryErr) {
          log.error('Five9 re-auth retry failed', {
            sessionId,
            error: retryErr instanceof Error ? retryErr.message : String(retryErr),
          });
          throw retryErr;
        }
      } else {
        throw err;
      }
    }

    await this.sessionStore.extendTTL(sessionId);
    log.info('Five9 sendUserMessage succeeded', { sessionId });
  }

  async sendTypingIndicator(sessionId: string): Promise<void> {
    log.debug('Five9 sendTypingIndicator called', { sessionId });

    if (!this.client) {
      log.error('Five9 sendTypingIndicator failed — client not configured', { sessionId });
      throw new Error('Five9 client not configured');
    }

    if (!this.sessionStore) {
      log.error('Five9 sendTypingIndicator failed — session store not configured', { sessionId });
      throw new Error('Five9 session store not configured');
    }

    const session = await this.sessionStore.get(sessionId);
    if (!session) {
      log.warn('Five9 sendTypingIndicator — session not found', { sessionId });
      return;
    }

    const conversationId = session['providerSessionId'];
    const providerDataStr = session['providerData'];
    if (!conversationId || !providerDataStr) {
      log.warn('Five9 sendTypingIndicator — missing conversationId or providerData', { sessionId });
      return;
    }

    const providerData = JSON.parse(providerDataStr) as {
      token: string;
      targetHost: string;
      farmId: string;
    };

    try {
      await this.client.sendTyping(
        providerData.targetHost,
        conversationId,
        providerData.token,
        providerData.farmId,
      );
    } catch (err) {
      log.warn('Five9 sendTypingIndicator failed (best-effort)', {
        sessionId,
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async endSession(sessionId: string, reason: string): Promise<void> {
    log.info('Ending Five9 transfer session', { sessionId, reason });

    // Best-effort: end conversation on Five9
    if (this.client && this.sessionStore) {
      const session = await this.sessionStore.get(sessionId);
      if (session) {
        const providerDataStr = session['providerData'];
        const conversationId = session['providerSessionId'];
        if (providerDataStr && conversationId) {
          try {
            const providerData = JSON.parse(providerDataStr) as {
              token: string;
              targetHost: string;
            };
            await this.client.endConversation(
              providerData.targetHost,
              conversationId,
              providerData.token,
            );
          } catch (err) {
            log.warn('Failed to end Five9 conversation (best-effort)', {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    if (this.sessionStore) {
      await this.sessionStore.end(sessionId);
    }
  }

  async handleInboundEvent(event: XOEvent, tenantId: string): Promise<void> {
    log.info('Five9 inbound event received', {
      type: event.type,
      conversationId: event.conversationId,
      tenantId,
    });

    if (!this.sessionStore) {
      log.warn('No session store configured, cannot resolve event context', {
        conversationId: event.conversationId,
      });
      return;
    }

    const session = await this.sessionStore.getByProvider('five9', tenantId, event.conversationId);
    if (!session) {
      log.warn('No active session for inbound Five9 event', {
        conversationId: event.conversationId,
        type: event.type,
        tenantId,
      });
      return;
    }

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

    // Map the Five9 event type to an ABL event type
    const mappedType = Five9EventHandler.mapEventType(event.type);
    if (!mappedType) {
      log.debug('Unmapped Five9 event type, skipping handler dispatch', {
        type: event.type,
        conversationId: event.conversationId,
      });
      return;
    }

    const agentEvent: AgentEvent = {
      type: mappedType,
      sessionId: resolvedKey,
      tenantId: session['tenantId'],
      contactId: session['contactId'],
      channel: session['channel'] as TransferChannel,
      timestamp: event.timestamp ?? new Date().toISOString(),
      data: event.data ?? {},
    };

    // Fire all registered agent message handlers
    log.info('Dispatching Five9 event to handlers', {
      type: mappedType,
      sessionId: resolvedKey,
      handlerCount: this.agentMessageHandlers.length,
    });
    for (const handler of this.agentMessageHandlers) {
      try {
        await handler(agentEvent);
      } catch (err) {
        log.error('Agent message handler threw during Five9 event processing', {
          type: mappedType,
          sessionId: resolvedKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log.info('Five9 inbound event processed', {
      type: mappedType,
      conversationId: event.conversationId,
      sessionId: resolvedKey,
    });
  }

  onAgentMessage(handler: AgentMessageHandler): void {
    if (this.agentMessageHandlers.length >= MAX_HANDLERS) {
      log.warn('Max agent message handlers reached, ignoring', { max: MAX_HANDLERS });
      return;
    }
    this.agentMessageHandlers.push(handler);
  }

  onSessionEvent(handler: SessionEventHandler): void {
    if (this.sessionEventHandlers.length >= MAX_HANDLERS) {
      log.warn('Max session event handlers reached, ignoring', { max: MAX_HANDLERS });
      return;
    }
    this.sessionEventHandlers.push(handler);
  }

  /**
   * Gracefully close the adapter, clearing all handler arrays.
   */
  async close(): Promise<void> {
    log.info('Closing Five9Adapter');
    this.client = null;
    this.agentMessageHandlers.length = 0;
    this.sessionEventHandlers.length = 0;
  }
}
