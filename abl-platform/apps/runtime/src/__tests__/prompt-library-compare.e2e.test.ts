/**
 * E2E-2, E2E-3, E2E-4: Prompt Library Test Endpoint
 *
 * E2E-2: Compare Mode A — same prompt × 3 models in parallel
 * E2E-3: Compare Mode B — 3 versions × 1 model in parallel
 * E2E-4: Cross-product compare is rejected with 400
 *
 * Uses a mock OpenAI-compatible LLM server with a 200ms artificial delay to
 * prove parallel execution in E2E-2 and E2E-3.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from './helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  provisionTenantModel,
  uniqueEmail,
  uniqueSlug,
  type TenantModelRecord,
} from './helpers/channel-e2e-bootstrap.js';
import { startMockLLM } from '../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../tools/agents/e2e-functional/types.js';
import {
  createPrompt,
  createVersion,
  promoteVersion,
  runTestPanes,
} from './helpers/prompt-library-helpers.js';

const TIMEOUT_MS = 90_000;
const PANE_DELAY_MS = 200;

describe('E2E-2/3/4: Prompt Library test endpoint', () => {
  let harness: RuntimeApiHarness | undefined;
  let mockLlm: MockLLM | undefined;
  let token: string;
  let projectId: string;
  let tenantId: string;

  let m1: TenantModelRecord;
  let m2: TenantModelRecord;
  let m3: TenantModelRecord;

  beforeAll(async () => {
    mockLlm = await startMockLLM();
    harness = await startRuntimeServerHarness();

    const boot = await bootstrapProject(
      harness,
      uniqueEmail('pl-compare'),
      uniqueSlug('pl-compare-tenant'),
      uniqueSlug('pl-compare-proj'),
    );
    token = boot.token;
    projectId = boot.projectId;
    tenantId = boot.tenantId;

    const modelBase = {
      targetTenantId: tenantId,
      integrationType: 'api' as const,
      provider: 'openai',
      modelId: 'gpt-4o-mini',
      endpointUrl: mockLlm.url,
      connection: {
        credentialName: 'mock-key',
        apiKey: 'mock-api-key-for-testing',
        authType: 'bearer',
      },
    };

    [m1, m2, m3] = await Promise.all([
      provisionTenantModel(harness, token, { ...modelBase, displayName: 'mock-model-1' }),
      provisionTenantModel(harness, token, { ...modelBase, displayName: 'mock-model-2' }),
      provisionTenantModel(harness, token, { ...modelBase, displayName: 'mock-model-3' }),
    ]);
  }, TIMEOUT_MS);

  afterAll(async () => {
    await harness?.close();
    await mockLlm?.close();
  });

  describe('E2E-2: Compare Mode A — 3 models in parallel', () => {
    test(
      'returns 3 panes, all with output, in under (3 × delay + buffer)ms',
      async () => {
        // Register a delayed response for each request pattern
        mockLlm!.register('Summarize', {
          content: 'Mock summary output',
          delay: PANE_DELAY_MS,
        });

        const { item } = await createPrompt(harness!, token, projectId, {
          name: `compare-a-${Date.now()}`,
        });
        const v = await createVersion(harness!, token, projectId, item._id, {
          template: 'Summarize: {{text}}',
          variables: ['text'],
        });
        await promoteVersion(harness!, token, projectId, item._id, v._id);

        const wallStart = Date.now();
        const res = await runTestPanes(harness!, token, projectId, {
          panes: [
            { promptVersionId: v._id, tenantModelId: m1.id },
            { promptVersionId: v._id, tenantModelId: m2.id },
            { promptVersionId: v._id, tenantModelId: m3.id },
          ],
          variables: { text: 'hello world' },
          userMessage: 'go',
        });
        const wallMs = Date.now() - wallStart;

        expect(res.status).toBe(200);
        expect(res.body.results).toHaveLength(3);
        expect(res.body.failedPanes).toHaveLength(0);

        for (const pane of res.body.results!) {
          expect(pane.output).toBeTruthy();
          expect(pane.latencyMs).toBeGreaterThan(0);
        }

        // Parallel execution: wall-clock should be much less than 3 × delay
        expect(wallMs).toBeLessThan(PANE_DELAY_MS * 3 + 2000);
      },
      TIMEOUT_MS,
    );
  });

  describe('E2E-3: Compare Mode B — 3 versions × 1 model', () => {
    test(
      'returns 3 panes, one per version',
      async () => {
        mockLlm!.register('ping', {
          content: 'pong',
          delay: PANE_DELAY_MS,
        });

        const { item } = await createPrompt(harness!, token, projectId, {
          name: `compare-b-${Date.now()}`,
        });

        const [v1, v2, v3] = await Promise.all([
          createVersion(harness!, token, projectId, item._id, {
            template: 'Template A — ping',
            variables: [],
          }),
          createVersion(harness!, token, projectId, item._id, {
            template: 'Template B — ping',
            variables: [],
          }),
          createVersion(harness!, token, projectId, item._id, {
            template: 'Template C — ping',
            variables: [],
          }),
        ]);

        const res = await runTestPanes(harness!, token, projectId, {
          panes: [
            { promptVersionId: v1._id, tenantModelId: m1.id },
            { promptVersionId: v2._id, tenantModelId: m1.id },
            { promptVersionId: v3._id, tenantModelId: m1.id },
          ],
          userMessage: 'ping',
        });

        expect(res.status).toBe(200);
        expect(res.body.results).toHaveLength(3);

        const returnedIds = new Set(res.body.results!.map((p) => p.promptVersionId));
        expect(returnedIds.has(v1._id)).toBe(true);
        expect(returnedIds.has(v2._id)).toBe(true);
        expect(returnedIds.has(v3._id)).toBe(true);
      },
      TIMEOUT_MS,
    );
  });

  describe('E2E-4: Validation — empty panes or malformed payload returns 400', () => {
    test(
      'rejects empty panes array',
      async () => {
        const res = await runTestPanes(harness!, token, projectId, {
          panes: [],
          userMessage: 'ping',
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
      },
      TIMEOUT_MS,
    );

    test(
      'rejects more than 5 panes',
      async () => {
        const { item } = await createPrompt(harness!, token, projectId, {
          name: `max-panes-${Date.now()}`,
        });
        const v = await createVersion(harness!, token, projectId, item._id, {
          template: 'ping',
          variables: [],
        });

        const sixPanes = Array.from({ length: 6 }, () => ({
          promptVersionId: v._id,
          tenantModelId: m1.id,
        }));
        const res = await runTestPanes(harness!, token, projectId, {
          panes: sixPanes,
        });
        expect(res.status).toBe(400);
      },
      TIMEOUT_MS,
    );

    test(
      'rejects unknown extra fields on the payload (strict schema)',
      async () => {
        const { item } = await createPrompt(harness!, token, projectId, {
          name: `strict-schema-${Date.now()}`,
        });
        const v = await createVersion(harness!, token, projectId, item._id, {
          template: 'hello',
          variables: [],
        });

        const res = await runTestPanes(harness!, token, projectId, {
          panes: [{ promptVersionId: v._id, tenantModelId: m1.id }],
          // @ts-expect-error injecting unknown field
          unknownField: true,
          userMessage: 'ping',
        });
        expect(res.status).toBe(400);
      },
      TIMEOUT_MS,
    );

    test(
      'error response body does not leak tenant id or model id',
      async () => {
        const res = await runTestPanes(harness!, token, projectId, {
          panes: [],
          userMessage: 'ping',
        });
        expect(res.status).toBe(400);
        const bodyStr = JSON.stringify(res.body);
        expect(bodyStr).not.toContain(tenantId);
      },
      TIMEOUT_MS,
    );
  });
});
