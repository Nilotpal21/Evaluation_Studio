import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreateOwnedFactStore = vi.fn();
const mockCreateProjectFactStore = vi.fn();

vi.mock('../../services/stores/mongodb-fact-store.js', () => ({
  PROJECT_SCOPE_USER_ID: '__project__',
  createOwnedFactStore: (...args: unknown[]) => mockCreateOwnedFactStore(...args),
  createProjectFactStore: (...args: unknown[]) => mockCreateProjectFactStore(...args),
}));

describe('runtime-session-identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateOwnedFactStore.mockReturnValue({ kind: 'user-store' });
    mockCreateProjectFactStore.mockReturnValue({ kind: 'project-store' });
  });

  it('rekeys runtime session identity and fact stores when canonical contact is backfilled', async () => {
    const { applyCallerContextToRuntimeSession } =
      await import('../../services/session/runtime-session-identity.js');

    const session = {
      id: 'sess-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'sdk-session-legacy-1',
      callerContext: {
        tenantId: 'tenant-1',
        channel: 'sdk_websocket',
        customerId: 'verified-user-42',
        anonymousId: 'sdk-session-legacy-1',
        sessionPrincipalId: 'sdk-session-legacy-1',
      },
      data: {
        values: {
          user_id: 'sdk-session-legacy-1',
          session: {
            userId: 'sdk-session-legacy-1',
            sessionId: 'sess-1',
          },
        },
        gatheredKeys: new Set<string>(),
      },
      factStore: { kind: 'legacy-store' },
      projectFactStore: { kind: 'legacy-project-store' },
    } as any;

    applyCallerContextToRuntimeSession(session, {
      contactId: 'contact-42',
      contactDisplayName: 'Verified Contact',
    } as any);

    expect(session.callerContext).toEqual(
      expect.objectContaining({
        contactId: 'contact-42',
        contactDisplayName: 'Verified Contact',
        sessionPrincipalId: 'sdk-session-legacy-1',
        anonymousId: 'sdk-session-legacy-1',
      }),
    );
    expect(session.userId).toBe('contact-42');
    expect(session.data.values.user_id).toBe('contact-42');
    expect(session.data.values.session.userId).toBe('contact-42');
    expect(session.data.values.session.sessionPrincipalId).toBe('sdk-session-legacy-1');
    expect(session.data.values.session.anonymousId).toBe('sdk-session-legacy-1');
    expect(mockCreateOwnedFactStore).toHaveBeenCalledWith('tenant-1', 'contact-42', 'project-1');
    expect(mockCreateProjectFactStore).toHaveBeenCalledWith('tenant-1', 'project-1');
    expect(session.factStore).toEqual({ kind: 'user-store' });
    expect(session.projectFactStore).toEqual({ kind: 'project-store' });
  });

  it('keeps project memory available while leaving anonymous session principals out of durable user memory', async () => {
    const { applyCallerContextToRuntimeSession } =
      await import('../../services/session/runtime-session-identity.js');

    const session = {
      id: 'sess-2',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'sdk-session-legacy-2',
      callerContext: {
        tenantId: 'tenant-1',
        channel: 'sdk_websocket',
        anonymousId: 'sdk-session-legacy-2',
        sessionPrincipalId: 'sdk-session-legacy-2',
      },
      data: {
        values: {
          user_id: 'sdk-session-legacy-2',
          session: {
            userId: 'sdk-session-legacy-2',
            sessionId: 'sess-2',
          },
        },
        gatheredKeys: new Set<string>(),
      },
      factStore: { kind: 'legacy-store' },
      projectFactStore: undefined,
    } as any;

    applyCallerContextToRuntimeSession(session, {
      tenantId: 'tenant-1',
      channel: 'sdk_websocket',
      anonymousId: 'sdk-session-legacy-2',
      sessionPrincipalId: 'sdk-session-legacy-2',
      identityTier: 0,
      verificationMethod: 'none',
    } as any);

    expect(session.userId).toBe('sdk-session-legacy-2');
    expect(mockCreateOwnedFactStore).not.toHaveBeenCalled();
    expect(mockCreateProjectFactStore).toHaveBeenCalledWith('tenant-1', 'project-1');
    expect(session.factStore).toBeUndefined();
    expect(session.projectFactStore).toEqual({ kind: 'project-store' });
  });

  it('keeps customer-backed sessions on customer-owned durable memory', async () => {
    const { applyCallerContextToRuntimeSession } =
      await import('../../services/session/runtime-session-identity.js');

    const session = {
      id: 'sess-3',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'sdk-session-legacy-3',
      callerContext: {
        tenantId: 'tenant-1',
        channel: 'web',
        customerId: 'customer-42',
        anonymousId: 'sdk-session-legacy-3',
        sessionPrincipalId: 'sdk-session-legacy-3',
      },
      data: {
        values: {
          user_id: 'sdk-session-legacy-3',
          session: {
            userId: 'sdk-session-legacy-3',
            sessionId: 'sess-3',
          },
        },
        gatheredKeys: new Set<string>(),
      },
      factStore: { kind: 'legacy-store' },
      projectFactStore: undefined,
    } as any;

    applyCallerContextToRuntimeSession(session, {
      tenantId: 'tenant-1',
      channel: 'web',
      customerId: 'customer-42',
      anonymousId: 'sdk-session-legacy-3',
      sessionPrincipalId: 'sdk-session-legacy-3',
      identityTier: 1,
      verificationMethod: 'email_link',
    } as any);

    expect(session.userId).toBe('customer-42');
    expect(session.data.values.user_id).toBe('customer-42');
    expect(mockCreateOwnedFactStore).toHaveBeenCalledWith('tenant-1', 'customer-42', 'project-1');
    expect(mockCreateProjectFactStore).toHaveBeenCalledWith('tenant-1', 'project-1');
    expect(session.factStore).toEqual({ kind: 'user-store' });
    expect(session.projectFactStore).toEqual({ kind: 'project-store' });
  });
});
