import { afterEach, describe, expect, test } from 'vitest';
import {
  buildRuntimeOAuthCallbackUri,
  resolveRuntimePublicOAuthBaseUrl,
} from '../services/oauth-callback-url.js';

const ORIGINAL_RUNTIME_PUBLIC_BASE_URL = process.env.RUNTIME_PUBLIC_BASE_URL;

afterEach(() => {
  if (ORIGINAL_RUNTIME_PUBLIC_BASE_URL === undefined) {
    delete process.env.RUNTIME_PUBLIC_BASE_URL;
  } else {
    process.env.RUNTIME_PUBLIC_BASE_URL = ORIGINAL_RUNTIME_PUBLIC_BASE_URL;
  }
});

describe('oauth-callback-url helpers', () => {
  test('normalizes the configured public runtime OAuth base URL', () => {
    process.env.RUNTIME_PUBLIC_BASE_URL = 'https://runtime.example.com///';

    expect(resolveRuntimePublicOAuthBaseUrl()).toBe('https://runtime.example.com');
  });

  test('returns null when the public runtime OAuth base URL is missing or blank', () => {
    delete process.env.RUNTIME_PUBLIC_BASE_URL;
    expect(resolveRuntimePublicOAuthBaseUrl()).toBeNull();

    process.env.RUNTIME_PUBLIC_BASE_URL = '   ';
    expect(resolveRuntimePublicOAuthBaseUrl()).toBeNull();
  });

  test('builds provider-specific callback URIs from the resolved public base URL', () => {
    const baseUrl = 'https://runtime.example.com';

    expect(buildRuntimeOAuthCallbackUri(baseUrl, 'google-oauth')).toBe(
      'https://runtime.example.com/api/v1/oauth/callback/google-oauth',
    );
    expect(buildRuntimeOAuthCallbackUri(baseUrl, 'custom/provider')).toBe(
      'https://runtime.example.com/api/v1/oauth/callback/custom%2Fprovider',
    );
  });
});
