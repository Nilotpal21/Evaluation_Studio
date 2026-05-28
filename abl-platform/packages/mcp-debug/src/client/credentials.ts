/**
 * Credentials Reader
 *
 * Reads stored credentials from ~/.kore-platform/credentials (Conf-format).
 * Compatible with the kore-platform-cli credential storage.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

export interface StoredCredentials {
  token: string;
  refreshToken?: string;
  expiresAt: string;
  email?: string;
}

/**
 * Get the credentials file path.
 * Conf uses: ~/.config/kore-platform/credentials.json (Linux/Mac)
 */
function getCredentialsPath(): string {
  const configDir = process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
  return path.join(configDir, 'kore-platform', 'credentials.json');
}

/**
 * Decrypt a Conf-encrypted file.
 * Conf uses AES-256-CBC with the encryption key as password.
 */
function decryptConf(encryptedData: string, encryptionKey: string): string {
  // Conf stores: hex(iv) + encrypted_data
  // The encryption key is hashed to create the actual key
  const key = crypto.createHash('sha256').update(encryptionKey).digest();

  try {
    // Try to parse as JSON first (unencrypted fallback)
    JSON.parse(encryptedData);
    return encryptedData;
  } catch {
    // It's encrypted — Conf uses a specific format
  }

  // Conf format: base64-encoded encrypted data with IV prepended
  const data = Buffer.from(encryptedData, 'hex');
  const iv = data.subarray(0, 16);
  const encrypted = data.subarray(16);

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, undefined, 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Read stored credentials from the kore-platform credentials file.
 * Returns null if no credentials found, expired, or unreadable.
 */
export function readStoredCredentials(): StoredCredentials | null {
  const credPath = getCredentialsPath();

  try {
    if (!fs.existsSync(credPath)) {
      return null;
    }

    const raw = fs.readFileSync(credPath, 'utf-8').trim();
    if (!raw) return null;

    let data: Record<string, unknown>;
    try {
      // Try decrypting with the known encryption key
      // TODO: Replace with OS keychain (keytar) — hardcoded key provides encoding, not confidentiality
      const decrypted = decryptConf(raw, 'kore-platform-cli-v1');
      data = JSON.parse(decrypted);
    } catch {
      // If decryption fails, try reading as plain JSON
      try {
        data = JSON.parse(raw);
      } catch {
        return null;
      }
    }

    const token = data['token'] as string | undefined;
    const expiresAt = data['expiresAt'] as string | undefined;

    if (!token || !expiresAt) {
      return null;
    }

    return {
      token,
      refreshToken: (data['refreshToken'] as string) || undefined,
      expiresAt,
      email: (data['email'] as string) || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Write credentials to ~/.config/kore-platform/credentials.json.
 * Creates the directory if it doesn't exist.
 */
export function writeStoredCredentials(creds: StoredCredentials): void {
  const credPath = getCredentialsPath();
  const dir = path.dirname(credPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(credPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/**
 * Check if stored credentials have a valid (non-expired) access token.
 */
export function hasValidToken(creds: StoredCredentials): boolean {
  return new Date(creds.expiresAt) > new Date();
}

/**
 * Check if stored credentials have a refresh token for renewal.
 */
export function hasRefreshToken(creds: StoredCredentials): boolean {
  return !!creds.refreshToken;
}
