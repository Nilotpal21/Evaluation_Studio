/**
 * Meta OAuth Provider (WhatsApp + Messenger)
 *
 * Implements ChannelOAuthProvider for Facebook Login OAuth flow.
 * A single class handles both WhatsApp and Messenger, parameterized by channel type.
 */

import { randomBytes } from 'node:crypto';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import { createLogger } from '@abl/compiler/platform';
import type { ChannelOAuthProvider, ChannelOAuthResult } from '../channel-oauth-provider.js';

const log = createLogger('meta-oauth-provider');

const META_AUTHORIZE_URL = 'https://www.facebook.com/v21.0/dialog/oauth';
const META_TOKEN_URL = 'https://graph.facebook.com/v21.0/oauth/access_token';
const META_ACCOUNTS_URL = 'https://graph.facebook.com/v21.0/me/accounts';

const DEFAULT_WHATSAPP_SCOPES = 'whatsapp_business_management,whatsapp_business_messaging';
const DEFAULT_MESSENGER_SCOPES = 'pages_messaging,pages_read_engagement,pages_manage_metadata';

export interface MetaOAuthConfig {
  channelType: 'whatsapp' | 'messenger';
  appId: string;
  appSecret: string;
  scopes?: string;
}

export class MetaOAuthProvider implements ChannelOAuthProvider {
  readonly channelType: string;

  constructor(private config: MetaOAuthConfig) {
    this.channelType = config.channelType;
  }

  private get scopes(): string {
    if (this.config.scopes) return this.config.scopes;
    return this.config.channelType === 'whatsapp'
      ? DEFAULT_WHATSAPP_SCOPES
      : DEFAULT_MESSENGER_SCOPES;
  }

  buildAuthorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.config.appId,
      scope: this.scopes,
      state,
      redirect_uri: redirectUri,
      response_type: 'code',
    });
    return `${META_AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<ChannelOAuthResult> {
    // Step 1: Exchange code for access token
    const tokenResponse = await fetch(META_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new AppError(
        `Meta token exchange HTTP error: ${tokenResponse.status} — ${errorText.substring(0, 200)}`,
        { ...ErrorCodes.SERVICE_UNAVAILABLE },
      );
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token?: string;
      error?: { message: string };
    };

    if (!tokenData.access_token) {
      throw new AppError(
        `Meta OAuth failed: ${tokenData.error?.message ?? 'no access_token returned'}`,
        { ...ErrorCodes.BAD_REQUEST },
      );
    }

    // Step 2: Resolve page/business identity
    const accountsResponse = await fetch(
      `${META_ACCOUNTS_URL}?access_token=${tokenData.access_token}`,
    );

    if (!accountsResponse.ok) {
      const errorText = await accountsResponse.text();
      throw new AppError(
        `Meta accounts API error: ${accountsResponse.status} — ${errorText.substring(0, 200)}`,
        { ...ErrorCodes.SERVICE_UNAVAILABLE },
      );
    }

    const accountsData = (await accountsResponse.json()) as {
      data?: Array<{ id: string; name: string; access_token: string }>;
      error?: { message: string };
    };

    if (accountsData.error) {
      throw new AppError(`Meta accounts API error: ${accountsData.error.message}`, {
        ...ErrorCodes.BAD_REQUEST,
      });
    }

    const page = accountsData.data?.[0];
    const pageName = page?.name ?? '';
    const pageId = page?.id ?? '';
    const pageAccessToken = page?.access_token ?? tokenData.access_token;
    const verifyToken = randomBytes(16).toString('hex');

    log.info('Meta OAuth code exchanged', {
      channelType: this.channelType,
      pageId,
      pageName,
    });

    if (this.config.channelType === 'whatsapp') {
      return {
        credentials: {
          access_token: tokenData.access_token,
          app_secret: this.config.appSecret,
          verify_token: verifyToken,
        },
        externalIdentifier: pageId,
        displayName: `WhatsApp - ${pageName || pageId}`,
        metadata: { pageId, pageName, verifyToken },
      };
    }

    // Messenger
    return {
      credentials: {
        page_access_token: pageAccessToken,
        app_secret: this.config.appSecret,
        verify_token: verifyToken,
      },
      externalIdentifier: pageId,
      displayName: `Messenger - ${pageName || pageId}`,
      metadata: { pageId, pageName, verifyToken },
    };
  }
}
