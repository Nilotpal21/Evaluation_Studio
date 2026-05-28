import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChannelOAuthService } from '../channel-oauth-service.js';
import type { ChannelOAuthProvider, ChannelOAuthResult } from '../channel-oauth-provider.js';
import type { OAuthStateStore } from '../../tool-oauth-service.js';

function createMockProvider(channelType = 'slack'): ChannelOAuthProvider {
  return {
    channelType,
    buildAuthorizeUrl: vi.fn(
      (state, redirectUri) => `https://example.com/authorize?state=${state}`,
    ),
    exchangeCode: vi.fn(async () => ({
      credentials: { bot_token: 'xoxb-test' },
      externalIdentifier: 'T123:A456',
      displayName: 'Test Workspace',
      metadata: { teamId: 'T123' },
    })),
  };
}

function createMockStateStore(): OAuthStateStore {
  const store = new Map<string, any>();
  return {
    set: vi.fn(async (state, data) => {
      store.set(state, data);
    }),
    getAndDelete: vi.fn(async (state) => {
      const data = store.get(state);
      store.delete(state);
      return data ?? null;
    }),
  };
}

describe('ChannelOAuthService', () => {
  let service: ChannelOAuthService;
  let stateStore: OAuthStateStore;
  let provider: ChannelOAuthProvider;

  beforeEach(() => {
    stateStore = createMockStateStore();
    provider = createMockProvider();
    service = new ChannelOAuthService(stateStore);
    service.registerProvider(provider);
  });

  describe('initiateFlow', () => {
    it('returns authUrl and state for registered provider', async () => {
      const result = await service.initiateFlow(
        'slack',
        'tenant-1',
        'user-1',
        'project-1',
        'https://studio.example.com/callback',
      );

      expect(result.authUrl).toContain('https://example.com/authorize');
      expect(result.state).toBeDefined();
      expect(result.state).toHaveLength(64); // 32 bytes hex
      expect(stateStore.set).toHaveBeenCalledOnce();
    });

    it('throws for unregistered channel type', async () => {
      await expect(
        service.initiateFlow('unknown', 'tenant-1', 'user-1', 'project-1', 'https://example.com'),
      ).rejects.toThrow(/unknown/i);
    });
  });

  describe('handleCallback', () => {
    it('validates state and returns provider result', async () => {
      const { state } = await service.initiateFlow(
        'slack',
        'tenant-1',
        'user-1',
        'project-1',
        'https://studio.example.com/callback',
      );

      const result = await service.handleCallback('slack', 'auth-code-123', state);

      expect(result.credentials).toEqual({ bot_token: 'xoxb-test' });
      expect(result.externalIdentifier).toBe('T123:A456');
      expect(result.displayName).toBe('Test Workspace');
      expect(provider.exchangeCode).toHaveBeenCalledWith(
        'auth-code-123',
        'https://studio.example.com/callback',
      );
    });

    it('throws for invalid state', async () => {
      await expect(service.handleCallback('slack', 'code', 'bad-state')).rejects.toThrow(
        /invalid|expired/i,
      );
    });

    it('throws for mismatched channel type', async () => {
      const { state } = await service.initiateFlow(
        'slack',
        'tenant-1',
        'user-1',
        'project-1',
        'https://example.com',
      );

      await expect(service.handleCallback('whatsapp', 'code', state)).rejects.toThrow(/mismatch/i);
    });

    it('throws when state has expired', async () => {
      const { state } = await service.initiateFlow(
        'slack',
        'tenant-1',
        'user-1',
        'project-1',
        'https://example.com',
      );

      // Manually overwrite the stored state with an already-expired expiresAt
      const original = stateStore.getAndDelete as ReturnType<typeof vi.fn>;
      original.mockImplementationOnce(async (key: string) => ({
        provider: 'slack',
        tenantId: 'tenant-1',
        userId: 'user-1',
        projectId: 'project-1',
        redirectUri: 'https://example.com',
        expiresAt: Date.now() - 1000, // expired 1 second ago
      }));

      await expect(service.handleCallback('slack', 'code', state)).rejects.toThrow(/expired/i);
    });
  });
});
