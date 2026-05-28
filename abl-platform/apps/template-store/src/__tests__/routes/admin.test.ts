/**
 * Admin Routes — Integration Tests
 *
 * Tests the admin template management API endpoints against a real Express server
 * with MongoMemoryServer. No mocking of codebase components.
 *
 * Covers bugs found during manual testing:
 *   Bug 7:  longDescription empty string → Mongoose validation failure
 *   Bug 8:  Upload defaulted to draft/pending → invisible in browse
 *   Bug 9:  Complexity enum mismatch (beginner/intermediate vs starter/standard/advanced)
 *   Bug 10: Category default 'other' doesn't exist → should be 'general'
 *
 * Also covers:
 *   - Template upload with valid files bundle
 *   - Auto-extraction of name and description from manifest
 *   - Publisher tenant isolation
 *   - Slug generation uniqueness
 *   - Admin list, update, and delete operations
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { setupTestMongo, teardownTestMongo, clearCollections } from '../helpers/setup-mongo.js';
import { requestIdMiddleware } from '@agent-platform/shared-observability';

// ─── Test Helpers ────────────────────────────────────────────────────────────

let baseUrl: string;
let server: http.Server;

/**
 * Test middleware that injects auth context (replaces requireAuth for testing).
 * This lets us test route handler logic without needing real JWT verification.
 */
function testAuth(tenantId: string = 'test-tenant', isSuperAdmin: boolean = false) {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as Record<string, unknown>).user = {
      id: 'test-user',
      email: 'test@example.com',
      name: 'Test User',
      tenantId,
    };
    (req as Record<string, unknown>).tenantContext = {
      tenantId: isSuperAdmin ? 'platform' : tenantId,
      userId: 'test-user',
      isSuperAdmin,
    };
    next();
  };
}

async function request(
  method: string,
  path: string,
  opts?: { headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...opts?.headers,
    },
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, headers: res.headers };
}

function closeServer(s: http.Server): Promise<void> {
  return new Promise((resolve) => {
    s.close(() => resolve());
  });
}

// ─── Valid Test Bundle ──────────────────────────────────────────────────────

/**
 * A minimal valid project bundle that passes readFolderV2 + validateAgentSyntax.
 * Uses the colon format required by the import pipeline.
 */
function createValidBundle(
  agentName: string = 'test-agent',
  overrides?: { manifest?: Record<string, unknown> },
) {
  const manifest = {
    format_version: '2.0',
    name: overrides?.manifest?.name ?? `Test Project ${agentName}`,
    description: overrides?.manifest?.description ?? `A test project with agent ${agentName}`,
    entry_agent: agentName,
    agents: {
      [agentName]: {
        path: `agents/${agentName}.agent.abl`,
        description: `Test agent ${agentName}`,
      },
    },
    metadata: {
      entity_counts: { agents: 1 },
    },
    ...overrides?.manifest,
  };

  const files: Record<string, string> = {
    'project.json': JSON.stringify(manifest),
    [`agents/${agentName}.agent.abl`]: `AGENT: ${agentName}\n  MODEL gpt-4o\n  GOAL\n    Handle test requests`,
  };

  return { files, manifest };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Set environment before any imports that read config
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret-for-integration-tests';
  process.env.RATE_LIMIT_MAX_REQUESTS = '10000';
  process.env.RATE_LIMIT_WINDOW_MS = '60000';

  await setupTestMongo();

  // Import models BEFORE syncIndexes so text index gets created
  await import('@agent-platform/database/models');
  const mongoose = await import('mongoose');
  await mongoose.default.connection.syncIndexes();

  // Import routes AFTER mongoose is connected (lazy model imports)
  const { default: adminRouter } = await import('../../routes/admin.js');

  // Build Express app with testAuth instead of requireAuth
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(requestIdMiddleware());
  app.use('/api/v1/admin', testAuth('test-tenant', false), adminRouter);
  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
  });

  server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  await closeServer(server);
  await teardownTestMongo();
}, 30_000);

