/**
 * Connector Discovery-to-Sync E2E Test (E2E-5)
 *
 * Tests the complete enterprise connector lifecycle via real HTTP API:
 *   1. Create connector (POST)
 *   2. Seed OAuth token (DB — OAuth flow is tested separately in E2E-4)
 *   3. Trigger discovery (POST) — assert discovery record + job queued
 *   4. Simulate discovery completion (DB update — worker tested separately)
 *   5. Get discovery results (GET) — assert resources present
 *   6. Generate recommendations (POST)
 *   7. Accept recommendation (POST)
 *   8. Cross-tenant isolation: wrong tenantId → 404
 *
 * Infrastructure:
 * - Real dual-connection MongoDB via MongoMemoryServer
 * - Real Express app with actual route handlers
 * - DI-injected fake queue factory (no vi.mock)
 * - No vi.mock() or jest.mock() anywhere
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { setupTestMongo, teardownTestMongo, clearCollections } from '../helpers/setup-mongo.js';
import { setQueueFactory, resetQueueFactory } from '../../workers/shared.js';
import { getLazyModel } from '../../db/index.js';
import type {
  IConnectorConfig,
  IConnectorDiscovery,
  ISearchIndex,
  ISearchSource,
  IEndUserOAuthToken,
} from '@agent-platform/database/models';

// ─── Constants ────────────────────────────────────────────────────────────

const TENANT_A = 'tenant-e2e-discovery-a';
const TENANT_B = 'tenant-e2e-discovery-b';
const USER_ID = 'user-e2e-discovery-1';
const PROJECT_ID = 'project-e2e-discovery-1';

// ─── Fake Queue Factory ──────────────────────────────────────────────────

interface CapturedJob {
  name: string;
  data: Record<string, unknown>;
  opts: Record<string, unknown>;
}

/** Jobs captured by the fake queue factory. */
const capturedJobs: CapturedJob[] = [];

/**
 * Creates a fake BullMQ Queue that captures add() calls without Redis.
 * Returns a minimal object that satisfies the Queue interface usage in routes.
 */
