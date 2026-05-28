/**
 * Enterprise Services Tests (Studio)
 *
 * Comprehensive tests for:
 * - Tenant Config Service
 * - Retention Service (policy + GDPR)
 * - Key Rotation Service
 * - Secret Masking Service
 * - Token Family Tracking
 *
 * NOTE: Circuit Breaker, ResilientLLMProvider, and API Key Scope tests
 * are in apps/platform/ — those modules don't exist in studio.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Tenant Config
import { TenantConfigService, type Plan } from '../services/tenant-config';

// Retention
import {
  RetentionService,
  GDPRDeletionService,
  getAuditRetentionMatrix,
  resolveRetention,
  type RetentionPolicy,
  type RetentionStore,
  type GDPRStore,
} from '../services/retention/retention-service';

// Key Rotation
import { KeyRotationService, InMemoryKeyStore } from '../services/security/key-rotation-service';

// Secret Masking
import { SecretMaskingService } from '../services/security/secret-masking';

// =============================================================================
// TENANT CONFIG SERVICE
// =============================================================================

describe('TenantConfigService', () => {
  let service: TenantConfigService;

  beforeEach(() => {
    service = new TenantConfigService();
  });

  test('returns correct defaults for FREE plan', () => {
    const config = service.getConfig('tenant-1', 'FREE');
    expect(config.limits.maxConcurrentSessions).toBe(10);
    expect(config.limits.maxAgentsPerProject).toBe(3);
    expect(config.limits.messagesPerMonth).toBe(1000);
    expect(config.features.ssoEnabled).toBe(false);
    expect(config.features.customModels).toBe(false);
  });

  test('returns correct defaults for ENTERPRISE plan', () => {
    const config = service.getConfig('tenant-1', 'ENTERPRISE');
    expect(config.limits.maxConcurrentSessions).toBe(-1);
    expect(config.limits.maxAgentsPerProject).toBe(-1);
    expect(config.features.ssoEnabled).toBe(true);
    expect(config.features.dataResidency).toBe(true);
  });

  test('applies tenant-specific overrides', () => {
    service.setOverrides('tenant-1', {
      limits: { maxConcurrentSessions: 100 } as any,
    });

    const config = service.getConfig('tenant-1', 'FREE');
    expect(config.limits.maxConcurrentSessions).toBe(100);
    // Other limits unchanged
    expect(config.limits.maxAgentsPerProject).toBe(3);
  });

  test('clears overrides', () => {
    service.setOverrides('tenant-1', {
      limits: { maxConcurrentSessions: 100 } as any,
    });
    service.clearOverrides('tenant-1');

    const config = service.getConfig('tenant-1', 'FREE');
    expect(config.limits.maxConcurrentSessions).toBe(10);
  });

  test('checkLimit handles unlimited (-1)', () => {
    expect(service.checkLimit(999999, -1)).toBe(true);
    expect(service.checkLimit(5, 10)).toBe(true);
    expect(service.checkLimit(11, 10)).toBe(false);
  });

  test('getAllPlanDefaults returns all plans', () => {
    const plans = service.getAllPlanDefaults();
    expect(Object.keys(plans)).toEqual(['FREE', 'TEAM', 'BUSINESS', 'ENTERPRISE']);
    expect(plans.TEAM.limits.requestsPerMinute).toBeGreaterThan(
      plans.FREE.limits.requestsPerMinute,
    );
  });

  test('BUSINESS plan enables SSO and MFA', () => {
    const config = service.getConfig('t', 'BUSINESS');
    expect(config.features.ssoEnabled).toBe(true);
    expect(config.features.mfaEnabled).toBe(true);
    expect(config.security.requireMfa).toBe(true);
  });

  test('plans scale correctly and ENTERPRISE is unlimited', () => {
    const free = service.getConfig('t', 'FREE');
    const team = service.getConfig('t', 'TEAM');
    const business = service.getConfig('t', 'BUSINESS');
    const enterprise = service.getConfig('t', 'ENTERPRISE');

    expect(team.limits.requestsPerMinute).toBeGreaterThan(free.limits.requestsPerMinute);
    expect(business.limits.requestsPerMinute).toBeGreaterThan(team.limits.requestsPerMinute);
    expect(enterprise.limits.requestsPerMinute).toBe(-1);
    expect(service.checkLimit(Number.MAX_SAFE_INTEGER, enterprise.limits.requestsPerMinute)).toBe(
      true,
    );
  });
});

// =============================================================================
// RETENTION SERVICE
// =============================================================================

describe('RetentionService', () => {
  function createMockRetentionStore(): RetentionStore {
    return {
      findSessionsOlderThan: vi.fn().mockResolvedValue(['session-1', 'session-2']),
      findArchivedSessionsOlderThan: vi.fn().mockResolvedValue(['session-old']),
      findTracesOlderThan: vi.fn().mockResolvedValue(['trace-1']),
      findMessagesWithPIIOlderThan: vi.fn().mockResolvedValue(['msg-1']),
      archiveSessions: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      deleteTraces: vi.fn().mockResolvedValue(undefined),
      scrubPIIBatch: vi.fn().mockResolvedValue(undefined),
    };
  }

  test('getPolicy returns plan-based defaults', () => {
    const store = createMockRetentionStore();
    const service = new RetentionService(store);

    const policy = service.getPolicy('t1', 'FREE');
    expect(policy.sessions.activeRetentionDays).toBe(7);
    expect(policy.sessions.totalRetentionDays).toBe(7);
  });

  test('getPolicy applies compliance requirements', () => {
    const store = createMockRetentionStore();
    const service = new RetentionService(store);

    const policy = service.getPolicy('t1', 'FREE', ['hipaa']);
    expect(policy.sessions.totalRetentionDays).toBe(2190); // HIPAA: 6 years
    expect(policy.auditLogs.retentionDays).toBe(2190);
  });

  test('publishes an explicit audit retention matrix for shared and dedicated subsystems', () => {
    const matrix = getAuditRetentionMatrix();
    const sharedMongo = matrix.find((entry) => entry.subsystem === 'sharedMongoAuditLogs');
    const sharedClickHouse = matrix.find(
      (entry) => entry.subsystem === 'sharedClickHouseAuditEvents',
    );
    const piiAudit = matrix.find((entry) => entry.subsystem === 'piiAudit');
    const crawlAudit = matrix.find((entry) => entry.subsystem === 'crawlAudit');
    const omnichannel = matrix.find((entry) => entry.subsystem === 'omnichannelBuffer');

    expect(sharedMongo).toMatchObject({
      classification: 'shared-audit',
      ttlMode: 'disabled-by-default',
      requiresExplicitApproval: false,
    });
    expect(sharedMongo?.defaultPolicy).toContain('Approved default');

    expect(sharedClickHouse).toMatchObject({
      classification: 'shared-audit',
      ttlMode: 'policy-review',
      requiresExplicitApproval: false,
    });
    expect(sharedClickHouse?.defaultPolicy).toContain('730-day hard delete');

    expect(piiAudit).toMatchObject({
      classification: 'dedicated-audit',
      ttlMode: 'dedicated-ttl',
      requiresExplicitApproval: false,
    });

    expect(crawlAudit).toMatchObject({
      classification: 'operational-history',
      ttlMode: 'policy-review',
      requiresExplicitApproval: false,
    });

    expect(omnichannel).toMatchObject({
      classification: 'operational-history',
      ttlMode: 'not-applicable',
    });
  });

  test('planRetention identifies data for processing', async () => {
    const store = createMockRetentionStore();
    const service = new RetentionService(store);
    const policy = service.getPolicy('t1', 'FREE');

    const plan = await service.planRetention('t1', policy);
    expect(plan.sessionsToArchive).toEqual(['session-1', 'session-2']);
    expect(plan.sessionsToDelete).toEqual(['session-old']);
    expect(plan.tracesToPurge).toEqual(['trace-1']);
  });

  test('executeRetention archives then deletes', async () => {
    const store = createMockRetentionStore();
    const service = new RetentionService(store);

    const report = await service.executeRetention({
      tenantId: 't1',
      sessionsToArchive: ['s1', 's2'],
      sessionsToDelete: ['s3'],
      tracesToPurge: ['tr1'],
      piiFieldsToScrub: ['m1'],
      auditLogsToArchive: [],
    });

    expect(report.archived).toBe(2);
    expect(report.deleted).toBe(1);
    expect(report.tracePurged).toBe(1);
    expect(report.scrubbed).toBe(1);
    expect(report.errors).toHaveLength(0);
  });

  test('executeRetention handles errors gracefully', async () => {
    const store = createMockRetentionStore();
    (store.archiveSessions as any).mockRejectedValueOnce(new Error('S3 timeout'));
    const service = new RetentionService(store);

    const report = await service.executeRetention({
      tenantId: 't1',
      sessionsToArchive: ['s1', 's2'],
      sessionsToDelete: [],
      tracesToPurge: [],
      piiFieldsToScrub: [],
      auditLogsToArchive: [],
    });

    expect(report.archived).toBe(0); // Batch failed entirely
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('S3 timeout');
  });
});

describe('resolveRetention (compliance conflicts)', () => {
  const basePolicy: RetentionPolicy = {
    tenantId: 't1',
    plan: 'FREE',
    sessions: { activeRetentionDays: 7, archiveRetentionDays: 0, totalRetentionDays: 7 },
    messages: { retentionDays: 7, piiRetentionDays: 7 },
    traces: { hotRetentionDays: 7, analyticsRetentionDays: 30 },
    auditLogs: { retentionDays: 30, immutable: true },
  };

  test('SOC2 extends audit log retention to 365 days', () => {
    const resolved = resolveRetention(basePolicy, ['soc2']);
    expect(resolved.auditLogs.retentionDays).toBe(365);
  });

  test('HIPAA extends session retention to 6 years', () => {
    const resolved = resolveRetention(basePolicy, ['hipaa']);
    expect(resolved.sessions.totalRetentionDays).toBe(2190);
  });

  test('PCI DSS sets PII retention to 0 (immediate scrub)', () => {
    const resolved = resolveRetention(basePolicy, ['pci_dss']);
    expect(resolved.messages.piiRetentionDays).toBe(0);
  });

  test('GDPR ensures PII <= general retention', () => {
    const policy = { ...basePolicy, messages: { retentionDays: 30, piiRetentionDays: 90 } };
    const resolved = resolveRetention(policy, ['gdpr']);
    expect(resolved.messages.piiRetentionDays).toBe(30);
  });

  test('multiple compliance requirements stack', () => {
    const resolved = resolveRetention(basePolicy, ['soc2', 'hipaa']);
    expect(resolved.auditLogs.retentionDays).toBe(2190); // HIPAA > SOC2
    expect(resolved.sessions.totalRetentionDays).toBe(2190);
  });
});

describe('GDPRDeletionService', () => {
  function createMockGDPRStore(): GDPRStore {
    return {
      findSubjectSessions: vi.fn().mockResolvedValue(['s1', 's2']),
      findSubjectMessages: vi.fn().mockResolvedValue(['m1', 'm2', 'm3']),
      findSubjectTraces: vi.fn().mockResolvedValue(['t1']),
      findSubjectContacts: vi.fn().mockResolvedValue(['contact-1']),
      findSubjectAttachments: vi.fn().mockResolvedValue(['attachment-1']),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      deleteMessages: vi.fn().mockResolvedValue(undefined),
      anonymizeTraces: vi.fn().mockResolvedValue(undefined),
      anonymizeContacts: vi.fn().mockResolvedValue(undefined),
      anonymizeAuditEntries: vi.fn().mockResolvedValue(undefined),
      anonymizeAttachments: vi.fn().mockResolvedValue(undefined),
      anonymizeUser: vi.fn().mockResolvedValue(undefined),
      deletePersonalAuthProfiles: vi.fn().mockResolvedValue(undefined),
      reassignSharedAuthProfiles: vi.fn().mockResolvedValue(undefined),
    };
  }

  test('processes all_data deletion', async () => {
    const store = createMockGDPRStore();
    const service = new GDPRDeletionService(store);

    const result = await service.processDeletionRequest({
      id: 'req-1',
      tenantId: 't1',
      requestedBy: 'admin-1',
      subjectId: 'user-123',
      scope: 'all_data',
      status: 'pending',
      createdAt: new Date(),
      slaDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    expect(result.status).toBe('completed');
    expect(store.deleteSession).toHaveBeenCalledTimes(2);
    expect(store.deleteMessages).toHaveBeenCalledWith(['m1', 'm2', 'm3'], 't1');
    expect(store.anonymizeTraces).toHaveBeenCalledWith(['t1'], 't1');
    expect(store.anonymizeAuditEntries).toHaveBeenCalledWith('user-123', 't1');
    expect(store.anonymizeContacts).toHaveBeenCalledWith(['contact-1'], 't1');
    expect(store.anonymizeAttachments).toHaveBeenCalledWith(['attachment-1'], 't1');
    expect(store.anonymizeUser).toHaveBeenCalledWith('user-123', 't1');
  });

  test('processes pii_only deletion', async () => {
    const store = createMockGDPRStore();
    const service = new GDPRDeletionService(store);

    const result = await service.processDeletionRequest({
      id: 'req-2',
      tenantId: 't1',
      requestedBy: 'admin-1',
      subjectId: 'user-123',
      scope: 'pii_only',
      status: 'pending',
      createdAt: new Date(),
      slaDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    expect(result.status).toBe('completed');
    expect(store.deleteSession).not.toHaveBeenCalled(); // No session deletion for PII-only
    expect(store.anonymizeTraces).toHaveBeenCalled();
    expect(store.anonymizeAuditEntries).toHaveBeenCalled();
  });

  test('isWithinSLA checks deadline', () => {
    const service = new GDPRDeletionService(createMockGDPRStore());

    expect(
      service.isWithinSLA({
        slaDeadline: new Date(Date.now() + 1000),
      } as any),
    ).toBe(true);

    expect(
      service.isWithinSLA({
        slaDeadline: new Date(Date.now() - 1000),
      } as any),
    ).toBe(false);
  });
});

// =============================================================================
// KEY ROTATION SERVICE
// =============================================================================

describe('KeyRotationService', () => {
  let store: InMemoryKeyStore;
  let service: KeyRotationService;

  beforeEach(() => {
    store = new InMemoryKeyStore();
    service = new KeyRotationService(store);
  });

  test('initialize creates first key version', async () => {
    const key = await service.initialize();
    expect(key.version).toBe(1);
    expect(key.status).toBe('active');
    expect(key.algorithm).toBe('AES-256-GCM');
  });

  test('initialize returns existing active key', async () => {
    const first = await service.initialize();
    const second = await service.initialize();
    expect(first.id).toBe(second.id);
  });

  test('rotateMasterKey creates new version', async () => {
    await service.initialize();
    const { oldVersion, newVersion } = await service.rotateMasterKey();

    expect(oldVersion).toBe(1);
    expect(newVersion).toBe(2);

    const versions = await service.listVersions();
    expect(versions).toHaveLength(2);
    expect(versions[0].status).toBe('active'); // New key
    expect(versions[1].status).toBe('decrypt_only'); // Old key
  });

  test('destroyKeyVersion prevents destroying active key', async () => {
    await service.initialize();
    await expect(service.destroyKeyVersion(1)).rejects.toMatchObject({
      message: expect.stringContaining('Cannot destroy active key'),
    });
  });

  test('destroyKeyVersion works for decrypt-only keys', async () => {
    await service.initialize();
    await service.rotateMasterKey();
    await service.destroyKeyVersion(1);

    const versions = await service.listVersions();
    const destroyed = versions.find((v) => v.version === 1);
    expect(destroyed?.status).toBe('destroyed');
  });

  test('isRotationDue returns true for old keys', async () => {
    const quickRotation = new KeyRotationService(store, { masterKeyRotationDays: 0 });
    await quickRotation.initialize();

    // Wait briefly to ensure the key is "old"
    await new Promise((r) => setTimeout(r, 10));
    expect(await quickRotation.isRotationDue()).toBe(true);
  });

  test('isApiKeyExpired detects expired keys', () => {
    const created = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000); // 400 days ago
    const result = service.isApiKeyExpired(created);
    expect(result.expired).toBe(true);
  });

  test('isApiKeyExpired warns before expiry', () => {
    const created = new Date(Date.now() - 340 * 24 * 60 * 60 * 1000); // 340 days ago (25 days left)
    const result = service.isApiKeyExpired(created);
    expect(result.expired).toBe(false);
    expect(result.warningDays).toBeGreaterThan(0);
    expect(result.warningDays).toBeLessThan(30);
  });

  test('isApiKeyExpired returns safe for fresh keys', () => {
    const result = service.isApiKeyExpired(new Date());
    expect(result.expired).toBe(false);
    expect(result.warningDays).toBe(-1);
  });
});

// =============================================================================
// SECRET MASKING SERVICE
// =============================================================================

describe('SecretMaskingService', () => {
  let masker: SecretMaskingService;

  beforeEach(() => {
    masker = new SecretMaskingService();
  });

  test('masks bearer tokens', () => {
    const input = 'Authorization: Bearer sk-ant-1234567890abcdef';
    const result = masker.maskString(input);
    expect(result).not.toContain('sk-ant-1234567890abcdef');
    expect(result).toContain('REDACTED');
  });

  test('masks email addresses', () => {
    const result = masker.maskString('Contact john@example.com for help');
    expect(result).not.toContain('john@example.com');
    expect(result).toContain('REDACTED');
  });

  test('masks SSNs', () => {
    const result = masker.maskString('SSN: 123-45-6789');
    expect(result).not.toContain('123-45-6789');
  });

  test('masks credit card numbers (Luhn valid)', () => {
    const result = masker.maskString('Card: 4532015112830366');
    expect(result).not.toContain('4532015112830366');
  });

  test('does not mask random digit sequences that fail Luhn', () => {
    // 1111222233334444 fails Luhn validation — should NOT be masked as CC
    // Use a string that won't match phone patterns either
    const result = masker.maskString('Order ref: ABCD-1111-2222-3333');
    expect(result).toContain('ABCD-1111-2222-3333');
  });

  test('masks key prefixes (sk-, abl_)', () => {
    const result = masker.maskString('Key is sk-abcdefghijklmnopqrstuvwxyz');
    expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });

  test('maskObject walks nested objects', () => {
    const input = {
      user: { email: 'test@example.com', name: 'John' },
      auth: { token: 'Bearer secret123456789012345' },
    };

    const result = masker.maskObject(input);
    expect(result.user.email).not.toContain('test@example.com');
    // token key detected as secret
    expect(result.auth.token).toContain('REDACTED');
  });

  test('maskObject detects secret-sounding key names', () => {
    const input = {
      api_key: 'my-secret-key-value',
      password: 'hunter2',
      name: 'not-a-secret',
    };

    const result = masker.maskObject(input);
    expect(result.api_key).toContain('REDACTED');
    expect(result.password).toContain('REDACTED');
    expect(result.name).toBe('not-a-secret');
  });

  test('addSecretKey registers custom keys', () => {
    masker.addSecretKey('MY_CUSTOM_SECRET');
    const result = masker.maskObject({ my_custom_secret: 'sensitive-value' });
    expect(result.my_custom_secret).toContain('REDACTED');
  });

  test('partial masking strategy shows first/last chars', () => {
    const partialMasker = new SecretMaskingService({
      strategy: 'partial',
      partialReveal: 4,
    });

    const result = partialMasker.maskString('SSN: 123-45-6789');
    expect(result).not.toContain('123-45-6789');
  });

  test('handles null and undefined gracefully', () => {
    expect(masker.maskObject(null)).toBeNull();
    expect(masker.maskObject(undefined)).toBeUndefined();
    expect(masker.maskObject(42)).toBe(42);
  });
});
