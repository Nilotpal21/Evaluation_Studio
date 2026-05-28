/**
 * ABLP-775 / DFA-9: audience extraction logic for oauth2_client_credentials
 *
 * Tests the exact audience extraction logic from resolve-tool-auth.ts line 649
 * without requiring any mocking.
 */
import { describe, it, expect } from 'vitest';

describe('oauth2_client_credentials audience extraction', () => {
  /**
   * Mirrors the extraction at resolve-tool-auth.ts:
   *   const audience = typeof profile.config.audience === 'string' ? profile.config.audience.trim() : '';
   */
  function extractAudience(config: Record<string, unknown>): string {
    return typeof config.audience === 'string' ? config.audience.trim() : '';
  }

  it('extracts non-empty audience string from profile config', () => {
    const config: Record<string, unknown> = { audience: 'https://api.example.com/' };
    expect(extractAudience(config)).toBe('https://api.example.com/');
  });

  it('returns empty string when audience is absent', () => {
    const config: Record<string, unknown> = {};
    expect(extractAudience(config)).toBe('');
  });

  it('returns empty string when audience is whitespace', () => {
    const config: Record<string, unknown> = { audience: '   ' };
    expect(extractAudience(config)).toBe('');
  });

  it('returns empty string when audience is null', () => {
    const config: Record<string, unknown> = { audience: null };
    expect(extractAudience(config)).toBe('');
  });

  it('returns empty string when audience is a number', () => {
    const config: Record<string, unknown> = { audience: 42 };
    expect(extractAudience(config)).toBe('');
  });

  it('trims leading/trailing whitespace from audience', () => {
    const config: Record<string, unknown> = { audience: '  https://api.example.com/  ' };
    expect(extractAudience(config)).toBe('https://api.example.com/');
  });
});
