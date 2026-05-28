#!/usr/bin/env tsx
/**
 * Multi-Agent Review (Agent C)
 *
 * Dispatches 10 parallel subagents to review a commit against ABL platform
 * invariants. Each subagent focuses on a specific domain (security, isolation,
 * performance, etc.) and reports findings with severity and file:line locations.
 *
 * Usage:
 *   pnpm review:multi              # reviews HEAD
 *   pnpm review:multi abc1234      # reviews specific commit
 *   tsx tools/agents/multi-review.ts [commit-sha]
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, type AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL = 'claude-sonnet-4-6';
const MAX_TURNS = 50;
const MAX_BUDGET_USD = 5.0;
const PROMPTS_DIR = resolve(__dirname, 'prompts');

// Severity ranking — higher index = lower priority.
// When deduplicating by file:line, the finding from the higher-priority
// (lower index) subagent wins.
const SEVERITY_DOMAIN_RANK: string[] = [
  'security',
  'isolation',
  'acl',
  'stateless',
  'performance',
  'architecture',
  'api-contracts',
  'db-models',
  'runtime-logic',
  'studio-react',
];

// Maps subagent name -> prompt filename and domain tag
const SUBAGENT_CONFIG: Record<string, { promptFile: string; domain: string; description: string }> =
  {
    'runtime-logic': {
      promptFile: 'runtime-reviewer.md',
      domain: 'runtime-logic',
      description:
        'Reviews runtime service logic for race conditions, missing awaits, error handling, and break conditions.',
    },
    'studio-react': {
      promptFile: 'studio-reviewer.md',
      domain: 'studio-react',
      description:
        'Reviews React components for missing keys, stale closures, useEffect cleanup, and incorrect prop types.',
    },
    security: {
      promptFile: 'security-reviewer.md',
      domain: 'security',
      description:
        'Reviews for SSRF, injection, credential exposure, stack trace leaks, and tenant isolation violations.',
    },
    'api-contracts': {
      promptFile: 'api-reviewer.md',
      domain: 'api-contracts',
      description:
        'Reviews API response envelopes, status codes, and error shapes for consistency.',
    },
    'db-models': {
      promptFile: 'db-reviewer.md',
      domain: 'db-models',
      description:
        'Reviews database schema changes, index coverage, migration safety, and field type changes.',
    },
    performance: {
      promptFile: 'performance-reviewer.md',
      domain: 'performance',
      description:
        'Reviews for N+1 queries, unbounded loops, missing pagination, and in-memory Map size/TTL limits.',
    },
    stateless: {
      promptFile: 'stateless-reviewer.md',
      domain: 'stateless',
      description:
        'Reviews for in-memory state without Redis/Mongo backing, singleton state, and missing distributed locks.',
    },
    isolation: {
      promptFile: 'isolation-reviewer.md',
      domain: 'isolation',
      description:
        'Reviews for tenant/project isolation: every query scoped to tenantId/projectId, no findById without tenant.',
    },
    acl: {
      promptFile: 'acl-reviewer.md',
      domain: 'acl',
      description:
        'Reviews for requireAuth on every route, requireProjectPermission with correct operations, no custom JWT.',
    },
    architecture: {
      promptFile: 'architecture-reviewer.md',
      domain: 'architecture',
      description:
        'Reviews for thin routes, business logic in services, no direct DB in routes, and repo pattern usage.',
    },
  };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the target commit SHA from CLI args or default to HEAD.
 * Input is from process.argv (developer-controlled CLI), not from
 * external/untrusted sources.
 */
function getCommitSha(): string {
  const arg = process.argv[2];
  if (arg && !arg.startsWith('-')) {
    // Validate: must look like a hex SHA prefix (safe for shell use)
    if (!/^[0-9a-fA-F]{4,40}$/.test(arg)) {
      console.error(`ERROR: Invalid commit SHA format: ${arg}`);
      process.exit(1);
    }
    return arg;
  }
  return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
}

function getShortSha(sha: string): string {
  return sha.slice(0, 7);
}

function getCommitDiff(sha: string): string {
  try {
    return execSync(`git diff ${sha}~1..${sha}`, {
      encoding: 'utf-8',
      maxBuffer: 20 * 1024 * 1024, // 20 MB
    }).trim();
  } catch {
    // Fallback for initial commit or shallow clone
    return execSync(`git show ${sha} --format="" --patch`, {
      encoding: 'utf-8',
      maxBuffer: 20 * 1024 * 1024,
    }).trim();
  }
}

function getCommitMessage(sha: string): string {
  try {
    return execSync(`git log -1 --format="%s" ${sha}`, {
      encoding: 'utf-8',
    }).trim();
  } catch {
    return '(unknown commit message)';
  }
}

function loadPrompt(filename: string): string {
  const fullPath = resolve(PROMPTS_DIR, filename);
  try {
    return readFileSync(fullPath, 'utf-8');
  } catch {
    throw new Error(`Prompt file not found: ${fullPath}. Ensure all prompt files are present.`);
  }
}

function todayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Build subagent definitions
// ---------------------------------------------------------------------------

