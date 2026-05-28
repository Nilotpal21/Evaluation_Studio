import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PIIVault } from '@abl/compiler/platform/security/pii-vault.js';

const { mockWriteAuditEvent } = vi.hoisted(() => ({
  mockWriteAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/audit-store-singleton.js', () => ({
  getAuditStore: vi.fn(),
  writeAuditEvent: (...args: unknown[]) => mockWriteAuditEvent(...args),
}));

import {
  flushAndClearSessionPIIVault,
  flushPIIVaultToDurableStore,
  revealPIITokens,
  type PIIRevealRepositories,
  type PIITokenVaultInsert,
  type PIITokenVaultRevealRecord,
  type PIITokenVaultRepository,
} from '../../services/pii/pii-token-vault-service.js';

function makeRepository(): PIITokenVaultRepository & {
  insertMany: ReturnType<typeof vi.fn>;
} {
  return {
    insertMany: vi.fn().mockResolvedValue({}),
  };
}

function makeRevealRecord(
  overrides: Partial<PIITokenVaultRevealRecord> = {},
): PIITokenVaultRevealRecord {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    tokenId: 'token-email',
    token: '{{PII:email:token-email}}',
    piiType: 'email',
    patternName: 'email',
    encryptedOriginalValue: 'user@example.com',
    sourceSurface: 'message',
    sourceMessageId: 'message-1',
    revealable: true,
    erasedAt: null,
    expireAt: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeRevealRepositories(records: PIITokenVaultRevealRecord[]): PIIRevealRepositories & {
  tokenVault: {
    find: ReturnType<typeof vi.fn>;
  };
  auditLog: {
    insertMany: ReturnType<typeof vi.fn>;
  };
} {
  return {
    tokenVault: {
      find: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue(records),
      }),
    },
    auditLog: {
      insertMany: vi.fn().mockResolvedValue({}),
    },
  };
}

