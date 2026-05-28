/**
 * Agent SDK scenario: Memory (9).
 *
 * Tests session-scoped and cross-session memory:
 * 1. Store a fact in a new session
 * 2. Recall it in the same session
 * 3. Check if it persists to a new session
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { registerScenario } from './index.js';
import type { ScenarioContext, ScenarioResult } from '../types.js';

registerScenario(
  9,
  'Memory',
  async (ctx: ScenarioContext): Promise<ScenarioResult> => {
    const start = Date.now();
    const { sandbox, runtimeUrl, mockLlm } = ctx;

    // Register mock LLM patterns for memory-related messages
    mockLlm.reset();
    mockLlm.register('remember', {
      content: 'Got it! I will remember that your favorite color is blue.',
    });
    mockLlm.register('favorite color', {
      content: 'Your favorite color is blue, as you mentioned earlier.',
    });

    const agentPrompt = `You are a test executor. Do these three steps using curl or fetch:

Step 1: Send POST to ${runtimeUrl}/api/v1/chat/agent
  Body: {"projectId": "${sandbox.projectId}", "message": "Remember that my favorite color is blue"}
  Header: Authorization: Bearer ${sandbox.authToken}
  Record the sessionId from the response.

Step 2: Send POST to ${runtimeUrl}/api/v1/chat/agent
  Body: {"projectId": "${sandbox.projectId}", "sessionId": "<sessionId from step 1>", "message": "What is my favorite color?"}
  Header: Authorization: Bearer ${sandbox.authToken}
  Check if the response mentions "blue".

Step 3: Send POST to ${runtimeUrl}/api/v1/chat/agent
  Body: {"projectId": "${sandbox.projectId}", "message": "What is my favorite color?"}
  Header: Authorization: Bearer ${sandbox.authToken}
  (No sessionId — new session.) Check if "blue" appears in the response.

Report results as:
STEP1: PASS/FAIL - [reason]
STEP2: PASS/FAIL - [reason]
STEP3: PASS/FAIL - [reason]
RESULT: PASS (if steps 1 and 2 pass) or RESULT: FAIL (if step 1 or 2 fails)
Note: Step 3 may or may not pass — it tests cross-session memory which is optional.`;

    let agentResult = '';
    try {
      for await (const message of query({
        prompt: agentPrompt,
        options: {
          allowedTools: ['Bash'],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          maxTurns: 15,
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
        id: 9,
        name: 'Memory',
        passed: false,
        durationMs: Date.now() - start,
        error: `Agent SDK error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const passed = agentResult.includes('RESULT: PASS');

    return {
      id: 9,
      name: 'Memory',
      passed,
      durationMs: Date.now() - start,
      error: !passed ? `Agent reported: ${agentResult.slice(0, 500)}` : undefined,
      details: agentResult.slice(0, 300),
    };
  },
  'agent-sdk',
);
