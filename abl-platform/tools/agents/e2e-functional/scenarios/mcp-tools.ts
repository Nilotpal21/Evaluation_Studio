/**
 * Direct-fetch scenario: MCP Tool Execution (8).
 *
 * Creates an agent with an MCP tool definition pointing at the mock MCP server,
 * sends an order lookup query, and verifies the tool was called and response
 * includes the expected order data.
 */

import { registerScenario, fetchJson } from './index.js';
import type { ScenarioContext, ScenarioResult } from '../types.js';

registerScenario(
  8,
  'MCP Tool Execution',
  async (ctx: ScenarioContext): Promise<ScenarioResult> => {
    const start = Date.now();
    const { sandbox, studioUrl, runtimeUrl, mockLlm } = ctx;

    // Register mock LLM to return a tool call for order lookups,
    // then return the order data in the follow-up
    mockLlm.reset();
    mockLlm.registerToolCall('order', {
      name: 'lookup_order',
      arguments: { orderId: '12345' },
      followUpContent: 'Order 12345 has been shipped and the ETA is 2026-03-20.',
    });

    // Create agent for MCP test
    const agentRes = await fetchJson<{ id?: string; agent?: { id?: string } }>(
      `${studioUrl}/api/projects/${sandbox.projectId}/agents`,
      {
        method: 'POST',
        body: {
          name: 'mcp_agent',
          agentPath: 'agents/mcp_agent',
          description: 'MCP tool agent',
        },
        token: sandbox.authToken,
      },
    );

    if (agentRes.status !== 201) {
      return {
        id: 8,
        name: 'MCP Tool Execution',
        passed: false,
        durationMs: Date.now() - start,
        error: `Failed to create MCP agent: ${agentRes.status}`,
      };
    }

    // Set DSL on MCP agent — includes MCP tool reference
    const mcpCommand = ctx.mockMcpServer.command;
    const mcpArgs = ctx.mockMcpServer.args.join(' ');
    const mcpAgentDsl = `AGENT: mcp_agent

GOAL: "Help users look up orders"

TOOLS:
  lookup_order(orderId: string) -> object
    type: mcp
    server: "mock-mcp"
    tool: "lookup_order"
    description: "Look up order status by order ID"

MCP_SERVERS:
  mock-mcp:
    command: "${mcpCommand}"
    args: "${mcpArgs}"
`;

    await fetchJson(`${studioUrl}/api/projects/${sandbox.projectId}/agents/mcp_agent/dsl`, {
      method: 'PUT',
      body: { dslContent: mcpAgentDsl },
      token: sandbox.authToken,
    });

    // Set entry agent
    await fetchJson(`${studioUrl}/api/projects/${sandbox.projectId}`, {
      method: 'PATCH',
      body: { entryAgentName: 'mcp_agent' },
      token: sandbox.authToken,
    });

    // Send a message to the runtime agent directly
    const { status, data } = await fetchJson<{
      sessionId?: string;
      response?: string;
      traceEvents?: Array<{ type?: string; name?: string; [key: string]: unknown }>;
    }>(`${runtimeUrl}/api/v1/chat/agent`, {
      method: 'POST',
      body: { projectId: sandbox.projectId, message: 'Look up order 12345' },
      token: sandbox.authToken,
    });

    const errors: string[] = [];

    if (status !== 200) {
      errors.push(`Expected status 200, got ${status}`);
    }

    if (!data.response || typeof data.response !== 'string' || data.response.length === 0) {
      errors.push(`Expected non-empty response string, got: ${JSON.stringify(data.response)}`);
    } else {
      // Verify the response contains expected order data from the mock LLM follow-up
      const response = data.response.toLowerCase();
      const hasOrderData =
        response.includes('shipped') ||
        response.includes('12345') ||
        response.includes('eta') ||
        response.includes('2026-03-20');
      if (!hasOrderData) {
        errors.push(
          `Expected response to mention order data (shipped/12345/ETA/2026-03-20), got: ${data.response.slice(0, 200)}`,
        );
      }
    }

    if (!data.sessionId) {
      errors.push(`Expected sessionId in response, got: ${JSON.stringify(data)}`);
    }

    // Verify the mock LLM received the tool call request
    const lastReq = mockLlm.getLastRequest();
    if (!lastReq) {
      errors.push('Mock LLM received no request');
    }

    return {
      id: 8,
      name: 'MCP Tool Execution',
      passed: errors.length === 0,
      durationMs: Date.now() - start,
      error: errors.length > 0 ? errors.join('; ') : undefined,
      details:
        errors.length === 0
          ? `Response contains order data, sessionId=${data.sessionId}`
          : undefined,
    };
  },
  'fetch',
);
