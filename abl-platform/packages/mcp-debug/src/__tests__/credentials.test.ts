/**
 * Tests for credentials reader
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { readStoredCredentials, hasValidToken, hasRefreshToken } from '../client/credentials.js';
import type { StoredCredentials } from '../client/credentials.js';

// Mock fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe('credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('readStoredCredentials', () => {
    test('returns null when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(readStoredCredentials()).toBeNull();
    });

    test('returns null when file is empty', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('');
      expect(readStoredCredentials()).toBeNull();
    });

    test('reads plain JSON credentials', () => {
      const creds = {
        token: 'abc123',
        expiresAt: '2099-01-01T00:00:00.000Z',
        email: 'user@example.com',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(creds));

      const result = readStoredCredentials();
      expect(result).not.toBeNull();
      expect(result!.token).toBe('abc123');
      expect(result!.expiresAt).toBe('2099-01-01T00:00:00.000Z');
      expect(result!.email).toBe('user@example.com');
    });

    test('returns null when token field is missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ expiresAt: '2099-01-01T00:00:00.000Z' }),
      );
      expect(readStoredCredentials()).toBeNull();
    });

    test('returns null when expiresAt field is missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ token: 'abc123' }));
      expect(readStoredCredentials()).toBeNull();
    });

    test('includes refreshToken when present', () => {
      const creds = {
        token: 'abc123',
        expiresAt: '2099-01-01T00:00:00.000Z',
        refreshToken: 'refresh-abc',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(creds));

      const result = readStoredCredentials();
      expect(result!.refreshToken).toBe('refresh-abc');
    });

    test('returns null when file contains invalid JSON and not encrypted', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not-json-and-not-valid-hex');
      expect(readStoredCredentials()).toBeNull();
    });

    test('reads encrypted Conf credentials', () => {
      // Encrypt like Conf does: AES-256-CBC with sha256(encryptionKey)
      const encryptionKey = 'kore-platform-cli-v1';
      const key = crypto.createHash('sha256').update(encryptionKey).digest();
      const iv = crypto.randomBytes(16);

      const plaintext = JSON.stringify({
        token: 'encrypted-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
        email: 'encrypted@example.com',
      });

      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      let encrypted = cipher.update(plaintext, 'utf8');
      encrypted = Buffer.concat([encrypted, cipher.final()]);
      const stored = Buffer.concat([iv, encrypted]).toString('hex');

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(stored);

      const result = readStoredCredentials();
      expect(result).not.toBeNull();
      expect(result!.token).toBe('encrypted-token');
      expect(result!.email).toBe('encrypted@example.com');
    });

    test('returns null when fs.readFileSync throws', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('EACCES');
      });
      expect(readStoredCredentials()).toBeNull();
    });
  });

  describe('hasValidToken', () => {
    test('returns true when expiresAt is in the future', () => {
      const creds: StoredCredentials = {
        token: 'abc',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
      expect(hasValidToken(creds)).toBe(true);
    });

    test('returns false when expiresAt is in the past', () => {
      const creds: StoredCredentials = {
        token: 'abc',
        expiresAt: new Date(Date.now() - 3600_000).toISOString(),
      };
      expect(hasValidToken(creds)).toBe(false);
    });
  });

  describe('hasRefreshToken', () => {
    test('returns true when refreshToken is present', () => {
      const creds: StoredCredentials = {
        token: 'abc',
        expiresAt: '2099-01-01T00:00:00.000Z',
        refreshToken: 'refresh-abc',
      };
      expect(hasRefreshToken(creds)).toBe(true);
    });

    test('returns false when refreshToken is undefined', () => {
      const creds: StoredCredentials = {
        token: 'abc',
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
      expect(hasRefreshToken(creds)).toBe(false);
    });
  });
});
