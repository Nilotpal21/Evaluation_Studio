/**
 * E2E-4: tier / pack-selection changes via PATCH apply on the next
 * session even when subsequent messages reuse the same project.
 *
 * Asserts the cache-invalidation epoch (`bumpPIIConfigEpoch`) actually
 * threads from the runtime-config PATCH boundary to the session-PII
 * snapshot loader, so a project that flips from `basic` to `standard`
 * tier sees its EU pack take effect immediately.
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
} from '../helpers/pii-e2e-helpers.js';

const SUITE_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;
const TEST_IBAN = 'GB82 WEST 1234 5698 7654 32';
const PROMPT = 'What is the example IBAN?';

let harness!: RuntimeApiHarness;
let mockLlm!: MockLLM;

describe.sequential('E2E-4: tier swap propagates after PATCH', () => {
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
    'flipping basic→standard with eu pack added → next session masks the IBAN',
    async () => {
      const admin = await bootstrapPIIProject(harness, mockLlm, 'pii-tier-flip');

      // Phase 1: basic tier, core only — IBAN is delivered raw.
      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: false,
        redact_output: true,
        tier: 'basic',
        enabled_recognizer_packs: ['core'],
      });
      const before = await chatWithPIIEcho(harness, admin, PROMPT);
      expect(before.status, JSON.stringify(before.body)).toBe(200);
      expect(before.body.response).toContain(TEST_IBAN);

      // Phase 2: PATCH to standard + eu — bumpPIIConfigEpoch fires.
      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: false,
        redact_output: true,
        tier: 'standard',
        enabled_recognizer_packs: ['core', 'eu'],
      });

      // Fresh session — the snapshot cache for this (tenant, project)
      // is invalidated by the epoch bump, so the new pack list applies.
      const after = await chatWithPIIEcho(harness, admin, PROMPT);
      expect(after.status, JSON.stringify(after.body)).toBe(200);
      expect(after.body.response).not.toContain(TEST_IBAN);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'flipping standard→basic (eu removed) → next session reverts to raw IBAN',
    async () => {
      const admin = await bootstrapPIIProject(harness, mockLlm, 'pii-tier-revert');

      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: false,
        redact_output: true,
        tier: 'standard',
        enabled_recognizer_packs: ['core', 'eu'],
      });
      const masked = await chatWithPIIEcho(harness, admin, PROMPT);
      expect(masked.status).toBe(200);
      expect(masked.body.response).not.toContain(TEST_IBAN);

      // Revert.
      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: false,
        redact_output: true,
        tier: 'basic',
        enabled_recognizer_packs: ['core'],
      });

      const reverted = await chatWithPIIEcho(harness, admin, PROMPT);
      expect(reverted.status).toBe(200);
      expect(reverted.body.response).toContain(TEST_IBAN);
    },
    TEST_TIMEOUT_MS,
  );
});