afterEach(async () => {
  await clearCollections();
});

// ─── POST /templates/upload ──────────────────────────────────────────────────

describe('POST /templates/upload', () => {
  it('creates template with valid files bundle', async () => {
    const { files } = createValidBundle('my-agent');

    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files },
    });

    expect(res.status).toBe(201);
    const body = res.body as {
      success: boolean;
      data: {
        template: { slug: string; name: string; status: string };
        version: { version: string };
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.template.slug).toBeTruthy();
    expect(body.data.version.version).toBe('1.0.0');
  });

  it('auto-extracts name and description from manifest', async () => {
    const { files } = createValidBundle('auto-extract', {
      manifest: {
        name: 'My Custom Template Name',
        description: 'This is a custom description from the manifest',
      },
    });

    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files },
    });

    expect(res.status).toBe(201);
    const body = res.body as {
      success: boolean;
      data: {
        template: { name: string; shortDescription: string };
      };
    };
    expect(body.success).toBe(true);
    // Name is auto-extracted from manifest when not in metadata
    expect(body.data.template.name).toBe('My Custom Template Name');
    // Description falls back to manifest description
    expect(body.data.template.shortDescription).toBe(
      'This is a custom description from the manifest',
    );
  });

  // Bug 7: longDescription empty string → Mongoose validation failure
  it('defaults longDescription to shortDescription when not provided (Bug 7)', async () => {
    const { files } = createValidBundle('long-desc-test', {
      manifest: {
        name: 'Long Desc Test',
        description: 'Short description from manifest',
      },
    });

    // Upload without longDescription in metadata
    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files, metadata: { name: 'Long Desc Test' } },
    });

    expect(res.status).toBe(201);
    const body = res.body as {
      success: boolean;
      data: {
        template: { longDescription: string; shortDescription: string };
      };
    };
    expect(body.success).toBe(true);
    // longDescription should not be empty — falls back to shortDescription
    expect(body.data.template.longDescription).toBeTruthy();
    expect(body.data.template.longDescription.length).toBeGreaterThan(0);
  });

  it('handles explicit empty longDescription gracefully (Bug 7 regression)', async () => {
    const { files } = createValidBundle('empty-long-desc');

    // Explicitly pass empty longDescription
    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files, metadata: { longDescription: '' } },
    });

    // Should succeed — the route handler falls back to shortDescription
    expect(res.status).toBe(201);
    const body = res.body as {
      success: boolean;
      data: {
        template: { longDescription: string };
      };
    };
    expect(body.success).toBe(true);
    // longDescription should NOT be empty string
    expect(body.data.template.longDescription).toBeTruthy();
    expect(body.data.template.longDescription.length).toBeGreaterThan(0);
  });

  // Bug 8: Upload defaulted to draft/pending → invisible in browse
  it('sets status to published and reviewStatus to approved (Bug 8)', async () => {
    const { files } = createValidBundle('status-test');

    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files },
    });

    expect(res.status).toBe(201);
    const body = res.body as {
      success: boolean;
      data: {
        template: { status: string; reviewStatus: string };
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.template.status).toBe('published');
    expect(body.data.template.reviewStatus).toBe('approved');
  });

  it('sets publisherTenantId from auth context', async () => {
    const { files } = createValidBundle('publisher-test');

    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files },
    });

    expect(res.status).toBe(201);
    const body = res.body as {
      success: boolean;
      data: {
        template: { publisherTenantId: string };
      };
    };
    expect(body.success).toBe(true);
    // testAuth sets tenantId = 'test-tenant' with isSuperAdmin = false
    expect(body.data.template.publisherTenantId).toBe('test-tenant');
  });

  it('returns 400 for empty files bundle', async () => {
    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files: {} },
    });

    expect(res.status).toBe(400);
    const body = res.body as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
  });

  it('succeeds without project.json (metadata extracted from defaults)', async () => {
    // readFolderV2 does NOT require project.json — it's optional for v1 bundles.
    // The upload route gracefully handles missing manifest by using defaults.
    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: {
        files: {
          'agents/test.agent.abl': 'AGENT: test\n  MODEL gpt-4o\n  GOAL\n    Test',
        },
      },
    });

    expect(res.status).toBe(201);
    const body = res.body as {
      success: boolean;
      data: { template: { name: string } };
    };
    expect(body.success).toBe(true);
    // Without manifest, falls back to 'Untitled Template'
    expect(body.data.template.name).toBe('Untitled Template');
  });

  it('returns 400 for invalid ABL syntax in agent files', async () => {
    const files: Record<string, string> = {
      'project.json': JSON.stringify({
        format_version: '2.0',
        name: 'Bad Syntax',
        entry_agent: 'bad',
        agents: { bad: { path: 'agents/bad.agent.abl' } },
      }),
      // Bad syntax: missing colon after AGENT, missing MODEL etc
      'agents/bad.agent.abl': 'THIS IS NOT VALID ABL CONTENT\nNO AGENT HEADER',
    };

    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files },
    });

    expect(res.status).toBe(400);
    const body = res.body as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SYNTAX_ERROR');
  });

  // Bug 9: Complexity enum mismatch
  it('validates complexity enum — accepts starter/standard/advanced (Bug 9)', async () => {
    for (const complexity of ['starter', 'standard', 'advanced'] as const) {
      const { files } = createValidBundle(`complexity-${complexity}`);

      const res = await request('POST', '/api/v1/admin/templates/upload', {
        body: { files, metadata: { complexity } },
      });

      expect(res.status).toBe(201);
      const body = res.body as {
        success: boolean;
        data: { template: { complexity: string } };
      };
      expect(body.success).toBe(true);
      expect(body.data.template.complexity).toBe(complexity);
    }
  });

  it('rejects invalid complexity values like beginner/intermediate (Bug 9)', async () => {
    const { files } = createValidBundle('bad-complexity');

    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files, metadata: { complexity: 'beginner' } },
    });

    expect(res.status).toBe(400);
    const body = res.body as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects intermediate complexity value (Bug 9)', async () => {
    const { files } = createValidBundle('bad-complexity-2');

    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files, metadata: { complexity: 'intermediate' } },
    });

    expect(res.status).toBe(400);
    const body = res.body as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  // Bug 10: Category default 'other' doesn't exist
  it('defaults category to general when not provided (Bug 10)', async () => {
    const { files } = createValidBundle('default-category');

    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files },
    });

    expect(res.status).toBe(201);
    const body = res.body as {
      success: boolean;
      data: { template: { category: string } };
    };
    expect(body.success).toBe(true);
    expect(body.data.template.category).toBe('general');
  });

  it('generates unique slug from template name', async () => {
    const { files: files1 } = createValidBundle('slug-unique-a');
    const { files: files2 } = createValidBundle('slug-unique-b', {
      manifest: { name: 'Test Project slug-unique-a' }, // same name to force collision
    });

    // First upload
    const res1 = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files: files1 },
    });
    expect(res1.status).toBe(201);
    const body1 = res1.body as { data: { template: { slug: string } } };
    const slug1 = body1.data.template.slug;

    // Second upload with same name — should generate unique slug
    const res2 = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files: files2 },
    });
    expect(res2.status).toBe(201);
    const body2 = res2.body as { data: { template: { slug: string } } };
    const slug2 = body2.data.template.slug;

    // Both should have valid slugs but they must be different
    expect(slug1).toBeTruthy();
    expect(slug2).toBeTruthy();
    expect(slug1).not.toBe(slug2);
  });

  it('metadata name overrides manifest name', async () => {
    const { files } = createValidBundle('meta-override', {
      manifest: { name: 'Manifest Name' },
    });

    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files, metadata: { name: 'Metadata Name' } },
    });

    expect(res.status).toBe(201);
    const body = res.body as {
      success: boolean;
      data: { template: { name: string } };
    };
    expect(body.data.template.name).toBe('Metadata Name');
  });

  it('returns extracted agents/tools/envVars from manifest', async () => {
    const { files } = createValidBundle('extraction-test');

    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files },
    });

    expect(res.status).toBe(201);
    const body = res.body as {
      success: boolean;
      data: {
        extracted: {
          agents: Array<{ name: string }>;
          tools: string[];
          envVars: string[];
          entryAgent: string | undefined;
        };
      };
    };
    expect(body.data.extracted.agents).toHaveLength(1);
    expect(body.data.extracted.agents[0].name).toBe('extraction-test');
    expect(body.data.extracted.entryAgent).toBe('extraction-test');
  });
});

