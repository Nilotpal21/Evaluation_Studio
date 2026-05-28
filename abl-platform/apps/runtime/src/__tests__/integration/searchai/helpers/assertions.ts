/**
 * Common Assertions for SearchAI E2E Tests
 */

import { expect } from 'vitest';

/**
 * Assert a search response has valid document results.
 */
export function expectSearchResults(response: any, minCount = 1): void {
  expect(response).toBeDefined();
  expect(response.results).toBeDefined();
  expect(Array.isArray(response.results)).toBe(true);
  expect(response.results.length).toBeGreaterThanOrEqual(minCount);

  for (const result of response.results) {
    expect(result.documentId).toBeDefined();
    expect(typeof result.score).toBe('number');
  }
}

/**
 * Assert a discovery manifest has the expected structure.
 */
export function expectDiscoveryManifest(manifest: any): void {
  expect(manifest).toBeDefined();
  expect(manifest.kb).toBeDefined();
  expect(manifest.kb.name).toBeDefined();
  expect(manifest.searchEndpoint).toBeDefined();
  expect(manifest.searchEndpoint.url).toBeDefined();
  expect(manifest.searchEndpoint.method).toBe('POST');
  expect(manifest.capabilities).toBeDefined();
  expect(manifest._meta).toBeDefined();
  expect(manifest._meta.ttlSeconds).toBe(300);
}

/**
 * Assert a capability section has skipWhen guidance.
 */
export function expectCapabilityGuidance(capability: any): void {
  expect(capability).toBeDefined();
  expect(typeof capability.available).toBe('boolean');
  expect(typeof capability.description).toBe('string');
  if (capability.skipWhen) {
    expect(typeof capability.skipWhen).toBe('string');
  }
}

/**
 * Assert aggregation results have valid structure.
 */
export function expectAggregationResults(response: any, minBuckets = 1): void {
  expect(response).toBeDefined();
  expect(response.aggregations || response.results).toBeDefined();
  const buckets = response.aggregations || response.results;
  expect(Array.isArray(buckets)).toBe(true);
  expect(buckets.length).toBeGreaterThanOrEqual(minBuckets);
}

/**
 * Make an HTTP request to the test server.
 */
export async function fetchJson(
  baseUrl: string,
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const body = await response.json();
  return { status: response.status, body };
}
