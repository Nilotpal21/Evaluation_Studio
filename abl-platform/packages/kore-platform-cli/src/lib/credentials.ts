/**
 * Credentials Management
 *
 * Securely stores authentication tokens.
 */

import Conf from 'conf';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// =============================================================================
// TYPES
// =============================================================================

export interface Credentials {
  token: string;
  refreshToken?: string;
  expiresAt: string;
  email?: string;
}

// =============================================================================
// CREDENTIALS STORE
// =============================================================================

const credentials = new Conf<Credentials>({
  projectName: 'kore-platform',
  configName: 'credentials',
  encryptionKey: 'kore-platform-cli-v1', // Simple obfuscation
});

// =============================================================================
// FUNCTIONS
// =============================================================================

/**
 * Get stored credentials
 */
export function getCredentials(): Credentials | null {
  const token = credentials.get('token');
  const expiresAt = credentials.get('expiresAt');

  if (!token || !expiresAt) {
    return null;
  }

  // Check if expired — but keep credentials if we have a refresh token for auto-refresh
  if (new Date(expiresAt) < new Date()) {
    const refreshToken = credentials.get('refreshToken');
    if (!refreshToken) {
      clearCredentials();
      return null;
    }
  }

  return {
    token,
    refreshToken: credentials.get('refreshToken') || undefined,
    expiresAt,
    email: credentials.get('email'),
  };
}

/**
 * Get the access token
 */
export function getToken(): string | null {
  const creds = getCredentials();
  return creds?.token || null;
}

/**
 * Save credentials
 */
export function saveCredentials(creds: Credentials): void {
  credentials.set('token', creds.token);
  credentials.set('expiresAt', creds.expiresAt);
  if (creds.refreshToken) {
    credentials.set('refreshToken', creds.refreshToken);
  }
  if (creds.email) {
    credentials.set('email', creds.email);
  }

  // Try to set restrictive permissions on the file
  try {
    const credPath = credentials.path;
    const dir = path.dirname(credPath);

    // Ensure directory exists with restricted permissions
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // Set file permissions (owner read/write only)
    if (fs.existsSync(credPath)) {
      fs.chmodSync(credPath, 0o600);
    }
  } catch {
    // Ignore permission errors on Windows
  }
}

/**
 * Clear credentials
 */
export function clearCredentials(): void {
  credentials.clear();
}

/**
 * Check if authenticated
 */
export function isAuthenticated(): boolean {
  return getCredentials() !== null;
}

/**
 * Get credentials file path
 */
export function getCredentialsPath(): string {
  return credentials.path;
}

/**
 * Get email from credentials
 */
export function getEmail(): string | null {
  return credentials.get('email') || null;
}
