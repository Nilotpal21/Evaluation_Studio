/**
 * Auth Profile Mock Factory
 *
 * Shared test helpers for creating AuthProfile fixtures across packages.
 * Provides consistent test data for model tests, service tests, and API tests.
 */

import { vi } from 'vitest';

// Unique ID counter for deterministic test data
let idCounter = 0;
function nextId(): string {
  return `ap-test-${++idCounter}-${Date.now()}`;
}

export interface AuthProfileFixture {
  _id: string;
  name: string;
  description?: string;
  tenantId: string;
  projectId: string | null;
  scope: 'tenant' | 'project';
  environment: string | null;
  visibility: 'shared' | 'personal';
  createdBy: string;
  authType: string;
  config: Record<string, unknown>;
  encryptedSecrets: string;
  encryptionKeyVersion: number;
  linkedAppProfileId?: string;
  connector?: string;
  category?: string;
  tags?: string[];
  status: 'active' | 'expired' | 'revoked' | 'invalid';
  expiresAt?: Date;
  lastValidatedAt?: Date;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const AUTH_TYPE_FIXTURES: Record<
  string,
  { config: Record<string, unknown>; secrets: Record<string, unknown> }
> = {
  none: { config: {}, secrets: {} },
  api_key: {
    config: { headerName: 'X-API-Key', placement: 'header' },
    secrets: { apiKey: 'test-api-key-secret-value' },
  },
  bearer: {
    config: {},
    secrets: { token: 'test-bearer-token-value' },
  },
  oauth2_app: {
    config: {
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      refreshUrl: 'https://oauth2.googleapis.com/token',
      defaultScopes: ['openid', 'email'],
      scopeSeparator: ' ',
      pkceRequired: true,
      pkceMethod: 'S256',
      supportedGrantTypes: ['authorization_code'],
    },
    secrets: {
      clientId: 'test-client-id.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-test-client-secret',
    },
  },
  oauth2_token: {
    config: {
      provider: 'google',
      scopes: ['openid', 'email'],
      grantedScopes: ['openid', 'email'],
      tokenType: 'bearer',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshTokenRotation: false,
    },
    secrets: {
      accessToken: 'ya29.test-access-token',
      refreshToken: '1//test-refresh-token',
    },
  },
  oauth2_client_credentials: {
    config: {
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    },
    secrets: {
      clientId: 'test-cc-client-id',
      clientSecret: 'test-cc-client-secret',
    },
  },
};

export function makeAuthProfile(overrides?: Partial<AuthProfileFixture>): AuthProfileFixture {
  const authType = overrides?.authType ?? 'api_key';
  const scope = overrides?.scope ?? 'project';
  const fixture = AUTH_TYPE_FIXTURES[authType] ?? AUTH_TYPE_FIXTURES['api_key'];
  const now = new Date();

  return {
    _id: nextId(),
    name: `Test Profile ${authType}`,
    tenantId: 'tenant-test-1',
    projectId: scope === 'tenant' ? null : 'proj-test-1',
    scope,
    environment: null,
    visibility: 'shared',
    createdBy: 'user-test-1',
    authType,
    config: { ...fixture.config },
    encryptedSecrets: JSON.stringify(fixture.secrets),
    encryptionKeyVersion: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
    // Enforce scope/projectId consistency after overrides
    ...(overrides?.scope === 'tenant' ? { projectId: null } : {}),
  };
}

export function makeDecryptedCredentials(authType: string): Record<string, unknown> {
  const fixture = AUTH_TYPE_FIXTURES[authType];
  if (!fixture) return {};
  return { ...fixture.secrets };
}

export function makeAuthProfileService(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    create: vi.fn().mockResolvedValue(makeAuthProfile()),
    update: vi.fn().mockResolvedValue(makeAuthProfile()),
    delete: vi.fn().mockResolvedValue({ success: true }),
    resolve: vi.fn().mockResolvedValue(makeDecryptedCredentials('api_key')),
    findById: vi.fn().mockResolvedValue(makeAuthProfile()),
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    validateAccess: vi.fn().mockResolvedValue(makeAuthProfile()),
    getConsumers: vi.fn().mockResolvedValue([]),
    revoke: vi.fn().mockResolvedValue(makeAuthProfile({ status: 'revoked' })),
    ...overrides,
  };
}
