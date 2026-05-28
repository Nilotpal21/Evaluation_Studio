import { describe, expect, it } from 'vitest';
import {
  OAUTH_PROVIDER_PRESETS,
  detectOAuthProvider,
} from '@/components/auth-profiles/oauth-provider-presets';

describe('detectOAuthProvider', () => {
  it('returns null for empty / nullish / non-string input', () => {
    expect(detectOAuthProvider(undefined)).toBeNull();
    expect(detectOAuthProvider(null)).toBeNull();
    expect(detectOAuthProvider('')).toBeNull();
    expect(detectOAuthProvider('   ')).toBeNull();
  });

  it('returns null for unrecognized providers', () => {
    expect(detectOAuthProvider('https://example.com/oauth/authorize')).toBeNull();
    expect(detectOAuthProvider('https://auth.custom-saas.io/authorize')).toBeNull();
  });

  it('detects Google authorization URLs and returns offline-access params', () => {
    const result = detectOAuthProvider('https://accounts.google.com/o/oauth2/v2/auth');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('google');
    expect(result?.label).toBe('Google');
    expect(result?.authorizationParams).toEqual({
      access_type: 'offline',
      prompt: 'consent',
    });
    expect(result?.detectionNote).toMatch(/access_type=offline/);
  });

  it('detects Microsoft authorization URLs without auto-fill (scope-based offline)', () => {
    const v1 = detectOAuthProvider(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(v1?.id).toBe('microsoft');
    expect(v1?.authorizationParams).toBeUndefined();
    expect(v1?.detectionNote).toMatch(/offline_access/);

    const live = detectOAuthProvider('https://login.live.com/oauth20_authorize.srf');
    expect(live?.id).toBe('microsoft');
  });

  it('detects GitHub and Slack authorization URLs as informational', () => {
    const gh = detectOAuthProvider('https://github.com/login/oauth/authorize');
    expect(gh?.id).toBe('github');
    expect(gh?.authorizationParams).toBeUndefined();

    const slackV2 = detectOAuthProvider('https://slack.com/oauth/v2/authorize');
    expect(slackV2?.id).toBe('slack');

    const slackV1 = detectOAuthProvider('https://slack.com/oauth/authorize');
    expect(slackV1?.id).toBe('slack');
  });

  it('trims whitespace and is case-insensitive on the host', () => {
    expect(detectOAuthProvider('  https://Accounts.Google.com/o/oauth2/v2/auth  ')?.id).toBe(
      'google',
    );
  });

  it('does not match same-domain non-authorization paths or look-alikes', () => {
    // Phishing-style look-alikes must not match
    expect(detectOAuthProvider('https://accounts.google.com.attacker.com/auth')).toBeNull();
    expect(detectOAuthProvider('https://malicious.com/accounts.google.com/auth')).toBeNull();
  });

  it('every preset declares the required shape', () => {
    for (const preset of OAUTH_PROVIDER_PRESETS) {
      expect(typeof preset.id).toBe('string');
      expect(typeof preset.label).toBe('string');
      expect(typeof preset.matches).toBe('function');
      expect(typeof preset.detectionNote).toBe('string');
      expect(preset.detectionNote.length).toBeGreaterThan(20);
    }
  });
});
