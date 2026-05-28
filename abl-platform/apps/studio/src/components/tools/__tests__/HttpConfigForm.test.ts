/**
 * HttpConfigForm Validation Tests
 *
 * CRITICAL SECURITY TESTS: SSRF protection, URL validation, auth validation
 * These tests ensure that malicious URLs and protocols are blocked before
 * reaching the backend.
 */

import { createElement, useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, test, expect } from 'vitest';
import {
  HttpConfigForm,
  validateHttpConfig,
  extractInputReferences,
  getAuthProfileTypeFilter,
} from '../HttpConfigForm';
import type { HttpConfig } from '../HttpConfigForm';

function renderHttpConfigForm(initialConfig: HttpConfig) {
  function Harness() {
    const [config, setConfig] = useState(initialConfig);
    return createElement(HttpConfigForm, {
      config,
      onChange: setConfig,
      showTemplates: false,
    });
  }

  return render(createElement(Harness));
}

// =============================================================================
// CRITICAL: SSRF PROTECTION TESTS
// =============================================================================

describe('validateHttpConfig - SSRF Protection', () => {
  test('blocks file:// protocol to prevent local file access', () => {
    const config: HttpConfig = {
      endpoint: 'file:///etc/passwd',
      method: 'GET',
      authType: 'none',
    };
    const errors = validateHttpConfig(config);
    expect(errors.endpoint).toBeDefined();
    expect(errors.endpoint).toContain('Blocked protocol');
  });

  test('blocks gopher:// protocol to prevent SSRF attacks', () => {
    const config: HttpConfig = {
      endpoint: 'gopher://malicious.com:25/xHELO%20localhost',
      method: 'GET',
      authType: 'none',
    };
    const errors = validateHttpConfig(config);
    expect(errors.endpoint).toBeDefined();
    expect(errors.endpoint).toContain('Blocked protocol');
  });

  test('blocks dict:// protocol to prevent information disclosure', () => {
    const config: HttpConfig = {
      endpoint: 'dict://localhost:11211/stat',
      method: 'GET',
      authType: 'none',
    };
    const errors = validateHttpConfig(config);
    expect(errors.endpoint).toBeDefined();
    expect(errors.endpoint).toContain('Blocked protocol');
  });

  test('allows http:// protocol', () => {
    const config: HttpConfig = {
      endpoint: 'http://api.example.com/endpoint',
      method: 'GET',
      authType: 'none',
    };
    const errors = validateHttpConfig(config);
    expect(errors.endpoint).toBeUndefined();
  });

  test('allows https:// protocol', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com/endpoint',
      method: 'GET',
      authType: 'none',
    };
    const errors = validateHttpConfig(config);
    expect(errors.endpoint).toBeUndefined();
  });

  test('rejects URLs with non-http protocols (ftp, ssh, etc)', () => {
    const config: HttpConfig = {
      endpoint: 'ftp://files.example.com/data',
      method: 'GET',
      authType: 'none',
    };
    const errors = validateHttpConfig(config);
    expect(errors.endpoint).toBeDefined();
    expect(errors.endpoint).toContain('must use http:// or https://');
  });

  test('rejects invalid URL format', () => {
    const config: HttpConfig = {
      endpoint: 'not-a-valid-url',
      method: 'GET',
      authType: 'none',
    };
    const errors = validateHttpConfig(config);
    expect(errors.endpoint).toBeDefined();
    expect(errors.endpoint).toContain('must be a valid URL');
  });

  test('requires endpoint to be non-empty', () => {
    const config: HttpConfig = {
      endpoint: '',
      method: 'GET',
      authType: 'none',
    };
    const errors = validateHttpConfig(config);
    expect(errors.endpoint).toBeDefined();
    expect(errors.endpoint).toContain('required');
  });
});

// =============================================================================
// BASIC VALIDATION TESTS
// =============================================================================

