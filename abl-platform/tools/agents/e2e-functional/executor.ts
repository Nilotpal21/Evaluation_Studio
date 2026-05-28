/**
 * Functional E2E Test Executor
 *
 * Orchestrates mock servers, sandbox creation, scenario execution, and reporting.
 *
 * Prerequisites:
 *   - Studio running (default http://localhost:5173) with ENABLE_DEV_LOGIN=true
 *   - Runtime running (default http://localhost:3112)
 *   - MongoDB accessible (auto-reads MONGODB_URL from apps/runtime/.env)
 *
 * Usage:
 *   npx tsx tools/agents/e2e-functional/executor.ts \
 *     [--studio-url http://localhost:5173] \
 *     [--runtime-url http://localhost:3112] \
 *     [--real-llm] \
 *     [--scenarios 1,2,4]
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, type SandboxConfig } from '../e2e-smoke/sandbox.js';
import { startMockLLM } from './mock-llm-server.js';
import { startMockToolServer } from './mock-tool-server.js';
import { getScenarios, runScenario } from './scenarios/index.js';
import type { ScenarioResult, ScenarioContext, ExtendedSandbox, MockMcpServer } from './types.js';

// Import all scenario files to trigger registration
import './scenarios/basic-chat.js';
import './scenarios/guardrails.js';
import './scenarios/multi-agent.js';
import './scenarios/http-tools.js';
import './scenarios/mcp-tools.js';
import './scenarios/memory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── CLI ────────────────────────────────────────────────────────────────────

interface ExecutorConfig extends SandboxConfig {
  realLlm: boolean;
  scenarioFilter?: number[];
}

function parseArgs(): ExecutorConfig {
  const args = process.argv.slice(2);
  let studioUrl = 'http://localhost:5173';
  let runtimeUrl = 'http://localhost:3112';
  let realLlm = false;
  let scenarioFilter: number[] | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--studio-url':
        studioUrl = args[++i];
        break;
      case '--runtime-url':
        runtimeUrl = args[++i];
        break;
      case '--admin-token':
        // Accepted for backward-compat but unused — sandbox authenticates via dev-login
        i++;
        break;
      case '--real-llm':
        realLlm = true;
        break;
      case '--scenarios':
        scenarioFilter = args[++i]
          .split(',')
          .map(Number)
          .filter((n) => !isNaN(n));
        break;
    }
  }

  return { studioUrl, runtimeUrl, adminToken: '', realLlm, scenarioFilter };
}

// ─── Report ─────────────────────────────────────────────────────────────────

function formatReport(
  results: ScenarioResult[],
  mode: string,
  tenantId: string,
  projectId: string,
  totalDurationMs: number,
): string {
  const lines: string[] = [];
  const timestamp = new Date().toISOString();

  lines.push(`Functional E2E Report — ${timestamp}`);
  lines.push(`Mode: ${mode} | Tenant: ${tenantId} | Project: ${projectId}`);
  lines.push('');

  for (const r of results) {
    const status = r.passed ? 'PASS' : 'FAIL';
    const duration = `${(r.durationMs / 1000).toFixed(1)}s`;
    const name = r.name.padEnd(25, '.');
    const suffix = r.error ? ` — ${r.error.slice(0, 100)}` : '';
    lines.push(`${status}  [${r.id}] ${name} ${duration}${suffix}`);
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const totalSec = (totalDurationMs / 1000).toFixed(1);
  lines.push('');
  lines.push(`Result: ${passed}/${total} passed | Duration: ${totalSec}s`);

  return lines.join('\n');
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = parseArgs();
  const mode = config.realLlm ? 'real-llm' : 'mock-llm';
  const scenarioTimeoutMs = config.realLlm ? 300_000 : 120_000;

  console.log(`Functional E2E Test — mode: ${mode}`);
  console.log(`  Studio:  ${config.studioUrl}`);
  console.log(`  Runtime: ${config.runtimeUrl}`);
  console.log('');

  // 1. Start mock servers
  const mockLlm = await startMockLLM();
  const mockToolServer = await startMockToolServer();

  // MCP server is a standalone script — provide command info for DSL references
  const mockMcpServer: MockMcpServer = {
    command: 'npx',
    args: ['tsx', resolve(__dirname, 'mock-mcp-server.ts')],
    close: async () => {
      /* no-op: MCP server is started per-use by the runtime */
    },
  };

  console.log(`  Mock LLM:  ${mockLlm.url}`);
  console.log(`  Mock Tool: ${mockToolServer.url}`);
  console.log('');

  let sandbox: ExtendedSandbox | undefined;
  const results: ScenarioResult[] = [];
  const startTime = Date.now();

  try {
    // 2. Create sandbox with LLM infrastructure
    const sandboxConfig: Partial<SandboxConfig> = {
      studioUrl: config.studioUrl,
      runtimeUrl: config.runtimeUrl,
      adminToken: config.adminToken,
    };

    if (!config.realLlm) {
      (sandboxConfig as Record<string, unknown>).mockLlmUrl = mockLlm.url;
    } else {
      (sandboxConfig as Record<string, unknown>).realLlm = true;
    }

    sandbox = (await createSandbox(sandboxConfig)) as ExtendedSandbox;

    console.log(`  Tenant:  ${sandbox.tenantId}`);
    console.log(`  Project: ${sandbox.projectId}`);
    console.log(`  Agent:   ${sandbox.agentId}`);
    console.log('');

    // 3. Get scenarios to run
    const scenarios = getScenarios(config.scenarioFilter);
    console.log(`Running ${scenarios.length} scenarios...`);
    console.log('');

    const ctx: ScenarioContext = {
      sandbox,
      studioUrl: config.studioUrl,
      runtimeUrl: config.runtimeUrl,
      mockLlm,
      mockToolServer,
      mockMcpServer,
      realLlm: config.realLlm,
      scenarioTimeoutMs,
    };

    // 4. Run all scenarios sequentially
    for (const scenario of scenarios) {
      const tag = scenario.method === 'agent-sdk' ? ' (agent SDK)' : '';
      process.stdout.write(`  [${scenario.id}] ${scenario.name}${tag}...`);

      const result = await runScenario(scenario, ctx);
      results.push(result);

      const status = result.passed ? 'PASS' : 'FAIL';
      const duration = `${(result.durationMs / 1000).toFixed(1)}s`;
      console.log(` ${status} (${duration})`);

      if (!result.passed && result.error) {
        console.log(`       Error: ${result.error.slice(0, 200)}`);
      }
    }

    // 5. Write report
    const totalDurationMs = Date.now() - startTime;
    const report = formatReport(
      results,
      mode,
      sandbox.tenantId,
      sandbox.projectId,
      totalDurationMs,
    );

    const reportPath = resolve(__dirname, 'last-report.txt');
    writeFileSync(reportPath, report, 'utf-8');

    console.log('\n' + '='.repeat(70));
    console.log(report);
    console.log('='.repeat(70));
    console.log(`\nReport saved to: ${reportPath}`);
  } finally {
    // 6. Cleanup
    if (sandbox) {
      try {
        await sandbox.cleanup();
      } catch (err) {
        console.warn(`Cleanup error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await mockLlm.close();
    await mockToolServer.close();
  }

  // Exit with appropriate code
  const allPassed = results.every((r) => r.passed);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
