/**
 * TravelDesk Supervisor WS Flow E2E Test
 *
 * Reproduces the EXACT flow seen in the Studio UI:
 *   1. Load supervisor + all child agents (like handleLoadAgent does)
 *   2. Check for ON_START / flow initialization (like handler.ts:315-322)
 *   3. Send first user message (triggers routing to Welcome_Agent)
 *   4. Welcome_Agent greets, completes, returns to supervisor
 *   5. Send "need hotel in paris for 3 nights" (triggers routing to Sales_Agent)
 *   6. Observe the Anthropic API 400 error: "messages.0: user messages must have non-empty content"
 *
 * This test captures ALL trace events, thread state, and conversation history
 * at each step to pinpoint exactly where empty messages enter the pipeline.
 *
 * Uses real LLM calls via the multi-provider pattern from test-utils.ts.
 * Supports Anthropic, OpenAI, LiteLLM etc. via LLM_PROVIDER env var.
 * Auto-skips when no API key is available.
 */

import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';

// Load .env from runtime app BEFORE any other imports that depend on it
dotenvConfig({ path: join(import.meta.dirname, '../../.env') });

import { loadConfig } from '../config/index';
import {
  RuntimeExecutor,
  getActiveThread,
  compileToResolvedAgent,
} from '../services/runtime-executor';
import { SessionLLMClient } from '../services/llm/session-llm-client';
import type { ModelResolutionService, ResolvedModel } from '../services/llm/model-resolution';
import {
  getSkipReason,
  getApiKey,
  DEFAULT_PROVIDER,
  PROVIDER_MODELS,
} from '../../../../packages/compiler/src/__tests__/e2e/fixtures/test-utils.js';

// =============================================================================
// HELPERS
// =============================================================================

const TRAVELDESK_DIR = join(import.meta.dirname, '../../../../examples/traveldesk');

function loadDSL(relativePath: string): string {
  return readFileSync(join(TRAVELDESK_DIR, relativePath), 'utf-8');
}