describe('validateHttpConfig - Basic Validation', () => {
  test('validates minimal valid config', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
    };
    const errors = validateHttpConfig(config);
    expect(Object.keys(errors)).toHaveLength(0);
  });

  test('requires method to be specified', () => {
    // Intentionally invalid config to test validation
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: '' as HttpConfig['method'],
      authType: 'none',
    };
    const errors = validateHttpConfig(config);
    expect(errors.method).toBeDefined();
    expect(errors.method).toContain('required');
  });

  test('accepts exact config templates in runtime numeric fields', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      timeoutMs: '{{config.HTTP_TIMEOUT_MS}}',
      retryCount: '{{config.HTTP_RETRY_COUNT}}',
      retryDelayMs: '{{config.HTTP_RETRY_DELAY_MS}}',
      rateLimitPerMinute: '{{config.HTTP_RATE_LIMIT}}',
      circuitBreaker: {
        threshold: '{{config.HTTP_CB_THRESHOLD}}',
        resetMs: '{{config.HTTP_CB_RESET_MS}}',
      },
    };

    const errors = validateHttpConfig(config);

    expect(errors.timeoutMs).toBeUndefined();
    expect(errors.retryCount).toBeUndefined();
    expect(errors.retryDelayMs).toBeUndefined();
    expect(errors.rateLimitPerMinute).toBeUndefined();
    expect(errors.circuitBreakerThreshold).toBeUndefined();
    expect(errors.circuitBreakerResetMs).toBeUndefined();
  });

  test('rejects non-exact config expressions in runtime numeric fields', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      timeoutMs: 'prefix-{{config.HTTP_TIMEOUT_MS}}' as HttpConfig['timeoutMs'],
    };

    const errors = validateHttpConfig(config);

    expect(errors.timeoutMs).toContain('{{config.KEY}}');
  });
});

describe('HttpConfigForm - Request Body Type', () => {
  test('keeps Form Data selected while updating the Content-Type header', async () => {
    const user = userEvent.setup();
    let latestConfig: HttpConfig = {
      endpoint: 'https://api.example.com/token',
      method: 'POST',
      authType: 'none',
      bodyType: 'json',
      headers: [{ key: 'Content-Type', value: 'application/json' }],
    };

    function Harness() {
      const [config, setConfig] = useState(latestConfig);
      return createElement(HttpConfigForm, {
        config,
        onChange: (next: HttpConfig) => {
          latestConfig = next;
          setConfig(next);
        },
        showTemplates: false,
      });
    }

    render(createElement(Harness));

    await user.click(screen.getByTestId('http-config-body-type'));
    await user.click(await screen.findByText('Form Data'));

    expect(latestConfig.bodyType).toBe('form');
    expect(latestConfig.headers).toEqual([
      { key: 'Content-Type', value: 'application/x-www-form-urlencoded' },
    ]);
    expect(screen.getByTestId('http-config-body-type')).toHaveTextContent('Form Data');
  });
});

describe('getAuthProfileTypeFilter', () => {
  test('maps oauth2_client auth to oauth2 client-credentials compatible profiles', () => {
    expect(getAuthProfileTypeFilter('oauth2_client')).toEqual(
      expect.arrayContaining(['oauth2_client_credentials', 'azure_ad']),
    );
  });

  test('maps custom auth to enterprise/custom auth profile types including mtls', () => {
    expect(getAuthProfileTypeFilter('custom')).toEqual(
      expect.arrayContaining([
        'basic',
        'custom_header',
        'aws_iam',
        'mtls',
        'ssh_key',
        'digest',
        'kerberos',
        'saml',
        'hawk',
        'ws_security',
      ]),
    );
  });
});

// =============================================================================
// AUTH VALIDATION TESTS
// =============================================================================

