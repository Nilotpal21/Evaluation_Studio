/**
 * INT-3 + INT-5 — PII entity catalog endpoint integration tests.
 *
 * INT-3: Entity catalog pack-enable state cache invalidation.
 * Boundary: Runtime GET /api/projects/:projectId/pii-entities ↔
 *           getProjectPIIConfig() LRU cache ↔ project_runtime_configs.
 *
 * INT-5: Entity catalog reads from recognizer registry (FR-10.1).
 * Boundary: Runtime catalog endpoint ↔ listEnabledPIIEntities() from
 *           @abl/compiler/platform ↔ recognizer-pack ENTITIES exports.
 *
 * Test infrastructure: RuntimeApiHarness + MongoMemoryServer.
 * HTTP-only access except direct DB writes to seed project_runtime_configs.
 * Zero vi.mock calls.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import authRouter from '../../../routes/auth.js';
import platformAdminTenantsRouter from '../../../routes/platform-admin-tenants.js';
import piiEntitiesRouter from '../../../routes/pii-entities.js';
import {
  startRuntimeApiHarness,
  type RuntimeApiHarness,
} from '../../helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  requestJson,
  uniqueEmail,
  uniqueSlug,
  type BootstrapProjectResult,
} from '../../helpers/channel-e2e-bootstrap.js';
import {
  resetProjectPIIConfigCache,
  invalidateProjectPIIConfig,
} from '../../../services/pii/project-pii-config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EntityEntry {
  id: string;
  label: string;
  pack: string;
  category: string;
}

interface CatalogSuccessResponse {
  success: boolean;
  data: { entities: EntityEntry[] };
}

// ---------------------------------------------------------------------------
// Canonical entity IDs per pack (from recognizer-packs/*.ts ENTITIES exports)
// ---------------------------------------------------------------------------

const CORE_ENTITY_IDS = ['email', 'ssn', 'credit_card', 'phone', 'ip_address'];

const US_ENTITY_IDS = [
  'us_passport',
  'us_drivers_license',
  'us_itin',
  'us_bank_account',
  'us_aba_routing',
];

const EU_ENTITY_IDS = [
  'eu_iban',
  'eu_uk_nhs',
  'eu_uk_nino',
  'eu_uk_passport',
  'eu_de_tax_id',
  'eu_it_fiscal_code',
  'eu_es_nif_nie',
  'eu_pl_pesel',
  'eu_fi_pic',
  'eu_se_personal_number',
];

const APAC_ENTITY_IDS = [
  'in_aadhaar',
  'in_pan',
  'in_gstin',
  'sg_nric',
  'au_tfn',
  'au_medicare',
  'au_abn',
  'kr_rrn',
];

const FINANCIAL_ENTITY_IDS = ['fin_swift_bic', 'fin_btc_wallet'];

const MEDICAL_ENTITY_IDS = ['med_mrn', 'med_npi', 'med_dea'];

const NETWORK_ENTITY_IDS = ['net_ipv6', 'net_mac', 'net_url_with_credentials'];

const INTL_PHONE_ENTITY_IDS = ['phone'];

const ALL_ENTITY_IDS = [
  ...CORE_ENTITY_IDS,
  ...US_ENTITY_IDS,
  ...EU_ENTITY_IDS,
  ...APAC_ENTITY_IDS,
  ...FINANCIAL_ENTITY_IDS,
  ...MEDICAL_ENTITY_IDS,
  ...NETWORK_ENTITY_IDS,
  ...INTL_PHONE_ENTITY_IDS,
];

const ALL_PACK_NAMES = [
  'core',
  'us',
  'eu',
  'apac',
  'financial',
  'medical',
  'network',
  'international-phone',
];

// ---------------------------------------------------------------------------
// Shared harness
// ---------------------------------------------------------------------------

let harness: RuntimeApiHarness;
let ctx: BootstrapProjectResult;

function catalogUrl(): string {
  return `/api/projects/${ctx.projectId}/pii-entities`;
}

/**
 * Write directly to the project_runtime_configs collection to configure packs.
 *
 * loadFromDB() reads `pii_redaction.enabled_recognizer_packs` from the lean
 * document, matching the Mongoose schema field name.
 */