function buildAgents(diff: string): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};

  for (const [name, config] of Object.entries(SUBAGENT_CONFIG)) {
    const systemPrompt = loadPrompt(config.promptFile);

    agents[name] = {
      description: config.description,
      prompt: [
        systemPrompt,
        '',
        '---',
        '',
        '## Commit Diff to Review',
        '',
        'Review the following diff. Use Read, Glob, and Grep tools to inspect',
        'surrounding code when the diff alone is ambiguous. Only report findings',
        'you are confident about.',
        '',
        '```diff',
        diff,
        '```',
      ].join('\n'),
      tools: ['Read', 'Glob', 'Grep'],
      model: 'sonnet',
    };
  }

  return agents;
}

// ---------------------------------------------------------------------------
// Orchestrator prompt
// ---------------------------------------------------------------------------

function buildOrchestratorPrompt(sha: string, commitMessage: string): string {
  const domainList = Object.entries(SUBAGENT_CONFIG)
    .map(([name, c]) => `- **${name}**: ${c.description}`)
    .join('\n');

  const agentCount = Object.keys(SUBAGENT_CONFIG).length;
  const severityRank = SEVERITY_DOMAIN_RANK.map((d, i) => `${i + 1}. ${d}`).join('\n');

  return `You are the orchestrator for a multi-agent code review of commit ${sha}.

Commit message: "${commitMessage}"

You have ${agentCount} specialized review subagents available. Your job:

1. **Dispatch ALL ${agentCount} subagents in parallel** using the Agent tool. Each subagent already has the diff in its prompt. Ask each one to "Review the commit diff and report findings."

2. **Collect all findings** from every subagent. Each returns findings in the format:
   \`SEVERITY file:line — description\`
   where SEVERITY is CRITICAL, WARNING, or INFO.

3. **Deduplicate by file:line**. If multiple subagents flag the same file:line, keep only the finding from the highest-priority domain. Domain priority (highest first):
${severityRank}

4. **Filter**: Only surface high-confidence findings. Drop anything speculative.

5. **Output the final report** in this exact markdown format:

\`\`\`markdown
# Multi-Agent Review Report — ${sha}

**Commit:** ${commitMessage}
**Date:** ${todayStamp()}
**Reviewed by:** ${agentCount} subagents

## Critical (must fix)

- **[domain]** \`file:line\` — description

## Warnings

- **[domain]** \`file:line\` — description

## Info

- **[domain]** \`file:line\` — description

---

Summary: X critical, Y warnings, Z info
\`\`\`

If a section has no findings, write "None." under it.

## Available Subagents

${domainList}

## Important

- Dispatch ALL ${agentCount} subagents. Do not skip any.
- Use the Agent tool to dispatch them. Call all ${agentCount} in parallel (do not wait for one before starting the next).
- After all subagents return, compile the deduplicated report.
- The final report must be your last message. Output ONLY the markdown report, nothing else.`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const sha = getCommitSha();
  const shortSha = getShortSha(sha);
  const commitMessage = getCommitMessage(sha);

  console.log(`\x1b[1mMulti-Agent Review\x1b[0m — commit ${shortSha}`);
  console.log(`  Message: ${commitMessage}`);
  console.log(`  Subagents: ${Object.keys(SUBAGENT_CONFIG).length}`);
  console.log(`  Model: ${MODEL}`);
  console.log(`  Budget: $${MAX_BUDGET_USD}`);
  console.log('\u2501'.repeat(46) + '\n');

  const diff = getCommitDiff(sha);

  if (!diff) {
    console.log('No diff found for this commit. Nothing to review.');
    process.exit(0);
  }

  const diffLineCount = diff.split('\n').length;
  console.log(`  Diff size: ${diffLineCount} lines`);
  console.log('  Dispatching subagents...\n');

  const agents = buildAgents(diff);
  const orchestratorPrompt = buildOrchestratorPrompt(shortSha, commitMessage);

  let finalReport = '';
  const startTime = Date.now();

  const agentStream = query({
    prompt: orchestratorPrompt,
    options: {
      model: MODEL,
      allowedTools: ['Read', 'Glob', 'Grep', 'Agent'],
      permissionMode: 'acceptEdits',
      maxTurns: MAX_TURNS,
      maxBudgetUsd: MAX_BUDGET_USD,
      agents,
    },
  });

  for await (const message of agentStream) {
    if ('result' in message) {
      finalReport = message.result as string;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (!finalReport) {
    console.error(
      'ERROR: Orchestrator returned no report. The run may have hit maxTurns without completing.',
    );
    process.exit(1);
  }

  // Ensure the report directory exists
  const reportsDir = resolve(__dirname, '../../docs/plans');
  mkdirSync(reportsDir, { recursive: true });

  // Write the report
  const reportFilename = `${todayStamp()}-multi-review-${shortSha}.md`;
  const reportPath = resolve(reportsDir, reportFilename);
  writeFileSync(reportPath, finalReport, 'utf-8');

  console.log('\n' + '='.repeat(80));
  console.log('MULTI-AGENT REVIEW REPORT');
  console.log('='.repeat(80));
  console.log(finalReport);
  console.log('='.repeat(80));
  console.log(`\nDuration: ${elapsed}s`);
  console.log(`Report saved to: ${reportPath}`);
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