describe('validateHttpConfig - API Key Auth', () => {
  test('requires headerName when using API key auth', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'api_key',
      authConfig: {
        apiKey: 'test-key-123',
      },
    };
    const errors = validateHttpConfig(config);
    expect(errors['authConfig.headerName']).toBeDefined();
    expect(errors['authConfig.headerName']).toContain('required');
  });

  test('requires apiKey when using API key auth', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'api_key',
      authConfig: {
        headerName: 'X-API-Key',
      },
    };
    const errors = validateHttpConfig(config);
    expect(errors['authConfig.apiKey']).toBeDefined();
    expect(errors['authConfig.apiKey']).toContain('required');
  });

  test('rejects empty/whitespace headerName', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'api_key',
      authConfig: {
        headerName: '   ',
        apiKey: 'test-key',
      },
    };
    const errors = validateHttpConfig(config);
    expect(errors['authConfig.headerName']).toBeDefined();
  });

  test('rejects empty/whitespace apiKey', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'api_key',
      authConfig: {
        headerName: 'X-API-Key',
        apiKey: '   ',
      },
    };
    const errors = validateHttpConfig(config);
    expect(errors['authConfig.apiKey']).toBeDefined();
  });

  test('accepts valid API key auth config', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'api_key',
      authConfig: {
        headerName: 'X-API-Key',
        apiKey: 'sk_test_123456',
      },
    };
    const errors = validateHttpConfig(config);
    expect(errors['authConfig.headerName']).toBeUndefined();
    expect(errors['authConfig.apiKey']).toBeUndefined();
  });
});

describe('validateHttpConfig - Bearer Token Auth', () => {
  test('requires token when using bearer auth', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'bearer',
      authConfig: {},
    };
    const errors = validateHttpConfig(config);
    expect(errors['authConfig.token']).toBeDefined();
    expect(errors['authConfig.token']).toContain('required');
  });

  test('rejects empty/whitespace token', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'bearer',
      authConfig: {
        token: '   ',
      },
    };
    const errors = validateHttpConfig(config);
    expect(errors['authConfig.token']).toBeDefined();
  });

  test('accepts valid bearer token', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'bearer',
      authConfig: {
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
      },
    };
    const errors = validateHttpConfig(config);
    expect(errors['authConfig.token']).toBeUndefined();
  });
});

describe('validateHttpConfig - OAuth2 Client Credentials', () => {
  test('does not require inline OAuth fields when auth profile reference is set', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'oauth2_client',
      authProfileRef: 'billing_api_auth',
      authConfig: {},
    };
    const errors = validateHttpConfig(config);
    expect(errors['authConfig.clientId']).toBeUndefined();
    expect(errors['authConfig.clientSecret']).toBeUndefined();
    expect(errors['authConfig.tokenUrl']).toBeUndefined();
  });

  test('skips inline tokenUrl validation when auth profile reference is set', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'oauth2_client',
      authProfileRef: 'billing_api_auth',
      authConfig: {
        tokenUrl: 'not-a-valid-url',
      },
    };
    const errors = validateHttpConfig(config);
    expect(errors['authConfig.tokenUrl']).toBeUndefined();
  });

  test('requires clientId for OAuth2', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'oauth2_client',
      authConfig: {
        clientSecret: 'secret',
        tokenUrl: 'https://auth.example.com/token',
      },
    };
    const errors = validateHttpConfig(config);
    expect(errors['authConfig.clientId']).toBeDefined();
    expect(errors['authConfig.clientId']).toContain('required');
  });

  test('requires clientSecret for OAuth2', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'oauth2_client',
      authConfig: {
        clientId: 'client-123',
        tokenUrl: 'https://auth.example.com/token',
      },
    };
    const errors = validateHttpConfig(config);
    expect(errors['authConfig.clientSecret']).toBeDefined();
    expect(errors['authConfig.clientSecret']).toContain('required');
  });

  test('requires tokenUrl for OAuth2', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'oauth2_client',
      authConfig: {
        clientId: 'client-123',
        clientSecret: 'secret',
      },
    };
    const errors = validateHttpConfig(config);
    expect(errors['authConfig.tokenUrl']).toBeDefined();
    expect(errors['authConfig.tokenUrl']).toContain('required');
  });

  test('validates tokenUrl format', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'oauth2_client',
      authConfig: {
        clientId: 'client-123',
        clientSecret: 'secret',
        tokenUrl: 'not-a-valid-url',
      },
    };
    const errors = validateHttpConfig(config);
    expect(errors['authConfig.tokenUrl']).toBeDefined();
    expect(errors['authConfig.tokenUrl']).toContain('valid URL');
  });

  test('applies SSRF protection to tokenUrl', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'oauth2_client',
      authConfig: {
        clientId: 'client-123',
        clientSecret: 'secret',
        tokenUrl: 'file:///etc/passwd',
      },
    };
    const errors = validateHttpConfig(config);
    expect(errors['authConfig.tokenUrl']).toBeDefined();
    expect(errors['authConfig.tokenUrl']).toContain('Blocked protocol');
  });

  test('accepts valid OAuth2 config', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'oauth2_client',
      authConfig: {
        clientId: 'client-123',
        clientSecret: 'secret-456',
        tokenUrl: 'https://auth.example.com/oauth/token',
        scopes: 'read write',
      },
    };
    const errors = validateHttpConfig(config);
    expect(errors['authConfig.clientId']).toBeUndefined();
    expect(errors['authConfig.clientSecret']).toBeUndefined();
    expect(errors['authConfig.tokenUrl']).toBeUndefined();
  });
});

