/**
 * E2E-5: a project's custom regex pattern coexists with the EU pack —
 * BOTH a built-in IBAN and a project-scoped employee-ID pattern fire on
 * the same response.
 *
 * Asserts the pack registration + custom-pattern overlay paths compose
 * correctly through the registry; one detection surface does not crowd
 * out the other.
 *
 * Real Express runtime + MongoMemoryServer + mock OpenAI-compatible LLM.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from '../helpers/runtime-api-harness.js';
import { setSuperAdmins } from '../helpers/channel-e2e-bootstrap.js';
import { startMockLLM } from '../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../../tools/agents/e2e-functional/types.js';
import {
  bootstrapPIIProject,
  chatWithPIIEcho,
  patchPIIConfig,
  registerCustomPattern,
} from '../helpers/pii-e2e-helpers.js';

const SUITE_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;
const TEST_IBAN = 'GB82 WEST 1234 5698 7654 32';
const TEST_EMPLOYEE_ID = 'EMP-987654';
const PROMPT = 'Send the user details';

let harness!: RuntimeApiHarness;
let mockLlm!: MockLLM;

describe.sequential('E2E-5: custom pattern coexists with EU pack', () => {
  beforeAll(async () => {
    mockLlm = await startMockLLM();
    harness = await startRuntimeServerHarness({ ALLOW_INMEMORY_ASYNC_INFRA: 'true' });
  }, SUITE_TIMEOUT_MS);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    mockLlm.reset();
    mockLlm.register('user details', {
      content: `Employee ${TEST_EMPLOYEE_ID} banks at IBAN ${TEST_IBAN}.`,
    });
  });

  afterAll(async () => {
    await harness.close();
    await mockLlm.close();
  }, SUITE_TIMEOUT_MS);

  test(
    'IBAN and employee ID are both masked in the same response',
    async () => {
      const admin = await bootstrapPIIProject(harness, mockLlm, 'pii-coexist');

      const customPattern = await registerCustomPattern(harness, admin, {
        name: 'employee-id',
        regex: 'EMP-\\d{6}',
      });
      expect(customPattern.status).toBe(201);

      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: false,
        redact_output: true,
        tier: 'standard',
        enabled_recognizer_packs: ['core', 'eu'],
      });

      const response = await chatWithPIIEcho(harness, admin, PROMPT);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      // Both detections should have masked the original values.
      expect(response.body.response).not.toContain(TEST_IBAN);
      expect(response.body.response).not.toContain(TEST_EMPLOYEE_ID);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'custom pattern alone (no EU pack) still fires for the employee ID',
    async () => {
      const admin = await bootstrapPIIProject(harness, mockLlm, 'pii-custom-only');

      const customPattern = await registerCustomPattern(harness, admin, {
        name: 'employee-id',
        regex: 'EMP-\\d{6}',
      });
      expect(customPattern.status).toBe(201);

      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: false,
        redact_output: true,
        enabled_recognizer_packs: ['core'],
      });

      const response = await chatWithPIIEcho(harness, admin, PROMPT);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      // Employee ID masked by the custom pattern; IBAN passes through
      // because EU pack is disabled.
      expect(response.body.response).not.toContain(TEST_EMPLOYEE_ID);
      expect(response.body.response).toContain(TEST_IBAN);
    },
    TEST_TIMEOUT_MS,
  );
});