// ─── GET /templates ──────────────────────────────────────────────────────────

describe('GET /templates (admin list)', () => {
  it('returns templates scoped to publisherTenantId', async () => {
    // Upload two templates (they'll be under test-tenant)
    const { files: f1 } = createValidBundle('list-a');
    const { files: f2 } = createValidBundle('list-b');
    await request('POST', '/api/v1/admin/templates/upload', { body: { files: f1 } });
    await request('POST', '/api/v1/admin/templates/upload', { body: { files: f2 } });

    const res = await request('GET', '/api/v1/admin/templates');
    expect(res.status).toBe(200);
    const body = res.body as {
      success: boolean;
      data: { templates: unknown[]; total: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(2);
    expect(body.data.templates).toHaveLength(2);
  });

  it('returns empty list for tenant with no templates', async () => {
    // Don't upload anything — tenant has no templates
    const res = await request('GET', '/api/v1/admin/templates');
    expect(res.status).toBe(200);
    const body = res.body as {
      success: boolean;
      data: { templates: unknown[]; total: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(0);
    expect(body.data.templates).toHaveLength(0);
  });

  it('supports pagination', async () => {
    // Upload 5 templates
    for (let i = 0; i < 5; i++) {
      const { files } = createValidBundle(`paginate-${i}`);
      await request('POST', '/api/v1/admin/templates/upload', { body: { files } });
    }

    const res = await request('GET', '/api/v1/admin/templates?page=1&limit=2');
    expect(res.status).toBe(200);
    const body = res.body as {
      success: boolean;
      data: { templates: unknown[]; total: number; page: number; limit: number; hasMore: boolean };
    };
    expect(body.data.templates).toHaveLength(2);
    expect(body.data.total).toBe(5);
    expect(body.data.page).toBe(1);
    expect(body.data.limit).toBe(2);
    expect(body.data.hasMore).toBe(true);
  });

  it('supports status filter', async () => {
    // Upload a template (will be 'published')
    const { files } = createValidBundle('filter-status');
    const uploadRes = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files },
    });
    const templateId = (uploadRes.body as { data: { template: { _id: string } } }).data.template
      ._id;

    // Archive it
    await request('DELETE', `/api/v1/admin/templates/${templateId}`);

    // Filter by 'archived'
    const res = await request('GET', '/api/v1/admin/templates?status=archived');
    expect(res.status).toBe(200);
    const body = res.body as {
      success: boolean;
      data: { templates: Array<{ status: string }>; total: number };
    };
    expect(body.data.total).toBe(1);
    expect(body.data.templates[0].status).toBe('archived');

    // Filter by 'published' — should be empty since we archived it
    const res2 = await request('GET', '/api/v1/admin/templates?status=published');
    const body2 = res2.body as { data: { total: number } };
    expect(body2.data.total).toBe(0);
  });
});

// ─── GET /templates/:id ──────────────────────────────────────────────────────

describe('GET /templates/:id (admin detail)', () => {
  it('returns template detail by ID', async () => {
    const { files } = createValidBundle('detail-test', {
      manifest: { name: 'Detail Test Template' },
    });
    const uploadRes = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files },
    });
    const templateId = (uploadRes.body as { data: { template: { _id: string } } }).data.template
      ._id;

    const res = await request('GET', `/api/v1/admin/templates/${templateId}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      success: boolean;
      data: { template: { _id: string; name: string; category: string } };
    };
    expect(body.success).toBe(true);
    expect(body.data.template._id).toBe(templateId);
    expect(body.data.template.name).toBe('Detail Test Template');
  });

  it('returns 404 for nonexistent template', async () => {
    const res = await request('GET', '/api/v1/admin/templates/nonexistent-id-12345');
    expect(res.status).toBe(404);
    const body = res.body as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for template owned by different tenant', async () => {
    const { files } = createValidBundle('cross-tenant-detail');
    const uploadRes = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files },
    });
    const templateId = (uploadRes.body as { data: { template: { _id: string } } }).data.template
      ._id;

    const { Template } = await import('@agent-platform/database/models');
    await Template.updateOne({ _id: templateId }, { $set: { publisherTenantId: 'other-tenant' } });

    const res = await request('GET', `/api/v1/admin/templates/${templateId}`);
    expect(res.status).toBe(404);
  });
});

// ─── PATCH /templates/:id ────────────────────────────────────────────────────

describe('PATCH /templates/:id', () => {
  it('updates template metadata', async () => {
    const { files } = createValidBundle('patch-test');
    const uploadRes = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files },
    });
    const templateId = (uploadRes.body as { data: { template: { _id: string } } }).data.template
      ._id;

    const res = await request('PATCH', `/api/v1/admin/templates/${templateId}`, {
      body: {
        name: 'Updated Name',
        shortDescription: 'Updated description',
        category: 'sales',
        tags: ['updated', 'test'],
      },
    });

    expect(res.status).toBe(200);
    const body = res.body as {
      success: boolean;
      data: {
        template: {
          name: string;
          shortDescription: string;
          category: string;
          tags: string[];
        };
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.template.name).toBe('Updated Name');
    expect(body.data.template.shortDescription).toBe('Updated description');
    expect(body.data.template.category).toBe('sales');
    expect(body.data.template.tags).toEqual(['updated', 'test']);
  });

  it('returns 404 for nonexistent template', async () => {
    const res = await request('PATCH', '/api/v1/admin/templates/nonexistent-id-12345', {
      body: { name: 'Updated' },
    });

    expect(res.status).toBe(404);
    const body = res.body as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for template owned by different tenant', async () => {
    // Upload a template under 'test-tenant'
    const { files } = createValidBundle('cross-tenant-patch');
    const uploadRes = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files },
    });
    const templateId = (uploadRes.body as { data: { template: { _id: string } } }).data.template
      ._id;

    // Now manually change the publisherTenantId to a different tenant
    const { Template } = await import('@agent-platform/database/models');
    await Template.updateOne({ _id: templateId }, { $set: { publisherTenantId: 'other-tenant' } });

    // Try to patch — should fail because testAuth is for 'test-tenant'
    const res = await request('PATCH', `/api/v1/admin/templates/${templateId}`, {
      body: { name: 'Should Fail' },
    });

    expect(res.status).toBe(404);
    const body = res.body as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

// ─── DELETE /templates/:id ───────────────────────────────────────────────────

describe('DELETE /templates/:id', () => {
  it('archives template (sets status to archived)', async () => {
    const { files } = createValidBundle('delete-test');
    const uploadRes = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files },
    });
    const templateId = (uploadRes.body as { data: { template: { _id: string } } }).data.template
      ._id;

    const res = await request('DELETE', `/api/v1/admin/templates/${templateId}`);
    expect(res.status).toBe(200);
    const body = res.body as { success: boolean; data: { archived: boolean } };
    expect(body.success).toBe(true);
    expect(body.data.archived).toBe(true);

    // Verify the template is now archived
    const listRes = await request('GET', '/api/v1/admin/templates?status=archived');
    const listBody = listRes.body as {
      data: { templates: Array<{ _id: string; status: string }> };
    };
    const archived = listBody.data.templates.find((t) => t._id === templateId);
    expect(archived).toBeDefined();
    expect(archived?.status).toBe('archived');
  });

  it('returns 404 for nonexistent template', async () => {
    const res = await request('DELETE', '/api/v1/admin/templates/nonexistent-id-12345');
    expect(res.status).toBe(404);
    const body = res.body as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

// ─── Bug 8 verification: uploaded template appears in marketplace browse ─────

describe('Bug 8 verification: uploaded template visible in browse', () => {
  let marketplaceBaseUrl: string;
  let marketplaceServer: http.Server;

  beforeAll(async () => {
    // Stand up a separate Express app with marketplace routes to verify browse
    const { default: marketplaceRouter } = await import('../../routes/marketplace.js');
    const { default: adminRouter } = await import('../../routes/admin.js');

    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '10mb' }));
    app.use(requestIdMiddleware());
    app.use('/api/v1/marketplace', marketplaceRouter);
    app.use('/api/v1/admin', testAuth('test-tenant', false), adminRouter);

    marketplaceServer = http.createServer(app);
    await new Promise<void>((resolve) => {
      marketplaceServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = marketplaceServer.address() as AddressInfo;
    marketplaceBaseUrl = `http://127.0.0.1:${addr.port}`;
  }, 30_000);

  afterAll(async () => {
    await closeServer(marketplaceServer);
  });

  async function mpRequest(
    method: string,
    path: string,
    opts?: { body?: unknown },
  ): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${marketplaceBaseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  it('uploaded template immediately appears in browse results with status=published', async () => {
    const { files } = createValidBundle('browse-visible');

    // Upload via admin
    const uploadRes = await mpRequest('POST', '/api/v1/admin/templates/upload', {
      body: { files },
    });
    expect(uploadRes.status).toBe(201);
    const slug = (uploadRes.body as { data: { template: { slug: string } } }).data.template.slug;

    // Browse marketplace with tenantId to include tenant-scoped templates
    const browseRes = await mpRequest('GET', `/api/v1/marketplace/templates?tenantId=test-tenant`);
    expect(browseRes.status).toBe(200);
    const browseBody = browseRes.body as {
      data: { templates: Array<{ slug: string; status: string; reviewStatus: string }> };
    };

    const found = browseBody.data.templates.find((t) => t.slug === slug);
    expect(found).toBeDefined();
    expect(found?.status).toBe('published');
  });
});

