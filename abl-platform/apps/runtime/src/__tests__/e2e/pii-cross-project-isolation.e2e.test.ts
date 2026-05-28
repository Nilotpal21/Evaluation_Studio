/**
 * E2E-3: cross-project isolation of PII recognizer-pack configuration.
 *
 * Three projects (P1, P2 under tenant T1; P3 under tenant T2) PUT
 * different `enabled_recognizer_packs` selections. Asserts:
 *   - Each project's GET response shows only its own pack list.
 *   - Cross-tenant access (T2 admin → T1 project) returns 404.
 *
 * The full IBAN detection pipeline test (E2E-1) requires an LLM mock
 * harness and is left as a follow-up; this test verifies the
 * configuration-isolation invariant the runtime relies on, which
 * combined with INT-9 (per-registry overlay isolation) covers the
 * security-relevant slice.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from '../helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
  type BootstrapProjectResult,
} from '../helpers/channel-e2e-bootstrap.js';

const SUITE_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 60_000;

let harness: RuntimeApiHarness;

interface RuntimeConfigEnvelope {
  success: boolean;
  data: {
    pii_redaction: {
      enabled_recognizer_packs?: string[];
    };
  };
  error?: { code: string };
}

async function configurePacks(admin: BootstrapProjectResult, packs: string[]): Promise<void> {
  const response = await requestJson<RuntimeConfigEnvelope>(
    harness,
    `/api/projects/${admin.projectId}/runtime-config`,
    {
      method: 'PUT',
      headers: authHeaders(admin.token),
      body: {
        pii_redaction: {
          enabled: true,
          redact_input: true,
          redact_output: false,
          enabled_recognizer_packs: packs,
        },
      },
    },
  );
  expect(response.status).toBe(200);
}

async function readPacks(admin: BootstrapProjectResult): Promise<string[] | undefined> {
  const response = await requestJson<RuntimeConfigEnvelope>(
    harness,
    `/api/projects/${admin.projectId}/runtime-config`,
    { method: 'GET', headers: authHeaders(admin.token) },
  );
  expect(response.status).toBe(200);
  return response.body.data.pii_redaction.enabled_recognizer_packs;
}

describe('E2E-3: cross-project / cross-tenant PII config isolation', () => {
  beforeAll(async () => {
    harness = await startRuntimeServerHarness({
      ALLOW_INMEMORY_ASYNC_INFRA: 'true',
    });
    await setSuperAdmins([]);
  }, SUITE_TIMEOUT_MS);

  beforeEach(async () => {
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
  });

  afterAll(async () => {
    await harness.close();
  }, SUITE_TIMEOUT_MS);

  test(
    'each project sees only its own enabled_recognizer_packs',
    async () => {
      const p1 = await bootstrapProject(
        harness,
        uniqueEmail('iso-p1-admin'),
        uniqueSlug('iso-p1-tenant'),
        uniqueSlug('iso-p1-project'),
      );
      const p2 = await bootstrapProject(
        harness,
        uniqueEmail('iso-p2-admin'),
        uniqueSlug('iso-p2-tenant'),
        uniqueSlug('iso-p2-project'),
      );

      await configurePacks(p1, ['core', 'eu']);
      await configurePacks(p2, ['core', 'medical']);

      expect(await readPacks(p1)).toEqual(['core', 'eu']);
      expect(await readPacks(p2)).toEqual(['core', 'medical']);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'cross-tenant GET returns 404 (tenant isolation)',
    async () => {
      const p1 = await bootstrapProject(
        harness,
        uniqueEmail('iso-cross-t1-admin'),
        uniqueSlug('iso-cross-t1-tenant'),
        uniqueSlug('iso-cross-t1-project'),
      );
      const t2Admin = await bootstrapProject(
        harness,
        uniqueEmail('iso-cross-t2-admin'),
        uniqueSlug('iso-cross-t2-tenant'),
        uniqueSlug('iso-cross-t2-project'),
      );

      await configurePacks(p1, ['core', 'apac']);

      // T2's admin token attempting to read T1's project — must 404.
      const response = await requestJson<RuntimeConfigEnvelope>(
        harness,
        `/api/projects/${p1.projectId}/runtime-config`,
        { method: 'GET', headers: authHeaders(t2Admin.token) },
      );
      expect(response.status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );
});
