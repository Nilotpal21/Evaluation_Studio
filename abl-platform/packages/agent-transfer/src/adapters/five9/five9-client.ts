/**
 * Five9 REST API Client
 *
 * HTTP client for Five9 Virtual Contact Center REST API.
 * Supports anonymous and supervisor authentication modes,
 * metadata discovery, and conversation lifecycle operations.
 *
 * All outbound URLs are validated via SSRF guard before fetch.
 * Accepts an optional fetchFn for dependency injection (testing).
 */
import { createLogger } from '@abl/compiler/platform';
import { assertAllowedUrl } from '../../security/ssrf-guard.js';
import type {
  Five9Credentials,
  Five9AuthResult,
  Five9AuthResponse,
  Five9MetadataResponse,
  Five9ConversationResponse,
  Five9AgentProfileResponse,
} from './types.js';

const log = createLogger('five9-client');

class Five9Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'Five9Error';
    this.code = code;
  }
}

/**
 * Five9 REST API client.
 *
 * All methods perform SSRF validation before making HTTP calls.
 * Non-2xx responses throw structured `{ code, message }` errors.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

export class Five9Client {
  private readonly credentials: Five9Credentials;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(credentials: Five9Credentials, fetchFn?: typeof fetch, timeoutMs?: number) {
    this.credentials = credentials;
    this.fetchFn = fetchFn ?? fetch;
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    return this.fetchFn(url, { ...init, signal: controller.signal }).finally(() =>
      clearTimeout(timeoutId),
    );
  }

  /**
   * Authenticate with Five9 and obtain a bearer token.
   *
   * Anonymous mode: POST /appsvcs/rs/svc/auth/anon?cookieless=true
   * Supervisor mode: POST /appsvcs/rs/svc/auth/login
   */
  async authenticate(): Promise<Five9AuthResult> {
    const { host, tenantName, authMode, username, password } = this.credentials;
    const baseUrl = `https://${host}`;

    let url: string;
    let body: Record<string, string>;

    if (authMode === 'supervisor') {
      if (!username || !password) {
        throw this.createError(
          'FIVE9_AUTH_CONFIG_ERROR',
          'Username and password required for supervisor auth mode',
        );
      }
      url = `${baseUrl}/appsvcs/rs/svc/auth/login`;
      body = { tenantName, username, password };
    } else {
      url = `${baseUrl}/appsvcs/rs/svc/auth/anon?cookieless=true`;
      body = { tenantName };
    }

    await assertAllowedUrl(url);

    const requestPayload =
      authMode === 'supervisor' ? { tenantName, username: username! } : { tenantName };
    log.info('Five9 authenticate request', { url, authMode, payload: requestPayload });

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const responseBody = await this.safeReadBody(response);
    log.info('Five9 authenticate response', {
      status: response.status,
      ok: response.ok,
      body: responseBody,
    });

    if (!response.ok) {
      throw this.createError(
        'FIVE9_AUTH_FAILED',
        `Authentication failed with status ${response.status}: ${responseBody}`,
      );
    }

    let data: Five9AuthResponse;
    try {
      data = JSON.parse(responseBody) as Five9AuthResponse;
    } catch {
      throw this.createError(
        'FIVE9_AUTH_PARSE_ERROR',
        `Failed to parse auth response: ${responseBody}`,
      );
    }

    const result = {
      tokenId: data.tokenId,
      orgId: data.orgId,
      farmId: data.context.farmId,
      targetHost: host,
    };
    log.info('Five9 authenticate result', {
      tokenId: data.tokenId ? '***' : null,
      orgId: result.orgId,
      farmId: result.farmId,
    });
    return result;
  }

  /**
   * Discover Five9 metadata (orgId, farmId, targetHost).
   * Uses the metadata endpoint to resolve the correct data center host.
   * Pass optional farmId to include it as a header (used during 435 migration recovery).
   */
  async discoverMetadata(host: string, token: string, farmId?: string): Promise<Five9AuthResult> {
    const url = `https://${host}/appsvcs/rs/svc/auth/metadata`;

    await assertAllowedUrl(url);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (farmId) {
      headers['farmId'] = farmId;
    }

    log.info('Five9 metadata request', { url, host, hasFarmIdHeader: !!farmId });

    const response = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers,
    });

    const responseBody = await this.safeReadBody(response);
    log.info('Five9 metadata response', {
      status: response.status,
      ok: response.ok,
      body: responseBody,
    });

    if (!response.ok) {
      throw this.createError(
        'FIVE9_METADATA_FAILED',
        `Metadata discovery failed with status ${response.status}: ${responseBody}`,
      );
    }

    let data: Five9MetadataResponse;
    try {
      data = JSON.parse(responseBody) as Five9MetadataResponse;
    } catch {
      throw this.createError(
        'FIVE9_METADATA_PARSE_ERROR',
        `Failed to parse metadata response: ${responseBody}`,
      );
    }

    // Resolve the targetHost from active data center apiUrls hostname
    const dataCenters = data.metadata?.dataCenters ?? [];
    const activeDataCenter = dataCenters.find((dc) => dc.active === true) ?? dataCenters[0];
    const firstApiUrl =
      activeDataCenter && activeDataCenter.apiUrls.length > 0 ? activeDataCenter.apiUrls[0] : null;
    const targetHost = firstApiUrl ? firstApiUrl.host : host;

    const result = { tokenId: token, orgId: data.orgId, farmId: data.context.farmId, targetHost };
    log.info('Five9 metadata result', {
      orgId: result.orgId,
      farmId: result.farmId,
      targetHost: result.targetHost,
      activeDataCenter: activeDataCenter?.name ?? '(none)',
      cloudClientUrl: data.context.cloudClientUrl,
    });
    return result;
  }

  /**
   * Handle Five9 435 "Service migrated" error.
   *
   * Per Five9 docs:
   * 1. Retrieve metadata to get the updated farmId
   * 2. Re-retrieve metadata with farmId header on the active datacenter's apiUrls host
   * 3. Return new metadata for retrying the original API call
   */
  async handleServiceMigrated(currentHost: string, token: string): Promise<Five9AuthResult> {
    log.info('Five9 handling 435 service migration', { currentHost });

    // Step 1: Retrieve updated metadata from current host
    const initialMetadata = await this.discoverMetadata(currentHost, token);
    log.info('Five9 migration step 1: got initial metadata', {
      farmId: initialMetadata.farmId,
      targetHost: initialMetadata.targetHost,
    });

    // Step 2: Re-retrieve metadata with farmId header on the active datacenter host
    const migratedMetadata = await this.discoverMetadata(
      initialMetadata.targetHost,
      token,
      initialMetadata.farmId,
    );
    log.info('Five9 migration step 2: got migrated metadata', {
      farmId: migratedMetadata.farmId,
      targetHost: migratedMetadata.targetHost,
    });

    return migratedMetadata;
  }

  /**
   * Check agent availability for the given campaign profiles.
   * GET /appsvcs/rs/svc/agents/{tokenId}/logged_in_profiles?profiles=...
   *
   * Returns the profile array with agentLoggedIn status per campaign.
   */
  async checkAgentAvailability(
    targetHost: string,
    tokenId: string,
    profiles: string[],
  ): Promise<Five9AgentProfileResponse[]> {
    const profilesParam = profiles.map((p) => encodeURIComponent(p)).join(',');
    const url = `https://${targetHost}/appsvcs/rs/svc/agents/${encodeURIComponent(tokenId)}/logged_in_profiles?profiles=${profilesParam}`;

    await assertAllowedUrl(url);

    log.info('Five9 checkAgentAvailability request', { url, targetHost, profiles });

    const response = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tokenId}`,
        'Content-Type': 'application/json',
      },
    });

    const responseBody = await this.safeReadBody(response);
    log.info('Five9 checkAgentAvailability response', {
      status: response.status,
      ok: response.ok,
      body: responseBody,
    });

    // Handle 435 service migration
    if (response.status === 435) {
      log.warn('Five9 checkAgentAvailability received 435 (service migrated)', {
        targetHost,
      });
      const migratedMetadata = await this.handleServiceMigrated(targetHost, tokenId);
      const retryUrl = `https://${migratedMetadata.targetHost}/appsvcs/rs/svc/agents/${encodeURIComponent(migratedMetadata.tokenId)}/logged_in_profiles?profiles=${profilesParam}`;
      await assertAllowedUrl(retryUrl);

      const retryResponse = await this.fetchWithTimeout(retryUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${migratedMetadata.tokenId}`,
          'Content-Type': 'application/json',
          farmId: migratedMetadata.farmId,
        },
      });
      const retryBody = await this.safeReadBody(retryResponse);
      log.info('Five9 checkAgentAvailability retry response after migration', {
        status: retryResponse.status,
        ok: retryResponse.ok,
        body: retryBody,
      });
      if (!retryResponse.ok) {
        throw this.createError(
          'FIVE9_AVAILABILITY_CHECK_FAILED',
          `Agent availability check failed after migration retry with status ${retryResponse.status}: ${retryBody}`,
        );
      }
      let retryData: Five9AgentProfileResponse[];
      try {
        retryData = JSON.parse(retryBody) as Five9AgentProfileResponse[];
      } catch {
        throw this.createError(
          'FIVE9_AVAILABILITY_PARSE_ERROR',
          `Failed to parse availability retry response: ${retryBody}`,
        );
      }
      log.info('Five9 checkAgentAvailability result (after migration)', {
        profileCount: retryData.length,
        profiles: retryData.map((p) => ({
          name: p.profileName,
          agentLoggedIn: p.agentLoggedIn,
          openForBusiness: p.openForBusiness,
        })),
      });
      return retryData;
    }

    if (!response.ok) {
      throw this.createError(
        'FIVE9_AVAILABILITY_CHECK_FAILED',
        `Agent availability check failed with status ${response.status}: ${responseBody}`,
      );
    }

    let data: Five9AgentProfileResponse[];
    try {
      data = JSON.parse(responseBody) as Five9AgentProfileResponse[];
    } catch {
      throw this.createError(
        'FIVE9_AVAILABILITY_PARSE_ERROR',
        `Failed to parse availability response: ${responseBody}`,
      );
    }

    log.info('Five9 checkAgentAvailability result', {
      profileCount: data.length,
      profiles: data.map((p) => ({
        name: p.profileName,
        agentLoggedIn: p.agentLoggedIn,
        openForBusiness: p.openForBusiness,
      })),
    });

    return data;
  }

  /**
   * Create a new conversation on the Five9 platform.
   */
  async createConversation(
    targetHost: string,
    token: string,
    params: {
      campaignName: string;
      tenantId: string;
      tenantName: string;
      callbackUrl?: string;
      type?: string;
      contact?: { firstName?: string; lastName?: string };
      attributes?: Record<string, string>;
    },
  ): Promise<Five9ConversationResponse> {
    const url = `https://${targetHost}/appsvcs/rs/svc/conversations`;

    await assertAllowedUrl(url);

    const requestPayload: Record<string, unknown> = {
      campaignName: params.campaignName,
      tenantId: params.tenantId,
      tenantName: params.tenantName,
      type: params.type ?? 'Generic',
    };
    if (params.callbackUrl) requestPayload.callbackUrl = params.callbackUrl;
    if (params.contact) requestPayload.contact = params.contact;
    if (params.attributes) requestPayload.attributes = params.attributes;
    log.info('Five9 createConversation request', { url, payload: requestPayload });

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestPayload),
    });

    const responseBody = await this.safeReadBody(response);
    log.info('Five9 createConversation response', {
      status: response.status,
      ok: response.ok,
      body: responseBody,
    });

    // Five9 returns 435 ("Service migrated") when the domain has moved to a different data center.
    // Per Five9 docs: re-discover metadata with farmId header, then retry on the new host.
    if (response.status === 435) {
      log.warn('Five9 createConversation received 435 (service migrated)', {
        targetHost,
        body: responseBody,
      });

      const migratedMetadata = await this.handleServiceMigrated(targetHost, token);
      const retryUrl = `https://${migratedMetadata.targetHost}/appsvcs/rs/svc/conversations`;
      await assertAllowedUrl(retryUrl);

      // Update tenantId in payload to use the new orgId from migrated metadata
      const retryPayload = { ...requestPayload, tenantId: migratedMetadata.orgId };
      log.info('Five9 createConversation retrying after migration', {
        newTargetHost: migratedMetadata.targetHost,
        newFarmId: migratedMetadata.farmId,
        retryUrl,
      });

      const retryResponse = await this.fetchWithTimeout(retryUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${migratedMetadata.tokenId}`,
          'Content-Type': 'application/json',
          farmId: migratedMetadata.farmId,
        },
        body: JSON.stringify(retryPayload),
      });
      const retryBody = await this.safeReadBody(retryResponse);
      log.info('Five9 createConversation retry response', {
        status: retryResponse.status,
        ok: retryResponse.ok,
        body: retryBody,
      });
      if (!retryResponse.ok) {
        throw this.createError(
          'FIVE9_CONVERSATION_CREATE_FAILED',
          `Conversation creation failed after migration retry with status ${retryResponse.status}: ${retryBody}`,
        );
      }
      let retryData: Five9ConversationResponse;
      try {
        retryData = JSON.parse(retryBody) as Five9ConversationResponse;
      } catch {
        throw this.createError(
          'FIVE9_CONVERSATION_PARSE_ERROR',
          `Failed to parse conversation retry response: ${retryBody}`,
        );
      }
      log.info('Five9 createConversation result (after migration)', {
        conversationId: retryData.conversationId,
        migratedTargetHost: migratedMetadata.targetHost,
      });
      return retryData;
    }

    if (!response.ok) {
      throw this.createError(
        'FIVE9_CONVERSATION_CREATE_FAILED',
        `Conversation creation failed with status ${response.status}: ${responseBody}`,
      );
    }

    let data: Five9ConversationResponse;
    try {
      data = JSON.parse(responseBody) as Five9ConversationResponse;
    } catch {
      throw this.createError(
        'FIVE9_CONVERSATION_PARSE_ERROR',
        `Failed to parse conversation response: ${responseBody}`,
      );
    }
    log.info('Five9 createConversation result', { conversationId: data.conversationId });
    return data;
  }

  /**
   * Send a message to an existing Five9 conversation.
   */
  async sendMessage(
    targetHost: string,
    conversationId: string,
    token: string,
    message: string,
    farmId: string,
  ): Promise<void> {
    const url = `https://${targetHost}/appsvcs/rs/svc/conversations/${encodeURIComponent(conversationId)}/messages`;

    await assertAllowedUrl(url);

    log.info('Five9 sendMessage request', {
      url,
      conversationId,
      contentLength: message.length,
    });

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        farmId,
      },
      body: JSON.stringify({ messageType: 'TEXT', message }),
    });

    const responseBody = await this.safeReadBody(response);
    log.info('Five9 sendMessage response', {
      status: response.status,
      ok: response.ok,
      conversationId,
      body: responseBody,
    });

    // Handle 435 service migration for sendMessage
    if (response.status === 435) {
      log.warn('Five9 sendMessage received 435 (service migrated)', { targetHost, conversationId });
      const migratedMetadata = await this.handleServiceMigrated(targetHost, token);
      const retryUrl = `https://${migratedMetadata.targetHost}/appsvcs/rs/svc/conversations/${encodeURIComponent(conversationId)}/messages`;
      await assertAllowedUrl(retryUrl);

      const retryResponse = await this.fetchWithTimeout(retryUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${migratedMetadata.tokenId}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          farmId: migratedMetadata.farmId,
        },
        body: JSON.stringify({ messageType: 'TEXT', message }),
      });
      const retryBody = await this.safeReadBody(retryResponse);
      log.info('Five9 sendMessage retry response after migration', {
        status: retryResponse.status,
        ok: retryResponse.ok,
        body: retryBody,
      });
      if (!retryResponse.ok) {
        throw this.createError(
          'FIVE9_SEND_MESSAGE_FAILED',
          `Send message failed after migration retry with status ${retryResponse.status}: ${retryBody}`,
        );
      }
      return;
    }

    if (!response.ok) {
      throw this.createError(
        'FIVE9_SEND_MESSAGE_FAILED',
        `Send message failed with status ${response.status}: ${responseBody}`,
      );
    }
  }

  /**
   * Send a typing indicator to a Five9 conversation.
   * PUT /conversations/{conversationId}/messages/typing
   */
  async sendTyping(
    targetHost: string,
    conversationId: string,
    token: string,
    farmId: string,
  ): Promise<void> {
    const url = `https://${targetHost}/appsvcs/rs/svc/conversations/${encodeURIComponent(conversationId)}/messages/typing`;

    await assertAllowedUrl(url);

    log.debug('Five9 sendTyping request', { url, conversationId });

    const response = await this.fetchWithTimeout(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        farmId,
      },
    });

    if (response.status === 435) {
      log.warn('Five9 sendTyping received 435 (service migrated)', { targetHost, conversationId });
      const migratedMetadata = await this.handleServiceMigrated(targetHost, token);
      const retryUrl = `https://${migratedMetadata.targetHost}/appsvcs/rs/svc/conversations/${encodeURIComponent(conversationId)}/messages/typing`;
      await assertAllowedUrl(retryUrl);

      const retryResponse = await this.fetchWithTimeout(retryUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${migratedMetadata.tokenId}`,
          farmId: migratedMetadata.farmId,
        },
      });
      if (!retryResponse.ok) {
        const retryBody = await this.safeReadBody(retryResponse);
        throw this.createError(
          'FIVE9_SEND_TYPING_FAILED',
          `Send typing failed after migration retry with status ${retryResponse.status}: ${retryBody}`,
        );
      }
      return;
    }

    if (!response.ok) {
      const responseBody = await this.safeReadBody(response);
      throw this.createError(
        'FIVE9_SEND_TYPING_FAILED',
        `Send typing failed with status ${response.status}: ${responseBody}`,
      );
    }
  }

  /**
   * End (delete) a Five9 conversation.
   */
  async endConversation(targetHost: string, conversationId: string, token: string): Promise<void> {
    const url = `https://${targetHost}/appsvcs/rs/svc/conversations/${encodeURIComponent(conversationId)}`;

    await assertAllowedUrl(url);

    log.info('Five9 endConversation request', { url, conversationId });

    const response = await this.fetchWithTimeout(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const responseBody = await this.safeReadBody(response);
    log.info('Five9 endConversation response', {
      status: response.status,
      ok: response.ok,
      conversationId,
      body: responseBody,
    });

    // Handle 435 service migration for endConversation
    if (response.status === 435) {
      log.warn('Five9 endConversation received 435 (service migrated)', {
        targetHost,
        conversationId,
      });
      const migratedMetadata = await this.handleServiceMigrated(targetHost, token);
      const retryUrl = `https://${migratedMetadata.targetHost}/appsvcs/rs/svc/conversations/${encodeURIComponent(conversationId)}`;
      await assertAllowedUrl(retryUrl);

      const retryResponse = await this.fetchWithTimeout(retryUrl, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${migratedMetadata.tokenId}`,
          'Content-Type': 'application/json',
          farmId: migratedMetadata.farmId,
        },
      });
      const retryBody = await this.safeReadBody(retryResponse);
      log.info('Five9 endConversation retry response after migration', {
        status: retryResponse.status,
        ok: retryResponse.ok,
        body: retryBody,
      });
      if (!retryResponse.ok) {
        throw this.createError(
          'FIVE9_END_CONVERSATION_FAILED',
          `End conversation failed after migration retry with status ${retryResponse.status}: ${retryBody}`,
        );
      }
      return;
    }

    if (!response.ok) {
      throw this.createError(
        'FIVE9_END_CONVERSATION_FAILED',
        `End conversation failed with status ${response.status}: ${responseBody}`,
      );
    }
  }

  /**
   * Safely read the response body text.
   * For logging: truncates to maxLen (default 2000) to avoid flooding logs.
   */
  private async safeReadBody(response: Response, maxLen = 2000): Promise<string> {
    try {
      const text = await response.text();
      return text.length > maxLen ? text.slice(0, maxLen) + '…(truncated)' : text;
    } catch {
      return '(unable to read response body)';
    }
  }

  /**
   * Create a structured error object.
   */
  private createError(code: string, message: string): Five9Error {
    return new Five9Error(code, message);
  }
}