// ─── Super-admin publisher context ───────────────────────────────────────────

describe('Super-admin uploads publish to platform scope', () => {
  let superAdminBaseUrl: string;
  let superAdminServer: http.Server;

  beforeAll(async () => {
    const { default: adminRouter } = await import('../../routes/admin.js');

    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '10mb' }));
    app.use(requestIdMiddleware());
    // Super admin auth
    app.use('/api/v1/admin', testAuth('platform', true), adminRouter);

    superAdminServer = http.createServer(app);
    await new Promise<void>((resolve) => {
      superAdminServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = superAdminServer.address() as AddressInfo;
    superAdminBaseUrl = `http://127.0.0.1:${addr.port}`;
  }, 30_000);

  afterAll(async () => {
    await closeServer(superAdminServer);
  });

  it('super-admin upload sets publisherTenantId to platform', async () => {
    const { files } = createValidBundle('super-admin-upload');

    const res = await fetch(`${superAdminBaseUrl}/api/v1/admin/templates/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    });
    const body = (await res.json()) as {
      success: boolean;
      data: { template: { publisherTenantId: string } };
    };

    expect(res.status).toBe(201);
    expect(body.data.template.publisherTenantId).toBe('platform');
  });
});

// ─── Upload validation: empty string coercion & Zod error details ───────────

describe('POST /templates/upload — validation edge cases', () => {
  it('accepts empty-string category by coercing to undefined (defaults to general)', async () => {
    const { files } = createValidBundle('empty-category');

    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files, metadata: { category: '' } },
    });

    expect(res.status).toBe(201);
    const body = res.body as {
      success: boolean;
      data: { template: { category: string } };
    };
    expect(body.success).toBe(true);
    // Empty string coerced to undefined → falls back to 'general'
    expect(body.data.template.category).toBe('general');
  });

  it('accepts empty-string name by coercing to undefined (falls back to manifest name)', async () => {
    const { files } = createValidBundle('empty-name', {
      manifest: { name: 'Manifest Fallback Name' },
    });

    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files, metadata: { name: '' } },
    });

    expect(res.status).toBe(201);
    const body = res.body as {
      success: boolean;
      data: { template: { name: string } };
    };
    expect(body.success).toBe(true);
    expect(body.data.template.name).toBe('Manifest Fallback Name');
  });

  it('accepts empty-string complexity by coercing to undefined (defaults to standard)', async () => {
    const { files } = createValidBundle('empty-complexity');

    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files, metadata: { complexity: '' } },
    });

    expect(res.status).toBe(201);
    const body = res.body as {
      success: boolean;
      data: { template: { complexity: string } };
    };
    expect(body.success).toBe(true);
    expect(body.data.template.complexity).toBe('standard');
  });

  it('accepts empty-string type by coercing to undefined (auto-detects from files)', async () => {
    const { files } = createValidBundle('empty-type');

    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files, metadata: { type: '' } },
    });

    expect(res.status).toBe(201);
    const body = res.body as {
      success: boolean;
      data: { template: { type: string } };
    };
    expect(body.success).toBe(true);
    // Type auto-detected from bundle contents (single agent → 'agent')
    expect(['agent', 'project']).toContain(body.data.template.type);
  });

  it('returns Zod validation details when metadata fields are invalid', async () => {
    const { files } = createValidBundle('bad-validation');

    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files, metadata: { complexity: 'beginner' } },
    });

    expect(res.status).toBe(400);
    const body = res.body as {
      success: boolean;
      error: {
        code: string;
        message: string;
        details?: Array<{ path: string[]; message: string }>;
      };
    };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    // Zod details should now be included
    expect(body.error.details).toBeDefined();
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.details!.length).toBeGreaterThan(0);
  });

  it('accepts whitespace-only strings by coercing to undefined', async () => {
    const { files } = createValidBundle('whitespace-fields');

    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { files, metadata: { name: '   ', shortDescription: '  ', category: '  ' } },
    });

    expect(res.status).toBe(201);
    const body = res.body as {
      success: boolean;
      data: { template: { name: string; category: string } };
    };
    expect(body.success).toBe(true);
    // All whitespace-only fields coerced to undefined → fall back to defaults
    expect(body.data.template.category).toBe('general');
  });

  it('accepts metadata with all empty strings (full form with no user input)', async () => {
    const { files } = createValidBundle('all-empty-metadata', {
      manifest: { name: 'From Manifest' },
    });

    // Simulates the admin UI sending the form with no user-filled fields
    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: {
        files,
        metadata: {
          name: '',
          shortDescription: '',
          longDescription: '',
          category: '',
          tags: [],
          complexity: '',
          type: '',
        },
      },
    });

    expect(res.status).toBe(201);
    const body = res.body as {
      success: boolean;
      data: { template: { name: string; category: string; complexity: string } };
    };
    expect(body.success).toBe(true);
    expect(body.data.template.name).toBe('From Manifest');
    expect(body.data.template.category).toBe('general');
    expect(body.data.template.complexity).toBe('standard');
  });

  it('rejects completely invalid body (no files field)', async () => {
    const res = await request('POST', '/api/v1/admin/templates/upload', {
      body: { metadata: { name: 'No Files' } },
    });

    expect(res.status).toBe(400);
    const body = res.body as {
      success: boolean;
      error: { code: string; details?: unknown[] };
    };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toBeDefined();
  });
});
