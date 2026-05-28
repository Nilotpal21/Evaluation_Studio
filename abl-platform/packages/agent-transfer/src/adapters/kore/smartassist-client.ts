/**
 * SmartAssist HTTP Client
 *
 * Internal HTTP client for Kore SmartAssist API.
 * Uses undici Pool for connection pooling, circuit breaker
 * for fault tolerance, and retry with exponential backoff.
 */
import { Pool } from 'undici';
import { createLogger } from '@abl/compiler/platform';
import type { SmartAssistConfig } from '../../config/schema.js';
import type { TransferResult, OperationResult, VoiceCallData } from '../../types.js';
import { assertAllowedUrlSync } from '../../security/ssrf-guard.js';

const log = createLogger('smartassist-client');

const LANGUAGE_MAP = new Map<string, string>([['pt-pt', 'pt_pt']]);

export interface AvailabilityPayload {
  agentId: string;
  contactId: string;
  tenantId: string;
  projectId: string;
  skills?: string[];
  queue?: string;
  language?: string;
}

export interface KoreTransferPayload {
  agentId: string;
  contactId: string;
  tenantId: string;
  projectId: string;
  channel?: string;
  queue?: string;
  skills?: string[];
  priority?: number;
  language?: string;
  conversationHistory?: Array<{ role: string; content: string; timestamp: string }>;
  /** Pre-computed plain-text transcript for immediate display on the agent desktop */
  conversationSummaryForAgentTransfer?: string;
  metadata?: Record<string, unknown>;
  sourceAgentId?: string;
  customData?: Record<string, unknown>;
  contact?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    customerId?: string;
  };

  // XO-required fields
  source?: string;
  conversationType?: string;
  skillsIds?: string[];
  metaInfo?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phoneNumber?: string;
    city?: string;
    country?: string;
    customData?: Record<string, unknown>;
    agentTransferConfig?: {
      automationBotId?: string;
      inQueueFlowId?: string;
      waitingExperienceId?: string;
      noAgentsFlowId?: string;
      outOfHoursFlowId?: string;
      lastIntentName?: string;
      dialog_tone?: Array<{ tone_name: string; level: number }>;
    };
  };
  keyIntentName?: string;
  sentimentTone?: { sentiment: string; emoji?: string; strength: number };
  agentDesktopMeta?: Record<string, unknown>;
  hostDomain?: string;
  os?: string;
  device?: string;
  surveyRequired?: 'YES' | 'NO' | 'ASK' | 'REQUESTED';
  email?: {
    emailId?: string;
    toEmailId?: string;
    subject?: string;
    cc?: string[];
  };
  campaignInfo?: Record<string, unknown>;
  voiceData?: VoiceCallData;
}

export type KoreUserEventName =
  | 'start_kore_agent_chat_message_for_agent'
  | 'start_control_message_for_agent'
  | 'close_conversation';

export interface KoreUserEvent {
  eventName: KoreUserEventName;
  payload: {
    conversationId: string;
    author: { id: string; type: 'USER' };
    orgId?: string;
    botId?: string;
    type?: string;
    value?: string;
    event: string;
    // Required by SmartAssist validateAgenticRequest — any per-message event
    // without these short-circuits the /execute call on the AgentAssist side.
    experience?: string;
    language?: string;
    attachments?: Array<{ url: string; name: string; mimeType: string; size?: number }>;
  };
  queryFields: { sid: string; cId: string };
}

export interface SyntheticUserResult {
  userId: string;
  myBotUserId?: string;
  customData?: Record<string, unknown>;
  secureCustomData?: Record<string, unknown>;
}

