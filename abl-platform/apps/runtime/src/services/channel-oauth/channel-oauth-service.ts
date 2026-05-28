/**
 * Channel OAuth Service
 *
 * Generic OAuth 2.0 flow manager for channel connections.
 * Delegates channel-specific logic to ChannelOAuthProvider adapters.
 * Reuses OAuthStateStore from ToolOAuthService for CSRF state management.
 */

import crypto from 'crypto';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import { createLogger } from '@abl/compiler/platform';
import type { ChannelOAuthProvider, ChannelOAuthResult } from './channel-oauth-provider.js';
import type { OAuthStateStore } from '../tool-oauth-service.js';

const log = createLogger('channel-oauth-service');

/** Pending channel OAuth state */
export interface PendingChannelOAuthState {
  channelType: string;
  tenantId: string;
  userId: string;
  projectId: string;
  redirectUri: string;
  expiresAt: number;
}

/** State TTL: 10 minutes */
const STATE_TTL_MS = 10 * 60 * 1000;

export class ChannelOAuthService {
  private providers = new Map<string, ChannelOAuthProvider>();

  constructor(private stateStore: OAuthStateStore) {}

  /** Register a channel OAuth provider */
  registerProvider(provider: ChannelOAuthProvider): void {
    this.providers.set(provider.channelType, provider);
    log.info('Channel OAuth provider registered', { channelType: provider.channelType });
  }

  /** Get list of channel types that support OAuth */
  getRegisteredChannelTypes(): string[] {
    return Array.from(this.providers.keys());
  }

  /** Initiate OAuth flow: generate state, return provider's authorize URL */
  async initiateFlow(
    channelType: string,
    tenantId: string,
    userId: string,
    projectId: string,
    redirectUri: string,
  ): Promise<{ authUrl: string; state: string }> {
    const provider = this.providers.get(channelType);
    if (!provider) {
      throw new AppError(
        `No OAuth provider registered for channel type: ${channelType}. Available: ${this.getRegisteredChannelTypes().join(', ') || 'none'}`,
        { ...ErrorCodes.BAD_REQUEST },
      );
    }

    const state = crypto.randomBytes(32).toString('hex');
    await this.stateStore.set(state, {
      provider: channelType,
      tenantId,
      userId,
      projectId,
      redirectUri,
      expiresAt: Date.now() + STATE_TTL_MS,
    } as any);

    const authUrl = provider.buildAuthorizeUrl(state, redirectUri);
    log.info('Channel OAuth flow initiated', { channelType, tenantId, projectId });
    return { authUrl, state };
  }

  /** Handle OAuth callback: validate state, exchange code, return result */
  async handleCallback(
    channelType: string,
    code: string,
    state: string,
  ): Promise<ChannelOAuthResult & { tenantId: string; userId: string; projectId: string }> {
    const pending = await this.stateStore.getAndDelete(state);
    if (!pending) {
      throw new AppError('Invalid or expired OAuth state', { ...ErrorCodes.BAD_REQUEST });
    }
    if (pending.expiresAt < Date.now()) {
      throw new AppError('OAuth state expired', { ...ErrorCodes.BAD_REQUEST });
    }
    if (pending.provider !== channelType) {
      throw new AppError(
        `Channel type mismatch: expected ${pending.provider}, got ${channelType}`,
        { ...ErrorCodes.BAD_REQUEST },
      );
    }
    if (
      typeof pending.userId !== 'string' ||
      pending.userId.length === 0 ||
      typeof (pending as { projectId?: unknown }).projectId !== 'string' ||
      typeof pending.redirectUri !== 'string'
    ) {
      throw new AppError('Invalid or expired OAuth state', { ...ErrorCodes.BAD_REQUEST });
    }

    const provider = this.providers.get(channelType);
    if (!provider) {
      throw new AppError(`No OAuth provider for channel type: ${channelType}`, {
        ...ErrorCodes.BAD_REQUEST,
      });
    }

    const projectId = (pending as { projectId: string }).projectId;
    const result = await provider.exchangeCode(code, pending.redirectUri);
    log.info('Channel OAuth code exchanged', {
      channelType,
      tenantId: pending.tenantId,
      externalIdentifier: result.externalIdentifier,
    });

    return {
      ...result,
      tenantId: pending.tenantId,
      userId: pending.userId,
      projectId,
    };
  }
}