function createFakeQueue(queueName: string) {
  let jobCounter = 0;
  return {
    name: queueName,
    add: async (jobName: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => {
      jobCounter++;
      const jobId = opts?.jobId ?? `fake-${queueName}-${jobCounter}`;
      capturedJobs.push({ name: jobName, data, opts: opts ?? {} });
      return { id: jobId, name: jobName, data };
    },
    close: async () => {},
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ─── Auth Middleware (test harness — NOT vi.mock) ─────────────────────────

/**
 * Injects tenantContext for the given tenantId.
 * Auth is tested in E2E-4; here we just need authenticated requests.
 */
function createTestAuthMiddleware(tenantId: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as any).tenantContext = {
      tenantId,
      userId: USER_ID,
      identityTier: 'user' as const,
      verificationMethod: 'jwt' as const,
      callerContext: {
        channel: 'api',
        customerId: null,
        anonymousId: null,
        initiatedById: USER_ID,
      },
      projectId: PROJECT_ID,
      permissions: [
        'index:read',
        'index:write',
        'source:read',
        'source:write',
        'document:read',
        'document:write',
      ],
    };
    next();
  };
}

// ─── Express App Factory ─────────────────────────────────────────────────

async function createTestApp(tenantId: string) {
  // Import the real routers (these use getLazyModel which is now bound to test DB)
  const { default: connectorDiscoveryRouter } = await import('../../routes/connector-discovery.js');
  const { default: connectorRouter } = await import('../../routes/connectors.js');

  const app = express();
  app.use(express.json());

  // Auth middleware — injects tenantContext without vi.mock
  app.use(createTestAuthMiddleware(tenantId));

  // Mount real routes — same mounting as server.ts
  // connectorRouter is mounted under /api/indexes (for /:indexId/connectors)
  // and /api (for /connectors/:connectorId routes — auth, sync, etc.)
  app.use('/api/indexes', connectorRouter);
  app.use('/api', connectorRouter);
  // connectorDiscoveryRouter is mounted under /api
  app.use('/api', connectorDiscoveryRouter);

  return app;
}

// ─── Discovery Data Fixtures ─────────────────────────────────────────────

const FAKE_DISCOVERED_RESOURCES = [
  {
    id: 'site-001',
    name: 'Engineering',
    displayName: 'Engineering Site',
    url: 'https://contoso.sharepoint.com/sites/engineering',
    resourceType: 'site',
    parentId: null,
    metadata: { webUrl: 'https://contoso.sharepoint.com/sites/engineering' },
  },
  {
    id: 'site-002',
    name: 'Marketing',
    displayName: 'Marketing Site',
    url: 'https://contoso.sharepoint.com/sites/marketing',
    resourceType: 'site',
    parentId: null,
    metadata: { webUrl: 'https://contoso.sharepoint.com/sites/marketing' },
  },
  {
    id: 'drive-001',
    name: 'Documents',
    displayName: 'Documents Library',
    url: 'https://contoso.sharepoint.com/sites/engineering/Documents',
    resourceType: 'drive',
    parentId: 'site-001',
    metadata: { driveType: 'documentLibrary' },
  },
];

const FAKE_CONTENT_PROFILES = [
  {
    resourceId: 'site-001',
    totalDocuments: 500,
    totalSizeBytes: 1_073_741_824, // 1 GB
    fileTypeDistribution: { pdf: 200, docx: 150, xlsx: 100, pptx: 50 },
    dateRange: { earliest: new Date('2023-01-01'), latest: new Date('2026-03-01') },
    averageDocumentSizeBytes: 2_147_483,
    updateFrequency: 'weekly' as const,
    sensitivityIndicators: [],
    sampleDocumentCount: 50,
  },
  {
    resourceId: 'site-002',
    totalDocuments: 200,
    totalSizeBytes: 524_288_000, // 500 MB
    fileTypeDistribution: { pdf: 100, docx: 80, png: 20 },
    dateRange: { earliest: new Date('2024-01-01'), latest: new Date('2026-02-15') },
    averageDocumentSizeBytes: 2_621_440,
    updateFrequency: 'monthly' as const,
    sensitivityIndicators: [],
    sampleDocumentCount: 30,
  },
];

// =============================================================================
// TEST SUITE
// =============================================================================

describe('Connector Discovery-to-Sync E2E (E2E-5)', () => {
  let appA: express.Application;
  let appB: express.Application;

  // Model accessors (bound after setupTestMongo)
  let ConnectorConfig: ReturnType<typeof getLazyModel<IConnectorConfig>>;
  let ConnectorDiscovery: ReturnType<typeof getLazyModel<IConnectorDiscovery>>;
  let SearchIndex: ReturnType<typeof getLazyModel<ISearchIndex>>;
  let SearchSource: ReturnType<typeof getLazyModel<ISearchSource>>;
  let EndUserOAuthToken: ReturnType<typeof getLazyModel<IEndUserOAuthToken>>;

  // Test state
  let indexId: string;
  let connectorId: string;
  let sourceId: string;

  beforeAll(async () => {
    // 1. Start MongoMemoryServer with dual-connection
    await setupTestMongo();

    // 2. Inject fake queue factory (DI — no vi.mock)
    setQueueFactory(createFakeQueue);

    // 3. Bind model accessors
    ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
    ConnectorDiscovery = getLazyModel<IConnectorDiscovery>('ConnectorDiscovery');
    SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
    SearchSource = getLazyModel<ISearchSource>('SearchSource');
    EndUserOAuthToken = getLazyModel<IEndUserOAuthToken>('EndUserOAuthToken');

    // 4. Seed a SearchIndex for tenant A (required by createConnector service)
    const idx = await SearchIndex.create({
      tenantId: TENANT_A,
      projectId: PROJECT_ID,
      slug: 'e2e-connector-test',
      name: 'E2E Connector Test Index',
      description: null,
      embeddingModel: 'bge-m3',
      embeddingDimensions: 1024,
      vectorStore: {
        provider: 'opensearch',
        collectionName: 'e2e_connector_test',
      },
      searchDefaults: {
        topK: 10,
        similarityThreshold: 0.7,
        includeMetadata: true,
      },
    });
    indexId = idx._id;

    // 5. Build Express apps (one per tenant for isolation testing)
    appA = await createTestApp(TENANT_A);
    appB = await createTestApp(TENANT_B);
  }, 60_000);

  afterEach(() => {
    // Reset captured jobs between tests
    capturedJobs.length = 0;
  });

  afterAll(async () => {
    resetQueueFactory();
    await clearCollections();
    await teardownTestMongo();
  }, 30_000);

  // ─── Step 1: Create Connector ────────────────────────────────────────────

  it('should create a SharePoint connector via API', async () => {
    const res = await request(appA)
      .post(`/api/indexes/${indexId}/connectors`)
      .send({
        name: 'E2E SharePoint Connector',
        connectorType: 'sharepoint',
        connectionConfig: {
          tenantUrl: 'https://contoso.sharepoint.com',
          clientId: 'e2e-client-id',
          scopes: ['Sites.Read.All', 'Files.Read.All'],
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.connector).toBeDefined();
    expect(res.body.data.connector.connectorType).toBe('sharepoint');
    expect(res.body.data.source).toBeDefined();

    connectorId = res.body.data.connector._id;
    sourceId = res.body.data.connector.sourceId;
  });

  // ─── Step 2: Seed OAuth Token ────────────────────────────────────────────

  it('should have connector accessible and seed OAuth token', async () => {
    // Verify the connector exists via GET
    const res = await request(appA).get(`/api/indexes/${indexId}/connectors/${connectorId}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Seed an OAuth token (OAuth flow is tested in E2E-4; here we just need a token reference)
    const token = await EndUserOAuthToken.create({
      tenantId: TENANT_A,
      userId: USER_ID,
      provider: 'microsoft',
      providerUserId: 'e2e-provider-user',
      encryptedAccessToken: 'fake-encrypted-access-token-for-e2e',
      encryptedRefreshToken: 'fake-encrypted-refresh-token-for-e2e',
      scope: 'Sites.Read.All Files.Read.All offline_access',
      expiresAt: new Date(Date.now() + 3600_000),
      consentedAt: new Date(),
    });

    // Link the OAuth token to the connector
    await ConnectorConfig.findOneAndUpdate(
      { _id: connectorId, tenantId: TENANT_A },
      { oauthTokenId: token._id },
    );

    // Verify the update
    const connector = await ConnectorConfig.findOne({
      _id: connectorId,
      tenantId: TENANT_A,
    }).lean();
    expect(connector).not.toBeNull();
    expect(connector!.oauthTokenId).toBe(token._id);
  });

  // ─── Step 3: Trigger Discovery ───────────────────────────────────────────

  it('should trigger discovery and queue a job', async () => {
    const res = await request(appA)
      .post(`/api/connectors/${connectorId}/discover`)
      .send({ mode: 'discover_and_profile' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.discoveryId).toBeDefined();
    expect(res.body.data.jobId).toBeDefined();
    expect(res.body.data.status).toBe('pending');

    // Verify a discovery record was created in the DB
    const discovery = await ConnectorDiscovery.findOne({
      _id: res.body.data.discoveryId,
      tenantId: TENANT_A,
    }).lean();
    expect(discovery).not.toBeNull();
    expect(discovery!.connectorId).toBe(connectorId);
    expect(discovery!.status).toBe('pending');

    // Verify a job was captured by the fake queue
    const discoveryJobs = capturedJobs.filter((j) => j.name === 'connector-discovery');
    expect(discoveryJobs.length).toBeGreaterThanOrEqual(1);
    const jobData = discoveryJobs[0].data;
    expect(jobData.connectorId).toBe(connectorId);
    expect(jobData.tenantId).toBe(TENANT_A);
    expect(jobData.mode).toBe('discover_and_profile');
  });

  // ─── Step 4: Simulate Discovery Completion ──────────────────────────────

  it('should have discovery results after worker simulation', async () => {
    // Find the latest discovery record
    const discovery = await ConnectorDiscovery.findOne({
      connectorId,
      tenantId: TENANT_A,
    }).sort({ createdAt: -1 });

    expect(discovery).not.toBeNull();

    // Simulate what the connector-discovery-worker does on completion:
    // Update the discovery record with resources, profiles, and completed status
    await ConnectorDiscovery.findOneAndUpdate(
      { _id: discovery!._id, tenantId: TENANT_A },
      {
        status: 'completed',
        resources: FAKE_DISCOVERED_RESOURCES,
        profiles: FAKE_CONTENT_PROFILES,
        totalResources: FAKE_DISCOVERED_RESOURCES.length,
        discoveredAt: new Date(),
        durationMs: 5432,
      },
    );

    // Verify via GET /connectors/:connectorId/discovery
    const res = await request(appA).get(`/api/connectors/${connectorId}/discovery`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('completed');
    expect(res.body.data.resources).toHaveLength(3);
    expect(res.body.data.profiles).toHaveLength(2);
    expect(res.body.data.totalResources).toBe(3);

    // Verify resource data integrity
    const siteResource = res.body.data.resources.find((r: { id: string }) => r.id === 'site-001');
    expect(siteResource).toBeDefined();
    expect(siteResource.displayName).toBe('Engineering Site');
    expect(siteResource.resourceType).toBe('site');
  });

  // ─── Step 5: Get Discovered Sites ────────────────────────────────────────

  it('should return discovered sites with pagination', async () => {
    const res = await request(appA).get(
      `/api/connectors/${connectorId}/discovered-sites?page=1&limit=10`,
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sites).toHaveLength(2); // Only 2 are resourceType=site
    expect(res.body.data.pagination.total).toBe(2);

    // Verify enrichment with profile data
    const engSite = res.body.data.sites.find((s: { id: string }) => s.id === 'site-001');
    expect(engSite).toBeDefined();
    expect(engSite.profile).not.toBeNull();
    expect(engSite.profile.totalDocuments).toBe(500);
  });

  // ─── Step 6: Generate Recommendations ────────────────────────────────────

  let recommendationId: string;

  it('should generate recommendations from discovery', async () => {
    // Get the latest discovery ID
    const discovery = await ConnectorDiscovery.findOne({
      connectorId,
      tenantId: TENANT_A,
      status: 'completed',
    })
      .sort({ createdAt: -1 })
      .lean();

    expect(discovery).not.toBeNull();

    const res = await request(appA)
      .post(`/api/connectors/${connectorId}/recommendations`)
      .send({ discoveryId: discovery!._id });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data._id).toBeDefined();
    expect(res.body.data.status).toBe('generated');
    expect(res.body.data.resourceScores).toBeDefined();
    expect(res.body.data.syncStrategy).toBeDefined();
    expect(res.body.data.permissionMode).toBeDefined();
    expect(res.body.data.filterConfig).toBeDefined();
    expect(res.body.data.costEstimate).toBeDefined();

    recommendationId = res.body.data._id;
  });

  // ─── Step 7: Accept Recommendation ───────────────────────────────────────

  it('should accept recommendation and update connector config', async () => {
    const res = await request(appA)
      .post(`/api/connectors/${connectorId}/recommendations/${recommendationId}/accept`)
      .send({ startSync: false });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.connector).toBeDefined();
    expect(res.body.data.message).toContain('accepted');

    // Verify connector was updated with recommendation config
    const connector = await ConnectorConfig.findOne({
      _id: connectorId,
      tenantId: TENANT_A,
    }).lean();

    expect(connector).not.toBeNull();
    expect(connector!.configurationSource).toBe('quick_setup');
    expect(connector!.recommendationId).toBe(recommendationId);
  });

  // ─── Step 8: Cross-Tenant Isolation ──────────────────────────────────────

  describe('Cross-Tenant Isolation', () => {
    it('should return 404 when discovering with wrong tenant', async () => {
      // Tenant B tries to discover Tenant A's connector
      const res = await request(appB)
        .post(`/api/connectors/${connectorId}/discover`)
        .send({ mode: 'discover_only' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('should return 404 when getting discovery results with wrong tenant', async () => {
      const res = await request(appB).get(`/api/connectors/${connectorId}/discovery`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('should return 404 when generating recommendations with wrong tenant', async () => {
      const discovery = await ConnectorDiscovery.findOne({
        connectorId,
        tenantId: TENANT_A,
        status: 'completed',
      })
        .sort({ createdAt: -1 })
        .lean();

      const res = await request(appB)
        .post(`/api/connectors/${connectorId}/recommendations`)
        .send({ discoveryId: discovery!._id });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('should return 404 when accepting recommendation with wrong tenant', async () => {
      const res = await request(appB)
        .post(`/api/connectors/${connectorId}/recommendations/${recommendationId}/accept`)
        .send({ startSync: false });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // ─── Step 9: Validation Tests ────────────────────────────────────────────

  describe('Validation', () => {
    it('should reject discovery with invalid mode', async () => {
      const res = await request(appA)
        .post(`/api/connectors/${connectorId}/discover`)
        .send({ mode: 'invalid_mode' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_MODE');
    });

    it('should reject recommendations without discoveryId', async () => {
      const res = await request(appA)
        .post(`/api/connectors/${connectorId}/recommendations`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('MISSING_FIELD');
    });

    it('should reject discovery for connector without OAuth token', async () => {
      // Create a second connector without OAuth
      const source2 = await SearchSource.create({
        tenantId: TENANT_A,
        indexId,
        name: 'Unauthenticated Source',
        sourceType: 'sharepoint',
        sourceConfig: {},
        status: 'pending',
      });

      const connector2 = await ConnectorConfig.create({
        tenantId: TENANT_A,
        sourceId: source2._id,
        connectorType: 'sharepoint',
        connectionConfig: { tenantUrl: 'https://other.sharepoint.com', clientId: 'other-client' },
      });

      const res = await request(appA)
        .post(`/api/connectors/${connector2._id}/discover`)
        .send({ mode: 'discover_only' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_AUTHENTICATED');
    });

    it('should reject recommendation for incomplete discovery', async () => {
      // Create a new discovery that is still pending
      const pendingDiscovery = await ConnectorDiscovery.create({
        tenantId: TENANT_A,
        connectorId,
        status: 'pending',
      });

      const res = await request(appA)
        .post(`/api/connectors/${connectorId}/recommendations`)
        .send({ discoveryId: pendingDiscovery._id });

      expect(res.status).toBe(500); // generateRecommendations throws which results in 500
      expect(res.body.success).toBe(false);
    });
  });

  // ─── Step 10: Accept with Sync ───────────────────────────────────────────

  it('should accept recommendation with startSync=true and queue sync job', async () => {
    // Create a fresh discovery + recommendation for this test
    const freshDiscovery = await ConnectorDiscovery.create({
      tenantId: TENANT_A,
      connectorId,
      status: 'completed',
      resources: FAKE_DISCOVERED_RESOURCES,
      profiles: FAKE_CONTENT_PROFILES,
      totalResources: FAKE_DISCOVERED_RESOURCES.length,
      discoveredAt: new Date(),
      durationMs: 1234,
    });

    // Generate recommendation
    const recRes = await request(appA)
      .post(`/api/connectors/${connectorId}/recommendations`)
      .send({ discoveryId: freshDiscovery._id });

    expect(recRes.status).toBe(200);
    const freshRecId = recRes.body.data._id;

    // Clear captured jobs before this test
    capturedJobs.length = 0;

    // Accept with startSync
    const res = await request(appA)
      .post(`/api/connectors/${connectorId}/recommendations/${freshRecId}/accept`)
      .send({ startSync: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.syncJobId).toBeDefined();
    expect(res.body.data.message).toContain('sync started');

    // Verify sync job was queued
    const syncJobs = capturedJobs.filter((j) => j.name === 'full-sync');
    expect(syncJobs.length).toBeGreaterThanOrEqual(1);
    expect(syncJobs[0].data.connectorId).toBe(connectorId);
    expect(syncJobs[0].data.syncType).toBe('full');
  });
}, 120_000);
