/**
 * E2E-ERR-1: project runtime-config validation for the new PII fields.
 *
 * Hits PUT /api/projects/:projectId/runtime-config with the four new
 * pii_redaction fields. Asserts:
 *   - Bad pack name in `enabled_recognizer_packs` is rejected with a
 *     structured VALIDATION_ERROR envelope (HTTP 400).
 *   - Out-of-range numeric fields (latency_budget_ms, confidence_threshold)
 *     are rejected.
 *   - Valid values round-trip through the response shape.
 *   - Subsequent GET reflects the persisted values.
 *   - Unset fields fall back to documented defaults (basic / 200 / 0.5 /
 *     ['core']).
 *
 * No mocks — RuntimeApiHarness boots the full Express middleware chain
 * against MongoMemoryServer.
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

const SUITE_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 45_000;

let harness: RuntimeApiHarness;
let admin: BootstrapProjectResult;

interface RuntimeConfigEnvelope {
  success: boolean;
  data: {
    projectId: string;
    pii_redaction: {
      enabled: boolean;
      redact_input: boolean;
      redact_output: boolean;
      tier?: string;
      latency_budget_ms?: number;
      confidence_threshold?: number;
      enabled_recognizer_packs?: string[];
    };
  };
  error?: { code: string; message: string; issues?: unknown[] };
}

async function getConfig(): Promise<RuntimeConfigEnvelope> {
  const response = await requestJson<RuntimeConfigEnvelope>(
    harness,
    `/api/projects/${admin.projectId}/runtime-config`,
    { method: 'GET', headers: authHeaders(admin.token) },
  );
  expect(response.status).toBe(200);
  return response.body;
}

async function putConfig(body: Record<string, unknown>): Promise<{
  status: number;
  body: RuntimeConfigEnvelope;
}> {
  const response = await requestJson<RuntimeConfigEnvelope>(
    harness,
    `/api/projects/${admin.projectId}/runtime-config`,
    { method: 'PUT', headers: authHeaders(admin.token), body },
  );
  return { status: response.status, body: response.body };
}

describe('E2E-ERR-1: PII config validation', () => {
  beforeAll(async () => {
    harness = await startRuntimeServerHarness({
      ALLOW_INMEMORY_ASYNC_INFRA: 'true',
    });
    await setSuperAdmins([]);
  }, SUITE_TIMEOUT_MS);

  beforeEach(async () => {
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    admin = await bootstrapProject(
      harness,
      uniqueEmail('pii-config-validation-admin'),
      uniqueSlug('pii-config-validation-tenant'),
      uniqueSlug('pii-config-validation-project'),
    );
  });

  afterAll(async () => {
    await harness.close();
  }, SUITE_TIMEOUT_MS);

  test(
    'rejects unknown pack name with VALIDATION_ERROR',
    async () => {
      const { status, body } = await putConfig({
        pii_redaction: {
          enabled: true,
          redact_input: true,
          redact_output: false,
          enabled_recognizer_packs: ['core', 'eu', 'eurpoe'], // typo
        },
      });
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe('VALIDATION_ERROR');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'rejects out-of-range latency_budget_ms (> 2000)',
    async () => {
      const { status, body } = await putConfig({
        pii_redaction: {
          enabled: true,
          redact_input: true,
          redact_output: false,
          latency_budget_ms: 5000,
        },
      });
      expect(status).toBe(400);
      expect(body.error?.code).toBe('VALIDATION_ERROR');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'rejects out-of-range confidence_threshold (> 1)',
    async () => {
      const { status, body } = await putConfig({
        pii_redaction: {
          enabled: true,
          redact_input: true,
          redact_output: false,
          confidence_threshold: 1.5,
        },
      });
      expect(status).toBe(400);
      expect(body.error?.code).toBe('VALIDATION_ERROR');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'rejects invalid tier enum value',
    async () => {
      const { status, body } = await putConfig({
        pii_redaction: {
          enabled: true,
          redact_input: true,
          redact_output: false,
          tier: 'super-deluxe', // not in enum
        },
      });
      expect(status).toBe(400);
      expect(body.error?.code).toBe('VALIDATION_ERROR');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'accepts valid PII config and round-trips through GET',
    async () => {
      const { status: putStatus, body: putBody } = await putConfig({
        pii_redaction: {
          enabled: true,
          redact_input: true,
          redact_output: false,
          tier: 'standard',
          latency_budget_ms: 350,
          confidence_threshold: 0.75,
          enabled_recognizer_packs: ['core', 'eu'],
        },
      });
      expect(putStatus).toBe(200);
      expect(putBody.success).toBe(true);
      expect(putBody.data.pii_redaction.tier).toBe('standard');
      expect(putBody.data.pii_redaction.latency_budget_ms).toBe(350);
      expect(putBody.data.pii_redaction.confidence_threshold).toBe(0.75);
      expect(putBody.data.pii_redaction.enabled_recognizer_packs).toEqual(['core', 'eu']);

      const { data } = await getConfig();
      expect(data.pii_redaction.tier).toBe('standard');
      expect(data.pii_redaction.latency_budget_ms).toBe(350);
      expect(data.pii_redaction.confidence_threshold).toBe(0.75);
      expect(data.pii_redaction.enabled_recognizer_packs).toEqual(['core', 'eu']);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'unset PII fields fall back to documented defaults',
    async () => {
      // No PUT — fresh project; GET should yield platform defaults.
      const { data } = await getConfig();
      expect(data.pii_redaction.tier).toBe('basic');
      expect(data.pii_redaction.latency_budget_ms).toBe(200);
      expect(data.pii_redaction.confidence_threshold).toBe(0.5);
      expect(data.pii_redaction.enabled_recognizer_packs).toEqual(['core']);
    },
    TEST_TIMEOUT_MS,
  );
});
