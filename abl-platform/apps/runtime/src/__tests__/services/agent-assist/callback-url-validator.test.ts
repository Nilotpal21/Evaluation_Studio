/**
 * Unit tests for callback URL validation (callback-url-validator.ts).
 *
 * Tests the standalone validator with dev-mode ngrok support.
 * Pure function — no mocks needed.
 */

import { describe, expect, it } from 'vitest';
import {
  validateCallbackUrl,
  resolveValidationOptions,
} from '../../../services/agent-assist/callback-url-validator.js';

describe('callback-url-validator', () => {
  describe('validateCallbackUrl — default (production mode)', () => {
    it('accepts valid HTTPS URL', () => {
      const result = validateCallbackUrl('https://example.com/callback');
      expect(result.valid).toBe(true);
    });

    it('rejects http://localhost without dev flag', () => {
      const result = validateCallbackUrl('http://localhost:3000/callback');
      expect(result.valid).toBe(false);
      expect((result as { valid: false; reason: string }).reason).toContain(
        'AGENT_ASSIST_ALLOW_HTTP_CALLBACKS',
      );
    });

    it('rejects http:// for non-localhost', () => {
      const result = validateCallbackUrl('http://example.com/callback');
      expect(result.valid).toBe(false);
    });

    it('rejects ftp:// scheme', () => {
      expect(validateCallbackUrl('ftp://example.com/file').valid).toBe(false);
    });

    it('rejects file:// scheme', () => {
      expect(validateCallbackUrl('file:///etc/passwd').valid).toBe(false);
    });

    it('rejects data: scheme', () => {
      expect(validateCallbackUrl('data:text/html,<script>alert(1)</script>').valid).toBe(false);
    });

    it('rejects 127.0.0.1 loopback', () => {
      expect(validateCallbackUrl('https://127.0.0.1/callback').valid).toBe(false);
    });

    it('rejects ::1 loopback', () => {
      expect(validateCallbackUrl('https://[::1]/callback').valid).toBe(false);
    });

    it('rejects 0.0.0.0', () => {
      expect(validateCallbackUrl('https://0.0.0.0/callback').valid).toBe(false);
    });

    it('rejects 10.x.x.x RFC1918', () => {
      const result = validateCallbackUrl('https://10.0.0.1/callback');
      expect(result.valid).toBe(false);
    });

    it('rejects 192.168.x.x RFC1918', () => {
      expect(validateCallbackUrl('https://192.168.1.1/callback').valid).toBe(false);
    });

    it('rejects 172.16-31.x.x RFC1918', () => {
      expect(validateCallbackUrl('https://172.16.0.1/callback').valid).toBe(false);
      expect(validateCallbackUrl('https://172.31.255.255/callback').valid).toBe(false);
    });

    it('allows 172.32.x.x (not RFC1918)', () => {
      expect(validateCallbackUrl('https://172.32.0.1/callback').valid).toBe(true);
    });

    it('rejects 169.254.x.x link-local', () => {
      expect(validateCallbackUrl('https://169.254.1.1/callback').valid).toBe(false);
    });

    it('rejects malformed URL', () => {
      const result = validateCallbackUrl('not-a-url');
      expect(result.valid).toBe(false);
    });
  });

  describe('validateCallbackUrl — dev mode (allowHttpLocalhost)', () => {
    const devOpts = { allowHttpLocalhost: true };

    it('allows http://localhost in dev mode', () => {
      const result = validateCallbackUrl('http://localhost:3000/callback', devOpts);
      expect(result.valid).toBe(true);
    });

    it('allows http://localhost without port in dev mode', () => {
      const result = validateCallbackUrl('http://localhost/callback', devOpts);
      expect(result.valid).toBe(true);
    });

    it('still rejects http:// for non-localhost in dev mode', () => {
      const result = validateCallbackUrl('http://example.com/callback', devOpts);
      expect(result.valid).toBe(false);
    });

    it('still rejects loopback IPs in dev mode', () => {
      expect(validateCallbackUrl('https://127.0.0.1/callback', devOpts).valid).toBe(false);
    });

    it('still rejects RFC1918 in dev mode', () => {
      expect(validateCallbackUrl('https://10.0.0.1/callback', devOpts).valid).toBe(false);
    });
  });

  describe('validateCallbackUrl — internal DNS deny-list', () => {
    it('rejects hostname on deny-list', () => {
      const result = validateCallbackUrl('https://internal.corp.example.com/callback', {
        internalDnsDenyList: ['internal.corp.example.com'],
      });
      expect(result.valid).toBe(false);
      expect((result as { valid: false; reason: string }).reason).toContain('Internal hostname');
    });

    it('deny-list match is case-insensitive', () => {
      const result = validateCallbackUrl('https://INTERNAL.CORP.EXAMPLE.COM/callback', {
        internalDnsDenyList: ['internal.corp.example.com'],
      });
      expect(result.valid).toBe(false);
    });

    it('allows hostname not on deny-list', () => {
      const result = validateCallbackUrl('https://external.example.com/callback', {
        internalDnsDenyList: ['internal.corp.example.com'],
      });
      expect(result.valid).toBe(true);
    });

    it('handles empty deny-list', () => {
      const result = validateCallbackUrl('https://example.com/callback', {
        internalDnsDenyList: [],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('resolveValidationOptions', () => {
    it('reads allowHttpLocalhost from env', () => {
      const opts = resolveValidationOptions({
        AGENT_ASSIST_ALLOW_HTTP_CALLBACKS: 'true',
      } as unknown as NodeJS.ProcessEnv);
      expect(opts.allowHttpLocalhost).toBe(true);
    });

    it('defaults allowHttpLocalhost to false', () => {
      const opts = resolveValidationOptions({} as NodeJS.ProcessEnv);
      expect(opts.allowHttpLocalhost).toBe(false);
    });

    it('parses comma-separated DNS deny-list', () => {
      const opts = resolveValidationOptions({
        AGENT_ASSIST_INTERNAL_DNS_DENYLIST: 'a.internal,b.internal, c.internal',
      } as unknown as NodeJS.ProcessEnv);
      expect(opts.internalDnsDenyList).toEqual(['a.internal', 'b.internal', 'c.internal']);
    });

    it('returns empty deny-list when env not set', () => {
      const opts = resolveValidationOptions({} as NodeJS.ProcessEnv);
      expect(opts.internalDnsDenyList).toEqual([]);
    });
  });
});
