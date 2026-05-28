#!/usr/bin/env npx tsx
/**
 * Rich Content E2E Test Script
 *
 * Tests that FORMATS blocks and VOICE configs flow through the WebSocket
 * channels end-to-end: DSL → Parser → Compiler → Runtime → Transport → Client.
 *
 * Prerequisites:
 *   1. Runtime server running: cd apps/runtime && pnpm dev
 *   2. MongoDB seeded with updated agents: pnpm seed:dev
 *
 * Usage (run from project root):
 *   cd apps/runtime && npx tsx ../../scripts/test-rich-content.ts
 *   cd apps/runtime && npx tsx ../../scripts/test-rich-content.ts --agent=Hotel_Search
 *   cd apps/runtime && npx tsx ../../scripts/test-rich-content.ts --inspect
 *   cd apps/runtime && npx tsx ../../scripts/test-rich-content.ts --rest
 *
 * Modes:
 *   (default)    Test all agents via debug WebSocket, check richContent + voiceConfig
 *   --agent=X    Test a specific agent only
 *   --inspect    Show full rich content payload for one agent (use with --agent=X)
 *   --rest       Also test the REST /api/chat/agent endpoint
 */

import WebSocket from 'ws';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const RUNTIME_HOST = process.env.RUNTIME_HOST || 'localhost';
const RUNTIME_PORT = process.env.RUNTIME_PORT || '3112';
const DEV_LOGIN_EMAIL = process.env.TEST_EMAIL || 'rich-content-tester@example.com';
const WEB_DEBUG_WS_AUTH_PROTOCOL = 'web-debug-auth';

// Test agents that have FORMATS + VOICE blocks
const TEST_AGENTS: Record<
  string,
  { messages: string[]; expectRichContent: boolean; expectVoiceConfig: boolean }
