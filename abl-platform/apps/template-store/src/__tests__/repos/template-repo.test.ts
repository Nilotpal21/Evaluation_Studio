/**
 * Template Repository — Unit Tests
 *
 * Tests query construction, sorting, pagination, and category aggregation
 * against a real MongoDB instance via MongoMemoryServer.
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

// ─── Seed helper ─────────────────────────────────────────────────────────────

async function seedTemplate(overrides: Record<string, unknown> = {}) {
  const { Template } = await import('@agent-platform/database/models');
  const defaults = {
    slug: `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: 'Test Template',
    shortDescription: 'Short',
    longDescription: 'Long',
    type: 'agent',
    typeMetadata: null,
    detailSections: [],
    category: 'customer-service',
    subcategory: null,
    industries: [],
    tags: ['test'],
    complexity: 'starter',
    publisherId: 'pub-1',
    publisherTenantId: 'platform',
    publisherName: 'Test Publisher',
    publisherVerified: false,
    visibility: 'public',
    status: 'published',
    installCount: 0,
    activeInstallCount: 0,
    viewCount: 0,
    ratingAverage: 0,
    ratingCount: 0,
    featuredOrder: null,
    publishedAt: new Date(),
    media: [],
    prerequisites: {
      envVars: [],
      connectors: [],
      mcpServers: [],
      authProfiles: [],
      models: [],
    },
    reviewStatus: 'approved',
    demoConversation: [],
    iconUrl: null,
  };
  return Template.create({ ...defaults, ...overrides });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('findTemplates', () => {
  it('filters by type', async () => {
    const { findTemplates } = await import('../../repos/template-repo.js');

    await seedTemplate({ slug: 'agent-1', type: 'agent' });
    await seedTemplate({ slug: 'project-1', type: 'project' });

    const result = await findTemplates({ page: 1, limit: 20, sort: 'popular', type: 'agent' });
    expect(result.total).toBe(1);
    expect(result.templates[0].type).toBe('agent');
  });

  it('filters by category', async () => {
    const { findTemplates } = await import('../../repos/template-repo.js');

    await seedTemplate({ slug: 'cs-1', category: 'customer-service' });
    await seedTemplate({ slug: 'sales-1', category: 'sales' });

    const result = await findTemplates({
      page: 1,
      limit: 20,
      sort: 'popular',
      category: 'customer-service',
    });
    expect(result.total).toBe(1);
    expect(result.templates[0].category).toBe('customer-service');
  });

  it('filters by complexity', async () => {
    const { findTemplates } = await import('../../repos/template-repo.js');

    await seedTemplate({ slug: 'starter-1', complexity: 'starter' });
    await seedTemplate({ slug: 'advanced-1', complexity: 'advanced' });

    const result = await findTemplates({
      page: 1,
      limit: 20,
      sort: 'popular',
      complexity: 'advanced',
    });
    expect(result.total).toBe(1);
    expect(result.templates[0].complexity).toBe('advanced');
  });

  it('calculates pagination offset correctly', async () => {
    const { findTemplates } = await import('../../repos/template-repo.js');

    for (let i = 0; i < 15; i++) {
      await seedTemplate({ slug: `page-${i}`, installCount: 15 - i });
    }

    const page2 = await findTemplates({ page: 2, limit: 5, sort: 'popular' });
    expect(page2.templates).toHaveLength(5);
    expect(page2.total).toBe(15);
  });

  it('sorts by popular (installCount desc)', async () => {
    const { findTemplates } = await import('../../repos/template-repo.js');

    await seedTemplate({ slug: 'low', installCount: 1 });
    await seedTemplate({ slug: 'high', installCount: 100 });
    await seedTemplate({ slug: 'mid', installCount: 50 });

    const result = await findTemplates({ page: 1, limit: 20, sort: 'popular' });
    expect(result.templates[0].slug).toBe('high');
    expect(result.templates[1].slug).toBe('mid');
    expect(result.templates[2].slug).toBe('low');
  });

  it('sorts by newest (createdAt desc)', async () => {
    const { findTemplates } = await import('../../repos/template-repo.js');

    const old = new Date('2025-01-01');
    const recent = new Date('2026-01-01');
    await seedTemplate({ slug: 'old', createdAt: old });
    await seedTemplate({ slug: 'recent', createdAt: recent });

    const result = await findTemplates({ page: 1, limit: 20, sort: 'newest' });
    expect(result.templates[0].slug).toBe('recent');
  });

  it('enforces published+public base filter', async () => {
    const { findTemplates } = await import('../../repos/template-repo.js');

    await seedTemplate({ slug: 'visible', status: 'published', visibility: 'public' });
    await seedTemplate({ slug: 'draft', status: 'draft', visibility: 'public' });
    await seedTemplate({ slug: 'private', status: 'published', visibility: 'private' });

    const result = await findTemplates({ page: 1, limit: 20, sort: 'popular' });
    expect(result.total).toBe(1);
    expect(result.templates[0].slug).toBe('visible');
  });

  it('sorts by rating descending', async () => {
    const { findTemplates } = await import('../../repos/template-repo.js');
    await seedTemplate({ slug: 'low-rated', ratingAverage: 3.0 });
    await seedTemplate({ slug: 'high-rated', ratingAverage: 4.8 });

    const result = await findTemplates({ page: 1, limit: 20, sort: 'rating' });
    expect(result.templates[0].slug).toBe('high-rated');
  });

  it('sorts by updatedAt descending', async () => {
    const { findTemplates } = await import('../../repos/template-repo.js');
    const old = await seedTemplate({ slug: 'old-updated' });
    const recent = await seedTemplate({ slug: 'recent-updated' });

    // Manually update timestamps
    const { Template } = await import('@agent-platform/database/models');
    await Template.updateOne({ _id: old._id }, { $set: { updatedAt: new Date('2025-01-01') } });
    await Template.updateOne({ _id: recent._id }, { $set: { updatedAt: new Date('2026-04-01') } });

    const result = await findTemplates({ page: 1, limit: 20, sort: 'updated' });
    expect(result.templates[0].slug).toBe('recent-updated');
  });
});

describe('findTemplateBySlug', () => {
  it('returns template for valid slug', async () => {
    const { findTemplateBySlug } = await import('../../repos/template-repo.js');
    await seedTemplate({ slug: 'test-slug', name: 'Test Slug' });

    const result = await findTemplateBySlug('test-slug');
    expect(result).not.toBeNull();
    expect(result?.slug).toBe('test-slug');
  });

  it('returns null for non-published template', async () => {
    const { findTemplateBySlug } = await import('../../repos/template-repo.js');
    await seedTemplate({ slug: 'draft-slug', status: 'draft' });

    const result = await findTemplateBySlug('draft-slug');
    expect(result).toBeNull();
  });

  it('returns null for nonexistent slug', async () => {
    const { findTemplateBySlug } = await import('../../repos/template-repo.js');

    const result = await findTemplateBySlug('does-not-exist');
    expect(result).toBeNull();
  });
});

describe('findFeaturedTemplates', () => {
  it('returns featured templates sorted by featuredOrder', async () => {
    const { findFeaturedTemplates } = await import('../../repos/template-repo.js');

    await seedTemplate({ slug: 'feat-3', featuredOrder: 3 });
    await seedTemplate({ slug: 'feat-1', featuredOrder: 1 });
    await seedTemplate({ slug: 'feat-2', featuredOrder: 2 });
    await seedTemplate({ slug: 'not-featured', featuredOrder: null });

    const result = await findFeaturedTemplates();
    expect(result).toHaveLength(3);
    expect(result[0].slug).toBe('feat-1');
    expect(result[1].slug).toBe('feat-2');
    expect(result[2].slug).toBe('feat-3');
  });
});

describe('findCategories', () => {
  it('returns categories with correct counts', async () => {
    const { findCategories } = await import('../../repos/template-repo.js');

    await seedTemplate({ slug: 'cs-1', category: 'customer-service' });
    await seedTemplate({ slug: 'cs-2', category: 'customer-service' });
    await seedTemplate({ slug: 'sales-1', category: 'sales' });

    const result = await findCategories();
    expect(result).toHaveLength(2);
    // Sorted by count desc
    expect(result[0].name).toBe('customer-service');
    expect(result[0].count).toBe(2);
    expect(result[1].name).toBe('sales');
    expect(result[1].count).toBe(1);
  });
});

describe('incrementViewCount', () => {
  it('atomically increments view count', async () => {
    const { incrementViewCount } = await import('../../repos/template-repo.js');
    const { Template } = await import('@agent-platform/database/models');

    const template = await seedTemplate({ slug: 'inc-test', viewCount: 5 });

    await incrementViewCount(template._id);

    const updated = await Template.findOne({ _id: template._id }).lean();
    expect(updated).not.toBeNull();
    expect(updated?.viewCount).toBe(6);
  });
});

describe('findLatestPublishedVersion', () => {
  it('returns latest published version', async () => {
    const { findLatestPublishedVersion } = await import('../../repos/template-repo.js');
    const { TemplateVersion } = await import('@agent-platform/database/models');
    const template = await seedTemplate({ slug: 'ver-test', name: 'Version Test' });

    // Create two published versions
    await TemplateVersion.create({
      templateId: template._id,
      version: '1.0.0',
      changelog: 'Initial',
      manifest: {},
      customizationSchema: null,
      status: 'published',
      publishedAt: new Date('2026-01-01'),
      createdBy: 'seed-test',
      createdAt: new Date('2026-01-01'),
    });
    await TemplateVersion.create({
      templateId: template._id,
      version: '2.0.0',
      changelog: 'Update',
      manifest: {},
      customizationSchema: null,
      status: 'published',
      publishedAt: new Date('2026-02-01'),
      createdBy: 'seed-test',
      createdAt: new Date('2026-02-01'),
    });

    const result = await findLatestPublishedVersion(template._id);
    expect(result).not.toBeNull();
    expect(result?.version).toBe('2.0.0');
  });

  it('returns null when no published version exists', async () => {
    const { findLatestPublishedVersion } = await import('../../repos/template-repo.js');
    const { TemplateVersion } = await import('@agent-platform/database/models');
    const template = await seedTemplate({ slug: 'no-ver', name: 'No Version' });

    // Create a draft version only
    await TemplateVersion.create({
      templateId: template._id,
      version: '0.1.0',
      changelog: 'Draft',
      manifest: {},
      customizationSchema: null,
      status: 'draft',
      publishedAt: null,
      createdBy: 'seed-test',
    });

    const result = await findLatestPublishedVersion(template._id);
    expect(result).toBeNull();
  });

  it('skips draft versions', async () => {
    const { findLatestPublishedVersion } = await import('../../repos/template-repo.js');
    const { TemplateVersion } = await import('@agent-platform/database/models');
    const template = await seedTemplate({ slug: 'draft-skip', name: 'Draft Skip' });

    await TemplateVersion.create({
      templateId: template._id,
      version: '1.0.0',
      changelog: 'Published',
      manifest: {},
      customizationSchema: null,
      status: 'published',
      publishedAt: new Date('2026-01-01'),
      createdBy: 'seed-test',
      createdAt: new Date('2026-01-01'),
    });
    await TemplateVersion.create({
      templateId: template._id,
      version: '2.0.0-draft',
      changelog: 'Draft newer',
      manifest: {},
      customizationSchema: null,
      status: 'draft',
      publishedAt: null,
      createdBy: 'seed-test',
      createdAt: new Date('2026-03-01'),
    });

    const result = await findLatestPublishedVersion(template._id);
    expect(result).not.toBeNull();
    expect(result?.version).toBe('1.0.0');
  });

  it('result does NOT contain files field', async () => {
    const { findLatestPublishedVersion } = await import('../../repos/template-repo.js');
    const { TemplateVersion } = await import('@agent-platform/database/models');
    const template = await seedTemplate({ slug: 'files-excl', name: 'Files Exclusion' });

    await TemplateVersion.create({
      templateId: template._id,
      version: '1.0.0',
      changelog: 'With files',
      manifest: {},
      files: { 'agent.abl': 'AGENT Test\n  MODEL gpt-4o' },
      customizationSchema: null,
      status: 'published',
      publishedAt: new Date('2026-01-01'),
      createdBy: 'seed-test',
      createdAt: new Date('2026-01-01'),
    });

    const result = await findLatestPublishedVersion(template._id);
    expect(result).not.toBeNull();
    expect(result?.version).toBe('1.0.0');
    // files field should be excluded by the select('-files') projection
    expect(result).not.toHaveProperty('files');
  });
});

describe('findBundleBySlugAndVersion', () => {
  it('returns files for valid slug and version', async () => {
    const { findBundleBySlugAndVersion } = await import('../../repos/template-repo.js');
    const { TemplateVersion } = await import('@agent-platform/database/models');

    const files = { 'agent.abl': 'AGENT Test\n  MODEL gpt-4o', 'config.json': '{}' };
    const template = await seedTemplate({ slug: 'bundle-slug', name: 'Bundle Slug' });
    await TemplateVersion.create({
      templateId: template._id,
      version: '1.0.0',
      changelog: 'Initial',
      manifest: {},
      files,
      customizationSchema: null,
      status: 'published',
      publishedAt: new Date(),
      createdBy: 'seed-test',
    });

    const result = await findBundleBySlugAndVersion('bundle-slug', '1.0.0');
    expect(result).not.toBeNull();
    expect(result!.files).toEqual(files);
  });

  it('returns null for nonexistent slug', async () => {
    const { findBundleBySlugAndVersion } = await import('../../repos/template-repo.js');

    const result = await findBundleBySlugAndVersion('does-not-exist', '1.0.0');
    expect(result).toBeNull();
  });

  it('returns null for unpublished template (reviewStatus: pending)', async () => {
    const { findBundleBySlugAndVersion } = await import('../../repos/template-repo.js');
    const { TemplateVersion } = await import('@agent-platform/database/models');

    const template = await seedTemplate({
      slug: 'pending-bundle',
      name: 'Pending Bundle',
      reviewStatus: 'pending',
    });
    await TemplateVersion.create({
      templateId: template._id,
      version: '1.0.0',
      changelog: 'Initial',
      manifest: {},
      files: { 'agent.abl': 'AGENT Test' },
      customizationSchema: null,
      status: 'published',
      publishedAt: new Date(),
      createdBy: 'seed-test',
    });

    const result = await findBundleBySlugAndVersion('pending-bundle', '1.0.0');
    expect(result).toBeNull();
  });
});

describe('findCategories with type filter', () => {
  it('returns only agent categories when type is agent', async () => {
    const { findCategories } = await import('../../repos/template-repo.js');

    await seedTemplate({ slug: 'cat-agent-1', type: 'agent', category: 'customer-service' });
    await seedTemplate({ slug: 'cat-agent-2', type: 'agent', category: 'customer-service' });
    await seedTemplate({ slug: 'cat-project-1', type: 'project', category: 'sales' });

    const result = await findCategories('agent');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('customer-service');
    expect(result[0].count).toBe(2);
  });

  it('returns only project categories when type is project', async () => {
    const { findCategories } = await import('../../repos/template-repo.js');

    // Data from previous test is cleared by afterEach
    await seedTemplate({ slug: 'cat-proj-a', type: 'project', category: 'sales' });
    await seedTemplate({ slug: 'cat-proj-b', type: 'project', category: 'hr' });
    await seedTemplate({ slug: 'cat-agent-x', type: 'agent', category: 'customer-service' });

    const result = await findCategories('project');
    expect(result).toHaveLength(2);
    const names = result.map((c) => c.name);
    expect(names).toContain('sales');
    expect(names).toContain('hr');
  });
});