export interface CircuitBreakerHandle {
  execute<T>(fn: () => Promise<T>): Promise<T>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SmartAssistClient {
  private readonly pool: Pool;
  private readonly config: SmartAssistConfig;
  private readonly circuitBreaker?: CircuitBreakerHandle;

  constructor(config: SmartAssistConfig, circuitBreaker?: CircuitBreakerHandle) {
    assertAllowedUrlSync(config.baseUrl);
    this.config = config;
    this.pool = new Pool(config.baseUrl, {
      connections: 50,
      pipelining: 1,
      keepAliveTimeout: 30_000,
    });
    this.circuitBreaker = circuitBreaker;
  }

  async checkBusinessHours(hoursId: string): Promise<OperationResult<boolean>> {
    const body = {
      id: this.config.hoursId || hoursId,
      botId: this.config.appId || '',
    };
    return this.post('/agentassist/api/v1/internal/flows/nodes/businessHours', body, 'CHECK_HOURS');
  }

  async checkAgentAvailability(payload: AvailabilityPayload): Promise<OperationResult<boolean>> {
    const identity = this.mapIdentity(payload.agentId, payload.contactId, payload.tenantId);
    const body = {
      ...identity,
      skills: payload.skills,
      queue: payload.queue,
      language: this.mapLanguage(payload.language) ?? 'en',
    };
    return this.post(
      '/agentassist/api/v1/internal/flows/nodes/agentsAvailability',
      body,
      'CHECK_AVAILABILITY',
    );
  }

  async validateQueue(queueId: string): Promise<OperationResult<boolean>> {
    const body = {
      queueId,
      botId: this.config.appId || '',
    };
    return this.post(
      '/agentassist/api/v1/internal/flows/nodes/queueAvailability',
      body,
      'VALIDATE_QUEUE',
    );
  }

  async initTransfer(payload: KoreTransferPayload): Promise<TransferResult> {
    // Build callback object — tells AgentAssist where to dispatch agent events.
    // Resolve URL: explicit config → RUNTIME_PUBLIC_BASE_URL → RUNTIME_BASE_URL → omit
    const webhookBaseUrl =
      this.config.ablWebhookBaseUrl ||
      process.env.RUNTIME_PUBLIC_BASE_URL ||
      process.env.RUNTIME_BASE_URL ||
      undefined;
    const callback = webhookBaseUrl
      ? {
          webhookUrl: `${webhookBaseUrl}/api/v1/agent-transfer/webhooks/smartassist`,
          source: 'abl-platform',
          ...(this.config.webhookSecret ? { webhookPasscode: this.config.webhookSecret } : {}),
        }
      : undefined;

    const body: Record<string, unknown> = {
      orgId: this.config.orgId || this.config.accountId || payload.tenantId,
      userId: payload.contactId,
      accountId:
        this.config.koreAccountId || this.config.orgId || this.config.accountId || payload.tenantId,
      botId: this.config.appId || payload.agentId,
      source: this.mapChannelToSource(payload.channel),
      language: this.mapLanguage(payload.language) ?? 'en',
      metaInfo: {
        firstName: payload.contact?.firstName || 'Anonymous',
        lastName: payload.contact?.lastName || 'User',
        conversationHistory: payload.conversationHistory,
        ...(payload.conversationSummaryForAgentTransfer
          ? { conversationSummaryForAgentTransfer: payload.conversationSummaryForAgentTransfer }
          : {}),
        metadata: payload.metadata,
        ...(payload.contact?.email ? { email: payload.contact.email } : {}),
        ...(payload.contact?.phone ? { phoneNumber: payload.contact.phone } : {}),
        ...(payload.metaInfo?.customData ? { customData: payload.metaInfo.customData } : {}),
        ...(payload.metaInfo?.agentTransferConfig
          ? { agentTransferConfig: payload.metaInfo.agentTransferConfig }
          : {}),
      },
      ...(callback ? { callback } : {}),
      conversationType: this.mapChannelToConversationType(payload.channel),
    };
    if (payload.queue) {
      body.queue = payload.queue;
    }
    if (payload.skills?.length) {
      body.skills = payload.skills;
    }
    if (payload.skillsIds?.length) {
      body.skillsIds = payload.skillsIds;
    }
    if (payload.sourceAgentId) {
      body.automationBotId = payload.sourceAgentId;
    }

    if (payload.voiceData) {
      body.phoneNumber = payload.voiceData.caller;
      body.CallIDData = payload.voiceData.sipCallId;

      if (this.config.botSIPURI) {
        body.botSIPURI = this.config.botSIPURI;
      } else if (payload.voiceData.sipTo) {
        body.botSIPURI = payload.voiceData.sipTo.startsWith('sip:')
          ? payload.voiceData.sipTo
          : `sip:${payload.voiceData.sipTo}`;
      }

      const voiceLang = this.mapLanguage(payload.language) ?? 'en';
      body.voiceChatAgentLang = voiceLang;
      body.voiceChatUserLang = voiceLang;
      body.recognizerLang = voiceLang;

      const metaInfo = body.metaInfo as Record<string, unknown>;
      metaInfo.caller = payload.voiceData.caller;
      metaInfo.callee = payload.voiceData.called;
      metaInfo.dialedNumber = payload.voiceData.called;
      if (payload.voiceData.callerName) {
        metaInfo.callerName = payload.voiceData.callerName;
      }
      if (payload.voiceData.originatingSipIp) {
        metaInfo.callerHost = payload.voiceData.originatingSipIp;
      }
    }

    const path = this.config.initTransferPath ?? '/agentassist/api/v1/conversations';
    const result = await this.post(path, body, 'INIT_TRANSFER', false);
    if (!result.success || !result.data) {
      return {
        success: false,
        status: 'failed',
        error: result.error ?? {
          code: 'SMARTASSIST_ERROR',
          message: 'Transfer initiation failed',
        },
      };
    }
    const responseData = result.data as Record<string, unknown>;
    const surveyRequired = responseData?.['surveyRequired'] as string | undefined;
    const surveyType = responseData?.['surveyType'] as string | undefined;
    return {
      success: true,
      status: 'transferred',
      providerSessionId:
        (responseData?.['conversationId'] as string | undefined) ??
        (responseData?.['_id'] as string | undefined) ??
        undefined,
      csatSurveyRequired:
        surveyRequired === 'YES' ||
        surveyRequired === 'ASK' ||
        surveyRequired === 'REQUESTED' ||
        undefined,
      csatSurveyType: typeof surveyType === 'string' ? surveyType : undefined,
    };
  }

  /**
   * Fetch the Kore accountId (orgId) for a given botId (appId/streamId).
   * Called lazily before prechecks when orgId is not already configured.
   *
   * Calls: POST <koreHost|baseUrl>/api/1.1/internal/agentassist/accounts/getAccountIdByBotId
   * Body:  { streamId: <appId> }
   */
  async getAccountIdByBotId(
    streamId: string,
  ): Promise<OperationResult<{ orgId: string; accountId?: string }>> {
    const koreHost = this.config.koreHost || this.config.baseUrl;
    const apiKey = this.config.koreApiKey || this.config.apiKey;
    const url = `${koreHost}/api/1.1/internal/agentassist/accounts/getAccountIdByBotId`;

    const payload = { streamId };
    log.info('Fetching orgId (accountId) by botId from KoreServer', {
      streamId,
      url,
      payload: JSON.stringify(payload),
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      assertAllowedUrlSync(koreHost);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const text = await response.text();

      log.info('KoreServer getAccountIdByBotId response', {
        statusCode: response.status,
        response: text.slice(0, 500),
      });

      if (!response.ok) {
        log.error('KoreServer getAccountIdByBotId failed', {
          streamId,
          url,
          statusCode: response.status,
          response: text.slice(0, 500),
        });
        return {
          success: false,
          error: {
            code: 'KORE_GET_ACCOUNT_ID_FAILED',
            message: `KoreServer returned ${response.status}: ${text.slice(0, 200)}`,
          },
        };
      }

      const data = JSON.parse(text) as Record<string, unknown>;
      const orgId = (data.orgId as string) || (data.accountId as string);
      if (!orgId) {
        log.error('KoreServer getAccountIdByBotId returned empty orgId', {
          streamId,
          url,
          response: text.slice(0, 500),
        });
        return {
          success: false,
          error: {
            code: 'KORE_GET_ACCOUNT_ID_EMPTY',
            message: 'KoreServer response missing orgId',
          },
        };
      }

      const accountId = (data.accountId as string) || undefined;
      log.info('Resolved orgId from KoreServer', { streamId, orgId, accountId });
      return { success: true, data: { orgId, accountId } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to fetch accountId by botId', { streamId, error: message });
      return {
        success: false,
        error: {
          code: 'KORE_GET_ACCOUNT_ID_ERROR',
          message,
        },
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Create a synthetic user in KoreServer before initiating a transfer.
   * This gives us a valid KoreServer userId (u-xxxx format) to use in
   * the conversations API payload instead of ABL's internal session ID.
   *
   * Calls: POST <koreHost|baseUrl>/api/1.1/internal/agentassist/user
   */
  async createSyntheticUser(sessionId: string): Promise<OperationResult<SyntheticUserResult>> {
    const koreHost = this.config.koreHost || this.config.baseUrl;

    const botId = this.config.appId;
    if (!botId) {
      return {
        success: false,
        error: {
          code: 'APP_ID_NOT_CONFIGURED',
          message: 'appId (botId) is required for synthetic user creation',
        },
      };
    }

    const apiKey = this.config.koreApiKey || this.config.apiKey;
    const url = `${koreHost}/api/1.1/internal/agentassist/user`;
    const body = {
      botId,
      event: {
        from: { id: sessionId },
        to: { id: botId },
      },
      customData: {},
    };

    log.info('Creating synthetic user in KoreServer', {
      sessionId,
      botId,
      url,
      payload: JSON.stringify(body),
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      assertAllowedUrlSync(koreHost);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();

      log.info('KoreServer synthetic user response', {
        statusCode: response.status,
        response: text.slice(0, 500),
      });

      if (!response.ok) {
        return {
          success: false,
          error: {
            code: 'KORE_USER_CREATION_FAILED',
            message: `KoreServer returned ${response.status}: ${text.slice(0, 200)}`,
          },
        };
      }

      const data = JSON.parse(text) as SyntheticUserResult;
      if (!data.userId) {
        return {
          success: false,
          error: {
            code: 'KORE_USER_CREATION_NO_USERID',
            message: 'KoreServer response missing userId',
          },
        };
      }

      log.info('Synthetic user created', {
        sessionId,
        userId: data.userId,
      });

      return { success: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to create synthetic user', { sessionId, error: message });
      return {
        success: false,
        error: {
          code: 'KORE_USER_CREATION_ERROR',
          message,
        },
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async updateTransfer(
    conversationId: string,
    payload: Record<string, unknown>,
  ): Promise<OperationResult<unknown>> {
    const body = { conversationId, ...payload };
    return this.post(
      '/agentassist/api/v1/internal/flows/nodes/updateTransfer',
      body,
      'UPDATE_TRANSFER',
    );
  }

  async sendEvent(
    sessionId: string,
    conversationId: string,
    event: KoreUserEvent,
  ): Promise<OperationResult<void>> {
    const basePath = this.config.eventHandlePath ?? '/agentassist/api/v1/internal/events/handle/';
    const path = `${basePath}?sid=${encodeURIComponent(sessionId)}&cId=${encodeURIComponent(conversationId)}`;
    return this.post(path, event as unknown as Record<string, unknown>, 'SEND_USER_EVENT');
  }

  async submitCsatRating(params: {
    userId: string;
    channel: string;
    botId: string;
    score: number;
    surveyType: 'csat' | 'nps' | 'likeDislike';
    comments?: string;
  }): Promise<OperationResult<{ message?: string }>> {
    const baseUrl = this.config.baseUrl;
    const apiKey = this.config.koreApiKey || this.config.apiKey;
    const url = `${baseUrl}/agentassist/api/v1/csatResponse/save`;

    const body: Record<string, unknown> = {
      userId: params.userId,
      channel: params.channel,
      botId: params.botId,
      score: params.score,
      surveyType: params.surveyType,
    };
    if (params.comments) {
      body.comments = params.comments;
    }

    log.info('Submitting CSAT rating to SmartAssist', {
      url,
      userId: params.userId,
      botId: params.botId,
      surveyType: params.surveyType,
      score: params.score,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      assertAllowedUrlSync(baseUrl);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();

      log.info('SmartAssist CSAT response', {
        statusCode: response.status,
        response: text.slice(0, 500),
      });

      if (!response.ok) {
        log.error('SmartAssist CSAT submission failed', {
          statusCode: response.status,
          response: text.slice(0, 500),
        });
        return {
          success: false,
          error: {
            code: 'CSAT_SUBMISSION_FAILED',
            message: 'CSAT submission was rejected by the provider',
          },
        };
      }

      let message: string | undefined;
      try {
        const data = JSON.parse(text) as Record<string, unknown>;
        message = typeof data.message === 'string' ? data.message : undefined;
      } catch {
        message = text || undefined;
      }

      return { success: true, data: { message } };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error('Failed to submit CSAT rating', { error: errorMessage });
      return {
        success: false,
        error: {
          code: 'CSAT_SUBMISSION_ERROR',
          message: 'CSAT submission failed due to a connectivity error',
        },
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  private async post<T>(
    path: string,
    body: Record<string, unknown>,
    operationCode: string,
    retryable = true,
  ): Promise<OperationResult<T>> {
    const execute = async (): Promise<OperationResult<T>> => {
      return retryable
        ? this.executeWithRetry(path, body, operationCode)
        : this.executeRequest(path, body, operationCode);
    };
    if (this.circuitBreaker) {
      return this.circuitBreaker.execute(execute);
    }
    return execute();
  }

  private async executeWithRetry<T>(
    path: string,
    body: Record<string, unknown>,
    operationCode: string,
  ): Promise<OperationResult<T>> {
    const { maxAttempts, backoffMs, backoffMultiplier } = this.config.retry;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      if (attempt > 0) {
        const delay = backoffMs * Math.pow(backoffMultiplier, attempt - 1);
        await sleep(delay);
      }
      try {
        const result = await this.executeRequest<T>(path, body, operationCode);
        if (!result.success && result.error) {
          if (result.error.code === 'SMARTASSIST_CLIENT_ERROR') return result;
        }
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (lastError.name === 'AbortError') {
          log.warn('SmartAssist request timed out', { path, attempt, operationCode });
          break;
        }
        log.warn('SmartAssist request failed, retrying', {
          path,
          attempt,
          maxAttempts,
          error: lastError.message,
          operationCode,
        });
      }
    }
    return {
      success: false,
      error: {
        code: 'SMARTASSIST_ERROR',
        message: lastError?.message ?? 'Request failed after retries',
      },
    };
  }

  private async executeRequest<T>(
    path: string,
    body: Record<string, unknown>,
    operationCode: string,
  ): Promise<OperationResult<T>> {
    const logLimit = operationCode === 'INIT_TRANSFER' ? 2000 : 500;
    log.info('SmartAssist API request', {
      operationCode,
      path,
      payload: JSON.stringify(body).slice(0, logLimit),
    });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const { statusCode, body: responseBody } = await this.pool.request({
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apiKey: this.config.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await responseBody.text();
      log.info('SmartAssist API response', {
        operationCode,
        path,
        statusCode,
        response: text.slice(0, logLimit),
      });
      if (statusCode >= 400 && statusCode < 500) {
        log.warn('SmartAssist client error', {
          path,
          statusCode,
          operationCode,
          response: text.slice(0, logLimit),
        });
        return {
          success: false,
          error: {
            code: 'SMARTASSIST_CLIENT_ERROR',
            message: `SmartAssist returned ${statusCode}: ${text.slice(0, 200)}`,
          },
        };
      }
      if (statusCode >= 500) {
        log.error('SmartAssist server error', {
          path,
          statusCode,
          operationCode,
          response: text.slice(0, logLimit),
        });
        throw new Error(`SmartAssist server error: ${statusCode} — ${text.slice(0, 200)}`);
      }
      if (!text) {
        return { success: true, data: undefined };
      }
      try {
        const data = JSON.parse(text) as T;
        return { success: true, data };
      } catch {
        log.warn('SmartAssist returned non-JSON response', {
          path,
          operationCode,
          response: text.slice(0, 200),
        });
        return {
          success: false,
          error: {
            code: 'SMARTASSIST_PARSE_ERROR',
            message: `Failed to parse SmartAssist response as JSON: ${text.slice(0, 200)}`,
          },
        };
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private mapLanguage(lang?: string): string | undefined {
    if (!lang) return undefined;
    return LANGUAGE_MAP.get(lang) ?? lang;
  }

  private mapIdentity(
    agentId: string,
    contactId: string,
    tenantId: string,
  ): Record<string, string> {
    return {
      botId: this.config.appId || agentId,
      userId: contactId,
      orgId: this.config.orgId || this.config.accountId || tenantId,
      accountId:
        this.config.koreAccountId || this.config.orgId || this.config.accountId || tenantId,
    };
  }

  private clampPriority(priority?: number | null): number {
    if (priority === undefined || priority === null) return 5;
    return Math.max(0, Math.min(10, priority));
  }

  /** Map ABL channel type to SmartAssist source field */
  private mapChannelToSource(channel?: string): string {
    switch (channel) {
      case 'voice':
      case 'korevg':
      case 'jambonz':
      case 'voice_twilio':
        return 'korevg';
      case 'audiocodes':
        return 'audiocodes';
      case 'email':
        return 'email';
      case 'whatsapp':
        return 'whatsapp';
      case 'slack':
        return 'slack';
      case 'msteams':
        return 'msteams';
      case 'web_debug':
      case 'chat':
      case 'messaging':
      default:
        return 'rtm';
    }
  }

  /** Map ABL channel type to SmartAssist conversationType */
  private mapChannelToConversationType(channel?: string): string {
    switch (channel) {
      case 'voice':
      case 'korevg':
      case 'audiocodes':
      case 'jambonz':
      case 'voice_twilio':
        return 'call';
      case 'email':
        return 'email';
      default:
        return 'livechat';
    }
  }
}
