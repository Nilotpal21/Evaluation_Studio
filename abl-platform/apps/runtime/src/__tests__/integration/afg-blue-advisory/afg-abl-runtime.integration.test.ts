/**
 * AFG Blue Advisory — ABL Runtime E2E Test
 *
 * Tests conversational scenarios against the ABL Runtime with compiled agent DSL files.
 * Uses pipeline classifier (Qwen) + inline gather (extraction merged into reasoning loop).
 *
 * Architecture:
 *   GuardRail_Supervisor → routes to Advisor_Agent or Store_Policy_Agent
 *   Advisor_Agent: product_search tool (AFG Render search service — same as Kore.ai production)
 *   Store_Policy_Agent: policy_search tool (Kore.ai SearchAI KB)
 *
 * External APIs (same as Kore.ai production):
 *   - AFG product search service (afg-demo-he7v.onrender.com)
 *   - Kore.ai SearchAI advancedSearch (policy KB)
 *
 * LLM: OpenAI GPT-4.1 (same model as Kore.ai production)
 * Pipeline: Qwen3.5-35B-A3B for fast routing classification
 *
 * Required env vars:
 *   OPENAI_API_KEY             – For OpenAI GPT-4.1 LLM (reasoning mode)
 *   Qwen3.5-35B-A3B_API_KEY   – Qwen3.5-35B-A3B API key (pipeline classifier)
 *   Qwen3.5-35B-A3B_URL       – Qwen3.5-35B-A3B endpoint URL
 *   AFG_SEARCHAI_ENDPOINT  – Kore.ai SearchAI advanced-search URL (read by policy_search.tool.abl)
 *   AFG_SEARCHAI_TOKEN     – Kore.ai SearchAI JWT token (read by policy_search.tool.abl; policy tests skip without it)
 *
 * Run with:
 *   pnpm --dir apps/runtime test:afg-e2e
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

// ── Mock DB models to avoid 10s Mongoose timeouts (no MongoDB in E2E) ──
vi.mock('@agent-platform/database/models', () => ({
  GuardrailPolicy: {
    find: vi.fn().mockReturnValue({
      limit: () => ({ lean: () => Promise.resolve([]) }),
    }),
  },
  Subscription: {
    findOne: vi.fn().mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve(null) }),
    }),
  },
  Tenant: {
    findOne: vi.fn().mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve(null) }),
    }),
  },
}));

vi.mock('@agent-platform/database', () => ({
  ProjectRuntimeConfig: {
    findOne: vi.fn().mockReturnValue({
      lean: () => Promise.resolve(null),
    }),
  },
}));

// Load .env from runtime app root (picks up API keys)
dotenvConfig({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..', '.env'),
});
// Also load root .env for Qwen3.5-35B-A3B credentials (override: false to not clobber runtime .env)
dotenvConfig({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..', '.env'),
  override: false,
});

// Runtime imports
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  type RuntimeSession,
} from '../../../services/runtime-executor.js';
import { SessionLLMClient } from '../../../services/llm/session-llm-client.js';
import type { ModelResolutionService } from '../../../services/llm/model-resolution.js';
import { loadConfig, isConfigLoaded } from '../../../config/index.js';

// =============================================================================
// CONFIG
// =============================================================================

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';

// Same model as Kore.ai production
const LLM_MODEL = process.env.AFG_LLM_MODEL ?? 'gpt-4.1';

// Qwen3.5-35B-A3B model for pipeline classifier (cheap + fast routing)
// eslint-disable-next-line @typescript-eslint/dot-notation
const QWEN_MODEL = process.env['Qwen3.5-35B-A3B_MODEL'] ?? 'qwen35-a3b-35b';
// eslint-disable-next-line @typescript-eslint/dot-notation
const QWEN_API_KEY = process.env['Qwen3.5-35B-A3B_API_KEY'] ?? '';
// eslint-disable-next-line @typescript-eslint/dot-notation
const QWEN_URL = process.env['Qwen3.5-35B-A3B_URL'] ?? '';

const SKIP_REASON = !OPENAI_API_KEY
  ? 'OPENAI_API_KEY not set — skipping ABL Runtime E2E tests'
  : '';

// =============================================================================
// LOAD ABL DSL FILES
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = path.resolve(__dirname, '../../../../../../examples/afg-blue-advisory');

function loadDSL(relativePath: string): string {
  const fullPath = path.resolve(EXAMPLES_DIR, relativePath);
  return fs.readFileSync(fullPath, 'utf-8');
}

// =============================================================================
// LOAD TOOL DSL FILES
// =============================================================================

import { loadToolDSLsAsResolved } from '@agent-platform/shared/tools/standalone-tool-adapter';
import type { ToolDefinition } from '@abl/compiler';

function resolveToolDSLs(): Map<string, ToolDefinition[]> {
  const productSearchDSL = loadDSL('tools/product_search.tools.abl');
  const policySearchDSL = loadDSL('tools/policy_search.tools.abl');
  const resolved = loadToolDSLsAsResolved([productSearchDSL, policySearchDSL]);

  // Map tool names to the agents that declare them
  const byAgent = new Map<string, ToolDefinition[]>();
  const advisorTools: ToolDefinition[] = [];
  const policyTools: ToolDefinition[] = [];

  const productSearch = resolved.get('product_search');
  if (productSearch) advisorTools.push(...(productSearch as unknown as ToolDefinition[]));

  const policySearch = resolved.get('policy_search');
  if (policySearch) policyTools.push(...(policySearch as unknown as ToolDefinition[]));

  if (advisorTools.length) byAgent.set('Advisor_Agent', advisorTools);
  if (policyTools.length) byAgent.set('Store_Policy_Agent', policyTools);

  return byAgent;
}

// =============================================================================
// TIMING HELPERS & TRACE LOGGING
// =============================================================================

interface TurnMetrics {
  startMs: number;
  firstChunkMs: number;
  endMs: number;
  ttfb: number;
  total: number;
  chunkCount: number;
  responseLength: number;
}

interface TurnTrace {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

interface TurnRecord {
  scenario: string;
  userMessage: string;
  agentResponse: string;
  metrics: TurnMetrics;
  traces: TurnTrace[];
  toolCalls: Array<{ tool: string; durationMs: number }>;
  passed: boolean;
}

// Collect all turn records for each run variant
const runReport: TurnRecord[] = [];
const noPipelineReport: TurnRecord[] = [];

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// ── Visual Formatting ──────────────────────────────────────────────────────

function logTurnHeader(scenario: string, userMessage: string) {
  const width = 80;
  console.log('\n' + '━'.repeat(width));
  console.log(`  ${scenario}`);
  console.log('━'.repeat(width));
  console.log(`  👤 User: "${userMessage}"`);
}

function logAgentResponse(text: string) {
  const maxLen = 300;
  const display = text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
  console.log(`  🤖 Agent:`);
  console.log(`  ─ Response ${'─'.repeat(65)}`);
  console.log(`  ${display}`);
  console.log(`  ${'─'.repeat(76)}`);
}

function logTimingBreakdown(metrics: {
  ttfb: number;
  total: number;
  chunkCount: number;
  responseLength: number;
}) {
  const fmtSec = (ms: number) => (ms / 1000).toFixed(2) + 's';
  console.log(`  ⏱  Timing:`);
  console.log(`     First response  → T+${fmtSec(metrics.ttfb)}  (TTFB)`);
  console.log(`     Total           → T+${fmtSec(metrics.total)}`);
  console.log(`     Chunks: ${metrics.chunkCount}  Characters: ${metrics.responseLength}`);
}

function logDecisionLog(events: Array<{ type: string; [key: string]: unknown }>) {
  if (events.length === 0) return;
  console.log(`  📋 Decision log (${events.length} events):`);
  for (const event of events) {
    const summary = JSON.stringify(event).substring(0, 120);
    const icon =
      event.type === 'handoff'
        ? '🔗'
        : event.type === 'tool_call'
          ? '🔧'
          : event.type === 'completion_check'
            ? '✅'
            : '→';
    console.log(`    ${icon} ${event.type}: ${summary}`);
  }
}

function logScenarioResult(scenario: string, passed: boolean, durationMs: number) {
  const icon = passed ? '✅' : '❌';
  const fmtSec = (ms: number) => (ms / 1000).toFixed(1) + 's';
  console.log(`\n  ${icon} ${scenario} — ${fmtSec(durationMs)}`);
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe('AFG Blue Advisory — ABL Runtime E2E', () => {
  let executor: RuntimeExecutor;
  let supervisorDSL: string;
  let advisorDSL: string;
  let policyDSL: string;

  beforeAll(async () => {
    if (SKIP_REASON) return;

    // loadConfig() must be called before SessionLLMClient can resolve providers
    if (!isConfigLoaded()) {
      await loadConfig();
    }

    // Load all DSL files
    supervisorDSL = loadDSL('agents/guardrail_supervisor.agent.abl');
    advisorDSL = loadDSL('agents/advisor_agent.agent.abl');
    policyDSL = loadDSL('agents/store_policy_agent.agent.abl');

    // Warm up the Render search service to avoid cold-start latency on first test.
    // Free-tier Render instances spin down after inactivity and can take 30-60s to wake.
    const RENDER_URL =
      'https://afg-demo-he7v.onrender.com/api/v2/product_search?compress=true&sessionId=warmup';
    try {
      console.log('⏳ Warming up Render search service...');
      const warmupStart = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 55_000);
      const res = await fetch(RENDER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ query: 'warmup', namespace: 'afg_products' }]),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const elapsed = ((Date.now() - warmupStart) / 1000).toFixed(1);
      console.log(`✅ Render service warm (${elapsed}s, status ${res.status})`);
    } catch (err) {
      console.warn('⚠️ Render warmup failed (tests will still run):', (err as Error).message);
    }
  }, 90_000);

  beforeEach(() => {
    if (SKIP_REASON) return;
    executor = new RuntimeExecutor();

    // Operation-type-aware mock: Qwen for pipeline classifier, GPT-4.1 for everything else
    const mockResolution = {
      resolve: async (ctx: { operationType?: string }) => {
        if (ctx.operationType === 'tool_selection' && QWEN_API_KEY && QWEN_URL) {
          return {
            modelId: QWEN_MODEL,
            provider: 'openai', // Qwen uses OpenAI-compatible API
            source: 'system_default' as const,
            credential: { apiKey: QWEN_API_KEY, endpoint: QWEN_URL, authType: 'api_key' },
            parameters: { maxTokens: 2048, temperature: 0 },
          };
        }
        return {
          modelId: `openai/${LLM_MODEL}`,
          provider: 'openai',
          source: 'system_default' as const,
          credential: { apiKey: OPENAI_API_KEY, authType: 'api_key' },
          parameters: { maxTokens: 4096 },
        };
      },
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

  afterAll(() => {
    if (SKIP_REASON || runReport.length === 0) return;

    const reportPath = path.resolve(__dirname, 'afg-run-report.json');
    const report = {
      timestamp: new Date().toISOString(),
      model: LLM_MODEL,
      pipelineModel: QWEN_MODEL,
      mode: 'pipeline + inline_gather',
      scenarios: runReport,
      summary: {
        total: runReport.length,
        passed: runReport.filter((r) => r.passed).length,
        failed: runReport.filter((r) => !r.passed).length,
        avgTotalMs: Math.round(
          runReport.reduce((s, r) => s + r.metrics.total, 0) / runReport.length,
        ),
        avgTtfbMs: Math.round(runReport.reduce((s, r) => s + r.metrics.ttfb, 0) / runReport.length),
        totalTraceEvents: runReport.reduce((s, r) => s + r.traces.length, 0),
      },
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n  ═══ Run report written to ${reportPath} ═══`);

    // Print summary table
    console.log('\n' + '═'.repeat(80));
    console.log('  AFG Blue Advisory — ABL Runtime Results (Pipeline + Inline Gather)');
    console.log('═'.repeat(80));
    for (const s of runReport) {
      const icon = s.passed ? '✅' : '❌';
      const ttfb = ((s.metrics?.ttfb ?? 0) / 1000).toFixed(1);
      const total = ((s.metrics?.total ?? 0) / 1000).toFixed(1);
      console.log(`  ${icon} ${s.scenario.padEnd(50)} TTFB: ${ttfb}s  Total: ${total}s`);
    }
    console.log('═'.repeat(80));
  });

  /**
   * Create a multi-agent session with pipeline + inline gather.
   * Pipeline (Qwen) handles fast routing on the supervisor.
   * Inline gather merges entity extraction into the reasoning loop.
   */
  function createAfgSession(): RuntimeSession {
    const resolvedTools = resolveToolDSLs();
    const resolved = compileToResolvedAgent(
      [supervisorDSL, advisorDSL, policyDSL],
      'GuardRail_Supervisor',
      undefined,
      resolvedTools,
    );

    // Enable inline gather on Advisor_Agent
    const advisorIR = resolved.agents['Advisor_Agent'];
    if (advisorIR) {
      advisorIR.execution.inline_gather = true;
    }

    // Enable pipeline classifier on supervisor for fast Qwen-based routing
    const supervisorIR = resolved.agents['GuardRail_Supervisor'];
    if (supervisorIR) {
      supervisorIR.execution.pipeline = {
        enabled: true,
        mode: 'sequential',
        model: 'qwen35-a3b-35b',
        shortCircuit: {
          enabled: true,
          confidenceThreshold: 0.85,
        },
        toolFilter: {
          enabled: false,
        },
        keywordVeto: {
          enabled: true,
          keywords: [],
        },
      };
    }

    const session = executor.createSessionFromResolved(resolved, {
      tenantId: 'afg-test',
      projectId: 'afg-blue-advisory',
      userId: 'e2e_test_user',
    });

    return session;
  }

  /**
   * Execute a turn with timing metrics and logging.
   */
  async function executeTurn(
    session: RuntimeSession,
    message: string,
    turnLabel: string,
  ): Promise<{
    result: any;
    metrics: TurnMetrics;
    chunks: string[];
    traces: TurnTrace[];
    perceivedTtfb: number;
  }> {
    const chunks: string[] = [];
    const traces: TurnTrace[] = [];
    const metrics: TurnMetrics = {
      startMs: Date.now(),
      firstChunkMs: 0,
      endMs: 0,
      ttfb: 0,
      total: 0,
      chunkCount: 0,
      responseLength: 0,
    };
    let firstFillerMs = 0;

    logTurnHeader(turnLabel, message);

    const result = await executor.executeMessage(
      session.id,
      message,
      (chunk: string) => {
        if (metrics.firstChunkMs === 0) {
          metrics.firstChunkMs = Date.now();
          metrics.ttfb = metrics.firstChunkMs - metrics.startMs;
        }
        chunks.push(chunk);
        metrics.chunkCount++;
      },
      (traceEvent: { type: string; data: Record<string, unknown> }) => {
        // Capture first filler as perceived TTFT
        if (traceEvent.type === 'status_update' && firstFillerMs === 0) {
          firstFillerMs = Date.now();
        }
        traces.push({ ...traceEvent, timestamp: Date.now() });
      },
    );

    // Perceived TTFT: first filler or first chunk, whichever came first
    const perceivedTtfb =
      firstFillerMs > 0
        ? Math.min(firstFillerMs, metrics.firstChunkMs || Infinity) - metrics.startMs
        : metrics.ttfb;

    metrics.endMs = Date.now();
    metrics.total = metrics.endMs - metrics.startMs;
    metrics.responseLength = result.response.length;

    logAgentResponse(result.response);
    logTimingBreakdown(metrics);

    // Log perceived TTFB if filler fired before first chunk
    if (firstFillerMs > 0 && firstFillerMs < (metrics.firstChunkMs || Infinity)) {
      const fillerText = traces.find((t) => t.type === 'status_update')?.data?.text || '';
      console.log(`  💬 Filler at T+${(perceivedTtfb / 1000).toFixed(1)}s: "${fillerText}"`);
      console.log(
        `     Perceived TTFB: ${(perceivedTtfb / 1000).toFixed(1)}s (actual: ${(metrics.ttfb / 1000).toFixed(1)}s)`,
      );
    }

    // Log decision trace summary
    const decisions = traces.filter(
      (t) =>
        t.type.includes('handoff') ||
        t.type.includes('delegate') ||
        t.type.includes('tool') ||
        t.type.includes('routing') ||
        t.type.includes('guard') ||
        t.type.includes('completion') ||
        t.type.includes('pipeline'),
    );
    logDecisionLog(decisions);

    return { result, metrics, chunks, traces, perceivedTtfb };
  }

  // ===========================================================================
  // Scenario 1: Greeting
  // ===========================================================================

  test.skipIf(!!SKIP_REASON)(
    'Greeting — agent introduces itself and asks what user wants',
    async () => {
      const session = createAfgSession();
      const { result, metrics, traces } = await executeTurn(session, 'Hi', 'Greeting');

      expect(result.response.length).toBeGreaterThan(10);
      const lower = result.response.toLowerCase();
      const passed =
        lower.includes('help') ||
        lower.includes('looking for') ||
        lower.includes('shop') ||
        lower.includes('assist') ||
        lower.includes('welcome') ||
        lower.includes('interested');
      expect(passed).toBe(true);

      runReport.push({
        scenario: 'Greeting',
        userMessage: 'Hi',
        agentResponse: result.response,
        metrics,
        traces,
        toolCalls: [],
        passed,
      });
    },
    60_000,
  );

  // ===========================================================================
  // Scenario 2: Product Search
  // ===========================================================================

  test.skipIf(!!SKIP_REASON)(
    'Product search — red sneakers under 500 AED returns product results',
    async () => {
      const session = createAfgSession();
      const { result, metrics, traces } = await executeTurn(
        session,
        'Show me red sneakers under 500 AED for men',
        'Product Search',
      );

      expect(result.response.length).toBeGreaterThan(50);
      const lower = result.response.toLowerCase();
      const passed =
        lower.includes('sneaker') ||
        lower.includes('shoe') ||
        lower.includes('footwear') ||
        lower.includes('red') ||
        lower.includes('aed') ||
        lower.includes('option');
      expect(passed).toBe(true);

      runReport.push({
        scenario: 'Product Search',
        userMessage: 'Show me red sneakers under 500 AED for men',
        agentResponse: result.response,
        metrics,
        traces,
        toolCalls: [],
        passed,
      });
    },
    90_000,
  );

  // ===========================================================================
  // Scenario 3: Guard Rail — Out of Scope
  // ===========================================================================

  test.skipIf(!!SKIP_REASON)(
    'Guard rail — flight booking is declined with alternatives',
    async () => {
      const session = createAfgSession();
      const { result, metrics, traces } = await executeTurn(
        session,
        'Book me a flight from Dubai to London for next week',
        'Guard Rail',
      );

      expect(result.response.length).toBeGreaterThan(20);
      const lower = result.response.toLowerCase();
      const declined =
        lower.includes("can't") ||
        lower.includes('can\u2019t') ||
        lower.includes('cannot') ||
        lower.includes('unable') ||
        lower.includes("don't") ||
        lower.includes('don\u2019t') ||
        lower.includes('not able') ||
        lower.includes('outside') ||
        lower.includes('not book') ||
        lower.includes('not process');
      expect(declined).toBe(true);
      const alternatives =
        lower.includes('fashion') ||
        lower.includes('clothing') ||
        lower.includes('accessories') ||
        lower.includes('help') ||
        lower.includes('shopping') ||
        lower.includes('travel accessories') ||
        lower.includes('retail') ||
        lower.includes('offers') ||
        lower.includes('automotive');
      expect(alternatives).toBe(true);

      runReport.push({
        scenario: 'Guard Rail',
        userMessage: 'Book me a flight from Dubai to London for next week',
        agentResponse: result.response,
        metrics,
        traces,
        toolCalls: [],
        passed: declined && alternatives,
      });
    },
    60_000,
  );

  // ===========================================================================
  // Scenario 4: Cross-Agent Delegation (Product + Policy)
  // ===========================================================================

  test.skipIf(!!SKIP_REASON || !process.env.AFG_SEARCHAI_TOKEN)(
    'Delegation — product + policy query triggers cross-agent handoff',
    async () => {
      const session = createAfgSession();
      const { result, metrics, traces } = await executeTurn(
        session,
        'I want to buy red sneakers and what is the return policy for clothing?',
        'Delegation',
      );

      expect(result.response.length).toBeGreaterThan(50);
      const lower = result.response.toLowerCase();
      const passed =
        lower.includes('return') ||
        lower.includes('policy') ||
        lower.includes('refund') ||
        lower.includes('exchange') ||
        lower.includes('original condition');
      expect(passed).toBe(true);

      runReport.push({
        scenario: 'Delegation',
        userMessage: 'I want to buy red sneakers and what is the return policy for clothing?',
        agentResponse: result.response,
        metrics,
        traces,
        toolCalls: [],
        passed,
      });
    },
    120_000,
  );

  // ===========================================================================
  // Scenario 5: Automobile Domain
  // ===========================================================================

  test.skipIf(!!SKIP_REASON)(
    'Automobile — Toyota SUV under 200000 AED returns vehicle results',
    async () => {
      const session = createAfgSession();
      const { result, metrics, traces } = await executeTurn(
        session,
        'Show me a Toyota SUV under 200000 AED',
        'Automobile',
      );

      expect(result.response.length).toBeGreaterThan(50);
      const lower = result.response.toLowerCase();
      const passed =
        lower.includes('toyota') ||
        lower.includes('suv') ||
        lower.includes('prado') ||
        lower.includes('land cruiser') ||
        lower.includes('highlander') ||
        lower.includes('vehicle');
      expect(passed).toBe(true);

      runReport.push({
        scenario: 'Automobile',
        userMessage: 'Show me a Toyota SUV under 200000 AED',
        agentResponse: result.response,
        metrics,
        traces,
        toolCalls: [],
        passed,
      });
    },
    90_000,
  );

  // ===========================================================================
  // Scenario 6: Multi-Turn (Greeting → Search → Follow-up)
  // ===========================================================================

  test.skipIf(!!SKIP_REASON)(
    'Multi-turn — greeting then product search then refinement',
    async () => {
      const session = createAfgSession();

      // Turn 1: Greeting
      const turn1 = await executeTurn(session, 'Hi', 'Turn 1');
      expect(turn1.result.response.length).toBeGreaterThan(10);

      // Turn 2: Product search
      const turn2 = await executeTurn(
        session,
        'Show me red sneakers under 500 AED for men',
        'Turn 2',
      );
      expect(turn2.result.response.length).toBeGreaterThan(50);

      // Turn 3: Follow-up refinement
      const turn3 = await executeTurn(
        session,
        'What about Nike ones? Show me Nike options',
        'Turn 3',
      );
      expect(turn3.result.response.length).toBeGreaterThan(20);
      const lower = turn3.result.response.toLowerCase();
      expect(lower.includes('nike') || lower.includes('sneaker') || lower.includes('option')).toBe(
        true,
      );

      // Print performance summary
      console.log('\n' + '━'.repeat(80));
      console.log('  Multi-Turn Performance Summary');
      console.log('━'.repeat(80));
      logScenarioResult('Turn 1 (Greeting)', true, turn1.metrics.total);
      logScenarioResult('Turn 2 (Search)', true, turn2.metrics.total);
      logScenarioResult('Turn 3 (Follow-up)', true, turn3.metrics.total);
      console.log(
        `\n  Total wall time: ${fmt(turn1.metrics.total + turn2.metrics.total + turn3.metrics.total)}`,
      );

      runReport.push({
        scenario: 'Multi-turn (Turn 1: Greeting)',
        userMessage: 'Hi',
        agentResponse: turn1.result.response,
        metrics: turn1.metrics,
        traces: turn1.traces,
        toolCalls: [],
        passed: true,
      });
      runReport.push({
        scenario: 'Multi-turn (Turn 2: Search)',
        userMessage: 'Show me red sneakers under 500 AED for men',
        agentResponse: turn2.result.response,
        metrics: turn2.metrics,
        traces: turn2.traces,
        toolCalls: [],
        passed: true,
      });
      runReport.push({
        scenario: 'Multi-turn (Turn 3: Follow-up)',
        userMessage: 'What about Nike ones? Show me Nike options',
        agentResponse: turn3.result.response,
        metrics: turn3.metrics,
        traces: turn3.traces,
        toolCalls: [],
        passed: true,
      });
    },
    180_000,
  );

  // ===========================================================================
  // Scenario 7: Conversation Summary Continuity
  // ===========================================================================

  test.skipIf(!!SKIP_REASON)(
    'Summary continuity — greeting with prior conversation context',
    async () => {
      const session = createAfgSession();

      // Inject conversation summary into session data (simulates metadata)
      session.data.values.conversationSummary =
        'Customer was looking at Nike running shoes in size 42 and asked about the 30% discount offer. They were comparing Nike Air Max 90 and Adidas Ultra Boost.';
      session.data.values.user = 'e2e_test_user';
      session.data.values.gender = 'male';
      session.data.values.location = 'Dubai';

      const { result, metrics, traces } = await executeTurn(
        session,
        'Hey there',
        'Summary Continuity',
      );

      expect(result.response.length).toBeGreaterThan(10);
      const lower = result.response.toLowerCase();

      // Strict assertion: response must reference specific prior context from the
      // injected conversationSummary — generic greetings like "help", "assist",
      // "shopping" do NOT count as demonstrating summary continuity.
      const referencedPriorContext =
        lower.includes('nike') ||
        lower.includes('running shoes') ||
        lower.includes('air max') ||
        lower.includes('size 42') ||
        lower.includes('adidas') ||
        lower.includes('last time') ||
        lower.includes('previous') ||
        lower.includes('welcome back') ||
        lower.includes('continue') ||
        lower.includes('where we left off') ||
        lower.includes('before');
      expect(referencedPriorContext).toBe(true);

      // Previous loose assertion kept for reference — it allowed generic responses
      // that don't demonstrate summary awareness:
      // const passed = lower.includes('nike') || lower.includes('running') ||
      //   lower.includes('shoes') || lower.includes('last time') ||
      //   lower.includes('previous') || lower.includes('continue') ||
      //   lower.includes('welcome back') || lower.includes('help') ||
      //   lower.includes('looking for') || lower.includes('interested') ||
      //   lower.includes('shopping') || lower.includes('assist');
      const passed = referencedPriorContext;

      runReport.push({
        scenario: 'Summary Continuity',
        userMessage: 'Hey there',
        agentResponse: result.response,
        metrics,
        traces,
        toolCalls: [],
        passed,
      });
    },
    60_000,
  );
});

