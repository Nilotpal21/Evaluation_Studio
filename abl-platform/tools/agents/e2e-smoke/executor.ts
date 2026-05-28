/**
 * E2E Smoke Test Executor — Agent A (Layer 3)
 *
 * Reads the route manifest, creates an isolated tenant sandbox,
 * then launches a Claude Agent SDK agent that exercises every route.
 *
 * Usage (via bootstrap entry point):
 *   npx tsx tools/agents/e2e-smoke/run.ts \
 *     [--studio-url http://localhost:5173] \
 *     [--runtime-url http://localhost:3112]
 *
 * Must be run from within Claude Code (the Agent SDK spawns a Claude Code subprocess).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { withSandbox, type SandboxConfig } from './sandbox.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): SandboxConfig {
  const args = process.argv.slice(2);
  let studioUrl = 'http://localhost:5173';
  let runtimeUrl = 'http://localhost:3112';
  // adminToken kept for backward compat but unused — sandbox authenticates via dev-login
  let adminToken = process.env.ADMIN_TOKEN ?? '';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--studio-url':
        studioUrl = args[++i];
        break;
      case '--runtime-url':
        runtimeUrl = args[++i];
        break;
      case '--admin-token':
        adminToken = args[++i];
        break;
    }
  }

  // Validate URLs to prevent SSRF or malformed targets
  for (const [label, url] of [
    ['studio-url', studioUrl],
    ['runtime-url', runtimeUrl],
  ] as const) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        console.error(`ERROR: --${label} must use http or https protocol`);
        process.exit(1);
      }
    } catch {
      console.error(`ERROR: --${label} is not a valid URL: ${url}`);
      process.exit(1);
    }
  }

  return { studioUrl, runtimeUrl, adminToken };
}

// ---------------------------------------------------------------------------
// Manifest loader
// ---------------------------------------------------------------------------

function loadManifest(): string {
  const manifestPath = resolve(__dirname, 'route-manifest.json');
  try {
    return readFileSync(manifestPath, 'utf-8');
  } catch {
    throw new Error(
      `route-manifest.json not found at ${manifestPath}. Run 'pnpm manifest:generate' first.`,
    );
  }
}

// ---------------------------------------------------------------------------
// System prompt loader
// ---------------------------------------------------------------------------

function loadSystemPrompt(): string {
  const promptPath = resolve(__dirname, '../prompts/e2e-executor.md');
  try {
    return readFileSync(promptPath, 'utf-8');
  } catch {
    throw new Error(`System prompt not found at ${promptPath}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = parseArgs();
  const manifestJson = loadManifest();
  const systemPrompt = loadSystemPrompt();

  console.log('Starting E2E Smoke Test...');
  console.log(`  Studio URL:  ${config.studioUrl}`);
  console.log(`  Runtime URL: ${config.runtimeUrl}`);

  await withSandbox(config, async (sandbox) => {
    console.log(`  Tenant ID:   ${sandbox.tenantId}`);
    console.log(`  Project ID:  ${sandbox.projectId}`);
    console.log(`  Agent ID:    ${sandbox.agentId}`);
    console.log(`  Session ID:  ${sandbox.sessionId}`);
    console.log('');

    // Build the user prompt with concrete sandbox IDs and the manifest
    const userPrompt = [
      '## Sandbox Context',
      '',
      `- **Studio URL:** ${config.studioUrl}`,
      `- **Runtime URL:** ${config.runtimeUrl}`,
      `- **Tenant ID:** ${sandbox.tenantId}`,
      `- **Project ID:** ${sandbox.projectId}`,
      `- **Agent ID:** ${sandbox.agentId}`,
      `- **Session ID:** ${sandbox.sessionId}`,
      `- **Auth Token:** available in $E2E_AUTH_TOKEN env var. Use it in curl: \`-H "Authorization: Bearer $E2E_AUTH_TOKEN"\``,
      '',
      '## Token Refresh',
      '',
      'The auth token expires after 15 minutes. If you get 401 responses, refresh it by running:',
      '```bash',
      `FRESH=$(curl -s -X POST ${config.studioUrl}/api/auth/dev-login -H "Content-Type: application/json" -d '${JSON.stringify({ email: sandbox.email })}' | jq -r '.accessToken') && export E2E_AUTH_TOKEN="$FRESH" && echo "Token refreshed"`,
      '```',
      'Run this proactively every ~50 routes to avoid token expiry mid-batch.',
      '',
      '## Route Manifest',
      '',
      '```json',
      manifestJson,
      '```',
      '',
      'Execute all routes in the manifest following the execution phases. Report results when complete.',
    ].join('\n');

    let finalReport = '';

    // Pass the auth token via environment variable so it never appears in
    // the prompt text, agent output, or persisted report files.
    const agentStream = query({
      prompt: userPrompt,
      options: {
        model: 'claude-sonnet-4-6',
        allowedTools: ['Read', 'Bash', 'Glob', 'Grep'],
        permissionMode: 'acceptEdits',
        maxTurns: 200,
        maxBudgetUsd: 25.0,
        systemPrompt,
        env: { ...process.env, E2E_AUTH_TOKEN: sandbox.authToken },
      },
    });

    let turnCount = 0;
    for await (const message of agentStream) {
      if (message.type === 'result') {
        finalReport = (message as { result: string }).result;
      } else if (message.type === 'assistant') {
        turnCount++;
        console.log(`  [Turn ${turnCount}] Agent responded`);
      }
    }

    if (!finalReport) {
      throw new Error(
        'Agent returned no report. The run may have hit maxTurns without completing.',
      );
    }

    // Write the report
    const reportPath = resolve(__dirname, 'last-report.txt');
    writeFileSync(reportPath, finalReport, 'utf-8');

    console.log('\n' + '='.repeat(80));
    console.log('E2E SMOKE TEST REPORT');
    console.log('='.repeat(80));
    console.log(finalReport);
    console.log('='.repeat(80));
    console.log(`\nReport saved to: ${reportPath}`);
  });
}

main()
  .catch((err) => {
    console.error('Fatal error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(() => mongoose.disconnect());
