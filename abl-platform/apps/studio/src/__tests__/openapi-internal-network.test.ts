import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';

const { GET: getOpenApiHtml } = await import('../app/api/openapi/route');
const { GET: getOpenApiSpec } = await import('../app/api/openapi/spec.json/route');

const originalNodeEnv = process.env.NODE_ENV;
const originalInternalAccessHeaderName = process.env.STUDIO_INTERNAL_ACCESS_HEADER_NAME;
const originalInternalAccessToken = process.env.STUDIO_INTERNAL_ACCESS_TOKEN;

function makeRequest(url: string, headers: HeadersInit = {}): NextRequest {
  return new NextRequest(new URL(url), { headers });
}

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;

  if (originalInternalAccessHeaderName === undefined) {
    delete process.env.STUDIO_INTERNAL_ACCESS_HEADER_NAME;
  } else {
    process.env.STUDIO_INTERNAL_ACCESS_HEADER_NAME = originalInternalAccessHeaderName;
  }

  if (originalInternalAccessToken === undefined) {
    delete process.env.STUDIO_INTERNAL_ACCESS_TOKEN;
  } else {
    process.env.STUDIO_INTERNAL_ACCESS_TOKEN = originalInternalAccessToken;
  }
});

describe('OpenAPI internal-network access', () => {
  it('serves the HTML docs for localhost requests', async () => {
    const response = await getOpenApiHtml(makeRequest('http://localhost:3000/api/openapi'));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('SwaggerUIBundle');
  });

  it('blocks public requests to the HTML docs', async () => {
    const response = await getOpenApiHtml(
      makeRequest('https://studio.example.com/api/openapi', {
        host: 'studio.example.com',
        'x-forwarded-for': '203.0.113.10',
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Forbidden: internal network access required',
    });
  });

  it('serves the spec for localhost requests without proxy headers', async () => {
    const response = await getOpenApiSpec(
      makeRequest('http://localhost:3000/api/openapi/spec.json'),
    );

    expect(response.status).toBe(200);
  });

  it('allows production requests with a configured trusted ingress assertion', async () => {
    process.env.NODE_ENV = 'production';
    process.env.STUDIO_INTERNAL_ACCESS_TOKEN = 'studio-internal-secret';

    const response = await getOpenApiSpec(
      makeRequest('https://studio.example.com/api/openapi/spec.json', {
        host: 'studio.example.com',
        'x-abl-internal-access': 'studio-internal-secret',
        'x-forwarded-for': '203.0.113.10',
      }),
    );

    expect(response.status).toBe(200);
  });

  it('does not trust a marker header unless the expected ingress token is configured', async () => {
    process.env.NODE_ENV = 'production';

    const response = await getOpenApiSpec(
      makeRequest('https://studio.example.com/api/openapi/spec.json', {
        host: 'studio.example.com',
        'x-abl-internal-access': 'studio-internal-secret',
      }),
    );

    expect(response.status).toBe(403);
  });

  it('does not allow localhost host fallback in production', async () => {
    process.env.NODE_ENV = 'production';

    const response = await getOpenApiHtml(
      makeRequest('https://studio.example.com/api/openapi', {
        host: 'localhost:3000',
      }),
    );

    expect(response.status).toBe(403);
  });

  it('blocks spoofed private-network headers when Studio cannot verify the remote peer', async () => {
    const response = await getOpenApiSpec(
      makeRequest('https://studio.example.com/api/openapi/spec.json', {
        host: 'localhost:3000',
        'x-forwarded-for': '10.0.0.8',
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Forbidden: internal network access required',
    });
  });

  it('blocks public requests to the spec endpoint', async () => {
    const response = await getOpenApiSpec(
      makeRequest('https://studio.example.com/api/openapi/spec.json', {
        host: 'studio.example.com',
      }),
    );

    expect(response.status).toBe(403);
  });
});
