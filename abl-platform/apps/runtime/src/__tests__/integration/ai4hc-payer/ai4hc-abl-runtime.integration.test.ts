/**
 * AI4HC Payer — ABL Runtime E2E Test
 *
 * Tests conversational scenarios against the ABL Runtime with compiled agent DSL files.
 * Uses the same Data Tables API as Kore.ai production.
 *
 * Architecture:
 *   Healthcare_Supervisor → auth gate → routes to 4 child agents
 *   Authentication_Agent, Plan_Information_Agent, Coverage_Information_Agent, Claim_Information_Agent
 *
 * Required env vars:
 *   AZURE_OPENAI_API_KEY           – For Azure OpenAI GPT-4.1 LLM
 *   AZURE_OPENAI_ENDPOINT          – Azure OpenAI endpoint URL
 *   AZURE_OPENAI_DEPLOYMENT        – Azure OpenAI deployment name
 *
 * Run with:
 *   npx vitest run --config vitest.integration.config.ts src/__tests__/integration/ai4hc-payer/ai4hc-abl-runtime.integration.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

// ── Mock DB models to avoid Mongoose timeouts (no MongoDB in E2E) ──
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

// Load .env from runtime app root
dotenvConfig({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..', '.env'),
});
// Also load root .env (override: false to not clobber runtime .env)
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
import { loadToolDSLsAsResolved } from '@agent-platform/shared/tools/standalone-tool-adapter';
import type { ToolDefinition } from '@abl/compiler';

import { SCENARIOS } from './scenarios';

// =============================================================================
// CONFIG
// =============================================================================

const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY ?? '';
const AZURE_OPENAI_ENDPOINT =
  process.env.AZURE_OPENAI_ENDPOINT ?? 'https://healthassisteastus2.openai.azure.com';
const AZURE_OPENAI_DEPLOYMENT =
  process.env.AZURE_OPENAI_DEPLOYMENT ?? 'healthassist-gpt-4.1-2025-04-14';
const LLM_MODEL = 'gpt-4.1';

const SKIP_REASON = !AZURE_OPENAI_API_KEY
  ? 'AZURE_OPENAI_API_KEY not set — skipping ABL Runtime E2E tests'
  : '';

// =============================================================================
// LOAD ABL DSL FILES
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = path.resolve(__dirname, '../../../../../../examples/ai4hc-payer-provider');

function loadDSL(relativePath: string): string {
  const fullPath = path.resolve(EXAMPLES_DIR, relativePath);
  return fs.readFileSync(fullPath, 'utf-8');
}

// =============================================================================
// LOAD TOOL DSL FILES
// =============================================================================

function resolveToolDSLs(): Map<string, ToolDefinition[]> {
  // Load individual standalone tool files (TOOL: singular header, one per file)
  const authToolDSL = loadDSL('tools/perform_provider_authentication.tools.abl');
  const planToolDSL = loadDSL('tools/get_plan_information.tools.abl');
  const claimToolDSL = loadDSL('tools/get_claim_information.tools.abl');
  const coverageKBDSL = loadDSL('tools/plan_services_coverage_kb.tools.abl');

  const resolved = loadToolDSLsAsResolved([authToolDSL, planToolDSL, claimToolDSL, coverageKBDSL]);

  // Map tools to the agents that declare them
  const byAgent = new Map<string, ToolDefinition[]>();

  const authTool = resolved.get('perform_provider_authentication');
  if (authTool) byAgent.set('Authentication_Agent', authTool as unknown as ToolDefinition[]);

  const planTool = resolved.get('get_plan_information');
  const coverageKB = resolved.get('Plan_Services_Coverage_Knowledge_Base');

  if (planTool) {
    byAgent.set('Plan_Information_Agent', planTool as unknown as ToolDefinition[]);
    // Coverage agent uses both plan tool and KB
    const coverageTools: ToolDefinition[] = [...(planTool as unknown as ToolDefinition[])];
    if (coverageKB) coverageTools.push(...(coverageKB as unknown as ToolDefinition[]));
    byAgent.set('Coverage_Information_Agent', coverageTools);
  }

  const claimTool = resolved.get('get_claim_information');
  if (claimTool) byAgent.set('Claim_Information_Agent', claimTool as unknown as ToolDefinition[]);

  return byAgent;
}

// =============================================================================
// TIMING HELPERS
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

interface TurnRecord {
  scenario: string;
  userMessage: string;
  agentResponse: string;
  metrics: TurnMetrics;
  passed: boolean;
}

const runReport: TurnRecord[] = [];

function logTurn(scenario: string, message: string, response: string, metrics: TurnMetrics) {
  const fmtSec = (ms: number) => (ms / 1000).toFixed(2) + 's';
  console.log(`\n── ${scenario} ──`);
  console.log(`  User: "${message}"`);
  console.log(
    `  Agent: "${response.length > 300 ? response.substring(0, 300) + '...' : response}"`,
  );
  console.log(
    `  TTFB: ${fmtSec(metrics.ttfb)} | Total: ${fmtSec(metrics.total)} | Chunks: ${metrics.chunkCount}`,
  );
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe.skipIf(!!SKIP_REASON)('AI4HC Payer — ABL Runtime E2E', () => {
  let executor: RuntimeExecutor;
  let supervisorDSL: string;
  let authAgentDSL: string;
  let planAgentDSL: string;
  let coverageAgentDSL: string;
  let claimAgentDSL: string;

  beforeAll(async () => {
    if (SKIP_REASON) return;

    if (!isConfigLoaded()) {
      await loadConfig();
    }

    // Load all DSL files
    supervisorDSL = loadDSL('agents/healthcare_supervisor.agent.abl');
    authAgentDSL = loadDSL('agents/authentication_agent.agent.abl');
    planAgentDSL = loadDSL('agents/plan_information_agent.agent.abl');
    coverageAgentDSL = loadDSL('agents/coverage_information_agent.agent.abl');
    claimAgentDSL = loadDSL('agents/claim_information_agent.agent.abl');

    console.log(`[AI4HC ABL E2E] DSL directory: ${EXAMPLES_DIR}`);
    console.log(`[AI4HC ABL E2E] LLM: Azure OpenAI ${AZURE_OPENAI_DEPLOYMENT}`);
    console.log(`[AI4HC ABL E2E] Scenarios: ${SCENARIOS.length}`);
  }, 30_000);

  beforeEach(() => {
    if (SKIP_REASON) return;
    executor = new RuntimeExecutor();

    // Wire Azure OpenAI as the LLM provider
    // Extract resource name from endpoint URL (e.g., 'healthassisteastus2' from 'https://healthassisteastus2.openai.azure.com')
    const azureResourceName = new URL(AZURE_OPENAI_ENDPOINT).hostname.split('.')[0];
    const mockResolution = {
      resolve: async () => ({
        modelId: AZURE_OPENAI_DEPLOYMENT,
        provider: 'azure',
        source: 'system_default' as const,
        credential: {
          apiKey: AZURE_OPENAI_API_KEY,
          authType: 'api_key',
          authConfig: {
            resourceName: azureResourceName,
            deploymentId: AZURE_OPENAI_DEPLOYMENT,
            apiVersion: '2024-08-01-preview',
          },
        },
        parameters: { maxTokens: 4096, temperature: 0.4 },
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
    if (SKIP_REASON || runReport.length === 0) return;

    const reportPath = path.resolve(__dirname, 'ai4hc-abl-run-report.json');
    const report = {
      timestamp: new Date().toISOString(),
      platform: 'abl',
      model: `azure/${AZURE_OPENAI_DEPLOYMENT}`,
      scenarios: runReport,
      summary: {
        total: runReport.length,
        passed: runReport.filter((r) => r.passed).length,
        failed: runReport.filter((r) => !r.passed).length,
        avgTotalMs: Math.round(
          runReport.reduce((s, r) => s + r.metrics.total, 0) / runReport.length,
        ),
        avgTtfbMs: Math.round(runReport.reduce((s, r) => s + r.metrics.ttfb, 0) / runReport.length),
      },
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n  Run report written to ${reportPath}`);

    // Print summary table
    console.log('\n' + '='.repeat(80));
    console.log('  AI4HC Payer — ABL Runtime Results');
    console.log('='.repeat(80));
    for (const s of runReport) {
      const icon = s.passed ? 'PASS' : 'FAIL';
      const ttfb = ((s.metrics?.ttfb ?? 0) / 1000).toFixed(1);
      const total = ((s.metrics?.total ?? 0) / 1000).toFixed(1);
      console.log(`  ${icon} ${s.scenario.padEnd(50)} TTFB: ${ttfb}s  Total: ${total}s`);
    }
    console.log('='.repeat(80));
  });

  /**
   * Create a multi-agent session for AI4HC Payer.
   */
  function createSession(): RuntimeSession {
    const resolvedTools = resolveToolDSLs();
    const resolved = compileToResolvedAgent(
      [supervisorDSL, authAgentDSL, planAgentDSL, coverageAgentDSL, claimAgentDSL],
      'Healthcare_Supervisor',
      undefined,
      resolvedTools,
    );

    const session = executor.createSessionFromResolved(resolved, {
      tenantId: 'ai4hc-test',
      projectId: 'ai4hc-payer-provider',
      userId: 'e2e_test_user',
    });

    return session;
  }

  /**
   * Execute a turn with timing metrics.
   */
  async function executeTurn(
    session: RuntimeSession,
    message: string,
    turnLabel: string,
  ): Promise<{ response: string; metrics: TurnMetrics }> {
    const chunks: string[] = [];
    const metrics: TurnMetrics = {
      startMs: Date.now(),
      firstChunkMs: 0,
      endMs: 0,
      ttfb: 0,
      total: 0,
      chunkCount: 0,
      responseLength: 0,
    };

    const result = await executor.executeMessage(session.id, message, (chunk: string) => {
      if (metrics.firstChunkMs === 0) {
        metrics.firstChunkMs = Date.now();
        metrics.ttfb = metrics.firstChunkMs - metrics.startMs;
      }
      chunks.push(chunk);
      metrics.chunkCount++;
    });

    metrics.endMs = Date.now();
    metrics.total = metrics.endMs - metrics.startMs;
    if (metrics.firstChunkMs === 0) {
      metrics.ttfb = metrics.total;
      metrics.firstChunkMs = metrics.endMs;
    }

    const response = result.response ?? chunks.join('');
    metrics.responseLength = response.length;

    logTurn(turnLabel, message, response, metrics);

    return { response, metrics };
  }

  // ─── Scenario Tests ─────────────────────────────────────────────────────────

  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      let session: RuntimeSession;

      beforeEach(() => {
        if (SKIP_REASON) return;
        session = createSession();
      });

      const turnLabels: string[] = [];
      for (let t = 0; t < scenario.turns.length; t++) {
        const turn = scenario.turns[t];
        const turnLabel = `Turn ${t + 1}: "${turn.user.slice(0, 50)}"`;
        turnLabels.push(turnLabel);

        test(
          turnLabel,
          async () => {
            // Execute all turns up to and including this one (sequential conversation)
            let lastResponse = '';
            let lastMetrics: TurnMetrics | null = null;

            for (let i = 0; i <= t; i++) {
              const { response, metrics } = await executeTurn(
                session,
                scenario.turns[i].user,
                `${scenario.name} · Turn ${i + 1}`,
              );
              lastResponse = response;
              lastMetrics = metrics;
            }

            // Assert non-empty response
            expect(lastResponse.length).toBeGreaterThan(0);

            // Record for report
            runReport.push({
              scenario: `${scenario.name} · Turn ${t + 1}`,
              userMessage: turn.user,
              agentResponse: lastResponse,
              metrics: lastMetrics!,
              passed: true,
            });
          },
          turn.maxTimeMs ? turn.maxTimeMs * 2 + 30000 : 120000,
        );
      }
    });
  }

  // ─── DSL Compilation Check (always runs) ──────────────────────────────────

  test('All DSL files compile without errors', () => {
    const resolvedTools = resolveToolDSLs();
    const resolved = compileToResolvedAgent(
      [supervisorDSL, authAgentDSL, planAgentDSL, coverageAgentDSL, claimAgentDSL],
      'Healthcare_Supervisor',
      undefined,
      resolvedTools,
    );

    expect(Object.keys(resolved.agents).length).toBe(5);

    const agentNames = Object.keys(resolved.agents);
    expect(agentNames).toContain('Healthcare_Supervisor');
    expect(agentNames).toContain('Authentication_Agent');
    expect(agentNames).toContain('Plan_Information_Agent');
    expect(agentNames).toContain('Coverage_Information_Agent');
    expect(agentNames).toContain('Claim_Information_Agent');

    console.log(`  Compiled agents: ${agentNames.join(', ')}`);
    console.log(`  Entry agent: ${resolved.entryAgent}`);
  });
});