> = {
  Simple_Booking_Flow: {
    messages: [], // Flow agent — welcome step fires automatically on load
    expectRichContent: true,
    expectVoiceConfig: true,
  },
  Hotel_Search: {
    messages: [], // Reasoning agent with ON_START — fires automatically
    expectRichContent: true,
    expectVoiceConfig: true,
  },
  Welcome_Agent: {
    messages: [], // Flow agent — check_user step fires automatically
    expectRichContent: true,
    expectVoiceConfig: true,
  },
  Farewell_Agent: {
    messages: [], // Flow agent — offer_feedback step fires automatically
    expectRichContent: false, // First step is a PROMPT, not a RESPOND with FORMATS
    expectVoiceConfig: true,
  },
  Booking_Manager: {
    messages: ['I want to view my booking'],
    expectRichContent: false, // Rich content only on COMPLETE/ON_ERROR, not normal responses
    expectVoiceConfig: false,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function getAccessToken(): Promise<string> {
  if (process.env.ACCESS_TOKEN?.trim()) {
    return process.env.ACCESS_TOKEN;
  }

  const response = await fetch(`http://${RUNTIME_HOST}:${RUNTIME_PORT}/api/auth/dev-login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: DEV_LOGIN_EMAIL }),
  });

  if (!response.ok) {
    throw new Error(`Failed to obtain dev-login token (${response.status})`);
  }

  const body = (await response.json()) as { accessToken?: string };
  if (!body.accessToken) {
    throw new Error('Dev-login response did not include an access token');
  }

  return body.accessToken;
}

function buildWebDebugWsProtocols(token: string): string[] {
  return [WEB_DEBUG_WS_AUTH_PROTOCOL, token];
}

function color(text: string, code: string): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

const green = (t: string) => color(t, '32');
const red = (t: string) => color(t, '31');
const yellow = (t: string) => color(t, '33');
const cyan = (t: string) => color(t, '36');
const dim = (t: string) => color(t, '2');
const bold = (t: string) => color(t, '1');

interface TestResult {
  agent: string;
  passed: boolean;
  richContentReceived: boolean;
  voiceConfigReceived: boolean;
  actionsReceived: boolean;
  responseText: string;
  richContentFormats: string[];
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN TEST RUNNER
// ─────────────────────────────────────────────────────────────────────────────

async function testAgent(
  agentName: string,
  config: (typeof TEST_AGENTS)[string],
): Promise<TestResult> {
  const result: TestResult = {
    agent: agentName,
    passed: false,
    richContentReceived: false,
    voiceConfigReceived: false,
    actionsReceived: false,
    responseText: '',
    richContentFormats: [],
  };

  return new Promise((resolve) => {
    void (async () => {
      const token = await getAccessToken();
      const wsUrl = `ws://${RUNTIME_HOST}:${RUNTIME_PORT}/ws`;
      const ws = new WebSocket(wsUrl, buildWebDebugWsProtocols(token));
      let sessionId: string | undefined;
      let responseCount = 0;
      const timeout = setTimeout(() => {
        result.error = 'Timeout (15s)';
        ws.close();
        resolve(result);
      }, 15000);

      ws.on('open', () => {
        console.log(dim(`  [${agentName}] Connected to WS`));
      });

      ws.on('error', (err) => {
        result.error = `WS Error: ${err.message}`;
        clearTimeout(timeout);
        resolve(result);
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        if (!result.error) {
          result.passed = true;
        }
        resolve(result);
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case 'info':
            console.log(dim(`  [${agentName}] Server: ${msg.message}`));
            // Load the agent
            ws.send(JSON.stringify({ type: 'load_agent', agentPath: agentName }));
            break;

          case 'agent_loaded':
            sessionId = msg.sessionId;
            console.log(dim(`  [${agentName}] Agent loaded, session: ${sessionId}`));
            if (config.messages.length > 0) {
              // Wait briefly for any auto-init response_end, then send first message
              setTimeout(() => {
                if (responseCount === 0) {
                  ws.send(
                    JSON.stringify({ type: 'send_message', sessionId, text: config.messages[0] }),
                  );
                }
              }, 500);
            }
            // For agents with no messages: the flow/ON_START init fires automatically
            // and we'll get response_end events without sending anything
            break;

          case 'agent_load_error':
            result.error = `Agent load failed: ${msg.error}`;
            clearTimeout(timeout);
            ws.close();
            break;

          case 'response_start':
            console.log(dim(`  [${agentName}] Response started...`));
            break;

          case 'response_chunk':
            // Accumulate but don't log each chunk
            break;

          case 'response_end':
            responseCount++;
            result.responseText = msg.fullText || '';

            // Check for rich content
            if (msg.richContent) {
              result.richContentReceived = true;
              const formats: string[] = [];
              if (msg.richContent.markdown) formats.push('markdown');
              if (msg.richContent.adaptive_card) formats.push('adaptive_card');
              if (msg.richContent.html) formats.push('html');
              if (msg.richContent.slack) formats.push('slack');
              if (msg.richContent.ag_ui) formats.push('ag_ui');
              if (msg.richContent.whatsapp) formats.push('whatsapp');
              result.richContentFormats = formats;
            }

            // Check for voice config
            if (msg.voiceConfig) {
              result.voiceConfigReceived = true;
            }

            // Check for actions
            if (msg.actions) {
              result.actionsReceived = true;
            }

            console.log(
              dim(
                `  [${agentName}] Response #${responseCount}: "${result.responseText.slice(0, 80)}..."`,
              ),
            );
            if (result.richContentReceived) {
              console.log(
                cyan(
                  `  [${agentName}] richContent formats: [${result.richContentFormats.join(', ')}]`,
                ),
              );
            }
            if (result.voiceConfigReceived) {
              console.log(cyan(`  [${agentName}] voiceConfig: present`));
            }
            if (result.actionsReceived) {
              console.log(cyan(`  [${agentName}] actions: present`));
            }

            // Close after first meaningful response (or after 2nd for multi-step flow init)
            result.passed = true;
            clearTimeout(timeout);
            ws.close();
            break;

          case 'state_update':
            // Ignore state updates
            break;

          case 'trace_event':
            // Ignore trace events
            break;

          case 'action_taken':
            break;

          case 'error':
            console.log(red(`  [${agentName}] Server error: ${msg.message}`));
            result.error = `Server error: ${msg.message}`;
            clearTimeout(timeout);
            ws.close();
            break;

          default:
            console.log(dim(`  [${agentName}] Unknown message type: ${msg.type}`));
        }
      });
    })().catch((error: unknown) => {
      result.error = error instanceof Error ? error.message : String(error);
      resolve(result);
    });
  });
}

