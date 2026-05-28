import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runWithTenantContext: vi.fn(async (_ctx: unknown, fn: () => unknown) => await fn()),
  getContactLinkingDeps: vi.fn(),
  linkSessionToContactExecute: vi.fn(),
  conversationLinkContact: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/shared-auth/middleware', () => ({
  runWithTenantContext: (...args: unknown[]) => mocks.runWithTenantContext(...args),
}));

vi.mock('../../services/identity/contact-linking-deps.js', () => ({
  getContactLinkingDeps: (...args: unknown[]) => mocks.getContactLinkingDeps(...args),
}));

vi.mock('../../services/stores/store-factory.js', () => ({
  getStores: () => ({
    conversation: {
      linkContact: (...args: unknown[]) => mocks.conversationLinkContact(...args),
    },
  }),
}));

describe('channel-contact-linking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runWithTenantContext.mockImplementation(async (_ctx: unknown, fn: () => unknown) => fn());
    mocks.linkSessionToContactExecute.mockResolvedValue(undefined);
    mocks.conversationLinkContact.mockResolvedValue(undefined);
    mocks.getContactLinkingDeps.mockReturnValue({
      resolveOrCreateContact: {
        execute: vi.fn(),
      },
      linkSessionToContact: {
        execute: (...args: unknown[]) => mocks.linkSessionToContactExecute(...args),
      },
    });
  });

  it('runs durable session contact linking inside a worker tenant context', async () => {
    const { linkResolvedContactToSession } =
      await import('../../services/identity/channel-contact-linking.js');

    await linkResolvedContactToSession({
      tenantId: 'tenant-1',
      channelType: 'genesys',
      channelId: 'conn-1',
      sessionId: 'runtime-sess-1',
      contactId: 'contact-1',
    });

    expect(mocks.runWithTenantContext).toHaveBeenCalledTimes(1);
    expect(mocks.runWithTenantContext).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        userId: 'system',
        role: 'system',
        permissions: [],
        authType: 'api_key',
        isSuperAdmin: false,
      },
      expect.any(Function),
    );
    expect(mocks.linkSessionToContactExecute).toHaveBeenCalledWith(
      'tenant-1',
      'contact-1',
      'runtime-sess-1',
      'genesys',
      'conn-1',
    );
    expect(mocks.conversationLinkContact).toHaveBeenCalledWith('runtime-sess-1', 'contact-1');
  });
});