// =============================================================================
// BODY SCHEMA VALIDATION TESTS
// =============================================================================

describe('validateHttpConfig - Body Schema Validation', () => {
  test('validates JSON Schema format when using body schema', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'none',
      useBodySchema: true,
      bodySchema: '{invalid-json}',
    };
    const errors = validateHttpConfig(config);
    expect(errors.bodySchema).toBeDefined();
    expect(errors.bodySchema).toContain('Invalid JSON Schema format');
  });

  test('requires type and properties in body schema', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'none',
      useBodySchema: true,
      bodySchema: '{"something": "else"}',
    };
    const errors = validateHttpConfig(config);
    expect(errors.bodySchema).toBeDefined();
    expect(errors.bodySchema).toContain('must have "type" and "properties"');
  });

  test('accepts valid JSON Schema', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'none',
      useBodySchema: true,
      bodySchema: JSON.stringify({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      }),
    };
    const errors = validateHttpConfig(config);
    expect(errors.bodySchema).toBeUndefined();
  });

  test('skips body schema validation when useBodySchema is false', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'none',
      useBodySchema: false,
      bodySchema: '{invalid-json}',
    };
    const errors = validateHttpConfig(config);
    expect(errors.bodySchema).toBeUndefined();
  });

  test('validates body template JSON format when using schema', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'none',
      useBodySchema: true,
      bodySchema: JSON.stringify({
        type: 'object',
        properties: { name: { type: 'string' } },
      }),
      body: '{invalid-json}',
    };
    const errors = validateHttpConfig(config);
    expect(errors.body).toBeDefined();
    expect(errors.body).toContain('Invalid JSON format');
  });

  test('accepts valid JSON in body template', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'none',
      useBodySchema: true,
      bodySchema: JSON.stringify({
        type: 'object',
        properties: { name: { type: 'string' } },
      }),
      body: '{"name": "{{input.username}}"}',
    };
    const errors = validateHttpConfig(config);
    expect(errors.body).toBeUndefined();
  });
});

// =============================================================================
// RETRY & RATE LIMIT VALIDATION TESTS
// =============================================================================

describe('validateHttpConfig - Retry Configuration', () => {
  test('accepts retry count of 0', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      retryCount: 0,
    };
    const errors = validateHttpConfig(config);
    expect(errors.retryCount).toBeUndefined();
  });

  test('accepts retry count up to 10', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      retryCount: 10,
    };
    const errors = validateHttpConfig(config);
    expect(errors.retryCount).toBeUndefined();
  });

  test('rejects negative retry count', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      retryCount: -1,
    };
    const errors = validateHttpConfig(config);
    expect(errors.retryCount).toBeDefined();
    expect(errors.retryCount).toContain('0–10');
  });

  test('rejects retry count above 10', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      retryCount: 15,
    };
    const errors = validateHttpConfig(config);
    expect(errors.retryCount).toBeDefined();
    expect(errors.retryCount).toContain('0–10');
  });

  test('requires retry delay of at least 100ms', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      retryDelayMs: 50,
    };
    const errors = validateHttpConfig(config);
    expect(errors.retryDelayMs).toBeDefined();
    expect(errors.retryDelayMs).toContain('100ms');
  });

  test('accepts retry delay of 100ms or more', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      retryDelayMs: 100,
    };
    const errors = validateHttpConfig(config);
    expect(errors.retryDelayMs).toBeUndefined();
  });
});

