/**
 * MSTeams OAuth Provider
 *
 * Implements ChannelOAuthProvider for Microsoft Teams Bot Framework.
 * Uses Azure AD OAuth 2.0 to authorize the platform bot app in a customer's tenant.
 */

import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import { createLogger } from '@abl/compiler/platform';
import type { ChannelOAuthProvider, ChannelOAuthResult } from '../channel-oauth-provider.js';

const log = createLogger('msteams-oauth-provider');

export interface MSTeamsOAuthConfig {
  appId: string;
  clientSecret: string;
  azureTenantId: string; // Azure AD tenant — often 'common' for multi-tenant bots
}

export class MSTeamsOAuthProvider implements ChannelOAuthProvider {
  readonly channelType = 'msteams';

  constructor(private config: MSTeamsOAuthConfig) {}

  buildAuthorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.config.appId,
      response_type: 'code',
      scope: 'https://api.botframework.com/.default',
      state,
      redirect_uri: redirectUri,
    });
    return `https://login.microsoftonline.com/${this.config.azureTenantId}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<ChannelOAuthResult> {
    const tokenUrl = `https://login.microsoftonline.com/${this.config.azureTenantId}/oauth2/v2.0/token`;

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.appId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        scope: 'https://api.botframework.com/.default',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new AppError(
        `MSTeams token exchange HTTP error: ${response.status} — ${errorText.substring(0, 200)}`,
        { ...ErrorCodes.SERVICE_UNAVAILABLE },
      );
    }

    const data = (await response.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (!data.access_token) {
      throw new AppError(
        `MSTeams OAuth failed: ${data.error ?? 'no access_token returned'} — ${data.error_description ?? ''}`,
        { ...ErrorCodes.BAD_REQUEST },
      );
    }

    log.info('MSTeams OAuth code exchanged', { appId: this.config.appId });

    return {
      credentials: {
        app_id: this.config.appId,
        client_secret: this.config.clientSecret,
        tenant_id: this.config.azureTenantId,
      },
      externalIdentifier: this.config.appId,
      displayName: `Microsoft Teams - ${this.config.appId}`,
      metadata: {
        appId: this.config.appId,
        azureTenantId: this.config.azureTenantId,
      },
    };
  }
}
