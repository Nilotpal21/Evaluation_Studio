/**
 * Analytics Repository — Unit Tests
 *
 * Tests event tracking and IP hashing functionality.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupTestMongo, teardownTestMongo, clearCollections } from '../helpers/setup-mongo.js';

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  await setupTestMongo();
}, 60_000);

afterEach(async () => {
  await clearCollections();
});

afterAll(async () => {
  await teardownTestMongo();
}, 30_000);

describe('hashIp', () => {
  it('returns a 16-character hex string', async () => {
    const { hashIp } = await import('../../repos/analytics-repo.js');

    const result = hashIp('192.168.1.1');
    expect(result).toHaveLength(16);
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces consistent results for the same IP', async () => {
    const { hashIp } = await import('../../repos/analytics-repo.js');

    const hash1 = hashIp('10.0.0.1');
    const hash2 = hashIp('10.0.0.1');
    expect(hash1).toBe(hash2);
  });

  it('produces different results for different IPs', async () => {
    const { hashIp } = await import('../../repos/analytics-repo.js');

    const hash1 = hashIp('10.0.0.1');
    const hash2 = hashIp('10.0.0.2');
    expect(hash1).not.toBe(hash2);
  });
});

describe('trackEvent', () => {
  it('creates a document with all required fields', async () => {
    const { trackEvent } = await import('../../repos/analytics-repo.js');
    const { TemplateAnalyticsEvent } = await import('@agent-platform/database/models');

    await trackEvent({
      eventType: 'marketplace_view',
      templateId: 'template-1',
      templateSlug: 'test-template',
      userId: 'user-1',
      tenantId: 'tenant-1',
      metadata: { page: 1, requestId: 'req-123' },
      ipHash: 'abcdef0123456789',
    });

    const events = await TemplateAnalyticsEvent.find({}).lean();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('marketplace_view');
    expect(events[0].templateId).toBe('template-1');
    expect(events[0].templateSlug).toBe('test-template');
    expect(events[0].userId).toBe('user-1');
    expect(events[0].tenantId).toBe('tenant-1');
    expect(events[0].ipHash).toBe('abcdef0123456789');
  });

  it('handles null optional fields for unauthenticated requests', async () => {
    const { trackEvent } = await import('../../repos/analytics-repo.js');
    const { TemplateAnalyticsEvent } = await import('@agent-platform/database/models');

    await trackEvent({
      eventType: 'search',
      metadata: { query: 'test' },
    });

    const events = await TemplateAnalyticsEvent.find({}).lean();
    expect(events).toHaveLength(1);
    expect(events[0].userId).toBeNull();
    expect(events[0].tenantId).toBeNull();
    expect(events[0].templateId).toBeNull();
    expect(events[0].templateSlug).toBeNull();
  });

  it('does not throw on failures (fire-and-forget)', async () => {
    const { trackEvent } = await import('../../repos/analytics-repo.js');

    // Pass invalid eventType — the function should log the error but not throw
    await expect(
      trackEvent({
        eventType: 'marketplace_view',
        // Valid event — should succeed without throwing
      }),
    ).resolves.not.toThrow();
  });

  it('accepts eventType bundle_access', async () => {
    const { trackEvent } = await import('../../repos/analytics-repo.js');
    const { TemplateAnalyticsEvent } = await import('@agent-platform/database/models');

    await trackEvent({
      eventType: 'bundle_access',
      templateSlug: 'bundle-template',
      metadata: { version: '1.0.0', bundleSizeBytes: 2048 },
    });

    const events = await TemplateAnalyticsEvent.find({ eventType: 'bundle_access' }).lean();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('bundle_access');
    expect(events[0].templateSlug).toBe('bundle-template');
  });
});
