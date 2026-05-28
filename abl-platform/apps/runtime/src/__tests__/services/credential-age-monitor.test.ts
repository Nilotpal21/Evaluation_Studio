import { describe, it, expect, vi, beforeEach } from 'vitest';

const MS_PER_DAY = 86_400_000;

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@agent-platform/database/models', () => ({
  ToolSecret: { find: vi.fn() },
  LLMCredential: { find: vi.fn() },
  ApiKey: { find: vi.fn() },
  AuthProfile: { find: vi.fn() },
}));

import { CredentialAgeMonitor } from '../../services/credential-age-monitor.js';
import { ToolSecret, LLMCredential, ApiKey, AuthProfile } from '@agent-platform/database/models';

const mockEventStore = {
  write: vi.fn(),
};

function mockLean(records: unknown[]) {
  return { lean: () => Promise.resolve(records) };
}

describe('CredentialAgeMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits warning event for credentials older than warningAgeDays', async () => {
    const oldDate = new Date(Date.now() - 61 * MS_PER_DAY);
    (ToolSecret.find as any).mockReturnValue(
      mockLean([{ _id: 's1', tenantId: 't1', createdAt: oldDate, toolName: 'test' }]),
    );
    (LLMCredential.find as any).mockReturnValue(mockLean([]));
    (ApiKey.find as any).mockReturnValue(mockLean([]));
    (AuthProfile.find as any).mockReturnValue(mockLean([]));

    const monitor = new CredentialAgeMonitor({
      eventStore: mockEventStore,
      warningAgeDays: 60,
      criticalAgeDays: 90,
    });

    await monitor.checkAll();

    expect(mockEventStore.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'credential.age.warning',
        tenantId: 't1',
        credentialId: 's1',
      }),
    );
  });

  it('emits critical event for credentials older than criticalAgeDays', async () => {
    const oldDate = new Date(Date.now() - 91 * MS_PER_DAY);
    (ToolSecret.find as any).mockReturnValue(
      mockLean([{ _id: 's1', tenantId: 't1', createdAt: oldDate, toolName: 'test' }]),
    );
    (LLMCredential.find as any).mockReturnValue(mockLean([]));
    (ApiKey.find as any).mockReturnValue(mockLean([]));
    (AuthProfile.find as any).mockReturnValue(mockLean([]));

    const monitor = new CredentialAgeMonitor({
      eventStore: mockEventStore,
      warningAgeDays: 60,
      criticalAgeDays: 90,
    });

    await monitor.checkAll();

    expect(mockEventStore.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'credential.age.critical',
        tenantId: 't1',
        credentialId: 's1',
      }),
    );
  });

  it('emits nothing when all credentials are fresh', async () => {
    (ToolSecret.find as any).mockReturnValue(mockLean([]));
    (LLMCredential.find as any).mockReturnValue(mockLean([]));
    (ApiKey.find as any).mockReturnValue(mockLean([]));
    (AuthProfile.find as any).mockReturnValue(mockLean([]));

    const monitor = new CredentialAgeMonitor({
      eventStore: mockEventStore,
      warningAgeDays: 60,
      criticalAgeDays: 90,
    });

    await monitor.checkAll();

    expect(mockEventStore.write).not.toHaveBeenCalled();
  });

  it('skips credentials where rotatedAt is recent even if createdAt is old', async () => {
    const createdOld = new Date(Date.now() - 100 * MS_PER_DAY);
    const rotatedRecent = new Date(Date.now() - 10 * MS_PER_DAY);
    (ToolSecret.find as any).mockReturnValue(
      mockLean([{ _id: 's1', tenantId: 't1', createdAt: createdOld, rotatedAt: rotatedRecent }]),
    );
    (LLMCredential.find as any).mockReturnValue(mockLean([]));
    (ApiKey.find as any).mockReturnValue(mockLean([]));
    (AuthProfile.find as any).mockReturnValue(mockLean([]));

    const monitor = new CredentialAgeMonitor({
      eventStore: mockEventStore,
      warningAgeDays: 60,
      criticalAgeDays: 90,
    });

    await monitor.checkAll();

    // rotatedAt is only 10 days old — within warning threshold, so no event emitted
    expect(mockEventStore.write).not.toHaveBeenCalled();
  });

  it('emits warning event for old AuthProfile records', async () => {
    const oldDate = new Date(Date.now() - 65 * MS_PER_DAY);
    (ToolSecret.find as any).mockReturnValue(mockLean([]));
    (LLMCredential.find as any).mockReturnValue(mockLean([]));
    (ApiKey.find as any).mockReturnValue(mockLean([]));
    (AuthProfile.find as any).mockReturnValue(
      mockLean([{ _id: 'ap1', tenantId: 't1', createdAt: oldDate, status: 'active' }]),
    );

    const monitor = new CredentialAgeMonitor({
      eventStore: mockEventStore,
      warningAgeDays: 60,
      criticalAgeDays: 90,
    });

    await monitor.checkAll();

    expect(mockEventStore.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'credential.age.warning',
        tenantId: 't1',
        credentialId: 'ap1',
        credentialType: 'AuthProfile',
      }),
    );
  });

  it('emits expiration approaching event for AuthProfiles expiring within grace period', async () => {
    const expiresIn3Days = new Date(Date.now() + 3 * MS_PER_DAY);
    (ToolSecret.find as any).mockReturnValue(mockLean([]));
    (LLMCredential.find as any).mockReturnValue(mockLean([]));
    (ApiKey.find as any).mockReturnValue(mockLean([]));

    // First call: age-based query returns nothing
    // Second call: expiration query returns the expiring profile
    let callCount = 0;
    (AuthProfile.find as any).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Age-based candidates query
        return mockLean([]);
      }
      // Expiration query
      return mockLean([
        {
          _id: 'ap2',
          tenantId: 't1',
          createdAt: new Date(),
          expiresAt: expiresIn3Days,
          status: 'active',
          rotationPolicy: { intervalDays: 30 },
        },
      ]);
    });

    const monitor = new CredentialAgeMonitor({
      eventStore: mockEventStore,
      warningAgeDays: 60,
      criticalAgeDays: 90,
    });

    await monitor.checkAll();

    expect(mockEventStore.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'credential.expiration.approaching',
        tenantId: 't1',
        credentialId: 'ap2',
        credentialType: 'AuthProfile',
        hasRotationPolicy: true,
      }),
    );
  });
});
