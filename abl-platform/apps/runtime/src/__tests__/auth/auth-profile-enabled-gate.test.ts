/**
 * Boundary tests for the `enabled` gate on resolveAuthProfileCredentials (F-4).
 *
 * The `enabled` field was introduced by ABLP-1123 as a runtime gate that
 * prevents credential resolution for administratively disabled profiles.
 * resolveAuthProfileCredentials is the service-instance resolution path
 * (model providers, voice, guardrails) and must respect this gate.
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

const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn().mockReturnValue({ catch: vi.fn() });

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}));

// ---------------------------------------------------------------------------
// SUT
// ---------------------------------------------------------------------------

import {
  resolveAuthProfileCredentials,
  getAuthProfileCache,
} from '../../services/auth-profile-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'profile-1',
    tenantId: 'tenant-1',
    authType: 'api_key',
    config: { headerName: 'X-Api-Key' },
    encryptedSecrets: '{"apiKey":"test-key"}',
    previousEncryptedSecrets: null,
    rotationGracePeriodMs: 24 * 60 * 60 * 1000,
    updatedAt: new Date(),
    lastUsedAt: new Date(),
    status: 'active',
    enabled: true,
    profileVersion: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveAuthProfileCredentials — enabled gate (F-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthProfileCache().clear();
  });

  it('returns null for a disabled profile (enabled: false) — gate must be in DB query', async () => {
    // The mock enforces the gate: a profile with enabled:false is not returned
    // when the query includes `enabled: { $ne: false }`.
    mockFindOne.mockImplementation((filter: Record<string, unknown>) => {
      const enabledFilter = filter.enabled as { $ne?: unknown } | undefined;
      if (enabledFilter?.$ne === false) {
        // Simulate DB filtering out the disabled profile
        return Promise.resolve(null);
      }
      return Promise.resolve(makeProfile({ enabled: false }));
    });

    const result = await resolveAuthProfileCredentials('profile-1', 'tenant-1');

    // Must return null — a disabled profile is not resolvable
    expect(result).toBeNull();
    // Verify the enabled gate was actually passed to the DB query
    const filter = mockFindOne.mock.calls[0][0] as Record<string, unknown>;
    expect(filter).toMatchObject({ enabled: { $ne: false } });
  });

  it('returns credentials for an enabled profile (enabled: true)', async () => {
    mockFindOne.mockResolvedValue(makeProfile({ enabled: true }));

    const result = await resolveAuthProfileCredentials('profile-1', 'tenant-1');

    expect(result).not.toBeNull();
    expect(result!.secrets).toEqual({ apiKey: 'test-key' });
  });

  it('returns credentials for a profile with enabled field absent (legacy rows default to enabled)', async () => {
    // Profiles created before ABLP-1123 have no enabled field — should resolve normally
    const profileWithoutEnabled = makeProfile();
    delete (profileWithoutEnabled as Record<string, unknown>).enabled;
    mockFindOne.mockResolvedValue(profileWithoutEnabled);

    const result = await resolveAuthProfileCredentials('profile-1', 'tenant-1');

    expect(result).not.toBeNull();
    expect(result!.secrets).toEqual({ apiKey: 'test-key' });
  });

  it('DB query always includes enabled gate regardless of profile state', async () => {
    // This test verifies the gate is always in the query — not applied conditionally
    mockFindOne.mockResolvedValue(makeProfile());

    await resolveAuthProfileCredentials('profile-1', 'tenant-1');

    const filter = mockFindOne.mock.calls[0][0] as Record<string, unknown>;
    expect(filter).toHaveProperty('enabled', { $ne: false });
    expect(filter).toHaveProperty('status', 'active');
  });
});
