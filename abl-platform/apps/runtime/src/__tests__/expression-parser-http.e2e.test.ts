import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from './helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  importProjectFiles,
  requestJson,
  type BootstrapProjectResult,
} from './helpers/channel-e2e-bootstrap.js';

const POLICY_AGENT_DSL = `AGENT: Policy_Agent
GOAL: "Validate policy expressions through the runtime API"

CONSTRAINTS:
  always:
    - REQUIRE message.title == "A OR B" AND ticket.status == "ready"
      ON_FAIL: "Need the ready title."
    - RESTRICT user.role NOT IN ["admin", "moderator"]
      ON_FAIL: "Restricted role."
`;

describe('expression parser runtime HTTP regression coverage', () => {
  let harness: RuntimeApiHarness;
  let owner: BootstrapProjectResult;
  let outsider: BootstrapProjectResult;

  beforeAll(async () => {
    harness = await startRuntimeServerHarness();
    owner = await bootstrapProject(
      harness,
      'expr-owner@example.com',
      'expr-owner-tenant',
      'expr-owner-project',
    );
    outsider = await bootstrapProject(
      harness,
      'expr-outsider@example.com',
      'expr-outsider-tenant',
      'expr-outsider-project',
    );

    await importProjectFiles(harness, owner.token, owner.projectId, {
      'agents/policy_agent.agent.abl': POLICY_AGENT_DSL,
    });
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  test('requires auth for project-scoped agent reads', async () => {
    const response = await requestJson<{ success: boolean; error?: unknown }>(
      harness,
      `/api/projects/${owner.projectId}/agents/Policy_Agent`,
      {
        method: 'GET',
      },
    );

    expect(response.status).toBe(401);
    expect(response.body).toBeDefined();
  });

  test('returns 400 for invalid validate payloads before running project validation', async () => {
    const response = await requestJson<{ success: boolean; error?: unknown }>(
      harness,
      `/api/projects/${owner.projectId}/validate`,
      {
        method: 'POST',
        headers: authHeaders(owner.token),
        body: { agentNames: [123] },
      },
    );

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  test('imports and compiles agents that contain NOT IN and quoted logical tokens', async () => {
    const projectAgent = await requestJson<{
      success: boolean;
      agent: { name: string; dslContent: string };
    }>(harness, `/api/projects/${owner.projectId}/agents/Policy_Agent`, {
      method: 'GET',
      headers: authHeaders(owner.token),
    });

    expect(projectAgent.status).toBe(200);
    expect(projectAgent.body.success).toBe(true);
    expect(projectAgent.body.agent.name).toBe('Policy_Agent');
    expect(projectAgent.body.agent.dslContent).toContain(
      'REQUIRE message.title == "A OR B" AND ticket.status == "ready"',
    );
    expect(projectAgent.body.agent.dslContent).toContain(
      'RESTRICT user.role NOT IN ["admin", "moderator"]',
    );

    const compiledAgent = await requestJson<{
      success: boolean;
      agent: {
        name: string;
        ir?: {
          constraints?: {
            constraints?: Array<{
              kind?: string;
              condition?: string;
            }>;
          };
        };
      };
    }>(harness, '/api/agents/Policy_Agent', {
      method: 'GET',
      headers: authHeaders(owner.token),
    });

    expect(compiledAgent.status).toBe(200);
    expect(compiledAgent.body.success).toBe(true);
    expect(compiledAgent.body.agent.name).toBe('Policy_Agent');
    expect(compiledAgent.body.agent.ir).toBeDefined();
    expect(compiledAgent.body.agent.ir?.constraints?.constraints).toMatchObject([
      {
        kind: 'require',
        condition:
          '(message.title IS NOT SET AND ticket.status IS NOT SET) OR (message.title == "A OR B" AND ticket.status == "ready")',
      },
      {
        kind: 'restrict',
        condition: 'user.role IS NOT SET OR NOT (user.role NOT IN ["admin", "moderator"])',
      },
    ]);

    const validation = await requestJson<{ success: boolean; data?: unknown }>(
      harness,
      `/api/projects/${owner.projectId}/validate`,
      {
        method: 'POST',
        headers: authHeaders(owner.token),
        body: { agentNames: ['Policy_Agent'] },
      },
    );

    expect(validation.status).toBe(200);
    expect(validation.body.success).toBe(true);
    expect(validation.body.data).toBeDefined();
  });

  test('conceals the imported agent from other tenants', async () => {
    const response = await requestJson<{ success: boolean; error?: unknown }>(
      harness,
      `/api/projects/${owner.projectId}/agents/Policy_Agent`,
      {
        method: 'GET',
        headers: authHeaders(outsider.token),
      },
    );

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
  });
});