describe('pii token vault service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flushes in-memory token originals to durable insert payloads with scoped metadata', async () => {
    const vault = new PIIVault();
    vault.tokenize('Email user@example.com and card 4111 1111 1111 1111');
    const repository = makeRepository();

    const result = await flushPIIVaultToDurableStore({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      vault,
      source: {
        sourceSurface: 'message',
        sourceMessageId: 'message-1',
        sourceFieldPath: 'content',
      },
      now: () => Date.UTC(2026, 0, 1),
      repository,
    });

    expect(result).toEqual({ flushed: 2, skipped: false });
    expect(repository.insertMany).toHaveBeenCalledWith(expect.any(Array), { ordered: false });

    const docs = repository.insertMany.mock.calls[0][0] as PIITokenVaultInsert[];
    expect(docs).toHaveLength(2);
    expect(docs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'project-1',
          sessionId: 'session-1',
          piiType: 'email',
          patternName: 'email',
          encryptedOriginalValue: 'user@example.com',
          sourceSurface: 'message',
          sourceMessageId: 'message-1',
          sourceFieldPath: 'content',
          revealable: true,
          expireAt: new Date(Date.UTC(2026, 0, 1) + 90 * 24 * 60 * 60 * 1000),
        }),
        expect.objectContaining({
          piiType: 'credit_card',
          patternName: 'credit_card',
          encryptedOriginalValue: '4111 1111 1111 1111',
        }),
      ]),
    );

    for (const doc of docs) {
      expect(doc.token).toMatch(/\{\{PII:/);
      const nonSecretMetadata = { ...doc, encryptedOriginalValue: '[encrypted]' };
      expect(JSON.stringify(nonSecretMetadata)).not.toContain('user@example.com');
      expect(JSON.stringify(nonSecretMetadata)).not.toContain('4111 1111 1111 1111');
    }
  });

  it('skips empty or unscoped vaults without inserting', async () => {
    const emptyVault = new PIIVault();
    const repository = makeRepository();

    await expect(
      flushPIIVaultToDurableStore({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        vault: emptyVault,
        repository,
      }),
    ).resolves.toEqual({ flushed: 0, skipped: true, reason: 'emptyVault' });

    const scopedVault = new PIIVault();
    scopedVault.tokenize('Email user@example.com');

    await expect(
      flushPIIVaultToDurableStore({
        tenantId: 'tenant-1',
        projectId: undefined,
        sessionId: 'session-1',
        vault: scopedVault,
        repository,
      }),
    ).resolves.toEqual({ flushed: 0, skipped: true, reason: 'missingScope' });

    expect(repository.insertMany).not.toHaveBeenCalled();
  });

  it('ignores duplicate token rows so terminal cleanup can be retried safely', async () => {
    const vault = new PIIVault();
    vault.tokenize('Email user@example.com and ops@example.com');
    const repository = makeRepository();
    repository.insertMany.mockRejectedValueOnce({
      writeErrors: [{ code: 11000 }],
    });

    const result = await flushPIIVaultToDurableStore({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      vault,
      repository,
    });

    expect(result).toEqual({ flushed: 1, skipped: false, duplicateCount: 1 });
  });

  it('clears the session-local vault after a successful durable flush', async () => {
    const vault = new PIIVault();
    vault.tokenize('Email user@example.com');
    const repository = makeRepository();

    const result = await flushAndClearSessionPIIVault(
      {
        id: 'session-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        piiVault: vault,
        piiRedactionConfig: { enabled: true },
      },
      { repository },
    );

    expect(result).toEqual({ flushed: 1, skipped: false });
    expect(vault.isEmpty()).toBe(true);
  });

  it('clears the session-local vault when reveal is disabled by PII settings', async () => {
    const vault = new PIIVault();
    vault.tokenize('Email user@example.com');
    const repository = makeRepository();

    const result = await flushAndClearSessionPIIVault(
      {
        id: 'session-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        piiVault: vault,
        piiRedactionConfig: { enabled: false },
      },
      { repository },
    );

    expect(result).toEqual({ flushed: 0, skipped: true, reason: 'notRevealable' });
    expect(repository.insertMany).not.toHaveBeenCalled();
    expect(vault.isEmpty()).toBe(true);
  });

  it('clears the session-local vault even when durable insert fails', async () => {
    const vault = new PIIVault();
    vault.tokenize('Email user@example.com');
    const repository = makeRepository();
    repository.insertMany.mockRejectedValueOnce(new Error('database unavailable'));

    const result = await flushAndClearSessionPIIVault(
      {
        id: 'session-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        piiVault: vault,
        piiRedactionConfig: { enabled: true },
      },
      { repository },
    );

    expect(result).toEqual({ flushed: 0, skipped: true, reason: 'insertFailed' });
    expect(vault.isEmpty()).toBe(true);
  });

  it('reveals selected durable tokens only after writing admin audit logs', async () => {
    const repositories = makeRevealRepositories([
      makeRevealRecord({
        tokenId: 'token-email',
        token: '{{PII:email:token-email}}',
        encryptedOriginalValue: 'alice@example.com',
      }),
    ]);

    const result = await revealPIITokens({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      tokenIds: ['token-email'],
      reason: 'Compliance review',
      ticketId: 'ABLP-535',
      actor: {
        actorId: 'privacy-user-1',
        authType: 'user',
        role: 'custom',
      },
      repositories,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(repositories.tokenVault.find).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      tokenId: { $in: ['token-email'] },
    });
    expect(repositories.auditLog.insertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'project-1',
          sessionId: 'session-1',
          tokenId: 'token-email',
          piiType: 'email',
          consumer: 'admin',
          renderMode: 'original',
          action: 'detokenize',
          metadata: expect.objectContaining({
            reason: 'Compliance review',
            ticketId: 'ABLP-535',
            actor: {
              actorId: 'privacy-user-1',
              authType: 'user',
              role: 'custom',
            },
          }),
        }),
      ],
      { ordered: true },
    );
    expect(result).toEqual({
      revealed: [
        {
          tokenId: 'token-email',
          token: '{{PII:email:token-email}}',
          piiType: 'email',
          patternName: 'email',
          value: 'alice@example.com',
          source: {
            surface: 'message',
            messageId: 'message-1',
          },
        },
      ],
      unavailable: [],
      auditLogCount: 1,
    });

    const auditDocs = repositories.auditLog.insertMany.mock.calls[0][0];
    expect(JSON.stringify(auditDocs)).not.toContain('alice@example.com');
  });

  it('supports source reference selectors for future Studio reveal affordances', async () => {
    const repositories = makeRevealRepositories([
      makeRevealRecord({
        tokenId: 'token-card',
        token: '{{PII:credit_card:token-card}}',
        piiType: 'credit_card',
        patternName: 'credit_card',
        encryptedOriginalValue: '4111 1111 1111 1111',
        sourceSpanId: 'span-1',
        sourceFieldPath: 'content',
      }),
    ]);

    const result = await revealPIITokens({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      sourceRefs: [{ sourceMessageId: 'message-1', sourceSpanId: 'span-1' }],
      reason: 'Investigate customer report',
      actor: {
        actorId: 'privacy-user-1',
        authType: 'user',
      },
      repositories,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(repositories.tokenVault.find).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      sourceMessageId: 'message-1',
      sourceSpanId: 'span-1',
    });
    expect(result.revealed).toEqual([
      expect.objectContaining({
        tokenId: 'token-card',
        value: '4111 1111 1111 1111',
      }),
    ]);
    expect(repositories.auditLog.insertMany).toHaveBeenCalledTimes(1);
  });

  it('emits reveal audit through the runtime audit pipeline when no Mongo audit repository is supplied', async () => {
    const tokenVault = {
      find: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue([
          makeRevealRecord({
            tokenId: 'token-email',
            token: '{{PII:email:token-email}}',
            encryptedOriginalValue: 'alice@example.com',
          }),
        ]),
      }),
    };

    const result = await revealPIITokens({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      tokenIds: ['token-email'],
      reason: 'Compliance review',
      ticketId: 'ABLP-535',
      actor: {
        actorId: 'privacy-user-1',
        authType: 'user',
        role: 'custom',
      },
      repositories: { tokenVault },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(mockWriteAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: 'pii',
        eventType: 'pii.accessed',
        action: 'detokenize',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        actorId: 'privacy-user-1',
        actorType: 'admin',
        resourceType: 'pii_token',
        resourceId: 'token-email',
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: new Date('2026-04-01T00:00:00.000Z'),
        metadata: expect.objectContaining({
          sessionId: 'session-1',
          tokenId: 'token-email',
          piiType: 'email',
          consumer: 'admin',
          renderMode: 'original',
          reason: 'Compliance review',
          ticketId: 'ABLP-535',
          actor: {
            actorId: 'privacy-user-1',
            authType: 'user',
            role: 'custom',
          },
        }),
      }),
    );
    expect(result.auditLogCount).toBe(1);
  });

  it('returns unavailable statuses without raw data for missing or non-revealable tokens', async () => {
    const repositories = makeRevealRepositories([
      makeRevealRecord({
        tokenId: 'token-disabled',
        encryptedOriginalValue: 'disabled@example.com',
        revealable: false,
      }),
      makeRevealRecord({
        tokenId: 'token-erased',
        encryptedOriginalValue: 'erased@example.com',
        erasedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
      makeRevealRecord({
        tokenId: 'token-expired',
        encryptedOriginalValue: 'expired@example.com',
        expireAt: new Date('2025-12-31T00:00:00.000Z'),
      }),
    ]);

    const result = await revealPIITokens({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      tokenIds: ['token-missing', 'token-disabled', 'token-erased', 'token-expired'],
      reason: 'Compliance review',
      actor: {
        actorId: 'privacy-user-1',
        authType: 'user',
      },
      repositories,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(result).toEqual({
      revealed: [],
      unavailable: expect.arrayContaining([
        { tokenId: 'token-missing', status: 'not_found' },
        {
          tokenId: 'token-disabled',
          status: 'not_revealable',
          piiType: 'email',
          patternName: 'email',
        },
        {
          tokenId: 'token-erased',
          status: 'erased',
          piiType: 'email',
          patternName: 'email',
        },
        {
          tokenId: 'token-expired',
          status: 'expired',
          piiType: 'email',
          patternName: 'email',
        },
      ]),
      auditLogCount: 0,
    });
    expect(JSON.stringify(result)).not.toContain('disabled@example.com');
    expect(JSON.stringify(result)).not.toContain('erased@example.com');
    expect(JSON.stringify(result)).not.toContain('expired@example.com');
    expect(repositories.auditLog.insertMany).not.toHaveBeenCalled();
  });

  it('fails closed when audit logging fails before raw reveal can be returned', async () => {
    const repositories = makeRevealRepositories([
      makeRevealRecord({ encryptedOriginalValue: 'alice@example.com' }),
    ]);
    repositories.auditLog.insertMany.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(
      revealPIITokens({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        tokenIds: ['token-email'],
        reason: 'Compliance review',
        actor: {
          actorId: 'privacy-user-1',
          authType: 'user',
        },
        repositories,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      }),
    ).rejects.toThrow('PII reveal audit write failed');
  });
});
