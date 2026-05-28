import { describe, expect, it } from 'vitest';
import {
  isBrowserSdkCorsRoute,
  resolveRuntimeCorsAllowedHeaders,
  resolveRuntimeCorsMethods,
  resolveRuntimeCorsOrigin,
} from '../lib/sdk-browser-cors.js';

const baseConfig = {
  env: 'production' as const,
  server: { frontendUrl: 'https://studio.example.com' },
  cors: {
    origins: ['http://localhost:5173'],
    methods: ['GET'],
    allowedHeaders: ['Authorization'],
  },
};

describe('sdk-browser-cors', () => {
  it('marks sdk bootstrap and refresh routes as browser SDK CORS routes', () => {
    expect(isBrowserSdkCorsRoute('/api/v1/sdk/init')).toBe(true);
    expect(isBrowserSdkCorsRoute('/api/v1/sdk/refresh')).toBe(true);
  });

  it('marks sdk attachment routes as browser SDK CORS routes', () => {
    expect(isBrowserSdkCorsRoute('/api/projects/proj-1/sessions/sess-1/attachments')).toBe(true);
    expect(
      isBrowserSdkCorsRoute('/api/projects/proj-1/sessions/sess-1/attachments/file-1/url'),
    ).toBe(true);
  });

  it('marks sdk session history routes as browser SDK CORS routes', () => {
    expect(isBrowserSdkCorsRoute('/api/projects/proj-1/sessions/sess-1/messages')).toBe(true);
  });

  it('does not mark unrelated routes as browser SDK CORS routes', () => {
    expect(isBrowserSdkCorsRoute('/api/projects/proj-1/sdk-channels')).toBe(false);
    expect(isBrowserSdkCorsRoute('/health')).toBe(false);
  });

  it('reflects browser origins for SDK client routes', () => {
    const origin = resolveRuntimeCorsOrigin(
      {
        path: '/api/v1/sdk/init',
        headers: { origin: 'https://customer.example.com' },
      },
      baseConfig,
    );

    expect(origin).toBe(true);
  });

  it('keeps Studio-origin CORS defaults for non-SDK routes', () => {
    const origin = resolveRuntimeCorsOrigin(
      {
        path: '/api/projects/proj-1/deployments',
        headers: { origin: 'https://customer.example.com' },
      },
      baseConfig,
    );

    expect(origin).toBe('https://studio.example.com');
  });

  it('preserves the default origin policy when no Origin header is present', () => {
    const origin = resolveRuntimeCorsOrigin(
      {
        path: '/api/v1/sdk/init',
        headers: {},
      },
      baseConfig,
    );

    expect(origin).toBe('https://studio.example.com');
  });

  it('falls back to configured CORS origins when production frontend URL is absent', () => {
    const origin = resolveRuntimeCorsOrigin(
      {
        path: '/api/projects/proj-1/deployments',
        headers: { origin: 'https://customer.example.com' },
      },
      {
        ...baseConfig,
        server: {},
      },
    );

    expect(origin).toEqual(['http://localhost:5173']);
  });

  it('adds browser SDK headers to SDK routes even when deployment headers are overridden', () => {
    const allowedHeaders = resolveRuntimeCorsAllowedHeaders(
      { path: '/api/v1/sdk/ws-ticket' },
      baseConfig,
    );

    expect(allowedHeaders).toEqual([
      'Authorization',
      'Content-Type',
      'X-SDK-Token',
      'X-Public-Key',
      'X-Tenant-Id',
      'X-Request-Id',
    ]);
  });

  it('keeps configured headers unchanged for non-SDK routes', () => {
    const allowedHeaders = resolveRuntimeCorsAllowedHeaders(
      { path: '/api/projects/proj-1/deployments' },
      baseConfig,
    );

    expect(allowedHeaders).toEqual(['Authorization']);
  });

  it('adds browser SDK preflight methods to SDK routes even when deployment methods are overridden', () => {
    const methods = resolveRuntimeCorsMethods({ path: '/api/v1/sdk/ws-ticket' }, baseConfig);

    expect(methods).toEqual(['GET', 'POST', 'OPTIONS']);
  });

  it('keeps configured methods unchanged for non-SDK routes', () => {
    const methods = resolveRuntimeCorsMethods(
      { path: '/api/projects/proj-1/deployments' },
      baseConfig,
    );

    expect(methods).toEqual(['GET']);
  });
});