// =============================================================================
// NO-PIPELINE VARIANT (Inline Gather Only — No Qwen Classifier)
// =============================================================================

describe('AFG Blue Advisory — ABL Runtime E2E (No Pipeline)', () => {
  let executor: RuntimeExecutor;
  let supervisorDSL: string;
  let advisorDSL: string;
  let policyDSL: string;

  beforeAll(async () => {
    if (SKIP_REASON) return;
    if (!isConfigLoaded()) {
      await loadConfig();
    }
    supervisorDSL = loadDSL('agents/guardrail_supervisor.agent.abl');
    advisorDSL = loadDSL('agents/advisor_agent.agent.abl');
    policyDSL = loadDSL('agents/store_policy_agent.agent.abl');
  });

  beforeEach(() => {
    if (SKIP_REASON) return;
    executor = new RuntimeExecutor();

    // GPT-4.1 for everything (no Qwen for pipeline)
    const mockResolution = {
      resolve: async () => ({
        modelId: `openai/${LLM_MODEL}`,
        provider: 'openai',
        source: 'system_default' as const,
        credential: { apiKey: OPENAI_API_KEY, authType: 'api_key' },
        parameters: { maxTokens: 4096 },
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

  afterAll(() => {
    if (SKIP_REASON || noPipelineReport.length === 0) return;

    const reportPath = path.resolve(__dirname, 'afg-run-report-no-pipeline.json');
    const report = {
      timestamp: new Date().toISOString(),
      model: LLM_MODEL,
      pipelineModel: 'none',
      mode: 'inline_gather_only',
      scenarios: noPipelineReport,
      summary: {
        total: noPipelineReport.length,
        passed: noPipelineReport.filter((r) => r.passed).length,
        failed: noPipelineReport.filter((r) => !r.passed).length,
        avgTotalMs: Math.round(
          noPipelineReport.reduce((s, r) => s + r.metrics.total, 0) / noPipelineReport.length,
        ),
        avgTtfbMs: Math.round(
          noPipelineReport.reduce((s, r) => s + r.metrics.ttfb, 0) / noPipelineReport.length,
        ),
        totalTraceEvents: noPipelineReport.reduce((s, r) => s + r.traces.length, 0),
      },
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n  ═══ No-Pipeline report written to ${reportPath} ═══`);

    console.log('\n' + '═'.repeat(80));
    console.log('  AFG Blue Advisory — ABL Runtime Results (Inline Gather Only, No Pipeline)');
    console.log('═'.repeat(80));
    for (const s of noPipelineReport) {
      const icon = s.passed ? '✅' : '❌';
      const ttfb = ((s.metrics?.ttfb ?? 0) / 1000).toFixed(1);
      const total = ((s.metrics?.total ?? 0) / 1000).toFixed(1);
      console.log(`  ${icon} ${s.scenario.padEnd(50)} TTFB: ${ttfb}s  Total: ${total}s`);
    }
    console.log('═'.repeat(80));
  });

  function createNoPipelineSession(): RuntimeSession {
    const resolvedTools = resolveToolDSLs();
    const resolved = compileToResolvedAgent(
      [supervisorDSL, advisorDSL, policyDSL],
      'GuardRail_Supervisor',
      undefined,
      resolvedTools,
    );

    const advisorIR = resolved.agents['Advisor_Agent'];
    if (advisorIR) {
      advisorIR.execution.inline_gather = true;
    }

    const session = executor.createSessionFromResolved(resolved, {
      tenantId: 'afg-test',
      projectId: 'afg-blue-advisory',
      userId: 'e2e_test_user',
    });

    return session;
  }

  async function executeTurnNP(
    session: RuntimeSession,
    message: string,
    turnLabel: string,
  ): Promise<{
    result: any;
    metrics: TurnMetrics;
    chunks: string[];
    traces: TurnTrace[];
    perceivedTtfb: number;
  }> {
    const chunks: string[] = [];
    const traces: TurnTrace[] = [];
    const metrics: TurnMetrics = {
      startMs: Date.now(),
      firstChunkMs: 0,
      endMs: 0,
      ttfb: 0,
      total: 0,
      chunkCount: 0,
      responseLength: 0,
    };
    let firstFillerMs = 0;

    logTurnHeader(`[No Pipeline] ${turnLabel}`, message);

    const result = await executor.executeMessage(
      session.id,
      message,
      (chunk: string) => {
        if (metrics.firstChunkMs === 0) {
          metrics.firstChunkMs = Date.now();
          metrics.ttfb = metrics.firstChunkMs - metrics.startMs;
        }
        chunks.push(chunk);
        metrics.chunkCount++;
      },
      (traceEvent: { type: string; data: Record<string, unknown> }) => {
        if (traceEvent.type === 'status_update' && firstFillerMs === 0) {
          firstFillerMs = Date.now();
        }
        traces.push({ ...traceEvent, timestamp: Date.now() });
      },
    );

    const perceivedTtfb =
      firstFillerMs > 0
        ? Math.min(firstFillerMs, metrics.firstChunkMs || Infinity) - metrics.startMs
        : metrics.ttfb;

    metrics.endMs = Date.now();
    metrics.total = metrics.endMs - metrics.startMs;
    metrics.responseLength = result.response.length;

    logAgentResponse(result.response);
    logTimingBreakdown(metrics);

    if (firstFillerMs > 0 && firstFillerMs < (metrics.firstChunkMs || Infinity)) {
      const fillerText = traces.find((t) => t.type === 'status_update')?.data?.text || '';
      console.log(`  💬 Filler at T+${(perceivedTtfb / 1000).toFixed(1)}s: "${fillerText}"`);
      console.log(
        `     Perceived TTFB: ${(perceivedTtfb / 1000).toFixed(1)}s (actual: ${(metrics.ttfb / 1000).toFixed(1)}s)`,
      );
    }

    const decisions = traces.filter(
      (t) =>
        t.type.includes('handoff') ||
        t.type.includes('delegate') ||
        t.type.includes('tool') ||
        t.type.includes('routing') ||
        t.type.includes('guard') ||
        t.type.includes('completion') ||
        t.type.includes('pipeline'),
    );
    logDecisionLog(decisions);

    return { result, metrics, chunks, traces, perceivedTtfb };
  }

  test.skipIf(!!SKIP_REASON)(
    'NP: Greeting',
    async () => {
      const session = createNoPipelineSession();
      const { result, metrics, traces } = await executeTurnNP(session, 'Hi', 'Greeting');

      expect(result.response.length).toBeGreaterThan(10);
      const lower = result.response.toLowerCase();
      const passed =
        lower.includes('help') ||
        lower.includes('looking for') ||
        lower.includes('shop') ||
        lower.includes('assist') ||
        lower.includes('welcome') ||
        lower.includes('interested');
      expect(passed).toBe(true);

      noPipelineReport.push({
        scenario: 'Greeting',
        userMessage: 'Hi',
        agentResponse: result.response,
        metrics,
        traces,
        toolCalls: [],
        passed,
      });
    },
    60_000,
  );

  test.skipIf(!!SKIP_REASON)(
    'NP: Product Search',
    async () => {
      const session = createNoPipelineSession();
      const { result, metrics, traces } = await executeTurnNP(
        session,
        'Show me red sneakers under 500 AED for men',
        'Product Search',
      );

      expect(result.response.length).toBeGreaterThan(50);
      const lower = result.response.toLowerCase();
      const passed =
        lower.includes('sneaker') ||
        lower.includes('shoe') ||
        lower.includes('footwear') ||
        lower.includes('red') ||
        lower.includes('aed') ||
        lower.includes('option');
      expect(passed).toBe(true);

      noPipelineReport.push({
        scenario: 'Product Search',
        userMessage: 'Show me red sneakers under 500 AED for men',
        agentResponse: result.response,
        metrics,
        traces,
        toolCalls: [],
        passed,
      });
    },
    90_000,
  );

  test.skipIf(!!SKIP_REASON)(
    'NP: Guard Rail',
    async () => {
      const session = createNoPipelineSession();
      const { result, metrics, traces } = await executeTurnNP(
        session,
        'Book me a flight from Dubai to London for next week',
        'Guard Rail',
      );

      expect(result.response.length).toBeGreaterThan(20);
      const lower = result.response.toLowerCase();
      const declined =
        lower.includes("can't") ||
        lower.includes('can\u2019t') ||
        lower.includes('cannot') ||
        lower.includes('unable') ||
        lower.includes("don't") ||
        lower.includes('don\u2019t') ||
        lower.includes('not able') ||
        lower.includes('outside') ||
        lower.includes('not book') ||
        lower.includes('not process');
      expect(declined).toBe(true);

      noPipelineReport.push({
        scenario: 'Guard Rail',
        userMessage: 'Book me a flight from Dubai to London for next week',
        agentResponse: result.response,
        metrics,
        traces,
        toolCalls: [],
        passed: declined,
      });
    },
    60_000,
  );

  test.skipIf(!!SKIP_REASON)(
    'NP: Automobile',
    async () => {
      const session = createNoPipelineSession();
      const { result, metrics, traces } = await executeTurnNP(
        session,
        'Show me a Toyota SUV under 200000 AED',
        'Automobile',
      );

      expect(result.response.length).toBeGreaterThan(50);
      const lower = result.response.toLowerCase();
      const passed =
        lower.includes('toyota') ||
        lower.includes('suv') ||
        lower.includes('prado') ||
        lower.includes('land cruiser') ||
        lower.includes('highlander') ||
        lower.includes('vehicle');
      expect(passed).toBe(true);

      noPipelineReport.push({
        scenario: 'Automobile',
        userMessage: 'Show me a Toyota SUV under 200000 AED',
        agentResponse: result.response,
        metrics,
        traces,
        toolCalls: [],
        passed,
      });
    },
    90_000,
  );

  test.skipIf(!!SKIP_REASON)(
    'NP: Delegation',
    async () => {
      const session = createNoPipelineSession();
      const { result, metrics, traces } = await executeTurnNP(
        session,
        'I want to buy red sneakers and what is the return policy for clothing?',
        'Delegation',
      );

      expect(result.response.length).toBeGreaterThan(50);
      const lower = result.response.toLowerCase();
      const passed =
        lower.includes('return') ||
        lower.includes('policy') ||
        lower.includes('refund') ||
        lower.includes('exchange') ||
        lower.includes('original condition');
      expect(passed).toBe(true);

      noPipelineReport.push({
        scenario: 'Delegation',
        userMessage: 'I want to buy red sneakers and what is the return policy for clothing?',
        agentResponse: result.response,
        metrics,
        traces,
        toolCalls: [],
        passed,
      });
    },
    120_000,
  );

  test.skipIf(!!SKIP_REASON)(
    'NP: Summary Continuity',
    async () => {
      const session = createNoPipelineSession();

      // Inject conversation summary into session data (simulates metadata)
      session.data.values.conversationSummary =
        'Customer was looking at Nike running shoes in size 42 and asked about the 30% discount offer. They were comparing Nike Air Max 90 and Adidas Ultra Boost.';
      session.data.values.user = 'e2e_test_user';
      session.data.values.gender = 'male';
      session.data.values.location = 'Dubai';

      const { result, metrics, traces } = await executeTurnNP(
        session,
        'Hey there',
        'Summary Continuity',
      );

      expect(result.response.length).toBeGreaterThan(10);
      const lower = result.response.toLowerCase();
      const referencedPriorContext =
        lower.includes('nike') ||
        lower.includes('running shoes') ||
        lower.includes('air max') ||
        lower.includes('size 42') ||
        lower.includes('adidas') ||
        lower.includes('last time') ||
        lower.includes('previous') ||
        lower.includes('welcome back') ||
        lower.includes('continue') ||
        lower.includes('where we left off') ||
        lower.includes('before');
      expect(referencedPriorContext).toBe(true);

      noPipelineReport.push({
        scenario: 'Summary Continuity',
        userMessage: 'Hey there',
        agentResponse: result.response,
        metrics,
        traces,
        toolCalls: [],
        passed: referencedPriorContext,
      });
    },
    60_000,
  );

  test.skipIf(!!SKIP_REASON)(
    'NP: Multi-turn',
    async () => {
      const session = createNoPipelineSession();

      const turn1 = await executeTurnNP(session, 'Hi', 'Turn 1');
      expect(turn1.result.response.length).toBeGreaterThan(10);

      const turn2 = await executeTurnNP(
        session,
        'Show me red sneakers under 500 AED for men',
        'Turn 2',
      );
      expect(turn2.result.response.length).toBeGreaterThan(50);

      const turn3 = await executeTurnNP(
        session,
        'What about Nike ones? Show me Nike options',
        'Turn 3',
      );
      expect(turn3.result.response.length).toBeGreaterThan(20);

      console.log('\n' + '━'.repeat(80));
      console.log('  No-Pipeline Multi-Turn Performance Summary');
      console.log('━'.repeat(80));
      logScenarioResult('Turn 1 (Greeting)', true, turn1.metrics.total);
      logScenarioResult('Turn 2 (Search)', true, turn2.metrics.total);
      logScenarioResult('Turn 3 (Follow-up)', true, turn3.metrics.total);
      console.log(
        `\n  Total wall time: ${fmt(turn1.metrics.total + turn2.metrics.total + turn3.metrics.total)}`,
      );

      noPipelineReport.push({
        scenario: 'Multi-turn (Turn 1: Greeting)',
        userMessage: 'Hi',
        agentResponse: turn1.result.response,
        metrics: turn1.metrics,
        traces: turn1.traces,
        toolCalls: [],
        passed: true,
      });
      noPipelineReport.push({
        scenario: 'Multi-turn (Turn 2: Search)',
        userMessage: 'Show me red sneakers under 500 AED for men',
        agentResponse: turn2.result.response,
        metrics: turn2.metrics,
        traces: turn2.traces,
        toolCalls: [],
        passed: true,
      });
      noPipelineReport.push({
        scenario: 'Multi-turn (Turn 3: Follow-up)',
        userMessage: 'What about Nike ones? Show me Nike options',
        agentResponse: turn3.result.response,
        metrics: turn3.metrics,
        traces: turn3.traces,
        toolCalls: [],
        passed: true,
      });
    },
    180_000,
  );
});
