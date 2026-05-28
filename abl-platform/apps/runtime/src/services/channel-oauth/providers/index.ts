/**
 * Channel OAuth Provider Registration
 *
 * Reads env vars and registers available channel OAuth providers.
 */

import { createLogger } from '@abl/compiler/platform';
import type { ChannelOAuthService } from '../channel-oauth-service.js';
import { MetaOAuthProvider } from './meta-oauth-provider.js';
import { MSTeamsOAuthProvider } from './msteams-oauth-provider.js';
import { SlackOAuthProvider } from './slack-oauth-provider.js';

const log = createLogger('channel-oauth-providers');

/** Register all available channel OAuth providers from environment config */
export function registerChannelOAuthProviders(service: ChannelOAuthService): void {
  // Slack
  const slackClientId = process.env.CHANNEL_OAUTH_SLACK_CLIENT_ID;
  const slackClientSecret = process.env.CHANNEL_OAUTH_SLACK_CLIENT_SECRET;
  const slackSigningSecret = process.env.CHANNEL_OAUTH_SLACK_SIGNING_SECRET;

  if (slackClientId && slackClientSecret && slackSigningSecret) {
    const scopes = (
      process.env.CHANNEL_OAUTH_SLACK_SCOPES ??
      'chat:write,chat:write.public,im:history,im:write,channels:read,channels:history,groups:read,groups:history,users:read,users:read.email,app_mentions:read,commands'
    )
      .split(',')
      .map((s) => s.trim());

    service.registerProvider(
      new SlackOAuthProvider({
        clientId: slackClientId,
        clientSecret: slackClientSecret,
        signingSecret: slackSigningSecret,
        scopes,
      }),
    );
  } else {
    log.info('Slack channel OAuth not configured (missing CHANNEL_OAUTH_SLACK_* env vars)');
  }

  // MSTeams
  const msteamsAppId = process.env.CHANNEL_OAUTH_MSTEAMS_APP_ID;
  const msteamsClientSecret = process.env.CHANNEL_OAUTH_MSTEAMS_CLIENT_SECRET;
  const msteamsTenantId = process.env.CHANNEL_OAUTH_MSTEAMS_TENANT_ID ?? 'common';

  if (msteamsAppId && msteamsClientSecret) {
    service.registerProvider(
      new MSTeamsOAuthProvider({
        appId: msteamsAppId,
        clientSecret: msteamsClientSecret,
        azureTenantId: msteamsTenantId,
      }),
    );
  } else {
    log.info('MSTeams channel OAuth not configured (missing CHANNEL_OAUTH_MSTEAMS_* env vars)');
  }

  // WhatsApp + Messenger (shared Meta app)
  const metaAppId = process.env.CHANNEL_OAUTH_META_APP_ID;
  const metaAppSecret = process.env.CHANNEL_OAUTH_META_APP_SECRET;

  if (metaAppId && metaAppSecret) {
    service.registerProvider(
      new MetaOAuthProvider({
        channelType: 'whatsapp',
        appId: metaAppId,
        appSecret: metaAppSecret,
        scopes: process.env.CHANNEL_OAUTH_WHATSAPP_SCOPES,
      }),
    );
    service.registerProvider(
      new MetaOAuthProvider({
        channelType: 'messenger',
        appId: metaAppId,
        appSecret: metaAppSecret,
        scopes: process.env.CHANNEL_OAUTH_MESSENGER_SCOPES,
      }),
    );
  } else {
    log.info('Meta channel OAuth not configured (missing CHANNEL_OAUTH_META_* env vars)');
  }
}
