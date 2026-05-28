/**
 * Slack OAuth Provider
 *
 * Implements ChannelOAuthProvider for Slack OAuth V2 flow.
 * Uses a platform-level Slack app (shared clientId/clientSecret).
 */

import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import { createLogger } from '@abl/compiler/platform';
import type { ChannelOAuthProvider, ChannelOAuthResult } from '../channel-oauth-provider.js';

const log = createLogger('slack-oauth-provider');

const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_TOKEN_URL = 'https://slack.com/api/oauth.v2.access';

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  scopes: string[];
}

export class SlackOAuthProvider implements ChannelOAuthProvider {
  readonly channelType = 'slack';

  constructor(private config: SlackOAuthConfig) {}

  buildAuthorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      scope: this.config.scopes.join(','),
      state,
      redirect_uri: redirectUri,
    });
    return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<ChannelOAuthResult> {
    const response = await fetch(SLACK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new AppError(
        `Slack token exchange HTTP error: ${response.status} — ${errorText.substring(0, 200)}`,
        { ...ErrorCodes.SERVICE_UNAVAILABLE },
      );
    }

    const data = (await response.json()) as {
      ok: boolean;
      error?: string;
      access_token?: string;
      bot_user_id?: string;
      app_id?: string;
      team?: { id: string; name: string };
    };

    if (!data.ok || !data.access_token) {
      throw new AppError(`Slack OAuth failed: ${data.error ?? 'no access_token returned'}`, {
        ...ErrorCodes.BAD_REQUEST,
      });
    }

    const teamId = data.team?.id ?? '';
    const teamName = data.team?.name ?? '';
    const appId = data.app_id ?? '';
    const botUserId = data.bot_user_id ?? '';

    log.info('Slack OAuth code exchanged', { teamId, appId });

    return {
      credentials: {
        bot_token: data.access_token,
        signing_secret: this.config.signingSecret,
      },
      externalIdentifier: `${teamId}:${appId}`,
      displayName: `Slack - ${teamName}`,
      metadata: { teamId, teamName, botUserId, appId },
    };
  }
}
