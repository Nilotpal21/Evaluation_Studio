/**
 * Auth Config Builder Tests
 *
 * Validates compile-time auth config validation for HTTP tool bindings.
 */

import { describe, it, expect } from 'vitest';
import { buildAuthConfigFromAST } from '../../platform/ir/auth-config-builder.js';

describe('buildAuthConfigFromAST', () => {
  describe('none / undefined', () => {
    it('should return undefined for undefined authType', () => {
      expect(buildAuthConfigFromAST(undefined)).toBeUndefined();
    });

    it('should return undefined for "none" authType', () => {
      expect(buildAuthConfigFromAST('none')).toBeUndefined();
    });
  });

  describe('oauth2_client', () => {
    it('should return valid config with tokenUrl and clientId', () => {
      const result = buildAuthConfigFromAST('oauth2_client', {
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'my-client',
        scopes: 'read,write',
      });
      expect(result).toEqual({
        oauth: {
          tokenUrl: 'https://auth.example.com/token',
          clientId: 'my-client',
          scopes: ['read', 'write'],
        },
      });
    });

    it('should throw if tokenUrl is missing', () => {
      expect(() => buildAuthConfigFromAST('oauth2_client', { clientId: 'id' })).toThrow(
        'oauth2_client auth requires a non-empty "tokenUrl"',
      );
    });

    it('should throw if clientId is missing', () => {
      expect(() =>
        buildAuthConfigFromAST('oauth2_client', { tokenUrl: 'https://example.com/token' }),
      ).toThrow('oauth2_client auth requires a non-empty "clientId"');
    });

    it('should throw if tokenUrl is empty string', () => {
      expect(() =>
        buildAuthConfigFromAST('oauth2_client', { tokenUrl: '', clientId: 'id' }),
      ).toThrow('oauth2_client auth requires a non-empty "tokenUrl"');
    });
  });

  describe('oauth2_user', () => {
    it('should return valid config with provider', () => {
      const result = buildAuthConfigFromAST('oauth2_user', { provider: 'google' });
      expect(result).toEqual({ provider: 'google' });
    });

    it('should throw if provider is missing', () => {
      expect(() => buildAuthConfigFromAST('oauth2_user', {})).toThrow(
        'oauth2_user auth requires a non-empty "provider"',
      );
    });

    it('should throw if provider is empty string', () => {
      expect(() => buildAuthConfigFromAST('oauth2_user', { provider: '' })).toThrow(
        'oauth2_user auth requires a non-empty "provider"',
      );
    });
  });

  describe('api_key', () => {
    it('should return default X-API-Key header', () => {
      const result = buildAuthConfigFromAST('api_key');
      expect(result).toEqual({ headerName: 'X-API-Key' });
    });

    it('should use custom headerName', () => {
      const result = buildAuthConfigFromAST('api_key', { headerName: 'X-Custom-Key' });
      expect(result).toEqual({ headerName: 'X-Custom-Key' });
    });
  });

  describe('bearer', () => {
    it('should return Authorization header with Bearer prefix', () => {
      const result = buildAuthConfigFromAST('bearer');
      expect(result).toEqual({ headerName: 'Authorization', headerPrefix: 'Bearer' });
    });
  });

  describe('custom', () => {
    it('should return custom headers', () => {
      const result = buildAuthConfigFromAST('custom', {
        customHeaders: { 'X-Token': '{{secrets.my_token}}' },
      });
      expect(result).toEqual({ customHeaders: { 'X-Token': '{{secrets.my_token}}' } });
    });

    it('should throw if customHeaders is empty', () => {
      expect(() => buildAuthConfigFromAST('custom', { customHeaders: {} })).toThrow(
        'custom auth requires non-empty "customHeaders"',
      );
    });

    it('should throw if customHeaders is missing', () => {
      expect(() => buildAuthConfigFromAST('custom', {})).toThrow(
        'custom auth requires non-empty "customHeaders"',
      );
    });
  });

  describe('searchai', () => {
    it('should return default Auth header with no searchai config when no tokenUrl', () => {
      const result = buildAuthConfigFromAST('searchai');
      expect(result).toEqual({ headerName: 'Auth' });
    });

    it('should return searchai config when tokenUrl is provided', () => {
      const result = buildAuthConfigFromAST('searchai', {
        tokenUrl: 'https://platform.example.com/api/jwt/generate',
        clientId: 'my-client',
        clientSecret: '{{secrets.SEARCHAI_SECRET}}',
        botId: 'bot-123',
      });
      expect(result).toEqual({
        headerName: 'Auth',
        searchai: {
          tokenUrl: 'https://platform.example.com/api/jwt/generate',
          clientId: 'my-client',
          clientSecret: '{{secrets.SEARCHAI_SECRET}}',
          botId: 'bot-123',
          headerName: 'Auth',
        },
      });
    });

    it('should use custom headerName', () => {
      const result = buildAuthConfigFromAST('searchai', { headerName: 'Authorization' });
      expect(result).toEqual({ headerName: 'Authorization' });
    });

    it('should use custom headerName in nested searchai config', () => {
      const result = buildAuthConfigFromAST('searchai', {
        tokenUrl: 'https://platform.example.com/api/jwt/generate',
        clientId: 'my-client',
        headerName: 'X-SearchAI-Token',
      });
      expect(result).toEqual({
        headerName: 'X-SearchAI-Token',
        searchai: {
          tokenUrl: 'https://platform.example.com/api/jwt/generate',
          clientId: 'my-client',
          clientSecret: undefined,
          botId: undefined,
          headerName: 'X-SearchAI-Token',
        },
      });
    });
  });

  describe('unknown auth type', () => {
    it('should return undefined for unknown auth type', () => {
      expect(buildAuthConfigFromAST('saml')).toBeUndefined();
    });
  });
});
