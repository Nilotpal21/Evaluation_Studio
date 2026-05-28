import { describe, expect, it } from 'vitest';
import {
  getAllowedAuthProfileUsageModes,
  resolveAuthProfileUsageMode,
  getAuthProfileUsageModeValidationError,
  normalizeOAuth2AppConfig,
  mergeOAuth2AppConfig,
  getMaterializedAuthProfileValidationErrors,
  PHASE1_AUTH_TYPES,
  PHASE1_SCHEMA_AUTH_TYPES,
} from '../../validation/auth-profile.schema.js';

describe('auth-profile schema helpers', () => {
  describe('usage mode helpers', () => {
    it('keeps the legacy phase 1 auth type export as an alias', () => {
      expect(PHASE1_AUTH_TYPES).toBe(PHASE1_SCHEMA_AUTH_TYPES);
    });

    it('returns the configured usage modes for known auth types', () => {
      expect(getAllowedAuthProfileUsageModes('oauth2_app')).toEqual([
        'preconfigured',
        'jit',
        'preflight',
      ]);
      expect(getAllowedAuthProfileUsageModes('oauth2_token')).toEqual(['user_token']);
    });

    it('falls back to preconfigured for unknown auth types', () => {
      expect(getAllowedAuthProfileUsageModes('future_auth_type')).toEqual(['preconfigured']);
    });

    it('resolves the explicit usage mode when provided', () => {
      expect(resolveAuthProfileUsageMode('oauth2_app', 'jit')).toBe('jit');
    });

    it('resolves the default usage mode for known and unknown auth types', () => {
      expect(resolveAuthProfileUsageMode('oauth2_app')).toBe('preconfigured');
      expect(resolveAuthProfileUsageMode('future_auth_type')).toBe('preconfigured');
    });

    it('returns validation errors only for invalid usage mode combinations', () => {
      expect(getAuthProfileUsageModeValidationError('oauth2_app', 'jit')).toBeNull();
      expect(getAuthProfileUsageModeValidationError('api_key', 'preflight')).toContain(
        "usageMode 'preflight' is not valid for authType 'api_key'",
      );
      expect(getAuthProfileUsageModeValidationError('future_auth_type', 'jit')).toContain(
        "usageMode 'jit' is not valid for authType 'future_auth_type'",
      );
    });
  });

  describe('oauth2_app config normalization', () => {
    it('normalizes legacy scopes into defaultScopes', () => {
      expect(
        normalizeOAuth2AppConfig({
          authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          scopes: ['openid', 'email'],
        }),
      ).toEqual({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        defaultScopes: ['openid', 'email'],
      });
    });

    it('returns the original payload unchanged when oauth2_app config is invalid', () => {
      const invalidConfig = {
        authorizationUrl: 'not-a-url',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        tokenParams: { audience: 42 },
      };

      expect(normalizeOAuth2AppConfig(invalidConfig)).toEqual(invalidConfig);
    });
  });

  describe('oauth2_app config merging', () => {
    it('canonicalizes legacy scopes updates into defaultScopes', () => {
      expect(
        mergeOAuth2AppConfig(
          {
            authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            scopes: ['old-scope'],
            defaultScopes: ['old-scope'],
          },
          { scopes: ['email', 'profile'] },
        ),
      ).toEqual({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        defaultScopes: ['email', 'profile'],
      });
    });

    it('removes the legacy scopes alias when updates explicitly unset it', () => {
      expect(
        mergeOAuth2AppConfig(
          {
            authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            scopes: ['old-scope'],
            defaultScopes: ['old-scope'],
          },
          { scopes: undefined },
        ),
      ).toEqual({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        defaultScopes: ['old-scope'],
      });
    });

    it('drops the legacy scopes alias when defaultScopes is updated directly', () => {
      expect(
        mergeOAuth2AppConfig(
          {
            authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            scopes: ['old-scope'],
            defaultScopes: ['old-scope'],
          },
          { defaultScopes: ['calendar.readonly'] },
        ),
      ).toEqual({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        defaultScopes: ['calendar.readonly'],
      });
    });
  });

  describe('materialized auth-profile validation', () => {
    it('reports config and secrets validation errors with materialized paths', () => {
      const errors = getMaterializedAuthProfileValidationErrors(
        'oauth2_app',
        {
          authorizationUrl: 'not-a-url',
          tokenUrl: 'https://oauth2.googleapis.com/token',
        },
        {
          clientId: 'client-id',
        },
      );

      expect(errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('config.authorizationUrl:'),
          expect.stringContaining('secrets.clientSecret:'),
        ]),
      );
    });

    it('reports missing and extra custom_header secrets after schema validation succeeds', () => {
      const errors = getMaterializedAuthProfileValidationErrors(
        'custom_header',
        {
          headers: {
            Authorization: 'Authorization',
          },
        },
        {
          headerValues: {
            'X-Api-Key': 'secret',
          },
        },
      );

      expect(errors).toEqual(
        expect.arrayContaining([
          'secrets.headerValues: missing values for configured headers: Authorization',
          'secrets.headerValues: contains unexpected headers: X-Api-Key',
        ]),
      );
    });

    it('returns no materialized validation errors for unknown auth types', () => {
      expect(
        getMaterializedAuthProfileValidationErrors(
          'future_auth_type',
          { arbitrary: true },
          { arbitrary: true },
        ),
      ).toEqual([]);
    });
  });
});
