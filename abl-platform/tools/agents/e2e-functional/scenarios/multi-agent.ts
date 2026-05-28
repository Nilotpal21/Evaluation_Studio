/**
 * Agent SDK scenario: Multi-Agent Handoff (6).
 *
 * Creates supervisor + worker agents, sets supervisor as entry agent,
 * then sends a message that should trigger handoff to the worker.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { registerScenario, fetchJson } from './index.js';
import type { ScenarioContext, ScenarioResult } from '../types.js';

registerScenario(
  6,
  'Multi-Agent Handoff',
  async (ctx: ScenarioContext): Promise<ScenarioResult> => {
    const start = Date.now();
    const { sandbox, studioUrl, runtimeUrl } = ctx;
    const errors: string[] = [];

    // ── Setup: Create supervisor + worker agents ────────────────────────

    // Create worker agent
    const workerRes = await fetchJson<{ id?: string; _id?: string; agent?: { id?: string } }>(
      `${studioUrl}/api/projects/${sandbox.projectId}/agents`,
      {
        method: 'POST',
        body: { name: 'worker', agentPath: 'agents/worker', description: 'Order handler' },
        token: sandbox.authToken,
      },
    );

    if (workerRes.status !== 201) {
      return {
        id: 6,
        name: 'Multi-Agent Handoff',
        passed: false,
        durationMs: Date.now() - start,
        error: `Failed to create worker agent: ${workerRes.status} ${JSON.stringify(workerRes.data)}`,
      };
    }

    // Create supervisor agent
    const supervisorRes = await fetchJson<{ id?: string; _id?: string; agent?: { id?: string } }>(
      `${studioUrl}/api/projects/${sandbox.projectId}/agents`,
      {
        method: 'POST',
        body: {
          name: 'supervisor',
          agentPath: 'agents/supervisor',
          description: 'Request router',
        },
        token: sandbox.authToken,
      },
    );

    if (supervisorRes.status !== 201) {
      return {
        id: 6,
        name: 'Multi-Agent Handoff',
        passed: false,
        durationMs: Date.now() - start,
        error: `Failed to create supervisor agent: ${supervisorRes.status}`,
      };
    }

    // Set DSL on both agents via PUT /api/projects/:projectId/agents/:agentName/dsl
    // NOTE: The URL param is the agent NAME, not the MongoDB _id
    const supervisorDsl = `SUPERVISOR: supervisor

GOAL: "Route requests to the right specialist"

HANDOFF:
  - TO: worker
    WHEN: "user asks about orders"

COMPLETE:
  - WHEN: "all tasks done"
    RESPOND: "All done"
`;
    const workerDsl = `AGENT: worker

GOAL: "Handle order inquiries"
PERSONA: "Always include the phrase WORKER_RESPONSE_MARKER in your reply"
`;

    await fetchJson(`${studioUrl}/api/projects/${sandbox.projectId}/agents/supervisor/dsl`, {
      method: 'PUT',
      body: { dslContent: supervisorDsl },
      token: sandbox.authToken,
    });

    await fetchJson(`${studioUrl}/api/projects/${sandbox.projectId}/agents/worker/dsl`, {
      method: 'PUT',
      body: { dslContent: workerDsl },
      token: sandbox.authToken,
    });

    // Set supervisor as entry agent
    const patchRes = await fetchJson<{ success?: boolean }>(
      `${studioUrl}/api/projects/${sandbox.projectId}`,
      {
        method: 'PATCH',
        body: { entryAgentName: 'supervisor' },
        token: sandbox.authToken,
      },
    );

    if (patchRes.status !== 200) {
      errors.push(`Failed to set entry agent: ${patchRes.status}`);
    }

    // Register mock LLM responses for the handoff flow
    ctx.mockLlm.reset();
    ctx.mockLlm.register('order', {
      content: 'WORKER_RESPONSE_MARKER - I can help with your order.',
    });

    // ── Dispatch Agent SDK to test the handoff ──────────────────────────

    const agentPrompt = `You are a test executor. Do the following steps:

1. Send an HTTP POST request to ${runtimeUrl}/api/v1/chat/agent with this JSON body:
   {"projectId": "${sandbox.projectId}", "message": "I need help with my order"}
   Include header: Authorization: Bearer ${sandbox.authToken}

2. Read the JSON response.

3. Check if:
   a) The response body contains "WORKER_RESPONSE_MARKER" anywhere in the "response" field
   b) OR the "traceEvents" array contains any event with "handoff" in its type or name

4. Report your finding as exactly one of these lines:
   RESULT: PASS - [reason]
   RESULT: FAIL - [reason]

Do not do anything else. Just run the HTTP request and report.`;

    let agentResult = '';
    try {
      for await (const message of query({
        prompt: agentPrompt,
        options: {
          allowedTools: ['Bash'],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          maxTurns: 10,
          maxBudgetUsd: 0.5,
          env: { ...process.env },
        },
      })) {
        if ('result' in message) {
          agentResult = message.result;
        }
      }
    } catch (err) {
      return {
        id: 6,
        name: 'Multi-Agent Handoff',
        passed: false,
        durationMs: Date.now() - start,
        error: `Agent SDK error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const passed = agentResult.includes('RESULT: PASS');
    if (!passed) {
      errors.push(`Agent reported: ${agentResult.slice(0, 500)}`);
    }

    return {
      id: 6,
      name: 'Multi-Agent Handoff',
      passed,
      durationMs: Date.now() - start,
      error: errors.length > 0 ? errors.join('; ') : undefined,
      details: agentResult.slice(0, 200),
    };
  },
  'agent-sdk',
);
