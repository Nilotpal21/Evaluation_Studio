/**
 * CredentialAgeMonitor AuthProfile Integration Tests (Task 3.9)
 *
 * Validates that:
 * - Profiles with old rotationStartedAt are flagged as stale
 * - Profiles with recent rotationStartedAt are not flagged
 * - Profiles without rotationStartedAt (never rotated) use createdAt
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

const mockAuthProfileFind = vi.fn();
const mockToolSecretFind = vi.fn().mockReturnValue({ lean: () => Promise.resolve([]) });
const mockLLMCredentialFind = vi.fn().mockReturnValue({ lean: () => Promise.resolve([]) });
const mockApiKeyFind = vi.fn().mockReturnValue({ lean: () => Promise.resolve([]) });

vi.mock('@agent-platform/database/models', () => ({
  ToolSecret: { find: (...args: any[]) => mockToolSecretFind(...args) },
  LLMCredential: { find: (...args: any[]) => mockLLMCredentialFind(...args) },
  ApiKey: { find: (...args: any[]) => mockApiKeyFind(...args) },
  AuthProfile: { find: (...args: any[]) => ({ lean: () => mockAuthProfileFind(...args) }) },
}));

// ---------------------------------------------------------------------------
// SUT
// ---------------------------------------------------------------------------

import { CredentialAgeMonitor } from '../../services/credential-age-monitor.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CredentialAgeMonitor AuthProfile queries (Task 3.9)', () => {
  let monitor: CredentialAgeMonitor;
  let events: any[];

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    monitor = new CredentialAgeMonitor({
      eventStore: { write: (e: unknown) => events.push(e) },
      warningAgeDays: 60,
      criticalAgeDays: 90,
    });
  });

  it('flags profiles with old rotationStartedAt as stale', async () => {
    const oldDate = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000); // 91 days ago

    mockAuthProfileFind.mockResolvedValueOnce([
      {
        _id: 'profile-1',
        tenantId: 'tenant-1',
        createdAt: oldDate,
        rotatedAt: null,
        rotationStartedAt: oldDate,
        status: 'active',
      },
    ]);

    // Second call for expiration check
    mockAuthProfileFind.mockResolvedValueOnce([]);

    await monitor.checkAll();

    expect(events.length).toBeGreaterThanOrEqual(1);
    const ageEvent = events.find(
      (e) => e.credentialType === 'AuthProfile' && e.credentialId === 'profile-1',
    );
    expect(ageEvent).toBeDefined();
    expect(ageEvent.type).toBe('credential.age.critical');
  });

  it('does not flag profiles with recent rotationStartedAt', async () => {
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago

    mockAuthProfileFind.mockResolvedValueOnce([
      // This profile's createdAt is old but rotatedAt is recent
      {
        _id: 'profile-2',
        tenantId: 'tenant-1',
        createdAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
        rotatedAt: recentDate,
        status: 'active',
      },
    ]);

    // Second call for expiration check
    mockAuthProfileFind.mockResolvedValueOnce([]);

    await monitor.checkAll();

    // The profile should not be flagged because rotatedAt is recent
    const ageEvent = events.find(
      (e) => e.credentialType === 'AuthProfile' && e.credentialId === 'profile-2',
    );
    expect(ageEvent).toBeUndefined();
  });

  it('flags profiles without rotationStartedAt using createdAt', async () => {
    const oldDate = new Date(Date.now() - 70 * 24 * 60 * 60 * 1000); // 70 days ago

    mockAuthProfileFind.mockResolvedValueOnce([
      {
        _id: 'profile-3',
        tenantId: 'tenant-1',
        createdAt: oldDate,
        rotatedAt: null,
        status: 'active',
      },
    ]);

    // Second call for expiration check
    mockAuthProfileFind.mockResolvedValueOnce([]);

    await monitor.checkAll();

    const ageEvent = events.find(
      (e) => e.credentialType === 'AuthProfile' && e.credentialId === 'profile-3',
    );
    expect(ageEvent).toBeDefined();
    expect(ageEvent.type).toBe('credential.age.warning');
  });
});