// =============================================================================
// EDGE CASES & COMPLEX SCENARIOS
// =============================================================================

describe('validateHttpConfig - Edge Cases', () => {
  test('handles undefined authConfig gracefully', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'api_key',
      // authConfig is undefined
    };
    const errors = validateHttpConfig(config);
    expect(errors['authConfig.headerName']).toBeDefined();
    expect(errors['authConfig.apiKey']).toBeDefined();
  });

  test('extracts input references only from the selected auth mode', () => {
    const refs = extractInputReferences({
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'api_key',
      authConfig: {
        headerName: 'X-API-Key',
        apiKey: '{{input.active_key}}',
        token: '{{input.stale_bearer_token}}',
      },
    });

    expect(refs).toEqual(['active_key']);
  });

  test('ignores stale hidden auth references during parameter validation', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'api_key',
      authConfig: {
        headerName: 'X-API-Key',
        apiKey: '{{input.active_key}}',
        token: '{{input.stale_bearer_token}}',
      },
      parameters: [
        {
          name: 'active_key',
          type: 'string',
          description: 'Active API key',
          required: true,
        },
      ],
    };

    const errors = validateHttpConfig(config);

    expect(errors.parameters).toBeUndefined();
  });

  test('validates multiple fields simultaneously', () => {
    // Intentionally invalid config to test validation
    const config: HttpConfig = {
      endpoint: '',
      method: '' as HttpConfig['method'],
      authType: 'bearer',
      authConfig: {},
      retryCount: 20,
    };
    const errors = validateHttpConfig(config);
    expect(errors.endpoint).toBeDefined();
    expect(errors.method).toBeDefined();
    expect(errors['authConfig.token']).toBeDefined();
    expect(errors.retryCount).toBeDefined();
  });

  test('allows optional fields to be omitted', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      // headers, queryParams, body, retryCount all omitted
    };
    const errors = validateHttpConfig(config);
    expect(Object.keys(errors)).toHaveLength(0);
  });

  test('handles URL with query parameters and fragments', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com/path?param=value#section',
      method: 'GET',
      authType: 'none',
    };
    const errors = validateHttpConfig(config);
    expect(errors.endpoint).toBeUndefined();
  });
});

describe('HttpConfigForm - sensitive auth input visibility', () => {
  test('allows API key values to be revealed and hidden while editing', async () => {
    const user = userEvent.setup();

    renderHttpConfigForm({
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'api_key',
      authConfig: {
        headerName: 'X-API-Key',
        apiKey: 'secret-api-key',
      },
    });

    const apiKeyInput = screen.getByLabelText('API Key Value');
    expect(apiKeyInput).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: 'Show value' }));
    expect(apiKeyInput).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: 'Hide value' }));
    expect(apiKeyInput).toHaveAttribute('type', 'password');
  });

  test('masks custom auth header values by default and allows revealing them', async () => {
    const user = userEvent.setup();

    renderHttpConfigForm({
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'custom',
      authConfig: {
        customHeaders: { Authorization: '{{secrets.API_KEY}}' },
      },
    });

    const headerValueInput = screen.getByDisplayValue('{{secrets.API_KEY}}');
    expect(headerValueInput).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: 'Show value' }));
    expect(headerValueInput).toHaveAttribute('type', 'text');
  });
});

// =============================================================================
// AUTH HEADER COLLISION VALIDATION TESTS
// =============================================================================

