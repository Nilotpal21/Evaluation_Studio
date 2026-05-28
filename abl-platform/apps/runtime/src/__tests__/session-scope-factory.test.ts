import { describe, expect, it } from 'vitest';
import type { CallerContext } from '@agent-platform/shared-auth';

import {
  assertProductionExecutionScope,
  ScopeValidationError,
} from '../services/session/scope-policy.js';
import type { ProductionExecutionScope } from '../services/session/execution-scope.js';
import {
  buildContactProductionExecutionScope,
  buildRequiredContactProductionExecutionScope,
  buildRequiredServicePrincipalProductionExecutionScope,
  buildServicePrincipalProductionExecutionScope,
  requiresCanonicalContactProductionScope,
  resolveIdentityEvidenceArtifactType,
} from '../services/session/execution-scope-factory.js';

function buildScope(overrides: Partial<ProductionExecutionScope> = {}): ProductionExecutionScope {
  return {
    kind: 'production',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    sessionId: 'runtime-session-1',
    sessionPrincipalId: 'session-principal-1',
    channelId: 'sdk',
    environment: 'prod',
    source: 'sdk',
    authType: 'sdk_session',
    traceId: 'trace-1',
    actor: { kind: 'contact', contactId: 'contact-1' },
    subject: { kind: 'contact', contactId: 'contact-1' },
    identityEvidence: {
      identityTier: 1,
      verificationMethod: 'sdk_bootstrap',
      artifacts: [{ type: 'external', valueHash: 'hash-1' }],
    },
    callerContext: {},
    ...overrides,
  };
}

