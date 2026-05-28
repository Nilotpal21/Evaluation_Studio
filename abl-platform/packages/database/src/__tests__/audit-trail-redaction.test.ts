/**
 * Audit Trail Ciphertext Redaction Tests (Task 3.8)
 *
 * Validates that:
 * - Encrypted fields (encryptedSecrets, previousEncryptedSecrets) are
 *   redacted as '[REDACTED]' in audit trail change records
 * - Non-sensitive fields still appear in audit trail
 * - findOneAndUpdate $set operator changes are also sanitized
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { setAuditHandler, sanitizeChanges } from '../mongo/plugins/audit-trail.plugin.js';

describe('Audit trail ciphertext redaction (Task 3.8)', () => {
  let capturedEntries: any[] = [];

  beforeEach(() => {
    capturedEntries = [];
    setAuditHandler((entry) => {
      capturedEntries.push(entry);
    });
  });

  afterAll(() => {
    setAuditHandler(null);
  });

  it('sanitizeChanges redacts encryptedSecrets in direct changes', () => {
    const changes = {
      encryptedSecrets: 'some-ciphertext-value',
      name: 'my-profile',
      status: 'active',
    };

    const result = sanitizeChanges(changes);

    expect(result).toBeDefined();
    expect(result!.encryptedSecrets).toBe('[REDACTED]');
    expect(result!.name).toBe('my-profile');
    expect(result!.status).toBe('active');
  });

  it('sanitizeChanges redacts previousEncryptedSecrets in direct changes', () => {
    const changes = {
      previousEncryptedSecrets: 'old-ciphertext',
      encryptedSecrets: 'new-ciphertext',
      config: { foo: 'bar' },
    };

    const result = sanitizeChanges(changes);

    expect(result).toBeDefined();
    expect(result!.previousEncryptedSecrets).toBe('[REDACTED]');
    expect(result!.encryptedSecrets).toBe('[REDACTED]');
    expect(result!.config).toEqual({ foo: 'bar' });
  });

  it('sanitizeChanges redacts $set.encryptedSecrets in findOneAndUpdate changes', () => {
    const changes = {
      $set: {
        encryptedSecrets: 'ciphertext-in-set',
        name: 'new-name',
      },
    };

    const result = sanitizeChanges(changes);

    expect(result).toBeDefined();
    const $set = result!.$set as Record<string, unknown>;
    expect($set.encryptedSecrets).toBe('[REDACTED]');
    expect($set.name).toBe('new-name');
  });

  it('sanitizeChanges redacts $unset operator encrypted fields', () => {
    const changes = {
      $unset: {
        previousEncryptedSecrets: '',
        name: '',
      },
    };

    const result = sanitizeChanges(changes);

    expect(result).toBeDefined();
    const $unset = result!.$unset as Record<string, unknown>;
    expect($unset.previousEncryptedSecrets).toBe('[REDACTED]');
    expect($unset.name).toBe('');
  });

  it('non-sensitive fields pass through sanitization unchanged', () => {
    const changes = {
      name: 'updated-name',
      status: 'revoked',
      config: { endpoint: 'https://example.com' },
      authType: 'bearer',
    };

    const result = sanitizeChanges(changes);

    expect(result).toBeDefined();
    expect(result!.name).toBe('updated-name');
    expect(result!.status).toBe('revoked');
    expect(result!.config).toEqual({ endpoint: 'https://example.com' });
    expect(result!.authType).toBe('bearer');
  });

  it('sanitizeChanges returns undefined for undefined input', () => {
    const result = sanitizeChanges(undefined);
    expect(result).toBeUndefined();
  });
});