async function seedPacks(tenantId: string, projectId: string, packs: string[]): Promise<void> {
  const { MongoConnectionManager } = await import('@agent-platform/database/mongo');
  const manager = MongoConnectionManager.getInstance();
  const db = manager.connection.db;
  if (!db) throw new Error('MongoDB connection not available');

  await db.collection('project_runtime_configs').updateOne(
    { tenantId, projectId },
    {
      $set: {
        tenantId,
        projectId,
        'pii_redaction.enabled_recognizer_packs': packs,
      },
    },
    { upsert: true },
  );
}

/** Remove the project_runtime_configs doc for the project. */
async function removePiiConfig(tenantId: string, projectId: string): Promise<void> {
  const { MongoConnectionManager } = await import('@agent-platform/database/mongo');
  const manager = MongoConnectionManager.getInstance();
  const db = manager.connection.db;
  if (!db) return;

  await db.collection('project_runtime_configs').deleteMany({ tenantId, projectId });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  harness = await startRuntimeApiHarness((app) => {
    app.use('/api/auth', authRouter);
    app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
    app.use('/api/projects/:projectId/pii-entities', piiEntitiesRouter);
  });

  ctx = await bootstrapProject(
    harness,
    uniqueEmail('piicatalog-admin'),
    uniqueSlug('piicatalog-tenant'),
    uniqueSlug('piicatalog-project'),
  );
}, 60_000);

afterAll(async () => {
  await harness.close();
}, 30_000);

beforeEach(async () => {
  // Clear the in-memory cache to ensure clean test isolation
  resetProjectPIIConfigCache();
  // Remove any existing config doc for the project
  await removePiiConfig(ctx.tenantId, ctx.projectId);
}, 30_000);

// =============================================================================
// INT-3 — Entity catalog pack-enable state cache invalidation
// =============================================================================

describe('INT-3 — Entity catalog pack-enable state cache invalidation', () => {
  test('Case 1: Default pack enablement returns all 37 entities', async () => {
    const res = await requestJson<CatalogSuccessResponse>(harness, catalogUrl(), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.entities).toHaveLength(ALL_ENTITY_IDS.length);
    expect(res.body.data.entities).toHaveLength(37);

    const returnedIds = res.body.data.entities.map((e) => e.id);
    for (const expectedId of ALL_ENTITY_IDS) {
      expect(returnedIds).toContain(expectedId);
    }
  });

  test('Case 2: Mutate packs + invalidate cache → fresh data', async () => {
    // Step 1: GET default catalog to prime the cache
    const res1 = await requestJson<CatalogSuccessResponse>(harness, catalogUrl(), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });
    expect(res1.status).toBe(200);
    expect(res1.body.data.entities).toHaveLength(37);

    // Step 2: Mutate the project's packs to only ['core']
    await seedPacks(ctx.tenantId, ctx.projectId, ['core']);

    // Step 3: Invalidate the cache
    invalidateProjectPIIConfig(ctx.tenantId, ctx.projectId);

    // Step 4: GET again — should reflect the new pack set
    const res2 = await requestJson<CatalogSuccessResponse>(harness, catalogUrl(), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });
    expect(res2.status).toBe(200);
    expect(res2.body.data.entities).toHaveLength(CORE_ENTITY_IDS.length);

    const returnedIds = res2.body.data.entities.map((e) => e.id);
    for (const expectedId of CORE_ENTITY_IDS) {
      expect(returnedIds).toContain(expectedId);
    }
  });

  test('Case 3: Without invalidation, cache returns stale data within TTL', async () => {
    // Step 1: GET default catalog to prime the cache with all 37 entities
    const res1 = await requestJson<CatalogSuccessResponse>(harness, catalogUrl(), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });
    expect(res1.status).toBe(200);
    expect(res1.body.data.entities).toHaveLength(37);

    // Step 2: Mutate the project's packs to only ['financial']
    await seedPacks(ctx.tenantId, ctx.projectId, ['financial']);

    // Step 3: GET without invalidation — within 60s TTL, should return stale data
    const res2 = await requestJson<CatalogSuccessResponse>(harness, catalogUrl(), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });
    expect(res2.status).toBe(200);
    // Still returns 37 (stale cached result)
    expect(res2.body.data.entities).toHaveLength(37);

    // Step 4: Now invalidate and re-fetch — should get fresh data
    invalidateProjectPIIConfig(ctx.tenantId, ctx.projectId);

    const res3 = await requestJson<CatalogSuccessResponse>(harness, catalogUrl(), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });
    expect(res3.status).toBe(200);
    expect(res3.body.data.entities).toHaveLength(FINANCIAL_ENTITY_IDS.length);

    const returnedIds = res3.body.data.entities.map((e) => e.id);
    for (const expectedId of FINANCIAL_ENTITY_IDS) {
      expect(returnedIds).toContain(expectedId);
    }
  });

  test('Case 4: Cache invalidation for one project does not affect another', async () => {
    // Prime cache for the main project
    const res1 = await requestJson<CatalogSuccessResponse>(harness, catalogUrl(), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });
    expect(res1.status).toBe(200);
    expect(res1.body.data.entities).toHaveLength(37);

    // Mutate the main project's packs
    await seedPacks(ctx.tenantId, ctx.projectId, ['core']);

    // Invalidate a DIFFERENT (fake) project — should not affect our project's cache
    invalidateProjectPIIConfig(ctx.tenantId, 'nonexistent-project-id');

    // Main project should still return stale (37 entities) because its cache is not invalidated
    const res2 = await requestJson<CatalogSuccessResponse>(harness, catalogUrl(), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });
    expect(res2.status).toBe(200);
    expect(res2.body.data.entities).toHaveLength(37);

    // Invalidate the correct project
    invalidateProjectPIIConfig(ctx.tenantId, ctx.projectId);

    const res3 = await requestJson<CatalogSuccessResponse>(harness, catalogUrl(), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });
    expect(res3.status).toBe(200);
    expect(res3.body.data.entities).toHaveLength(CORE_ENTITY_IDS.length);
  });
});