describe('session scope policy', () => {
  it('accepts a valid production execution scope', () => {
    const scope = buildScope();

    expect(() => assertProductionExecutionScope(scope)).not.toThrow();
  });

  it('rejects a production execution scope without a projectId', () => {
    const scope = buildScope({ projectId: '' });

    try {
      assertProductionExecutionScope(scope);
      throw new Error('expected scope validation to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(ScopeValidationError);
      expect(err).toMatchObject({
        code: 'INVALID_SESSION_SCOPE',
        details: expect.objectContaining({
          field: 'projectId',
        }),
      });
    }
  });

  it('rejects unsupported non-production scope kinds', () => {
    try {
      assertProductionExecutionScope({
        ...buildScope(),
        kind: 'debug',
      } as unknown);
      throw new Error('expected scope kind validation to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(ScopeValidationError);
      expect(err).toMatchObject({
        code: 'UNSUPPORTED_SCOPE_KIND',
        details: expect.objectContaining({
          field: 'kind',
          received: 'debug',
        }),
      });
    }
  });

  it('rejects unsupported service principal types', () => {
    const scope = buildScope({
      actor: {
        kind: 'service_principal',
        principalType: 'custom' as 'workflow',
        principalId: 'principal-1',
      },
    });

    try {
      assertProductionExecutionScope(scope);
      throw new Error('expected service principal validation to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(ScopeValidationError);
      expect(err).toMatchObject({
        code: 'INVALID_SESSION_SCOPE',
        details: expect.objectContaining({
          field: 'actor.principalType',
          reason: 'unsupported_service_principal_type',
        }),
      });
    }
  });
});

function buildCallerContext(overrides: Partial<CallerContext> = {}): CallerContext {
  return {
    tenantId: 'tenant-1',
    channel: 'sdk_http',
    channelId: 'channel-1',
    contactId: 'contact-1',
    customerId: 'customer-1',
    sessionPrincipalId: 'session-principal-1',
    anonymousId: undefined,
    initiatedById: 'user-1',
    identityTier: 2,
    verificationMethod: 'hmac',
    channelArtifact: 'artifact-hash-1',
    channelArtifactType: 'cookie',
    ...overrides,
  };
}

describe('execution scope factory', () => {
  it('builds a contact-backed production scope when canonical inputs are present', () => {
    const scope = buildContactProductionExecutionScope({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      channelId: 'channel-1',
      environment: 'production',
      source: 'sdk_ws',
      authType: 'sdk_session',
      traceId: 'trace-1',
      contactId: 'contact-1',
      callerContext: buildCallerContext(),
    });

    expect(scope).toEqual({
      kind: 'production',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      sessionPrincipalId: 'session-principal-1',
      channelId: 'channel-1',
      environment: 'production',
      source: 'sdk_ws',
      authType: 'sdk_session',
      traceId: 'trace-1',
      actor: { kind: 'contact', contactId: 'contact-1' },
      subject: { kind: 'contact', contactId: 'contact-1' },
      identityEvidence: {
        identityTier: 2,
        verificationMethod: 'hmac',
        artifacts: [{ type: 'cookie', valueHash: 'artifact-hash-1' }],
      },
      callerContext: expect.objectContaining({
        contactId: 'contact-1',
        channelArtifactType: 'cookie',
        sessionPrincipalId: 'session-principal-1',
        anonymousId: 'session-principal-1',
      }),
    });
  });

  it('returns null when canonical contact scope is incomplete', () => {
    const scope = buildContactProductionExecutionScope({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      channelId: 'channel-1',
      environment: 'production',
      source: 'chat_http',
      authType: 'sdk_session',
      traceId: 'trace-1',
      contactId: undefined,
      callerContext: buildCallerContext({ contactId: undefined }),
    });

    expect(scope).toBeNull();
  });

  it('allows explicit tenant-context fallbacks for identity evidence fields', () => {
    const scope = buildContactProductionExecutionScope({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      channelId: 'channel-1',
      environment: 'production',
      source: 'chat_http',
      authType: 'sdk_session',
      traceId: 'trace-1',
      contactId: 'contact-1',
      callerContext: buildCallerContext({
        identityTier: undefined as unknown as 2,
        verificationMethod: undefined as unknown as 'hmac',
        channelArtifact: undefined,
      }),
      identityTier: 2,
      verificationMethod: 'hmac',
      channelArtifact: 'artifact-hash-2',
      channelArtifactType: 'email_thread',
    });

    expect(scope?.identityEvidence).toEqual({
      identityTier: 2,
      verificationMethod: 'hmac',
      artifacts: [{ type: 'email', valueHash: 'artifact-hash-2' }],
    });
  });

  it('falls back to sessionId when no explicit session principal is provided', () => {
    const scope = buildContactProductionExecutionScope({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      channelId: 'channel-1',
      environment: 'production',
      source: 'chat_http',
      authType: 'sdk_session',
      traceId: 'trace-1',
      contactId: 'contact-1',
      callerContext: buildCallerContext({
        sessionPrincipalId: undefined,
        anonymousId: undefined,
      }),
    });

    expect(scope).toMatchObject({
      sessionPrincipalId: 'session-1',
      callerContext: {
        sessionPrincipalId: 'session-1',
        anonymousId: 'session-1',
      },
    });
  });

  it('maps non-specialized artifact types to external', () => {
    expect(resolveIdentityEvidenceArtifactType('psid')).toBe('external');
    expect(resolveIdentityEvidenceArtifactType('aad_id')).toBe('external');
    expect(resolveIdentityEvidenceArtifactType('sip_uri')).toBe('external');
  });

  it('throws a stable validation error when required production scope inputs are incomplete', () => {
    try {
      buildRequiredContactProductionExecutionScope({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        channelId: 'channel-1',
        environment: 'production',
        source: 'sdk_ws',
        authType: 'sdk_session',
        traceId: 'trace-1',
        contactId: undefined,
        callerContext: buildCallerContext({ contactId: undefined }),
      });
      throw new Error('expected required scope build to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(ScopeValidationError);
      expect(err).toMatchObject({
        code: 'INVALID_SESSION_SCOPE',
        details: expect.objectContaining({
          field: 'subject.contactId',
          reason: 'incomplete_contact_production_scope',
        }),
      });
    }
  });

  it('builds a service-principal production scope for non-human integration callers', () => {
    const scope = buildServicePrincipalProductionExecutionScope({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      channelId: 'connection-1',
      environment: 'production',
      source: 'a2a',
      authType: 'a2a_connection',
      traceId: 'trace-1',
      principalType: 'integration',
      principalId: 'connection-1',
      callerContext: { connectionId: 'connection-1' },
    });

    expect(scope).toEqual({
      kind: 'production',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      sessionPrincipalId: 'connection-1',
      channelId: 'connection-1',
      environment: 'production',
      source: 'a2a',
      authType: 'a2a_connection',
      traceId: 'trace-1',
      actor: {
        kind: 'service_principal',
        principalType: 'integration',
        principalId: 'connection-1',
      },
      subject: {
        kind: 'service_principal',
        principalType: 'integration',
        principalId: 'connection-1',
      },
      identityEvidence: {
        identityTier: 2,
        verificationMethod: 'provider',
        artifacts: [],
      },
      callerContext: {
        connectionId: 'connection-1',
        sessionPrincipalId: 'connection-1',
      },
    });
  });

  it('throws a stable validation error when required service-principal scope inputs are incomplete', () => {
    expect(() =>
      buildRequiredServicePrincipalProductionExecutionScope({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        channelId: 'connection-1',
        environment: 'production',
        source: 'a2a',
        authType: 'a2a_connection',
        traceId: 'trace-1',
        principalType: 'integration',
      }),
    ).toThrowError(ScopeValidationError);
  });

  it('requires canonical contact scope for all human production callers', () => {
    expect(
      requiresCanonicalContactProductionScope({
        authScope: 'session',
        identityTier: 0,
        verificationMethod: 'none',
      }),
    ).toBe(true);

    expect(
      requiresCanonicalContactProductionScope({
        authScope: 'user',
        identityTier: 2,
        verificationMethod: 'hmac',
      }),
    ).toBe(true);

    expect(
      requiresCanonicalContactProductionScope({
        contactId: 'contact-1',
        identityTier: 0,
        verificationMethod: 'none',
      }),
    ).toBe(true);
  });
});