interface TraceEvent {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Dump full session state for debugging
 */
function dumpSessionState(session: any, label: string): void {
  const activeThread = getActiveThread(session);
  console.log(`\n${'='.repeat(80)}`);
  console.log(`SESSION STATE: ${label}`);
  console.log(`${'='.repeat(80)}`);
  console.log(`  agentName: ${session.agentName}`);
  console.log(`  isComplete: ${session.isComplete}`);
  console.log(`  isEscalated: ${session.isEscalated}`);
  console.log(`  currentFlowStep: ${session.currentFlowStep}`);
  console.log(`  waitingForInput: ${JSON.stringify(session.waitingForInput)}`);
  console.log(`  handoffStack: ${JSON.stringify(session.handoffStack)}`);
  console.log(`  threads: ${session.threads.length}`);
  console.log(`  activeThreadIndex: ${session.activeThreadIndex}`);
  console.log(`  threadStack: ${JSON.stringify(session.threadStack)}`);

  console.log(`\n  --- Active Thread ---`);
  if (activeThread) {
    console.log(`    agentName: ${activeThread.agentName}`);
    console.log(`    status: ${activeThread.status}`);
    console.log(`    currentFlowStep: ${activeThread.currentFlowStep}`);
    console.log(`    returnExpected: ${activeThread.returnExpected}`);
    console.log(`    conversationHistory (${activeThread.conversationHistory.length} msgs):`);
    for (const msg of activeThread.conversationHistory) {
      const content =
        typeof msg.content === 'string'
          ? msg.content.substring(0, 100)
          : JSON.stringify(msg.content).substring(0, 100);
      console.log(`      [${msg.role}]: ${content}`);
    }
  }

  console.log(`\n  --- All Threads ---`);
  for (let i = 0; i < session.threads.length; i++) {
    const t = session.threads[i];
    console.log(
      `    Thread[${i}] ${t.agentName} (status=${t.status}, msgs=${t.conversationHistory.length}, flowStep=${t.currentFlowStep}, return=${t.returnExpected})`,
    );
    for (const msg of t.conversationHistory) {
      const content =
        typeof msg.content === 'string'
          ? msg.content.substring(0, 120)
          : JSON.stringify(msg.content).substring(0, 120);
      console.log(`      [${msg.role}]: ${content}`);
    }
  }

  console.log(
    `\n  --- Session-level conversationHistory (${session.conversationHistory.length} msgs) ---`,
  );
  for (const msg of session.conversationHistory) {
    const content =
      typeof msg.content === 'string'
        ? msg.content.substring(0, 120)
        : JSON.stringify(msg.content).substring(0, 120);
    console.log(`    [${msg.role}]: ${content}`);
  }
  console.log(`${'='.repeat(80)}\n`);
}

// =============================================================================
// TEST SUITE
// =============================================================================

const fixturesMissing = !existsSync(join(TRAVELDESK_DIR, 'supervisor.agent.abl'));
const skipReason = fixturesMissing ? 'examples/traveldesk/ fixtures not found' : getSkipReason();

describe.skipIf(!!skipReason)('TravelDesk Supervisor WS Flow E2E', () => {
  let executor: RuntimeExecutor;

  // DSL files loaded in beforeAll (not module scope) so skipIf guard takes effect first
  let supervisorDSL: string;
  let welcomeDSL: string;
  let salesDSL: string;
  let authDSL: string;
  let bookingDSL: string;
  let farewellDSL: string;
  let fallbackDSL: string;
  let liveDSL: string;
  let paymentDSL: string;

  beforeAll(async () => {
    // Load runtime config (required by SessionLLMClient) — async!
    await loadConfig();

    // Load all DSL files
    supervisorDSL = loadDSL('supervisor.agent.abl');
    welcomeDSL = loadDSL('agents/welcome_agent.agent.abl');
    salesDSL = loadDSL('agents/sales_agent.agent.abl');
    authDSL = loadDSL('agents/authentication.agent.abl');
    bookingDSL = loadDSL('agents/booking_manager.agent.abl');
    farewellDSL = loadDSL('agents/farewell_agent.agent.abl');
    fallbackDSL = loadDSL('agents/fallback_handler.agent.abl');
    liveDSL = loadDSL('agents/live_agent_transfer.agent.abl');
    paymentDSL = loadDSL('agents/payment_agent.agent.abl');
  });

  beforeEach(() => {
    const provider = DEFAULT_PROVIDER;
    const apiKey = getApiKey(provider);
    const modelMapping = PROVIDER_MODELS[provider] || PROVIDER_MODELS.anthropic;
    const modelId = `${provider}/${modelMapping.haiku}`;

    executor = new RuntimeExecutor();

    // Override wireLLMClient to bypass ModelResolutionService (no DB in tests).
    // Creates a SessionLLMClient backed by a mock resolution that returns
    // the active provider's API key and model (supports OpenAI, Anthropic, etc.).
    const mockResolution = {
      resolve: async () => ({
        modelId,
        provider,
        source: 'system_default' as const,
        credential: { apiKey, authType: 'api_key' },
        parameters: { maxTokens: 2048 },
      }),
    } as unknown as ModelResolutionService;

    (executor as any).llmWiring.wireLLMClient = async (session: any, agentIR: any) => {
      session.llmClient = new SessionLLMClient(mockResolution, {
        tenantId: session.tenantId,
        agentName: agentIR?.metadata?.name || session.agentName,
        agentIR,
        sessionId: session.id,
      });
    };
  });

  test('Full supervisor flow: greeting → Welcome_Agent → user request → Sales_Agent', async () => {
    // =========================================================================
    // STEP 1: Create multi-agent session (mirrors handleLoadAgent in handler.ts)
    // =========================================================================
    const allDSLs = [
      supervisorDSL,
      welcomeDSL,
      salesDSL,
      authDSL,
      bookingDSL,
      farewellDSL,
      fallbackDSL,
      liveDSL,
      paymentDSL,
    ];

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(allDSLs, 'TravelDesk_Supervisor'),
    );

    expect(session).toBeDefined();
    expect(session.agentName).toBe('TravelDesk_Supervisor');
    console.log(`\n[TEST] Session created: ${session.id}`);
    console.log(`[TEST] Supervisor mode: ${session.agentIR?.execution?.mode}`);
    console.log(`[TEST] Has on_start: ${!!session.agentIR?.on_start}`);
    console.log(`[TEST] currentFlowStep: ${session.currentFlowStep}`);

    dumpSessionState(session, 'After createSession');

    // =========================================================================
    // STEP 2: Initialize ON_START if present (mirrors handler.ts:315-322)
    // =========================================================================
    const traceEvents: TraceEvent[] = [];
    const chunks: string[] = [];

    const onChunk = (chunk: string) => {
      chunks.push(chunk);
      console.log(`[CHUNK] ${chunk.substring(0, 100)}`);
    };
    const onTraceEvent = (event: TraceEvent) => {
      traceEvents.push(event);
      console.log(`[TRACE] ${event.type}: ${JSON.stringify(event.data).substring(0, 200)}`);
    };

    if (session.currentFlowStep) {
      console.log('[TEST] Initializing flow session...');
      const flowResult = await executor.initializeSession(session.id, onChunk, onTraceEvent);
      console.log(`[TEST] Flow init result: ${JSON.stringify(flowResult?.action)}`);
      dumpSessionState(session, 'After flow init');
    } else if (session.agentIR?.on_start) {
      console.log('[TEST] Executing ON_START for reasoning agent...');
      const onStartResult = await executor.initializeSession(session.id, onChunk, onTraceEvent);
      console.log(`[TEST] ON_START result: ${JSON.stringify(onStartResult?.action)}`);
      dumpSessionState(session, 'After ON_START');
    } else {
      console.log('[TEST] No auto-start — supervisor waits for user input');
    }

    // =========================================================================
    // STEP 3: Send first user message "hi" (triggers Welcome_Agent routing)
    // =========================================================================
    console.log('\n[TEST] ========== Sending: "hi" ==========');
    traceEvents.length = 0;
    chunks.length = 0;

    let result;
    let error: Error | null = null;
    try {
      result = await executor.executeMessage(session.id, 'hi', onChunk, onTraceEvent);
      console.log(`[TEST] Result action: ${JSON.stringify(result.action)}`);
      console.log(`[TEST] Result response: ${result.response?.substring(0, 200)}`);
    } catch (e) {
      error = e as Error;
      console.error(`[TEST] ERROR on "hi": ${error.message}`);
    }

    dumpSessionState(session, 'After "hi"');

    // Log trace events summary
    console.log(`\n[TEST] Trace events after "hi" (${traceEvents.length}):`);
    for (const evt of traceEvents) {
      if (evt.type === 'handoff' || evt.type === 'handoff_condition_check') {
        console.log(
          `  ${evt.type}: from=${evt.data.from || evt.data.agent} to=${evt.data.to || evt.data.target} matched=${evt.data.result}`,
        );
      } else if (evt.type === 'flow_step_enter' || evt.type === 'flow_transition') {
        console.log(
          `  ${evt.type}: step=${evt.data.stepName} from=${evt.data.fromStep} to=${evt.data.toStep}`,
        );
      } else {
        console.log(`  ${evt.type}: ${JSON.stringify(evt.data).substring(0, 150)}`);
      }
    }

    // =========================================================================
    // STEP 4: Send second message "need hotel in paris for 3 nights"
    //         This is where the 400 error happens in the UI
    // =========================================================================
    console.log('\n[TEST] ========== Sending: "need hotel in paris for 3 nights" ==========');
    traceEvents.length = 0;
    chunks.length = 0;

    let result2;
    let error2: Error | null = null;
    try {
      result2 = await executor.executeMessage(
        session.id,
        'need hotel in paris for 3 nights',
        onChunk,
        onTraceEvent,
      );
      console.log(`[TEST] Result action: ${JSON.stringify(result2.action)}`);
      console.log(`[TEST] Result response: ${result2.response?.substring(0, 200)}`);
    } catch (e) {
      error2 = e as Error;
      console.error(`[TEST] ERROR on "need hotel in paris for 3 nights": ${error2.message}`);
    }

    dumpSessionState(session, 'After "need hotel in paris for 3 nights"');

    // Log trace events summary
    console.log(`\n[TEST] Trace events after second message (${traceEvents.length}):`);
    for (const evt of traceEvents) {
      if (evt.type === 'handoff' || evt.type === 'handoff_condition_check') {
        console.log(
          `  ${evt.type}: from=${evt.data.from || evt.data.agent} to=${evt.data.to || evt.data.target} matched=${evt.data.result}`,
        );
      } else if (evt.type === 'flow_step_enter' || evt.type === 'flow_transition') {
        console.log(
          `  ${evt.type}: step=${evt.data.stepName} from=${evt.data.fromStep} to=${evt.data.toStep}`,
        );
      } else if (evt.type === 'llm_call') {
        console.log(
          `  ${evt.type}: agent=${evt.data.agent} model=${evt.data.model} iteration=${evt.data.iteration}`,
        );
      } else if (evt.type === 'error') {
        console.log(`  ${evt.type}: ${evt.data.message}`);
      } else {
        console.log(`  ${evt.type}: ${JSON.stringify(evt.data).substring(0, 150)}`);
      }
    }

    // =========================================================================
    // ASSERTIONS: The test should surface the bug
    // =========================================================================

    // Verify conversation history integrity: no empty user messages
    console.log('\n[TEST] ========== CONVERSATION HISTORY INTEGRITY CHECK ==========');
    let hasEmptyUserMessage = false;
    for (let i = 0; i < session.threads.length; i++) {
      const thread = session.threads[i];
      for (let j = 0; j < thread.conversationHistory.length; j++) {
        const msg = thread.conversationHistory[j];
        if (
          msg.role === 'user' &&
          (!msg.content || (typeof msg.content === 'string' && msg.content.trim() === ''))
        ) {
          console.log(
            `  ❌ EMPTY USER MESSAGE in Thread[${i}] (${thread.agentName}) at index ${j}`,
          );
          hasEmptyUserMessage = true;
        }
      }
    }

    // Also check session-level history
    for (let j = 0; j < session.conversationHistory.length; j++) {
      const msg = session.conversationHistory[j];
      if (
        msg.role === 'user' &&
        (!msg.content || (typeof msg.content === 'string' && msg.content.trim() === ''))
      ) {
        console.log(`  ❌ EMPTY USER MESSAGE in session.conversationHistory at index ${j}`);
        hasEmptyUserMessage = true;
      }
    }

    if (!hasEmptyUserMessage) {
      console.log('  ✅ No empty user messages found in any thread or session history');
    }

    // The test documents the bug — if error2 is set, the 400 was reproduced
    if (error2) {
      console.log(`\n[TEST] 🐛 BUG REPRODUCED: ${error2.message}`);
    }

    // We expect no errors — if we get one, the test fails showing the trace
    expect(error).toBeNull();
    // This assertion will fail if the bug exists, showing the full trace above
    expect(error2).toBeNull();
    expect(hasEmptyUserMessage).toBe(false);
  }, 120_000); // 2 min timeout for LLM calls
});
