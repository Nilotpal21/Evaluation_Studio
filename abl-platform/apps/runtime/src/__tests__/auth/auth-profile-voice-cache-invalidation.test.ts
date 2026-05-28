/**
 * VoiceServiceFactory Cache Invalidation Tests (Task 3.10)
 *
 * Validates that:
 * - Auth profile rotation events clear cached voice services
 * - Non-voice category events are ignored
 * - invalidate() clears all service types for a tenant
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/shared/services/auth-profile', () => ({
  dualReadCredentials: vi.fn().mockResolvedValue({ credentials: null, source: 'legacy' }),
}));

vi.mock('../../services/auth-profile-resolver.js', () => ({
  resolveAuthProfileCredentials: vi.fn().mockResolvedValue(null),
  getAuthProfileCache: vi.fn(),
  resolveAuthProfileCredentials: vi.fn(),
}));

vi.mock('@agent-platform/database/models', () => ({
  TenantServiceInstance: {
    findOne: vi.fn().mockReturnValue({ lean: () => Promise.resolve(null) }),
  },
}));

vi.mock('../../services/voice/deepgram-service.js', () => ({
  DeepgramService: { fromCredentials: vi.fn() },
}));

vi.mock('../../services/voice/elevenlabs-service.js', () => ({
  ElevenLabsService: { fromCredentials: vi.fn() },
}));

vi.mock('../../services/voice/twilio-service.js', () => ({
  TwilioService: { fromCredentials: vi.fn() },
}));

vi.mock('../../services/voice/voice-mode-resolver.js', () => ({
  resolveVoiceMode: vi.fn(),
}));

// ---------------------------------------------------------------------------
// SUT
// ---------------------------------------------------------------------------

import { VoiceServiceFactory } from '../../services/voice/voice-service-factory.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VoiceServiceFactory cache invalidation (Task 3.10)', () => {
  let factory: VoiceServiceFactory;

  beforeEach(() => {
    factory = new VoiceServiceFactory(null);
  });

  it('invalidate() clears cached services for a tenant', () => {
    // Manually populate cache via internal access
    const cache = (factory as any).cache as Map<string, unknown>;
    cache.set('tenant-1:deepgram', { service: {}, instanceId: 'inst-1', cachedAt: Date.now() });
    cache.set('tenant-1:elevenlabs', { service: {}, instanceId: 'inst-2', cachedAt: Date.now() });
    cache.set('tenant-2:deepgram', { service: {}, instanceId: 'inst-3', cachedAt: Date.now() });

    // Invalidate tenant-1
    factory.invalidate('tenant-1');

    expect(cache.has('tenant-1:deepgram')).toBe(false);
    expect(cache.has('tenant-1:elevenlabs')).toBe(false);
    // tenant-2 should be unaffected
    expect(cache.has('tenant-2:deepgram')).toBe(true);
  });

  it('invalidate() with serviceType clears only that type', () => {
    const cache = (factory as any).cache as Map<string, unknown>;
    cache.set('tenant-1:deepgram', { service: {}, instanceId: 'inst-1', cachedAt: Date.now() });
    cache.set('tenant-1:elevenlabs', { service: {}, instanceId: 'inst-2', cachedAt: Date.now() });

    factory.invalidate('tenant-1', 'deepgram');

    expect(cache.has('tenant-1:deepgram')).toBe(false);
    expect(cache.has('tenant-1:elevenlabs')).toBe(true);
  });

  it('subscribeToAuthProfileEvents invalidates on voice category events', () => {
    const cache = (factory as any).cache as Map<string, unknown>;
    cache.set('tenant-1:deepgram', { service: {}, instanceId: 'inst-1', cachedAt: Date.now() });

    let subscribedHandler: ((message: string) => void) | null = null;
    const mockRedisSub = {
      subscribe: vi.fn((channel: string, cb: (message: string) => void) => {
        subscribedHandler = cb;
      }),
      unsubscribe: vi.fn(),
    };

    const cleanup = factory.subscribeToAuthProfileEvents(mockRedisSub);
    expect(mockRedisSub.subscribe).toHaveBeenCalledWith(
      'auth-profile:updated',
      expect.any(Function),
    );

    // Trigger voice category event
    subscribedHandler!(JSON.stringify({ tenantId: 'tenant-1', category: 'voice' }));

    expect(cache.has('tenant-1:deepgram')).toBe(false);

    cleanup();
    expect(mockRedisSub.unsubscribe).toHaveBeenCalledWith('auth-profile:updated');
  });

  it('subscribeToAuthProfileEvents ignores non-voice category events', () => {
    const cache = (factory as any).cache as Map<string, unknown>;
    cache.set('tenant-1:deepgram', { service: {}, instanceId: 'inst-1', cachedAt: Date.now() });

    let subscribedHandler: ((message: string) => void) | null = null;
    const mockRedisSub = {
      subscribe: vi.fn((channel: string, cb: (message: string) => void) => {
        subscribedHandler = cb;
      }),
      unsubscribe: vi.fn(),
    };

    factory.subscribeToAuthProfileEvents(mockRedisSub);

    // Trigger non-voice category event
    subscribedHandler!(JSON.stringify({ tenantId: 'tenant-1', category: 'api' }));

    // Cache should NOT be invalidated
    expect(cache.has('tenant-1:deepgram')).toBe(true);
  });

  it('subscribeToAuthProfileEvents handles malformed messages gracefully', () => {
    let subscribedHandler: ((message: string) => void) | null = null;
    const mockRedisSub = {
      subscribe: vi.fn((channel: string, cb: (message: string) => void) => {
        subscribedHandler = cb;
      }),
      unsubscribe: vi.fn(),
    };

    factory.subscribeToAuthProfileEvents(mockRedisSub);

    // Should not throw on malformed JSON
    expect(() => subscribedHandler!('not-valid-json')).not.toThrow();
    expect(() => subscribedHandler!(JSON.stringify({}))).not.toThrow();
  });
});
