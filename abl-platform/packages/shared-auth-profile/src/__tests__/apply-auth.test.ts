import { afterEach, describe, expect, it } from 'vitest';

import { applyAuth } from '../apply-auth.js';

/** Shared base params — caller overrides authType, config, secrets. */
const base = {
  headers: { 'Content-Type': 'application/json' },
  queryParams: new URLSearchParams(),
};

const trackedFlags = [
  'AUTH_AZURE_AD_ENABLED',
  'AUTH_SIGV4_ENABLED',
  'AUTH_DIGEST_ENABLED',
  'AUTH_HAWK_ENABLED',
  'AUTH_SAML_ENABLED',
  'ENABLE_KERBEROS',
] as const;

const previousFlagValues = new Map<string, string | undefined>();

for (const flag of trackedFlags) {
  previousFlagValues.set(flag, process.env[flag]);
}

afterEach(() => {
  for (const flag of trackedFlags) {
    const previous = previousFlagValues.get(flag);
    if (previous === undefined) {
      delete process.env[flag];
    } else {
      process.env[flag] = previous;
    }
  }
});

describe('applyAuth dispatcher', () => {
  it('none — returns headers unchanged', async () => {
    const result = await applyAuth({ ...base, authType: 'none', config: {}, secrets: {} });
    expect(result.headers).toEqual(base.headers);
  });

  it('api_key — sets header with prefix', async () => {
    const result = await applyAuth({
      ...base,
      authType: 'api_key',
      config: { headerName: 'X-API-Key', prefix: 'Key ', placement: 'header' },
      secrets: { apiKey: 'sk-test-123' },
    });
    expect(result.headers['X-API-Key']).toBe('Key sk-test-123');
  });

  it('api_key — query placement sets query param', async () => {
    const result = await applyAuth({
      ...base,
      authType: 'api_key',
      config: { headerName: 'key', placement: 'query' },
      secrets: { apiKey: 'qk-test' },
    });
    expect(result.queryParams?.get('key')).toBe('qk-test');
  });

  it('bearer — sets Authorization header', async () => {
    const result = await applyAuth({
      ...base,
      authType: 'bearer',
      config: {},
      secrets: { token: 'tok-abc' },
    });
    expect(result.headers['Authorization']).toBe('Bearer tok-abc');
  });

  it('oauth2_token — sets Bearer from accessToken', async () => {
    const result = await applyAuth({
      ...base,
      authType: 'oauth2_token',
      config: {},
      secrets: { accessToken: 'at-xyz' },
    });
    expect(result.headers['Authorization']).toBe('Bearer at-xyz');
  });

  it('oauth2_client_credentials — sets Bearer from accessToken', async () => {
    const result = await applyAuth({
      ...base,
      authType: 'oauth2_client_credentials',
      config: {},
      secrets: { accessToken: 'cc-token' },
    });
    expect(result.headers['Authorization']).toBe('Bearer cc-token');
  });

  it('oauth2_app — no-op (layer 1, not directly applied)', async () => {
    const result = await applyAuth({
      ...base,
      authType: 'oauth2_app',
      config: {},
      secrets: {},
    });
    // oauth2_app is Layer 1 — should not modify headers or add credentials
    expect(result.headers['Authorization']).toBeUndefined();
  });

  it('mtls — sets tlsOptions with cert/key', async () => {
    const result = await applyAuth({
      ...base,
      authType: 'mtls',
      config: {},
      secrets: { clientCert: '-----BEGIN CERT-----', clientKey: '-----BEGIN KEY-----' },
    });
    expect(result.tlsOptions).toEqual({
      cert: '-----BEGIN CERT-----',
      key: '-----BEGIN KEY-----',
    });
  });

  it('mtls — includes optional CA cert when provided', async () => {
    const result = await applyAuth({
      ...base,
      authType: 'mtls',
      config: {},
      secrets: {
        clientCert: '-----BEGIN CERT-----',
        clientKey: '-----BEGIN KEY-----',
        caCert: '-----BEGIN CA-----',
      },
    });
    expect(result.tlsOptions).toEqual({
      cert: '-----BEGIN CERT-----',
      key: '-----BEGIN KEY-----',
      ca: '-----BEGIN CA-----',
    });
  });

  it('unknown authType — returns headers unchanged (default case)', async () => {
    const result = await applyAuth({
      ...base,
      authType: 'totally_unknown_type',
      config: {},
      secrets: {},
    });
    expect(result.headers).toEqual(base.headers);
  });

  it('preserves existing headers across all types', async () => {
    const result = await applyAuth({
      ...base,
      authType: 'bearer',
      config: {},
      secrets: { token: 'test' },
    });
    expect(result.headers['Content-Type']).toBe('application/json');
    expect(result.headers['Authorization']).toBe('Bearer test');
  });

  it('azure_ad flag off returns AUTH_PROTOCOL_DISABLED', async () => {
    process.env.AUTH_AZURE_AD_ENABLED = 'false';
    await expect(
      applyAuth({
        ...base,
        authType: 'azure_ad',
        config: {},
        secrets: {},
      }),
    ).rejects.toMatchObject({
      code: 'AUTH_PROTOCOL_DISABLED',
      statusCode: 503,
    });
  });

  it('aws_iam flag off returns AUTH_PROTOCOL_DISABLED', async () => {
    process.env.AUTH_SIGV4_ENABLED = 'false';
    await expect(
      applyAuth({
        ...base,
        authType: 'aws_iam',
        config: {},
        secrets: {},
      }),
    ).rejects.toMatchObject({
      code: 'AUTH_PROTOCOL_DISABLED',
      statusCode: 503,
    });
  });

  it('digest flag off returns AUTH_PROTOCOL_DISABLED', async () => {
    process.env.AUTH_DIGEST_ENABLED = 'false';
    await expect(
      applyAuth({
        ...base,
        authType: 'digest',
        config: { realm: 'test-realm' },
        secrets: { username: 'user', password: 'pass' },
      }),
    ).rejects.toMatchObject({
      code: 'AUTH_PROTOCOL_DISABLED',
      statusCode: 503,
    });
  });

  it('hawk flag off returns AUTH_PROTOCOL_DISABLED', async () => {
    process.env.AUTH_HAWK_ENABLED = 'false';
    await expect(
      applyAuth({
        ...base,
        authType: 'hawk',
        config: {},
        secrets: { id: 'hawk-id', key: 'hawk-secret' },
      }),
    ).rejects.toMatchObject({
      code: 'AUTH_PROTOCOL_DISABLED',
      statusCode: 503,
    });
  });

  it('saml flag off returns AUTH_PROTOCOL_DISABLED', async () => {
    process.env.AUTH_SAML_ENABLED = 'false';
    await expect(
      applyAuth({
        ...base,
        authType: 'saml',
        config: {},
        secrets: {},
      }),
    ).rejects.toMatchObject({
      code: 'AUTH_PROTOCOL_DISABLED',
      statusCode: 503,
    });
  });

  it('kerberos build flag off returns AUTH_KERBEROS_NOT_BUILT', async () => {
    process.env.ENABLE_KERBEROS = 'false';
    await expect(
      applyAuth({
        ...base,
        authType: 'kerberos',
        config: {},
        secrets: {},
      }),
    ).rejects.toMatchObject({
      code: 'AUTH_KERBEROS_NOT_BUILT',
      statusCode: 400,
    });
  });
});
