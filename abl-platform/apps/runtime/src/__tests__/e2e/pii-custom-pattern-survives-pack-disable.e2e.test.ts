/**
 * E2E-7: a project's custom regex pattern continues to fire even when
 * `enabled_recognizer_packs` is set to an empty list.
 *
 * Closes the registry-bypass concern (parent feature GAP-013): the
 * registry singleton retains custom patterns regardless of pack
 * selection — clearing all packs does NOT silently drop project
 * custom patterns. The compiler-side equivalent lives in
 * `registry-bypass-regression.test.ts` (INT-1..INT-4).
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
const TEST_EMPLOYEE_ID = 'EMP-555000';
const PROMPT = 'Print the employee number';

let harness!: RuntimeApiHarness;
let mockLlm!: MockLLM;

describe.sequential('E2E-7: custom pattern survives pack disablement', () => {
  beforeAll(async () => {
    mockLlm = await startMockLLM();
    harness = await startRuntimeServerHarness({ ALLOW_INMEMORY_ASYNC_INFRA: 'true' });
  }, SUITE_TIMEOUT_MS);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    mockLlm.reset();
    mockLlm.register('employee number', {
      content: `Employee ${TEST_EMPLOYEE_ID} on roster.`,
    });
  });

  afterAll(async () => {
    await harness.close();
    await mockLlm.close();
  }, SUITE_TIMEOUT_MS);

  test(
    'baseline: custom pattern fires with eu pack enabled',
    async () => {
      const admin = await bootstrapPIIProject(harness, mockLlm, 'pii-survive-baseline');

      const customPattern = await registerCustomPattern(harness, admin, {
        name: 'employee-id',
        regex: 'EMP-\\d{6}',
      });
      expect(customPattern.status).toBe(201);

      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: false,
        redact_output: true,
        enabled_recognizer_packs: ['core', 'eu'],
      });

      const response = await chatWithPIIEcho(harness, admin, PROMPT);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.response).not.toContain(TEST_EMPLOYEE_ID);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'after PATCH to packs=[] the custom pattern still masks the employee ID',
    async () => {
      const admin = await bootstrapPIIProject(harness, mockLlm, 'pii-survive-cleared');

      const customPattern = await registerCustomPattern(harness, admin, {
        name: 'employee-id',
        regex: 'EMP-\\d{6}',
      });
      expect(customPattern.status).toBe(201);

      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: false,
        redact_output: true,
        enabled_recognizer_packs: ['core', 'eu'],
      });
      // Sanity: with eu pack on, custom pattern fires.
      const before = await chatWithPIIEcho(harness, admin, PROMPT);
      expect(before.status).toBe(200);
      expect(before.body.response).not.toContain(TEST_EMPLOYEE_ID);

      // Clear ALL packs.
      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: false,
        redact_output: true,
        enabled_recognizer_packs: [],
      });

      // Fresh session — custom pattern should STILL fire because the
      // registry singleton retains custom patterns regardless of pack
      // selection.
      const after = await chatWithPIIEcho(harness, admin, PROMPT);
      expect(after.status, JSON.stringify(after.body)).toBe(200);
      expect(after.body.response).not.toContain(TEST_EMPLOYEE_ID);
    },
    TEST_TIMEOUT_MS,
  );
});