describe('validateHttpConfig - Auth Header Collision Detection', () => {
  test('detects collision between api_key headerName and general headers', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'api_key',
      authConfig: {
        headerName: 'X-API-Key',
        apiKey: 'sk_test_123',
      },
      headers: [{ key: 'X-API-Key', value: 'duplicate-value' }],
    };
    const errors = validateHttpConfig(config);
    expect(errors.headerCollision).toBeDefined();
    expect(errors.headerCollision).toContain('X-API-Key');
    expect(errors.headerCollision).toContain('API Key auth');
  });

  test('detects case-insensitive collision for api_key', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'api_key',
      authConfig: {
        headerName: 'X-Api-Key',
        apiKey: 'sk_test_123',
      },
      headers: [{ key: 'x-api-key', value: 'duplicate' }],
    };
    const errors = validateHttpConfig(config);
    expect(errors.headerCollision).toBeDefined();
  });

  test('detects collision between bearer auth and Authorization header', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'bearer',
      authConfig: {
        token: 'eyJhbGciOiJIUzI1NiJ9...',
      },
      headers: [{ key: 'Authorization', value: 'Bearer other-token' }],
    };
    const errors = validateHttpConfig(config);
    expect(errors.headerCollision).toBeDefined();
    expect(errors.headerCollision).toContain('Bearer auth');
  });

  test('detects case-insensitive collision for bearer + authorization', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'bearer',
      authConfig: { token: 'some-token' },
      headers: [{ key: 'authorization', value: 'Bearer x' }],
    };
    const errors = validateHttpConfig(config);
    expect(errors.headerCollision).toBeDefined();
  });

  test('detects collision between custom auth headers and general headers', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'custom',
      authConfig: {
        customHeaders: {
          'X-Custom-Auth': '{{secrets.AUTH_TOKEN}}',
          'X-Tenant-Id': 'tenant-123',
        },
      },
      headers: [{ key: 'X-Custom-Auth', value: 'manual-value' }],
    };
    const errors = validateHttpConfig(config);
    expect(errors.headerCollision).toBeDefined();
    expect(errors.headerCollision).toContain('x-custom-auth');
  });

  test('detects multiple custom auth header collisions', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'custom',
      authConfig: {
        customHeaders: {
          'X-Auth': 'val1',
          'X-Tenant': 'val2',
        },
      },
      headers: [
        { key: 'X-Auth', value: 'dup1' },
        { key: 'X-Tenant', value: 'dup2' },
      ],
    };
    const errors = validateHttpConfig(config);
    expect(errors.headerCollision).toBeDefined();
    expect(errors.headerCollision).toContain('x-auth');
    expect(errors.headerCollision).toContain('x-tenant');
  });

  test('no collision when api_key headerName differs from general headers', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'api_key',
      authConfig: {
        headerName: 'X-API-Key',
        apiKey: 'sk_test_123',
      },
      headers: [{ key: 'Content-Type', value: 'application/json' }],
    };
    const errors = validateHttpConfig(config);
    expect(errors.headerCollision).toBeUndefined();
  });

  test('no collision when bearer auth and no Authorization in general headers', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'bearer',
      authConfig: { token: 'some-token' },
      headers: [{ key: 'Content-Type', value: 'application/json' }],
    };
    const errors = validateHttpConfig(config);
    expect(errors.headerCollision).toBeUndefined();
  });

  test('no collision when custom auth headers do not overlap with general headers', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'custom',
      authConfig: {
        customHeaders: { 'X-Auth': 'secret' },
      },
      headers: [{ key: 'Accept', value: 'application/json' }],
    };
    const errors = validateHttpConfig(config);
    expect(errors.headerCollision).toBeUndefined();
  });

  test('no collision when authType is none regardless of headers', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      headers: [{ key: 'Authorization', value: 'Bearer xyz' }],
    };
    const errors = validateHttpConfig(config);
    expect(errors.headerCollision).toBeUndefined();
  });

  test('no collision check when headers array is empty', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'api_key',
      authConfig: {
        headerName: 'X-API-Key',
        apiKey: 'sk_test_123',
      },
      headers: [],
    };
    const errors = validateHttpConfig(config);
    expect(errors.headerCollision).toBeUndefined();
  });

  test('skips empty-key headers when checking collisions', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'api_key',
      authConfig: {
        headerName: 'X-API-Key',
        apiKey: 'sk_test_123',
      },
      headers: [{ key: '', value: 'some-value' }],
    };
    const errors = validateHttpConfig(config);
    expect(errors.headerCollision).toBeUndefined();
  });
});

// =============================================================================
// INPUT REFERENCE EXTRACTION TESTS
// =============================================================================

