/**
 * Graph Transport
 *
 * Implements EmailTransport using Microsoft Graph API with OAuth2 client credentials.
 * Uses draft-then-send flow to retrieve the RFC 5322 internetMessageId for threading:
 *   1. POST /users/{sender}/messages  → creates draft, returns internetMessageId
 *   2. POST /users/{sender}/messages/{id}/send → delivers it
 *
 * Key behaviors:
 * - Token acquisition via client_credentials grant, cached until 5 min before expiry
 * - 401 retry: clears cached token, re-acquires, retries once
 * - 429 handling: throws with retryAfterMs for BullMQ to handle
 * - Threading via internetMessageHeaders (In-Reply-To, References)
 */

import { createLogger } from '@abl/compiler/platform';
import type { EmailTransport, EmailSendParams } from './transport-interface.js';

const log = createLogger('graph-transport');
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

export interface GraphTransportConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  senderAddress: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export class GraphTransport implements EmailTransport {
  private config: GraphTransportConfig;
  private cachedToken: CachedToken | null = null;

  constructor(config: GraphTransportConfig) {
    this.config = config;
  }

  async sendReply(params: EmailSendParams): Promise<{ messageId: string }> {
    const token = await this.getAccessToken();
    const messagePayload = this.buildMessagePayload(params);
    const userPath = `${GRAPH_API_BASE}/users/${encodeURIComponent(this.config.senderAddress)}`;

    // Step 1: Create draft — response includes the RFC 5322 internetMessageId
    const draftResponse = await this.graphFetch(`${userPath}/messages`, token, messagePayload);

    const draft = (await draftResponse.json()) as {
      id: string;
      internetMessageId: string;
    };

    // Step 2: Send the draft
    await this.graphFetch(`${userPath}/messages/${draft.id}/send`, token, null);

    const messageId = draft.internetMessageId;
    log.info('Email sent via Graph API', { to: params.to, messageId });
    return { messageId };
  }

  /**
   * POST to a Graph API endpoint with 401 retry and 429 handling.
   * `body` is null for POST-with-no-body (e.g., /send).
   */
  private async graphFetch(url: string, token: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      ...(body !== null && { body: JSON.stringify(body) }),
    });

    // 401 — token may be stale, retry once with fresh token
    if (response.status === 401) {
      log.warn('Graph API returned 401, refreshing token and retrying', { url });
      this.cachedToken = null;
      const freshToken = await this.getAccessToken();
      const retryResponse = await fetch(url, {
        method: 'POST',
        headers: {
          ...headers,
          Authorization: `Bearer ${freshToken}`,
        },
        ...(body !== null && { body: JSON.stringify(body) }),
      });
      if (!retryResponse.ok) {
        throw new Error(`Graph API failed after token refresh: ${retryResponse.status}`);
      }
      return retryResponse;
    }

    // 429 — rate limited
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60_000;
      const err = new Error(`Graph API rate limit exceeded. Retry after ${retryMs}ms`);
      (err as unknown as Record<string, unknown>).retryAfterMs = retryMs;
      throw err;
    }

    if (!response.ok) {
      throw new Error(`Graph API request failed: ${response.status}`);
    }

    return response;
  }

  async checkHealth(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      const token = await this.getAccessToken();
      const url = `${GRAPH_API_BASE}/users/${encodeURIComponent(this.config.senderAddress)}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return { healthy: response.ok, latencyMs: Date.now() - start };
    } catch {
      return { healthy: false, latencyMs: Date.now() - start };
    }
  }

  private pendingTokenRequest: Promise<string> | null = null;

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) {
      return this.cachedToken.accessToken;
    }

    if (!this.pendingTokenRequest) {
      this.pendingTokenRequest = this.fetchNewToken().finally(() => {
        this.pendingTokenRequest = null;
      });
    }
    return this.pendingTokenRequest;
  }

  private async fetchNewToken(): Promise<string> {
    const url = `https://login.microsoftonline.com/${encodeURIComponent(this.config.tenantId)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    });

    const response = await fetch(url, { method: 'POST', body });
    if (!response.ok) {
      throw new Error(`Failed to acquire Graph API token: ${response.status}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.cachedToken = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000 - TOKEN_EXPIRY_BUFFER_MS,
    };

    log.info('Graph API token acquired', { expiresIn: data.expires_in });
    return data.access_token;
  }

  /** Build the Graph API message resource (used for draft creation). */
  private buildMessagePayload(params: EmailSendParams): Record<string, unknown> {
    const internetMessageHeaders: Array<{ name: string; value: string }> = [];
    if (params.inReplyTo) {
      internetMessageHeaders.push({ name: 'In-Reply-To', value: params.inReplyTo });
    }
    if (params.references) {
      internetMessageHeaders.push({ name: 'References', value: params.references });
    }
    if (params.headers) {
      for (const [name, value] of Object.entries(params.headers)) {
        internetMessageHeaders.push({ name, value });
      }
    }

    const message: Record<string, unknown> = {
      subject: params.subject,
      body: params.html
        ? { contentType: 'HTML', content: params.html }
        : { contentType: 'Text', content: params.text },
      toRecipients: [{ emailAddress: { address: params.to } }],
    };

    if (params.cc && params.cc.length > 0) {
      message.ccRecipients = params.cc.map((addr) => ({ emailAddress: { address: addr } }));
    }
    if (params.bcc && params.bcc.length > 0) {
      message.bccRecipients = params.bcc.map((addr) => ({ emailAddress: { address: addr } }));
    }
    if (internetMessageHeaders.length > 0) {
      message.internetMessageHeaders = internetMessageHeaders;
    }

    return message;
  }
}
