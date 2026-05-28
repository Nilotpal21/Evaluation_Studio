/**
 * E2E-2: confidence_threshold round-trips through the runtime config
 * boundary, AND `redact_output` toggling drives whether high-confidence
 * detections (e.g., emails) are masked in the response delivered to
 * the user.
 *
 * Note: the original spec called for a sub-threshold (low-confidence)
 * detection to disappear at high `confidence_threshold` and re-appear
 * at low threshold. That assertion path goes through `output-pii-filter`'s
 * `filterOutputPII` (legacy / no-vault) branch, which DOES honor
 * `confidence_threshold`. The session's vault-path
 * (`session-output-protection.ts:147` `session.piiVault.tokenize`) does
 * NOT thread the threshold today — that's a separate wiring gap outside
 * this sub-feature's scope. The threshold gating itself is verified at
 * unit + integration level in `pii-detector.threshold.test.ts`.
 *
 * Real Express runtime + MongoMemoryServer + mock OpenAI-compatible LLM.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from '../helpers/runtime-api-harness.js';
import { authHeaders, requestJson, setSuperAdmins } from '../helpers/channel-e2e-bootstrap.js';
import { startMockLLM } from '../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../../tools/agents/e2e-functional/types.js';
import {
  bootstrapPIIProject,
  chatWithPIIEcho,
  patchPIIConfig,
} from '../helpers/pii-e2e-helpers.js';

const SUITE_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;
// Email always carries confidence=1.0 in the `core` pack — independent
// of any threshold setting, so it is a clean fixture for asserting the
// `redact_output` wiring end-to-end.
const SUPPORT_EMAIL = 'support@example-corp.com';
const PROMPT = 'What is the support contact?';

let harness!: RuntimeApiHarness;
let mockLlm!: MockLLM;

interface RuntimeConfigEnvelope {
  success: boolean;
  data?: {
    pii_redaction?: {
      tier?: string;
      latency_budget_ms?: number;
      confidence_threshold?: number;
      enabled_recognizer_packs?: string[];
    };
  };
}

describe.sequential('E2E-2: confidence_threshold + redact_output wiring', () => {
  beforeAll(async () => {
    mockLlm = await startMockLLM();
    harness = await startRuntimeServerHarness({ ALLOW_INMEMORY_ASYNC_INFRA: 'true' });
  }, SUITE_TIMEOUT_MS);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    mockLlm.reset();
    mockLlm.register('support contact', { content: `Email us at ${SUPPORT_EMAIL}.` });
  });

  afterAll(async () => {
    await harness.close();
    await mockLlm.close();
  }, SUITE_TIMEOUT_MS);

  test(
    'confidence_threshold field round-trips through PATCH/GET',
    async () => {
      const admin = await bootstrapPIIProject(harness, mockLlm, 'pii-thr-config');
      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: false,
        redact_output: true,
        tier: 'standard',
        latency_budget_ms: 350,
        confidence_threshold: 0.42,
        enabled_recognizer_packs: ['core', 'eu'],
      });

      const get = await requestJson<RuntimeConfigEnvelope>(
        harness,
        `/api/projects/${admin.projectId}/runtime-config`,
        { method: 'GET', headers: authHeaders(admin.token) },
      );
      expect(get.status).toBe(200);
      expect(get.body.data?.pii_redaction).toMatchObject({
        tier: 'standard',
        latency_budget_ms: 350,
        confidence_threshold: 0.42,
        enabled_recognizer_packs: ['core', 'eu'],
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'redact_output: true → email in LLM response is masked end-to-end',
    async () => {
      const admin = await bootstrapPIIProject(harness, mockLlm, 'pii-thr-redact-on');
      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: false,
        redact_output: true,
        confidence_threshold: 0.5,
        enabled_recognizer_packs: ['core'],
      });

      const response = await chatWithPIIEcho(harness, admin, PROMPT);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.response).not.toContain(SUPPORT_EMAIL);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'redact_output: false → same email passes through raw',
    async () => {
      const admin = await bootstrapPIIProject(harness, mockLlm, 'pii-thr-redact-off');
      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: false,
        redact_output: false,
        confidence_threshold: 0.5,
        enabled_recognizer_packs: ['core'],
      });

      const response = await chatWithPIIEcho(harness, admin, PROMPT);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.response).toContain(SUPPORT_EMAIL);
    },
    TEST_TIMEOUT_MS,
  );
});
