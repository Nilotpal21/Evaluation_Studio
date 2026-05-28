/**
 * Unit tests for `bridgeAzureDIAuth` + the `normalizeAuthForAP('azure-document-intelligence', ...)`
 * branch (LLD §3 Phase 3 Task 3.7).
 *
 * Pure data-mapping coverage: happy path, default fallbacks, missing fields,
 * legacy `auth.connection.connectionConfig` shape compatibility.
 *
 * Model selection is per-action (`extract_document.props.model`), not part
 * of the auth bundle. These tests assert the auth shape is `{ endpoint,
 * apiKey, apiVersion }`.
 */

import { describe, expect, it } from 'vitest';
import {
  bridgeAzureDIAuth,
  type AzureDIAuth,
} from '../adapters/activepieces/auth-adapters/azure-document-intelligence.js';
import { ConnectorConfigError } from '../adapters/activepieces/context-translator-errors.js';
import { normalizeAuthForAP } from '../adapters/activepieces/context-translator.js';

describe('bridgeAzureDIAuth', () => {
  it('maps connectionConfig + apiKey into the AP CustomAuth shape', () => {
    const out: AzureDIAuth = bridgeAzureDIAuth({
      apiKey: 'secret-key',
      connectionConfig: {
        endpoint: 'https://my-di.cognitiveservices.azure.com',
        apiVersion: '2024-11-30',
      },
    });

    expect(out).toEqual({
      endpoint: 'https://my-di.cognitiveservices.azure.com',
      apiKey: 'secret-key',
      apiVersion: '2024-11-30',
    });
  });

  it('applies the default apiVersion when omitted', () => {
    const out = bridgeAzureDIAuth({
      apiKey: 'secret-key',
      connectionConfig: {
        endpoint: 'https://my-di.cognitiveservices.azure.com',
      },
    });

    expect(out.apiVersion).toBe('2024-11-30');
  });

  it('reads endpoint + apiVersion from top-level when connectionConfig is absent', () => {
    const out = bridgeAzureDIAuth({
      apiKey: 'secret-key',
      endpoint: 'https://my-di.cognitiveservices.azure.com',
      apiVersion: '2023-07-31',
    });

    expect(out.endpoint).toBe('https://my-di.cognitiveservices.azure.com');
    expect(out.apiVersion).toBe('2023-07-31');
  });

  it('supports the legacy auth.connection.connectionConfig shape', () => {
    const out = bridgeAzureDIAuth({
      apiKey: 'secret-key',
      connection: {
        connectionConfig: {
          endpoint: 'https://legacy-di.cognitiveservices.azure.com',
        },
      },
    });

    expect(out.endpoint).toBe('https://legacy-di.cognitiveservices.azure.com');
  });

  it('falls back to auth.access_token when apiKey is absent', () => {
    const out = bridgeAzureDIAuth({
      access_token: 'oauth-derived-key',
      connectionConfig: { endpoint: 'https://my-di.cognitiveservices.azure.com' },
    });

    expect(out.apiKey).toBe('oauth-derived-key');
  });

  it('throws ConnectorConfigError when endpoint is missing', () => {
    expect(() => bridgeAzureDIAuth({ apiKey: 'secret-key', connectionConfig: {} })).toThrow(
      ConnectorConfigError,
    );
  });

  it('throws ConnectorConfigError when apiKey is missing', () => {
    expect(() =>
      bridgeAzureDIAuth({
        connectionConfig: { endpoint: 'https://my-di.cognitiveservices.azure.com' },
      }),
    ).toThrow(ConnectorConfigError);
  });

  it('ignores non-string apiVersion values (defensive)', () => {
    const out = bridgeAzureDIAuth({
      apiKey: 'secret-key',
      connectionConfig: {
        endpoint: 'https://my-di.cognitiveservices.azure.com',
        apiVersion: 42 as unknown as string,
      },
    });

    expect(out.apiVersion).toBe('2024-11-30');
  });

  it('ignores any defaultModel field passed in (model is per-action)', () => {
    const out = bridgeAzureDIAuth({
      apiKey: 'secret-key',
      connectionConfig: {
        endpoint: 'https://my-di.cognitiveservices.azure.com',
        defaultModel: 'prebuilt-receipt' as unknown as string,
      },
    });

    expect((out as Record<string, unknown>).defaultModel).toBeUndefined();
  });
});

describe('normalizeAuthForAP("azure-document-intelligence", ...)', () => {
  it('dispatches to bridgeAzureDIAuth', () => {
    const out = normalizeAuthForAP('azure-document-intelligence', {
      apiKey: 'secret-key',
      connectionConfig: {
        endpoint: 'https://my-di.cognitiveservices.azure.com',
        apiVersion: '2024-11-30',
      },
    });

    expect(out).toEqual({
      endpoint: 'https://my-di.cognitiveservices.azure.com',
      apiKey: 'secret-key',
      apiVersion: '2024-11-30',
    });
  });
});
