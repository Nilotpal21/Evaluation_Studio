/**
 * Agent SDK scenario: HTTP Tool Execution (7).
 *
 * Creates an agent with an HTTP tool definition pointing at the mock tool server,
 * sends a weather query, and verifies the tool was called and response includes weather data.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { registerScenario, fetchJson } from './index.js';
import type { ScenarioContext, ScenarioResult } from '../types.js';

registerScenario(
  7,
  'HTTP Tool Execution',
  async (ctx: ScenarioContext): Promise<ScenarioResult> => {
    const start = Date.now();
    const { sandbox, studioUrl, runtimeUrl, mockToolServer, mockLlm } = ctx;

    // Register mock LLM to return a tool call for weather queries,
    // then return the weather data in the follow-up
    mockLlm.reset();
    mockLlm.registerToolCall('weather', {
      name: 'get_weather',
      arguments: { city: 'Paris' },
      followUpContent: 'The weather in Paris is 22 degrees and sunny.',
    });

    // Create agent with HTTP tool DSL
    const agentRes = await fetchJson<{ id?: string; agent?: { id?: string } }>(
      `${studioUrl}/api/projects/${sandbox.projectId}/agents`,
      {
        method: 'POST',
        body: {
          name: 'tool_agent',
          agentPath: 'agents/tool_agent',
          description: 'Weather tool agent',
        },
        token: sandbox.authToken,
      },
    );

    if (agentRes.status !== 201) {
      return {
        id: 7,
        name: 'HTTP Tool Execution',
        passed: false,
        durationMs: Date.now() - start,
        error: `Failed to create tool agent: ${agentRes.status}`,
      };
    }

    // Set DSL on tool agent via PUT /api/projects/:projectId/agents/:agentName/dsl
    const toolAgentDsl = `AGENT: tool_agent

GOAL: "Help users check weather"

TOOLS:
  get_weather(city: string) -> object
    type: http
    endpoint: "${mockToolServer.url}/weather"
    method: GET
    description: "Get current weather for a city"

    QUERY_PARAMS:
      city: "{{input.city}}"
`;

    await fetchJson(`${studioUrl}/api/projects/${sandbox.projectId}/agents/tool_agent/dsl`, {
      method: 'PUT',
      body: { dslContent: toolAgentDsl },
      token: sandbox.authToken,
    });

    // Set entry agent
    await fetchJson(`${studioUrl}/api/projects/${sandbox.projectId}`, {
      method: 'PATCH',
      body: { entryAgentName: 'tool_agent' },
      token: sandbox.authToken,
    });

    // Dispatch agent to test
    const agentPrompt = `You are a test executor. Do the following steps:

1. Send an HTTP POST request to ${runtimeUrl}/api/v1/chat/agent with this JSON body:
   {"projectId": "${sandbox.projectId}", "message": "What is the weather in Paris?"}
   Include header: Authorization: Bearer ${sandbox.authToken}

2. Read the JSON response.

3. Check if the "response" field mentions temperature (22) or "sunny" or "Paris".
   Also check if "traceEvents" contains any tool-related spans.

4. Report your finding as exactly one of these lines:
   RESULT: PASS - [reason]
   RESULT: FAIL - [reason]`;

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
        id: 7,
        name: 'HTTP Tool Execution',
        passed: false,
        durationMs: Date.now() - start,
        error: `Agent SDK error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const passed = agentResult.includes('RESULT: PASS');

    return {
      id: 7,
      name: 'HTTP Tool Execution',
      passed,
      durationMs: Date.now() - start,
      error: !passed ? `Agent reported: ${agentResult.slice(0, 500)}` : undefined,
      details: agentResult.slice(0, 200),
    };
  },
  'agent-sdk',
);