async function testRestChannel(agentName: string): Promise<TestResult> {
  const result: TestResult = {
    agent: `${agentName} (REST)`,
    passed: false,
    richContentReceived: false,
    voiceConfigReceived: false,
    actionsReceived: false,
    responseText: '',
    richContentFormats: [],
  };

  try {
    const token = await getAccessToken();

    // First, we need a session. Use the debug WS to create one, then test REST.
    // Or directly hit the REST chat endpoint if it exists.
    const chatUrl = `http://${RUNTIME_HOST}:${RUNTIME_PORT}/api/v1/chat/agent`;
    const response = await fetch(chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        agentPath: agentName,
        message: 'Hello',
      }),
    });

    if (!response.ok) {
      result.error = `REST ${response.status}: ${await response.text()}`;
      return result;
    }

    const data = (await response.json()) as Record<string, unknown>;
    result.responseText = (data.response as string) || '';

    if (data.richContent) {
      result.richContentReceived = true;
      const rc = data.richContent as Record<string, unknown>;
      const formats: string[] = [];
      if (rc.markdown) formats.push('markdown');
      if (rc.html) formats.push('html');
      if (rc.adaptive_card) formats.push('adaptive_card');
      result.richContentFormats = formats;
    }

    if (data.voiceConfig) result.voiceConfigReceived = true;
    if (data.actions) result.actionsReceived = true;

    result.passed = true;
  } catch (err: unknown) {
    result.error = `REST error: ${(err as Error).message}`;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORT
// ─────────────────────────────────────────────────────────────────────────────

function printReport(results: TestResult[]) {
  console.log('\n' + bold('═══════════════════════════════════════════════════════════════'));
  console.log(bold('  Rich Content E2E Test Results'));
  console.log(bold('═══════════════════════════════════════════════════════════════'));

  let passed = 0;
  let failed = 0;
  let warnings = 0;

  for (const r of results) {
    const icon = r.passed ? green('PASS') : red('FAIL');
    console.log(`\n  ${icon}  ${bold(r.agent)}`);

    if (r.error) {
      console.log(red(`    Error: ${r.error}`));
      failed++;
      continue;
    }

    if (!r.passed) {
      failed++;
      continue;
    }

    passed++;

    // Rich content check
    if (r.richContentReceived) {
      console.log(green(`    ✓ richContent received: [${r.richContentFormats.join(', ')}]`));
    } else {
      const expected = TEST_AGENTS[r.agent.replace(' (REST)', '')]?.expectRichContent;
      if (expected) {
        console.log(red(`    ✗ richContent: MISSING (expected)`));
        warnings++;
      } else {
        console.log(dim(`    - richContent: not expected for this step`));
      }
    }

    // Voice config check
    if (r.voiceConfigReceived) {
      console.log(green(`    ✓ voiceConfig received`));
    } else {
      const expected = TEST_AGENTS[r.agent.replace(' (REST)', '')]?.expectVoiceConfig;
      if (expected) {
        console.log(red(`    ✗ voiceConfig: MISSING (expected)`));
        warnings++;
      } else {
        console.log(dim(`    - voiceConfig: not expected for this step`));
      }
    }

    // Actions check
    if (r.actionsReceived) {
      console.log(green(`    ✓ actions received`));
    }

    // Response preview
    if (r.responseText) {
      const preview = r.responseText.replace(/\n/g, ' ').slice(0, 100);
      console.log(dim(`    Response: "${preview}..."`));
    }
  }

  console.log('\n' + bold('───────────────────────────────────────────────────────────────'));
  console.log(
    `  ${green(`${passed} passed`)}, ${failed > 0 ? red(`${failed} failed`) : `${failed} failed`}, ${warnings > 0 ? yellow(`${warnings} warnings`) : `${warnings} warnings`}`,
  );
  console.log(bold('═══════════════════════════════════════════════════════════════\n'));

  // Print rich content samples
  const withRichContent = results.filter((r) => r.richContentReceived);
  if (withRichContent.length > 0) {
    console.log(bold('  Sample Rich Content Payloads:'));
    console.log(bold('───────────────────────────────────────────────────────────────'));
  }

  return failed === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// DETAILED RICH CONTENT INSPECTOR
// ─────────────────────────────────────────────────────────────────────────────

async function inspectRichContent(agentName: string): Promise<void> {
  console.log(bold(`\n  Inspecting rich content for: ${agentName}`));
  console.log(bold('───────────────────────────────────────────────────────────────'));

  return new Promise((resolve) => {
    void (async () => {
      const token = await getAccessToken();
      const wsUrl = `ws://${RUNTIME_HOST}:${RUNTIME_PORT}/ws`;
      const ws = new WebSocket(wsUrl, buildWebDebugWsProtocols(token));
      let sessionId: string | undefined;
      const timeout = setTimeout(() => {
        ws.close();
        resolve();
      }, 15000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'info') {
          ws.send(JSON.stringify({ type: 'load_agent', agentPath: agentName }));
        } else if (msg.type === 'agent_loaded') {
          sessionId = msg.sessionId;
          const testConfig = TEST_AGENTS[agentName];
          if (testConfig && testConfig.messages.length > 0) {
            ws.send(
              JSON.stringify({ type: 'send_message', sessionId, text: testConfig.messages[0] }),
            );
          }
        } else if (msg.type === 'response_end') {
          console.log(cyan('\n  response_end payload:'));
          console.log(dim('  fullText:'), msg.fullText?.slice(0, 200));

          if (msg.richContent) {
            console.log(green('\n  richContent:'));
            for (const [format, content] of Object.entries(msg.richContent)) {
              if (content) {
                console.log(cyan(`    ${format}:`));
                const str =
                  typeof content === 'string' ? content : JSON.stringify(content, null, 2);
                for (const line of str.split('\n').slice(0, 10)) {
                  console.log(`      ${line}`);
                }
                if (str.split('\n').length > 10) {
                  console.log(dim(`      ... (${str.split('\n').length - 10} more lines)`));
                }
              }
            }
          } else {
            console.log(yellow('\n  richContent: null'));
          }

          if (msg.voiceConfig) {
            console.log(green('\n  voiceConfig:'));
            console.log(
              `    instructions: "${msg.voiceConfig.instructions || msg.voiceConfig.voice_instructions || 'N/A'}"`,
            );
          } else {
            console.log(yellow('\n  voiceConfig: null'));
          }

          if (msg.actions) {
            console.log(green('\n  actions:'));
            console.log(`    ${JSON.stringify(msg.actions, null, 2)}`);
          }

          clearTimeout(timeout);
          ws.close();
          resolve();
        } else if (msg.type === 'error') {
          console.log(red(`  Error: ${msg.message}`));
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      });

      ws.on('error', (err) => {
        console.log(red(`  WS Error: ${err.message}`));
        clearTimeout(timeout);
        resolve();
      });
    })().catch((error: unknown) => {
      console.log(red(`  Setup Error: ${error instanceof Error ? error.message : String(error)}`));
      resolve();
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const specificAgent = args.find((a) => a.startsWith('--agent='))?.split('=')[1];
  const inspectMode = args.includes('--inspect');
  const restMode = args.includes('--rest');

  console.log(bold('\n  Rich Content E2E Test'));
  console.log(dim(`  Runtime: ws://${RUNTIME_HOST}:${RUNTIME_PORT}/ws`));
  console.log(dim(`  Time: ${new Date().toISOString()}\n`));

  // Inspect mode: show full rich content payload for one agent
  if (inspectMode) {
    const agent = specificAgent || 'Simple_Booking_Flow';
    await inspectRichContent(agent);
    return;
  }

  // Filter agents if specific one requested
  const agents = specificAgent
    ? {
        [specificAgent]: TEST_AGENTS[specificAgent] || {
          messages: ['hello'],
          expectRichContent: true,
          expectVoiceConfig: true,
        },
      }
    : TEST_AGENTS;

  const results: TestResult[] = [];

  // Test each agent sequentially (avoid overwhelming the server)
  for (const [name, config] of Object.entries(agents)) {
    console.log(bold(`\n  Testing: ${name}`));
    console.log(dim('  ─────────────────────────────'));
    const result = await testAgent(name, config);
    results.push(result);

    // Optional: also test REST channel
    if (restMode) {
      console.log(dim(`  Testing REST channel for ${name}...`));
      const restResult = await testRestChannel(name);
      results.push(restResult);
    }
  }

  const allPassed = printReport(results);

  // Inspect the first agent that received rich content
  const withRichContent = results.find((r) => r.richContentReceived);
  if (withRichContent) {
    await inspectRichContent(withRichContent.agent.replace(' (REST)', ''));
  }

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(red(`Fatal error: ${err.message}`));
  process.exit(1);
});
