/**
 * E2E-1: Enabling the EU pack causes IBANs in the LLM response to be
 * masked before delivery to the user.
 *
 * Real Express runtime + MongoMemoryServer + mock OpenAI-compatible LLM.
 * No mocking of @abl/* or @agent-platform/* — only the LLM endpoint
 * is replaced (true E2E).
 *
 * Asserts:
 *   1. Default config (only `core` pack) → IBAN passes through raw.
 *   2. After PATCHing `enabled_recognizer_packs = ['core', 'eu']`,
 *      a session sees the IBAN masked in the response delivered to
 *      the user.
 *   3. Cross-project isolation: a sibling project on the same tenant
 *      with EU pack disabled still sees raw IBAN — proving the pack
 *      selection is per-project, not global.
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
} from '../helpers/pii-e2e-helpers.js';

const SUITE_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;
// Canonical UK test IBAN — published by ISO and used in widely-quoted examples.
const TEST_IBAN = 'GB82 WEST 1234 5698 7654 32';
const PROMPT = 'What is the example IBAN?';

let harness!: RuntimeApiHarness;
let mockLlm!: MockLLM;

describe.sequential('E2E-1: EU pack masks IBAN end-to-end', () => {
  beforeAll(async () => {
    mockLlm = await startMockLLM();
    harness = await startRuntimeServerHarness({ ALLOW_INMEMORY_ASYNC_INFRA: 'true' });
  }, SUITE_TIMEOUT_MS);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    mockLlm.reset();
    mockLlm.register('example IBAN', { content: `The example IBAN is ${TEST_IBAN}.` });
  });

  afterAll(async () => {
    await harness.close();
    await mockLlm.close();
  }, SUITE_TIMEOUT_MS);

  test(
    'baseline: default `core`-only config does NOT mask the IBAN',
    async () => {
      const admin = await bootstrapPIIProject(harness, mockLlm, 'pii-eu-baseline');
      // Output redaction must be ON for any masking to be observable.
      // Pack selection is left at the default (`['core']`) so the EU pack
      // is NOT registered.
      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: true,
        redact_output: true,
        enabled_recognizer_packs: ['core'],
      });

      const response = await chatWithPIIEcho(harness, admin, PROMPT);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      // `core` pack does NOT detect IBAN → raw value is delivered.
      expect(response.body.response).toContain(TEST_IBAN);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'EU pack enabled: IBAN is masked in the response delivered to the user',
    async () => {
      const admin = await bootstrapPIIProject(harness, mockLlm, 'pii-eu-enabled');
      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: true,
        redact_output: true,
        tier: 'standard',
        enabled_recognizer_packs: ['core', 'eu'],
      });

      const response = await chatWithPIIEcho(harness, admin, PROMPT);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      // The raw IBAN must NOT appear in the assistant-visible response.
      expect(response.body.response).not.toContain(TEST_IBAN);
      // And neither should an unredacted GB country prefix on a 22-char block —
      // a coarser regression guard against regex regressions that drop only
      // the spaces but leave the digits.
      expect(response.body.response).not.toMatch(/GB\d{2}[A-Z0-9 ]{20,}/);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'cross-project isolation: sibling project under same tenant without EU pack still leaks',
    async () => {
      const adminA = await bootstrapPIIProject(harness, mockLlm, 'pii-eu-iso-a');
      await patchPIIConfig(harness, adminA, {
        enabled: true,
        redact_input: true,
        redact_output: true,
        enabled_recognizer_packs: ['core', 'eu'],
      });

      const adminB = await bootstrapPIIProject(harness, mockLlm, 'pii-eu-iso-b');
      await patchPIIConfig(harness, adminB, {
        enabled: true,
        redact_input: true,
        redact_output: true,
        enabled_recognizer_packs: ['core'],
      });

      const respA = await chatWithPIIEcho(harness, adminA, PROMPT);
      expect(respA.status).toBe(200);
      expect(respA.body.response).not.toContain(TEST_IBAN);

      const respB = await chatWithPIIEcho(harness, adminB, PROMPT);
      expect(respB.status).toBe(200);
      // Project B did NOT enable EU — IBAN passes through, proving the
      // overlay is per-project.
      expect(respB.body.response).toContain(TEST_IBAN);
    },
    TEST_TIMEOUT_MS,
  );
});