// =============================================================================
// INT-5 — Entity catalog reads from recognizer registry (FR-10.1)
// =============================================================================

describe('INT-5 — Entity catalog reads from recognizer registry (FR-10.1)', () => {
  test('Case 1: core + us packs return only core and us entities', async () => {
    await seedPacks(ctx.tenantId, ctx.projectId, ['core', 'us']);

    const res = await requestJson<CatalogSuccessResponse>(harness, catalogUrl(), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const expectedIds = [...CORE_ENTITY_IDS, ...US_ENTITY_IDS];
    expect(res.body.data.entities).toHaveLength(expectedIds.length);

    const returnedIds = res.body.data.entities.map((e) => e.id);
    for (const expectedId of expectedIds) {
      expect(returnedIds).toContain(expectedId);
    }

    // Verify no entities from other packs leak through
    const unexpectedPacks = ALL_PACK_NAMES.filter((p) => p !== 'core' && p !== 'us');
    const returnedPacks = new Set(res.body.data.entities.map((e) => e.pack));
    for (const pack of unexpectedPacks) {
      expect(returnedPacks).not.toContain(pack);
    }
  });

  test('Case 2: financial pack returns only financial entities', async () => {
    await seedPacks(ctx.tenantId, ctx.projectId, ['financial']);

    const res = await requestJson<CatalogSuccessResponse>(harness, catalogUrl(), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.entities).toHaveLength(FINANCIAL_ENTITY_IDS.length);

    const returnedIds = res.body.data.entities.map((e) => e.id);
    for (const expectedId of FINANCIAL_ENTITY_IDS) {
      expect(returnedIds).toContain(expectedId);
    }

    // Verify pack isolation — only financial pack entities returned
    const returnedPacks = new Set(res.body.data.entities.map((e) => e.pack));
    expect(returnedPacks.size).toBe(1);
    expect(returnedPacks).toContain('financial');
  });

  test('Case 3: All 8 packs return all 37 entities', async () => {
    await seedPacks(ctx.tenantId, ctx.projectId, ALL_PACK_NAMES);

    const res = await requestJson<CatalogSuccessResponse>(harness, catalogUrl(), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.entities).toHaveLength(37);

    const returnedIds = res.body.data.entities.map((e) => e.id);
    for (const expectedId of ALL_ENTITY_IDS) {
      expect(returnedIds).toContain(expectedId);
    }

    // Verify all 8 packs are represented
    const returnedPacks = new Set(res.body.data.entities.map((e) => e.pack));
    for (const pack of ALL_PACK_NAMES) {
      expect(returnedPacks).toContain(pack);
    }
  });

  test('Case 4: Entity shape matches EntityCatalogEntry — id, label, pack, category', async () => {
    await seedPacks(ctx.tenantId, ctx.projectId, ['core']);

    const res = await requestJson<CatalogSuccessResponse>(harness, catalogUrl(), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.entities.length).toBeGreaterThan(0);

    for (const entity of res.body.data.entities) {
      // Verify all 4 fields exist and are strings
      expect(typeof entity.id).toBe('string');
      expect(entity.id.length).toBeGreaterThan(0);
      expect(typeof entity.label).toBe('string');
      expect(entity.label.length).toBeGreaterThan(0);
      expect(typeof entity.pack).toBe('string');
      expect(entity.pack.length).toBeGreaterThan(0);
      expect(typeof entity.category).toBe('string');
      expect(entity.category.length).toBeGreaterThan(0);

      // Verify pack field matches 'core' since we configured only 'core'
      expect(entity.pack).toBe('core');
    }

    // Spot-check specific entities
    const emailEntity = res.body.data.entities.find((e) => e.id === 'email');
    expect(emailEntity).toBeDefined();
    expect(emailEntity?.label).toBe('Email Address');
    expect(emailEntity?.pack).toBe('core');
    expect(emailEntity?.category).toBe('contact');

    const ssnEntity = res.body.data.entities.find((e) => e.id === 'ssn');
    expect(ssnEntity).toBeDefined();
    expect(ssnEntity?.label).toBe('US Social Security Number');
    expect(ssnEntity?.pack).toBe('core');
    expect(ssnEntity?.category).toBe('government_id');

    const ccEntity = res.body.data.entities.find((e) => e.id === 'credit_card');
    expect(ccEntity).toBeDefined();
    expect(ccEntity?.label).toBe('Credit Card Number');
    expect(ccEntity?.pack).toBe('core');
    expect(ccEntity?.category).toBe('financial');
  });

  test('Case 5: Medical pack entities have correct metadata', async () => {
    await seedPacks(ctx.tenantId, ctx.projectId, ['medical']);

    const res = await requestJson<CatalogSuccessResponse>(harness, catalogUrl(), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });

    expect(res.status).toBe(200);
    expect(res.body.data.entities).toHaveLength(MEDICAL_ENTITY_IDS.length);

    const mrnEntity = res.body.data.entities.find((e) => e.id === 'med_mrn');
    expect(mrnEntity).toBeDefined();
    expect(mrnEntity?.label).toBe('Medical Record Number');
    expect(mrnEntity?.pack).toBe('medical');
    expect(mrnEntity?.category).toBe('healthcare');

    const npiEntity = res.body.data.entities.find((e) => e.id === 'med_npi');
    expect(npiEntity).toBeDefined();
    expect(npiEntity?.label).toBe('National Provider Identifier');
    expect(npiEntity?.category).toBe('healthcare');
  });

  test('Case 6: Unknown packs are silently skipped', async () => {
    await seedPacks(ctx.tenantId, ctx.projectId, ['core', 'nonexistent_pack']);

    const res = await requestJson<CatalogSuccessResponse>(harness, catalogUrl(), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Should only return core entities — nonexistent_pack is silently skipped
    expect(res.body.data.entities).toHaveLength(CORE_ENTITY_IDS.length);

    const returnedPacks = new Set(res.body.data.entities.map((e) => e.pack));
    expect(returnedPacks.size).toBe(1);
    expect(returnedPacks).toContain('core');
  });
});