describe('extractInputReferences', () => {
  test('extracts references from endpoint', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com/{{input.userId}}/profile',
      method: 'GET',
      authType: 'none',
    };
    const refs = extractInputReferences(config);
    expect(refs).toContain('userId');
  });

  test('extracts references from body', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'none',
      body: '{"email": "{{input.email}}", "name": "{{input.name}}"}',
    };
    const refs = extractInputReferences(config);
    expect(refs).toContain('email');
    expect(refs).toContain('name');
  });

  test('extracts references from headers', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      headers: [{ key: 'X-User', value: '{{input.userId}}' }],
    };
    const refs = extractInputReferences(config);
    expect(refs).toContain('userId');
  });

  test('extracts references from query params', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      queryParams: [{ key: 'filter', value: '{{input.searchTerm}}' }],
    };
    const refs = extractInputReferences(config);
    expect(refs).toContain('searchTerm');
  });

  test('extracts references from authConfig scalar fields', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'api_key',
      authConfig: {
        headerName: 'X-Key',
        apiKey: '{{input.apiKeyParam}}',
      },
    };
    const refs = extractInputReferences(config);
    expect(refs).toContain('apiKeyParam');
  });

  test('extracts references from customHeaders values', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'custom',
      authConfig: {
        customHeaders: {
          'X-Token': '{{input.authToken}}',
          'X-Static': 'static-value',
        },
      },
    };
    const refs = extractInputReferences(config);
    expect(refs).toContain('authToken');
    expect(refs).not.toContain('static-value');
  });

  test('deduplicates references', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com/{{input.id}}',
      method: 'POST',
      authType: 'none',
      body: '{"id": "{{input.id}}"}',
    };
    const refs = extractInputReferences(config);
    expect(refs.filter((r) => r === 'id')).toHaveLength(1);
  });

  test('returns empty array when no references', () => {
    const config: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
    };
    const refs = extractInputReferences(config);
    expect(refs).toHaveLength(0);
  });
});

// =============================================================================
// CUSTOM AUTH HEADER FOCUS REGRESSION TESTS
// =============================================================================

describe('HttpConfigForm - custom auth header focus regression', () => {
  test('keeps the custom header name input focused while typing', async () => {
    const user = userEvent.setup();

    renderHttpConfigForm({
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'custom',
      authConfig: {
        customHeaders: { '': '{{secrets.API_KEY}}' },
      },
    });

    const headerNameInput = screen.getByPlaceholderText('Header name');
    await user.click(headerNameInput);
    expect(headerNameInput).toHaveFocus();

    await user.type(headerNameInput, 'X');

    expect(screen.getByDisplayValue('X')).toHaveFocus();
  });

  test('backwards-compatible: normalizes legacy JSON string customHeaders', async () => {
    const user = userEvent.setup();

    // Simulate legacy data where customHeaders was a JSON string
    renderHttpConfigForm({
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'custom',
      authConfig: {
        // Force legacy string through type assertion — simulates DB data
        customHeaders: JSON.stringify({ 'X-Legacy': 'legacy-value' }) as unknown as Record<
          string,
          string
        >,
      },
    });

    // The legacy JSON string should be normalized and rendered correctly
    expect(screen.getByDisplayValue('X-Legacy')).toBeInTheDocument();
    expect(screen.getByDisplayValue('legacy-value')).toBeInTheDocument();
  });
});

describe('HttpConfigForm - OAuth2 auth-profile precedence', () => {
  function renderHttpConfigForm(initialConfig: HttpConfig) {
    function Harness() {
      const [config, setConfig] = useState(initialConfig);
      return createElement(HttpConfigForm, {
        config,
        onChange: setConfig,
        showTemplates: false,
      });
    }

    return render(createElement(Harness));
  }

  test('hides inline OAuth2 client credentials fields when auth profile reference is configured', () => {
    renderHttpConfigForm({
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'oauth2_client',
      authProfileRef: 'billing_api_auth',
      authConfig: {
        clientId: 'client-123',
        clientSecret: 'secret-456',
        tokenUrl: 'https://auth.example.com/oauth/token',
      },
    });

    expect(screen.queryByLabelText('Client ID')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Client Secret')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Token URL')).not.toBeInTheDocument();
  });
});
