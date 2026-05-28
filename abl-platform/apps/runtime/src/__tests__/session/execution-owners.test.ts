import { describe, expect, it } from 'vitest';
import {
  resolveAuthOwners,
  resolveCallerContextSessionPrincipalId,
  resolveRuntimeExecutionOwners,
} from '../../services/session/execution-owners.js';

describe('execution-owners', () => {
  it('prefers explicit sessionPrincipalId over the anonymous compatibility alias', () => {
    expect(
      resolveCallerContextSessionPrincipalId({
        sessionPrincipalId: 'sessp-1',
        anonymousId: 'anon-1',
      }),
    ).toBe('sessp-1');
  });

  it('separates contact-backed durable memory from the session principal lane', () => {
    const owners = resolveRuntimeExecutionOwners({
      userId: 'contact-42',
      callerContext: {
        tenantId: 'tenant-1',
        channel: 'sdk_websocket',
        contactId: 'contact-42',
        sessionPrincipalId: 'sessp-42',
        anonymousId: 'sessp-42',
        identityTier: 2,
        verificationMethod: 'oauth',
      },
    });

    expect(owners.compatibilityUserId).toBe('contact-42');
    expect(owners.contactOwner).toEqual({ kind: 'contact', id: 'contact-42' });
    expect(owners.sessionPrincipalOwner).toEqual({ kind: 'session_principal', id: 'sessp-42' });
    expect(owners.durableMemoryOwner).toEqual({ kind: 'contact', id: 'contact-42' });
  });

  it('keeps anonymous SDK sessions out of durable user memory while preserving auth ownership', () => {
    const owners = resolveRuntimeExecutionOwners({
      userId: 'sessp-anon-1',
      callerContext: {
        tenantId: 'tenant-1',
        channel: 'sdk_websocket',
        sessionPrincipalId: 'sessp-anon-1',
        anonymousId: 'sessp-anon-1',
        identityTier: 0,
        verificationMethod: 'none',
      },
    });

    expect(owners.compatibilityUserId).toBe('sessp-anon-1');
    expect(owners.sessionPrincipalOwner).toEqual({
      kind: 'session_principal',
      id: 'sessp-anon-1',
    });
    expect(owners.durableMemoryOwner).toBeUndefined();
  });

  it('preserves customer-backed user ownership ahead of a legacy session principal user id', () => {
    const owners = resolveRuntimeExecutionOwners({
      userId: 'sessp-legacy-1',
      callerContext: {
        tenantId: 'tenant-1',
        channel: 'web',
        customerId: 'customer-42',
        sessionPrincipalId: 'sessp-legacy-1',
        anonymousId: 'sessp-legacy-1',
        identityTier: 1,
        verificationMethod: 'email_link',
      },
    });

    expect(owners.compatibilityUserId).toBe('customer-42');
    expect(owners.customerOwner).toEqual({ kind: 'customer', id: 'customer-42' });
    expect(owners.sessionPrincipalOwner).toEqual({
      kind: 'session_principal',
      id: 'sessp-legacy-1',
    });
    expect(owners.durableMemoryOwner).toEqual({ kind: 'customer', id: 'customer-42' });
  });

  it('uses the explicit session principal for session-scoped auth without overwriting the user lane', () => {
    expect(
      resolveAuthOwners({
        userId: 'profile-owner-1',
        sessionPrincipalId: 'sessp-77',
        authScope: 'session',
      }),
    ).toEqual({
      userScopedOwnerId: 'profile-owner-1',
      sessionPrincipalId: 'sessp-77',
      tokenOwnerId: 'sessp-77',
    });
  });
});
