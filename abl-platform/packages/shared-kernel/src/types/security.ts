/**
 * Security-Related Normalized Types
 *
 * Types for tool secrets, org proxy configs, and end-user OAuth tokens.
 */

export interface NormalizedToolSecret {
  id: string; // _id converted to id
  tenantId: string;
  projectId: string;
  toolName: string;
  secretKey: string;
  encryptedValue: string;
  environment: string;
  version: number;
  expiresAt: string | null; // ISO 8601 or null
  rotatedAt: string | null; // ISO 8601 or null
  createdBy: string;
  createdAt: string; // ISO 8601 string
  updatedAt: string; // ISO 8601 string
}

export interface NormalizedOrgProxyConfig {
  id: string; // _id converted to id
  tenantId: string;
  name: string;
  proxyUrl: string;
  proxyAuthType: string;
  encryptedProxyUsername: string | null;
  encryptedProxyPassword: string | null;
  encryptedProxyToken: string | null;
  encryptedCaCertificate: string | null;
  encryptedClientCert: string | null;
  encryptedClientKey: string | null;
  urlPatterns: string;
  bypassPatterns: string | null;
  environment: string;
  priority: number;
  enabled: boolean;
  createdBy: string;
  createdAt: string; // ISO 8601 string
  updatedAt: string; // ISO 8601 string
}

export interface NormalizedEnvironmentVariable {
  id: string; // _id converted to id
  tenantId: string;
  projectId: string;
  environment: string;
  key: string;
  encryptedValue: string;
  isSecret: boolean;
  description: string | null;
  updatedBy: string | null;
  createdBy: string;
  createdAt: string; // ISO 8601 string
  updatedAt: string; // ISO 8601 string
}

export interface NormalizedEndUserOAuthToken {
  id: string; // _id converted to id
  tenantId: string;
  userId: string;
  provider: string;
  providerUserId: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  scope: string;
  expiresAt: string | null; // ISO 8601 or null
  refreshedAt: string | null; // ISO 8601 or null
  consentedAt: string; // ISO 8601 string
  revokedAt: string | null; // ISO 8601 or null
  lastUsedAt: string | null; // ISO 8601 or null
  createdAt: string; // ISO 8601 string
  updatedAt: string; // ISO 8601 string
}
