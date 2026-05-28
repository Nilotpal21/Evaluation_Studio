#!/usr/bin/env tsx
/**
 * Pre-Commit Audit Agent (Agent B)
 *
 * AI-powered audit of staged git changes using the Claude Agent SDK.
 * Checks for platform invariant violations with context-aware analysis.
 *
 * Usage:
 *   pnpm audit:pre-commit
 *   tsx tools/agents/pre-commit-audit.ts
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TIMEOUT_MS = 30_000;
const MODEL = 'claude-haiku-4-5';
const MAX_TURNS = 8;
const FALLBACK_SCRIPT = resolve(__dirname, '..', 'pre-review-audit.sh');
const PROMPT_PATH = resolve(__dirname, 'prompts', 'pre-commit.md');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStagedDiff(): string {
  try {
    return execSync('git diff --cached --unified=5', {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    }).trim();
  } catch (err) {
    // Log the error so failures aren't silently swallowed — an empty diff
    // will cause main() to exit(0) with "No staged changes to audit."
    console.error('Warning: git diff failed:', err instanceof Error ? err.message : String(err));
    return '';
  }
}

function runFallbackScript(): void {
  console.log('\n⏱  Timeout or error — falling back to tools/pre-review-audit.sh\n');
  try {
    execSync(`bash "${FALLBACK_SCRIPT}"`, {
      stdio: 'inherit',
      encoding: 'utf-8',
    });
  } catch (err) {
    // The shell script uses exit 1 for failures — propagate that
    const code = err instanceof Error && 'status' in err ? (err as { status: number }).status : 1;
    process.exit(code);
  }
}

function loadSystemPrompt(): string {
  try {
    return readFileSync(PROMPT_PATH, 'utf-8');
  } catch {
    throw new Error(`System prompt not found at ${PROMPT_PATH}`);
  }
}

/**
 * Parse the agent output and determine exit code.
 * Exit 1 if any CRITICAL findings, 0 otherwise.
 */
function processFindings(output: string): number {
  const lines = output.split('\n');
  let hasCritical = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('[CRITICAL]')) {
      hasCritical = true;
      console.log(`  \x1b[31mCRITICAL\x1b[0m ${trimmed.slice(10).trim()}`);
    } else if (trimmed.startsWith('[WARNING]')) {
      console.log(`  \x1b[33mWARNING\x1b[0m  ${trimmed.slice(9).trim()}`);
    } else if (trimmed.startsWith('[INFO]')) {
      console.log(`  \x1b[36mINFO\x1b[0m     ${trimmed.slice(6).trim()}`);
    } else if (trimmed.startsWith('Confidence:')) {
      console.log(`             ${trimmed}`);
    } else if (trimmed === 'No issues found.') {
      console.log(`  \x1b[32m✓ No issues found.\x1b[0m`);
    } else {
      console.log(`  ${trimmed}`);
    }
  }

  return hasCritical ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const diff = getStagedDiff();

  if (!diff) {
    console.log('No staged changes to audit.');
    process.exit(0);
  }

  const diffLineCount = diff.split('\n').length;
  console.log(`\x1b[1mPre-Commit Audit Agent\x1b[0m — analyzing ${diffLineCount} diff lines`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const systemPrompt = loadSystemPrompt();

  const userMessage = [
    'Audit the following staged diff for platform invariant violations.',
    'Use Read and Grep tools to verify ambiguous patterns before reporting.',
    '',
    '```diff',
    diff,
    '```',
  ].join('\n');

  // Race the agent against the timeout.
  // Note: if timeout wins, the agent query continues in background until process exits.
  // The Agent SDK does not yet support AbortController; process.exit() in the fallback
  // path terminates everything.
  let exitCode = 0;
  try {
    const result = await Promise.race([runAgent(systemPrompt, userMessage), timeout(TIMEOUT_MS)]);

    if (result === '__TIMEOUT__') {
      runFallbackScript();
      return;
    }

    exitCode = processFindings(result as string);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Agent error: ${message}`);
    runFallbackScript();
    return;
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (exitCode === 0) {
    console.log('\x1b[32m\x1b[1mAudit passed\x1b[0m — no critical findings.');
  } else {
    console.log('\x1b[31m\x1b[1mAudit failed\x1b[0m — fix critical findings before committing.');
  }

  process.exit(exitCode);
}

async function runAgent(systemPrompt: string, userMessage: string): Promise<string> {
  let finalResult = '';

  const messages = query({
    prompt: userMessage,
    options: {
      model: MODEL,
      allowedTools: ['Read', 'Grep'],
      maxTurns: MAX_TURNS,
      systemPrompt,
      permissionMode: 'default',
    },
  });

  for await (const message of messages) {
    if ('result' in message) {
      finalResult = message.result as string;
    }
  }

  return finalResult;
}

function timeout(ms: number): Promise<string> {
  return new Promise((resolve) => {
    setTimeout(() => resolve('__TIMEOUT__'), ms);
  });
}

main();
