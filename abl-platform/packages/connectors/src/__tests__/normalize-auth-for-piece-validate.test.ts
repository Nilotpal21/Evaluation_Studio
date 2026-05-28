/**
 * normalizeAuthForPieceValidate covers the auth-shape divergence between
 * the action runtime and the piece's `auth.validate` hook.
 *
 * Background (the bug it fixes): for `oauth2_app` and `api_key` auth
 * profiles bound to CUSTOM_AUTH pieces (Shopify) or SECRET_TEXT pieces
 * (Linear), our action-runtime normalisation produces a wrapped object
 * (`{ props: { ... } }` or `{ secret_text: 'x', apiKey: 'x' }`). But the
 * piece's `validate` function expects the flat object / raw string
 * respectively. Without this remapping every piece-level "test connection"
 * call would receive the wrong shape and report false negatives.
 */

import { describe, it, expect } from 'vitest';
import { normalizeAuthForPieceValidate } from '../adapters/activepieces/context-translator.js';

describe('normalizeAuthForPieceValidate', () => {
  describe('shopify (CUSTOM_AUTH wrapped as { props } at action time)', () => {
    it('unwraps `{ props: { shopName, adminToken } }` to the flat object the validate hook expects', () => {
      const result = normalizeAuthForPieceValidate('shopify', {
        apiKey: 'shppa_xxx',
        connectionConfig: { subdomain: 'mystore' },
      });
      expect(result).toEqual({ shopName: 'mystore', adminToken: 'shppa_xxx' });
    });
  });

  describe('linear (SECRET_TEXT)', () => {
    it('returns the raw API key string — Activepieces SECRET_TEXT validate gets a string, not an object', () => {
      const result = normalizeAuthForPieceValidate('linear', { apiKey: 'lin_api_abc' });
      expect(result).toBe('lin_api_abc');
    });

    it('falls back to apiKey when secret_text is not present', () => {
      const result = normalizeAuthForPieceValidate('linear', { apiKey: 'lin_api_xyz' });
      expect(result).toBe('lin_api_xyz');
    });
  });

  describe('airtable (SECRET_TEXT)', () => {
    it('returns the raw PAT string', () => {
      const result = normalizeAuthForPieceValidate('airtable', { apiKey: 'patAbc123' });
      expect(result).toBe('patAbc123');
    });

    it('prefers secret_text over apiKey when both present', () => {
      const result = normalizeAuthForPieceValidate('airtable', {
        apiKey: 'old',
        secret_text: 'patAbc123',
      });
      expect(result).toBe('patAbc123');
    });
  });

  describe('openai (SECRET_TEXT)', () => {
    it('returns the raw API key string', () => {
      const result = normalizeAuthForPieceValidate('openai', { apiKey: 'sk-abc123' });
      expect(result).toBe('sk-abc123');
    });
  });

  describe('stripe (SECRET_TEXT)', () => {
    it('returns the raw secret key string', () => {
      const result = normalizeAuthForPieceValidate('stripe', { apiKey: 'sk_test_xyz' });
      expect(result).toBe('sk_test_xyz');
    });
  });

  describe('connectors with no per-piece divergence', () => {
    it('returns the same shape as normalizeAuthForAP for OAuth2 pieces (e.g. gmail)', () => {
      const auth = { access_token: 'ya29.token', refresh_token: 'r' };
      const result = normalizeAuthForPieceValidate('gmail', auth);
      // Default branch in normalizeAuthForAP returns auth as-is for OAuth2.
      expect(result).toMatchObject({ access_token: 'ya29.token' });
    });

    it('returns auth as-is for unknown connector slugs (no override defined)', () => {
      const auth = { foo: 'bar' };
      const result = normalizeAuthForPieceValidate('totally-unknown-connector', auth);
      expect(result).toMatchObject({ foo: 'bar' });
    });
  });

  // Issue 4: CUSTOM_AUTH pieces that use the default normalize path.
  // These have no explicit case in normalizeAuthForPieceValidate — verify the
  // default pass-through does not mutate credentials that AWS/Azure/Postgres
  // validate hooks need in their original shape.
  describe('AWS IAM connectors — default normalize path passes credentials through unchanged', () => {
    const awsAuth = {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
    };

    it('amazon-s3: preserves IAM credentials shape', () => {
      const result = normalizeAuthForPieceValidate('amazon-s3', { ...awsAuth });
      expect(result).toMatchObject(awsAuth);
    });

    it('amazon-sqs: preserves IAM credentials shape', () => {
      const result = normalizeAuthForPieceValidate('amazon-sqs', { ...awsAuth });
      expect(result).toMatchObject(awsAuth);
    });

    it('amazon-ses: preserves IAM credentials shape', () => {
      const result = normalizeAuthForPieceValidate('amazon-ses', { ...awsAuth });
      expect(result).toMatchObject(awsAuth);
    });

    it('amazon-sns: preserves IAM credentials shape', () => {
      const result = normalizeAuthForPieceValidate('amazon-sns', { ...awsAuth });
      expect(result).toMatchObject(awsAuth);
    });
  });

  // azure-blob-storage uses CUSTOM_AUTH with a single `connectionString` prop.
  // The AP piece validate hook accesses auth.connectionString directly (flat).
  // The default normalizeAuthForAP path returns the auth object unchanged, so
  // normalizeAuthForPieceValidate passes connectionString through flat — no
  // props-envelope wrapping like Shopify/ServiceNow.
  describe('azure-blob-storage — connectionString passes flat to the AP validate hook', () => {
    it('passes connectionString through without wrapping in props envelope', () => {
      const auth = {
        connectionString:
          'DefaultEndpointsProtocol=https;AccountName=myaccount;AccountKey=abc123==;EndpointSuffix=core.windows.net',
      };
      const result = normalizeAuthForPieceValidate('azure-blob-storage', { ...auth });
      expect(result).toMatchObject(auth);
      // Confirm no props-wrapping (which would break auth.connectionString access in the hook)
      expect((result as Record<string, unknown>).props).toBeUndefined();
    });
  });

  describe('jira-cloud — explicit normalizeAuthForAP case returns auth unchanged', () => {
    it('preserves OAuth access_token and does not mutate the payload', () => {
      const auth = {
        access_token: 'eyJhbGc...',
        refresh_token: 'eyJhbGc...refresh',
        expires_in: 3600,
      };
      const result = normalizeAuthForPieceValidate('jira-cloud', { ...auth });
      expect(result).toMatchObject(auth);
    });
  });

  describe('postgres — default normalize path passes credentials through unchanged', () => {
    it('preserves host/port/user/password shape', () => {
      const auth = {
        host: 'db.example.com',
        port: 5432,
        database: 'mydb',
        user: 'readonly',
        password: 's3cr3t',
      };
      const result = normalizeAuthForPieceValidate(
        'postgres',
        auth as unknown as Record<string, unknown>,
      );
      expect(result).toMatchObject(auth);
    });
  });
});
