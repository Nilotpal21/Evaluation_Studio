import { describe, expect, it } from 'vitest';

/**
 * Unit test 1 of 4 for `external_agent_ops` (Spec 1).
 *
 * Tests the pure-function endpoint guard `validateExternalAgentEndpoint`
 * exported from `external-agent-ops.ts`. The wrapper must:
 *  - accept canonical http(s) URLs
 *  - reject file:// (scheme allowlist)
 *  - reject 169.254.x.x metadata addresses in production mode
 *  - reject IPv6 ULA / link-local / loopback in production mode
 *  - allow private/loopback when allowPrivate=true (dev-mode opt-in)
 *
 * R7 RISK #2 (LLD §3.11):
 *   - DNS rebinding defense: deferred to shared-kernel improvement task —
 *     pinning IPs across resolve and connect requires a custom undici
 *     dispatcher. Tracked as a Spec 1 follow-up.
 *   - Redirect-follow rejection: enforced at the fetch layer (executor sets
 *     `redirect: 'manual'` and treats 3xx as an error). Verified in the
 *     `tool-result-shape` test suite.
 */

import { validateExternalAgentEndpoint } from '@/lib/arch-ai/tools/external-agent-ops';

describe('validateExternalAgentEndpoint', () => {
  describe('valid endpoints', () => {
    it('accepts canonical https URLs', () => {
      const result = validateExternalAgentEndpoint('https://agent.example.com', false);
      expect(result.ok).toBe(true);
    });

    it('accepts canonical http URLs', () => {
      const result = validateExternalAgentEndpoint('http://api.example.com', false);
      expect(result.ok).toBe(true);
    });

    it('accepts URLs with trailing path', () => {
      const result = validateExternalAgentEndpoint(
        'https://agent.example.com/v1/agents/main',
        false,
      );
      expect(result.ok).toBe(true);
    });
  });

  describe('rejected schemes', () => {
    it('rejects file:// scheme', () => {
      const result = validateExternalAgentEndpoint('file:///etc/passwd', false);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SSRF_REJECTED');
      }
    });

    it('rejects ftp:// scheme', () => {
      const result = validateExternalAgentEndpoint('ftp://internal.example.com', false);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SSRF_REJECTED');
      }
    });

    it('rejects gopher:// scheme', () => {
      const result = validateExternalAgentEndpoint('gopher://example.com', false);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SSRF_REJECTED');
      }
    });
  });

  describe('SSRF address blocking (production mode)', () => {
    it('rejects AWS metadata IP 169.254.169.254', () => {
      const result = validateExternalAgentEndpoint(
        'http://169.254.169.254/latest/meta-data',
        false,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SSRF_REJECTED');
      }
    });

    it('rejects IPv4 link-local 169.254.x.x range', () => {
      const result = validateExternalAgentEndpoint('http://169.254.42.1', false);
      expect(result.ok).toBe(false);
    });

    it('rejects IPv4 loopback 127.0.0.1', () => {
      const result = validateExternalAgentEndpoint('http://127.0.0.1:8080', false);
      expect(result.ok).toBe(false);
    });

    it('rejects IPv6 loopback ::1', () => {
      const result = validateExternalAgentEndpoint('http://[::1]:8080', false);
      expect(result.ok).toBe(false);
    });

    it('rejects IPv6 ULA fc00::/7', () => {
      const result = validateExternalAgentEndpoint('http://[fc00::1]', false);
      expect(result.ok).toBe(false);
    });

    it('rejects IPv6 ULA fd00::/8', () => {
      const result = validateExternalAgentEndpoint('http://[fd12:3456:789a::1]', false);
      expect(result.ok).toBe(false);
    });

    it('rejects IPv6 link-local fe80::/10', () => {
      const result = validateExternalAgentEndpoint('http://[fe80::1]', false);
      expect(result.ok).toBe(false);
    });

    it('rejects RFC1918 192.168.x.x', () => {
      const result = validateExternalAgentEndpoint('http://192.168.1.1', false);
      expect(result.ok).toBe(false);
    });

    it('rejects RFC1918 10.x.x.x', () => {
      const result = validateExternalAgentEndpoint('http://10.0.0.1', false);
      expect(result.ok).toBe(false);
    });
  });

  describe('dev mode (allowPrivate=true)', () => {
    it('accepts 127.0.0.1 when allowPrivate=true', () => {
      const result = validateExternalAgentEndpoint('http://127.0.0.1:3001', true);
      expect(result.ok).toBe(true);
    });

    it('accepts localhost when allowPrivate=true', () => {
      const result = validateExternalAgentEndpoint('http://localhost:3001', true);
      expect(result.ok).toBe(true);
    });

    it('still rejects file:// even in dev mode (scheme allowlist is global)', () => {
      const result = validateExternalAgentEndpoint('file:///etc/passwd', true);
      expect(result.ok).toBe(false);
    });
  });

  describe('malformed input', () => {
    it('rejects empty string', () => {
      const result = validateExternalAgentEndpoint('', false);
      expect(result.ok).toBe(false);
    });

    it('rejects URL with no scheme', () => {
      const result = validateExternalAgentEndpoint('agent.example.com', false);
      expect(result.ok).toBe(false);
    });

    it('rejects URL with userinfo (credential leakage vector)', () => {
      const result = validateExternalAgentEndpoint('https://user:pass@agent.example.com', false);
      expect(result.ok).toBe(false);
    });
  });
});
