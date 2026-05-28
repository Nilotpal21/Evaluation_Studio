/**
 * MCP Testing Tools
 *
 * Tools for testing agent conversations and retrieving test results.
 * All tools are REMOTE (require platform auth).
 */

export interface TestingTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const testingTools: TestingTool[] = [
  {
    name: 'kore_test_conversation',
    description:
      'Test an agent by creating a session and sending a sequence of messages. Returns the full conversation with agent responses and trace events.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        agentName: { type: 'string', description: 'Name of the agent to test' },
        messages: {
          type: 'array',
          description: 'Array of user messages to send sequentially',
          items: { type: 'string' },
        },
        channelId: { type: 'string', description: 'Optional channel ID for the test session' },
      },
      required: ['projectId', 'agentName', 'messages'],
    },
  },
  {
    name: 'kore_test_scenario',
    description:
      'Run a test scenario with expected outcomes. Sends messages sequentially and checks each agent response against expectations. Reports pass/fail per step.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        agentName: { type: 'string', description: 'Name of the agent to test' },
        steps: {
          type: 'array',
          description:
            'Array of test steps: [{ message: string, expect?: { contains?: string, notContains?: string, contextHas?: Record<string, unknown> } }]',
          items: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              expect: {
                type: 'object',
                properties: {
                  contains: { type: 'string', description: 'Response should contain this text' },
                  notContains: {
                    type: 'string',
                    description: 'Response should NOT contain this text',
                  },
                },
              },
            },
            required: ['message'],
          },
        },
      },
      required: ['projectId', 'agentName', 'steps'],
    },
  },
  {
    name: 'kore_get_test_results',
    description:
      'Get detailed trace results for a test session. Returns all trace events for analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        sessionId: { type: 'string', description: 'Session ID from a test run' },
      },
      required: ['projectId', 'sessionId'],
    },
  },
];

/** Handle a testing tool call */
export async function handleTestingTool(
  name: string,
  args: Record<string, unknown>,
  apiUrl: string,
  headers: Record<string, string>,
): Promise<unknown> {
  switch (name) {
    case 'kore_test_conversation': {
      const { projectId, agentName, messages, channelId } = args as {
        projectId: string;
        agentName: string;
        messages: string[];
        channelId?: string;
      };

      // Create a test session
      const createRes = await fetch(
        `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/sessions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            agentName,
            channel: channelId ?? 'mcp-test',
            metadata: { source: 'mcp-test' },
          }),
        },
      );
      if (!createRes.ok) throw new Error(`Failed to create session: ${createRes.statusText}`);
      const session = (await createRes.json()) as { sessionId: string };

      // Send messages sequentially
      const results: Array<{ userMessage: string; agentResponse: unknown }> = [];
      for (const message of messages) {
        const msgRes = await fetch(
          `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(session.sessionId)}/messages`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ text: message }),
          },
        );
        if (!msgRes.ok) throw new Error(`Failed to send message: ${msgRes.statusText}`);
        const response = await msgRes.json();
        results.push({ userMessage: message, agentResponse: response });
      }

      // Get traces
      const tracesRes = await fetch(
        `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(session.sessionId)}/traces`,
        { headers },
      );
      const traces = tracesRes.ok ? await tracesRes.json() : null;

      return {
        sessionId: session.sessionId,
        conversation: results,
        traceCount: (traces as { traces?: unknown[] })?.traces?.length ?? 0,
        traces: (traces as { traces?: unknown[] })?.traces ?? [],
      };
    }

    case 'kore_test_scenario': {
      const { projectId, agentName, steps } = args as {
        projectId: string;
        agentName: string;
        steps: Array<{
          message: string;
          expect?: { contains?: string; notContains?: string };
        }>;
      };

      // Create session
      const createRes = await fetch(
        `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/sessions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            agentName,
            channel: 'mcp-test',
            metadata: { source: 'mcp-test-scenario' },
          }),
        },
      );
      if (!createRes.ok) throw new Error(`Failed to create session: ${createRes.statusText}`);
      const session = (await createRes.json()) as { sessionId: string };

      // Run steps
      const stepResults: Array<{
        step: number;
        message: string;
        response: string;
        pass: boolean;
        failures: string[];
      }> = [];

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const msgRes = await fetch(
          `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(session.sessionId)}/messages`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ text: step.message }),
          },
        );
        if (!msgRes.ok) throw new Error(`Step ${i + 1} failed to send: ${msgRes.statusText}`);
        const response = (await msgRes.json()) as { text?: string; message?: string };
        const responseText = response.text ?? response.message ?? JSON.stringify(response);

        const failures: string[] = [];
        if (step.expect?.contains && !responseText.includes(step.expect.contains)) {
          failures.push(`Expected response to contain "${step.expect.contains}"`);
        }
        if (step.expect?.notContains && responseText.includes(step.expect.notContains)) {
          failures.push(`Expected response NOT to contain "${step.expect.notContains}"`);
        }

        stepResults.push({
          step: i + 1,
          message: step.message,
          response: responseText,
          pass: failures.length === 0,
          failures,
        });
      }

      const allPassed = stepResults.every((r) => r.pass);
      return {
        sessionId: session.sessionId,
        passed: allPassed,
        totalSteps: steps.length,
        passedSteps: stepResults.filter((r) => r.pass).length,
        failedSteps: stepResults.filter((r) => !r.pass).length,
        results: stepResults,
      };
    }

    case 'kore_get_test_results': {
      const { projectId, sessionId } = args as { projectId: string; sessionId: string };
      const response = await fetch(
        `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/traces`,
        { headers },
      );
      if (!response.ok) throw new Error(`Failed to get traces: ${response.statusText}`);
      return response.json();
    }

    default:
      throw new Error(`Unknown testing tool: ${name}`);
  }
}
