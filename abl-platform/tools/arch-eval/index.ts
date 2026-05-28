/**
 * Arch-AI evaluation harness — orchestrator.
 *
 * Loops the configured scenarios, refreshes auth between runs, writes per-run
 * artifacts under docs/testing/arch-eval/<run-id>/, and emits a top-level
 * summary.json + summary.md after all runs complete.
 *
 * Usage:
 *   pnpm exec tsx tools/arch-eval/index.ts \
 *     --email test@example.com \
 *     --studio http://localhost:5173 \
 *     [--only s01-bookstore-support,s05-restaurant-reservation] \
 *     [--max 10]
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runScenario, type EvalBudget } from './run-scenario.js';
import { SCENARIOS, type Scenario } from './scenarios.js';

interface CliArgs {
  email: string;
  studioUrl: string;
  outputRoot: string;
  only?: Set<string>;
  max?: number;
  maxCostUsd?: number;
  maxTokenBudget?: number;
  runId: string;
}

interface TokenCache {
  token?: string;
  issuedAtMs?: number;
}

const DEV_LOGIN_REFRESH_AFTER_MS = 4 * 60 * 1000;
const DEV_LOGIN_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
const PROVIDER_ACCOUNT_FAILURE_PATTERNS = [
  /insufficient credits/i,
  /expired plan/i,
  /billing settings/i,
  /quota exceeded/i,
  /provider account/i,
];

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {
    email: 'test@example.com',
    studioUrl: 'http://localhost:5173',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--email') out.email = argv[++i];
    else if (a === '--studio') out.studioUrl = argv[++i];
    else if (a === '--output-root') out.outputRoot = argv[++i];
    else if (a === '--only') out.only = new Set((argv[++i] ?? '').split(',').filter(Boolean));
    else if (a === '--max') out.max = Number.parseInt(argv[++i] ?? '0', 10) || undefined;
    else if (a === '--max-cost-usd')
      out.maxCostUsd = Number.parseFloat(argv[++i] ?? '0') || undefined;
    else if (a === '--max-token-budget')
      out.maxTokenBudget = Number.parseInt(argv[++i] ?? '0', 10) || undefined;
    else if (a === '--run-id') out.runId = argv[++i];
  }
  if (!out.runId) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    out.runId = `run-${ts}`;
  }
  if (!out.outputRoot) {
    out.outputRoot = path.join(process.cwd(), 'docs/testing/arch-eval', out.runId);
  }
  return out as CliArgs;
}

async function devLogin(studio: string, email: string): Promise<string> {
  let lastError: string | undefined;
  for (let attempt = 0; attempt <= DEV_LOGIN_RETRY_DELAYS_MS.length; attempt += 1) {
    const res = await fetch(`${studio}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name: 'Arch Eval Bot' }),
    });
    if (res.ok) {
      const data = (await res.json()) as { accessToken?: string };
      if (!data.accessToken) throw new Error('dev-login returned no accessToken');
      return data.accessToken;
    }

    lastError = `dev-login failed: ${res.status} ${await readResponseSnippet(res)}`;
    const retryableStatus = res.status === 429 || res.status === 404 || res.status >= 500;
    if (!retryableStatus || attempt >= DEV_LOGIN_RETRY_DELAYS_MS.length) {
      break;
    }
    await sleep(DEV_LOGIN_RETRY_DELAYS_MS[attempt]);
  }

  throw new Error(lastError ?? 'dev-login failed');
}

async function getEvalToken(args: CliArgs, cache: TokenCache): Promise<string> {
  const now = Date.now();
  if (cache.token && cache.issuedAtMs && now - cache.issuedAtMs < DEV_LOGIN_REFRESH_AFTER_MS) {
    return cache.token;
  }

  const token = await devLogin(args.studioUrl, args.email);
  cache.token = token;
  cache.issuedAtMs = now;
  return token;
}

function isProviderAccountFailure(reason: unknown): boolean {
  if (typeof reason !== 'string') {
    return false;
  }
  return PROVIDER_ACCOUNT_FAILURE_PATTERNS.some((pattern) => pattern.test(reason));
}

async function readResponseSnippet(res: Response): Promise<string> {
  const text = await res.text().catch(() => res.statusText);
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (/^<!doctype html/i.test(normalized) || /<html/i.test(normalized)) {
    const title = normalized.match(/<title>(.*?)<\/title>/i)?.[1];
    const heading = normalized.match(/<h1[^>]*>(.*?)<\/h1>/i)?.[1];
    return [title, heading].filter(Boolean).join(' — ') || 'HTML error page';
  }
  return normalized.length > 500 ? `${normalized.slice(0, 500)}...` : normalized;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  return `${m.toFixed(1)}m`;
}

async function writeMarkdown(outRoot: string, results: unknown[]): Promise<void> {
  type Row = {
    scenarioId: string;
    status: string;
    durationMs: number;
    agentCount?: number;
    errorCount: number;
    projectSlug?: string;
    phaseTimings: Record<string, number>;
    toolCallCounts: Record<string, number>;
    buildTelemetry?: {
      buildEventCount: number;
      slowestAgent?: string;
      slowestAgentMs?: number;
    };
  };
  const rows = results as Row[];

  const lines: string[] = [];
  lines.push('# Arch-AI Eval Run Summary');
  lines.push('');
  lines.push(`**Generated**: ${new Date().toISOString()}`);
  lines.push(`**Scenarios**: ${rows.length}`);
  lines.push(
    `**Completed**: ${rows.filter((r) => r.status === 'completed').length} / ${rows.length}`,
  );
  lines.push('');
  lines.push('## Per-scenario');
  lines.push('');
  lines.push(
    '| Scenario | Status | Duration | Agents | Errors | Project | INTERVIEW | BLUEPRINT | BUILD | CREATE |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    lines.push(
      `| ${r.scenarioId} | ${r.status} | ${fmtDuration(r.durationMs)} | ${r.agentCount ?? '—'} | ${r.errorCount} | ${r.projectSlug ?? '—'} | ${fmtDuration(r.phaseTimings.INTERVIEW ?? 0)} | ${fmtDuration(r.phaseTimings.BLUEPRINT ?? 0)} | ${fmtDuration(r.phaseTimings.BUILD ?? 0)} | ${fmtDuration(r.phaseTimings.CREATE ?? 0)} |`,
    );
  }
  lines.push('');
  lines.push('## Build telemetry');
  lines.push('');
  lines.push('| Scenario | Build events | Slowest agent | Slowest agent duration |');
  lines.push('|---|---:|---|---:|');
  for (const r of rows) {
    lines.push(
      `| ${r.scenarioId} | ${r.buildTelemetry?.buildEventCount ?? 0} | ${r.buildTelemetry?.slowestAgent ?? '—'} | ${fmtDuration(r.buildTelemetry?.slowestAgentMs ?? 0)} |`,
    );
  }
  lines.push('');
  lines.push('## Tool-call totals');
  lines.push('');
  const totals: Record<string, number> = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.toolCallCounts ?? {})) {
      totals[k] = (totals[k] ?? 0) + (v as number);
    }
  }
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  for (const [tool, count] of sorted) {
    lines.push(`- ${tool}: ${count}`);
  }
  lines.push('');

  await fs.writeFile(path.join(outRoot, 'summary.md'), lines.join('\n'), 'utf8');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  await fs.mkdir(args.outputRoot, { recursive: true });

  process.stdout.write(`[arch-eval] run-id: ${args.runId}\n`);
  process.stdout.write(`[arch-eval] output: ${args.outputRoot}\n`);

  let scenarios: Scenario[] = SCENARIOS;
  if (args.only && args.only.size > 0) {
    scenarios = scenarios.filter((s) => args.only?.has(s.id));
  }
  if (args.max) {
    scenarios = scenarios.slice(0, args.max);
  }

  await fs.writeFile(
    path.join(args.outputRoot, 'scenarios.json'),
    JSON.stringify(scenarios, null, 2),
    'utf8',
  );

  const results: unknown[] = [];
  const tokenCache: TokenCache = {};
  const budget: EvalBudget | undefined =
    args.maxCostUsd !== undefined || args.maxTokenBudget !== undefined
      ? {
          maxCostUsd: args.maxCostUsd,
          maxTokens: args.maxTokenBudget,
          costUsd: 0,
          tokens: 0,
        }
      : undefined;
  for (const sc of scenarios) {
    if (budget?.exceeded) {
      process.stderr.write(`[arch-eval] budget abort before ${sc.id}: ${budget.exceeded}\n`);
      break;
    }
    process.stdout.write(`[arch-eval] === ${sc.id} (${sc.domain}) ===\n`);
    // Reuse the dev-login token briefly, but refresh before long scenarios.
    // BUILD can run for several minutes; starting a scenario with an older
    // token risks mid-stream 401s that hide the real generation result.
    let token: string;
    try {
      token = await getEvalToken(args, tokenCache);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[arch-eval] dev-login failed for ${sc.id}: ${reason}\n`);
      results.push({
        scenarioId: sc.id,
        status: 'failed',
        failureStage: 'dev_login',
        failureReason: reason,
        durationMs: 0,
        phaseTimings: {},
        toolCallCounts: {},
        errorCount: 1,
      });
      process.stderr.write(
        `[arch-eval] aborting remaining scenarios because dev-login is unavailable: ${reason}\n`,
      );
      break;
    }

    const cfg = {
      studioUrl: args.studioUrl,
      token,
      outputDir: args.outputRoot,
      budget,
    };

    const t0 = Date.now();
    try {
      const result = await runScenario(sc, cfg);
      results.push(result);
      const dur = fmtDuration(Date.now() - t0);
      process.stdout.write(
        `[arch-eval] ${sc.id} -> ${result.status} (${dur}, agents=${result.agentCount ?? '?'}, errors=${result.errorCount}, tokens=${budget?.tokens ?? 0}, cost=$${(budget?.costUsd ?? 0).toFixed(4)})\n`,
      );
      if (
        result.status === 'failed' &&
        result.failureStage === 'seed_message' &&
        isProviderAccountFailure(result.failureReason)
      ) {
        process.stderr.write(
          `[arch-eval] aborting remaining scenarios after provider-account failure in ${sc.id}: ${result.failureReason}\n`,
        );
        break;
      }
      if (budget?.exceeded) {
        process.stderr.write(`[arch-eval] budget abort after ${sc.id}: ${budget.exceeded}\n`);
        break;
      }
    } catch (err) {
      const dur = fmtDuration(Date.now() - t0);
      process.stderr.write(
        `[arch-eval] ${sc.id} CRASHED in ${dur}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      results.push({
        scenarioId: sc.id,
        status: 'failed',
        failureStage: 'harness_crash',
        failureReason: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
        phaseTimings: {},
        toolCallCounts: {},
        errorCount: 1,
      });
    }
  }

  await fs.writeFile(
    path.join(args.outputRoot, 'summary.json'),
    JSON.stringify(results, null, 2),
    'utf8',
  );
  if (budget) {
    await fs.writeFile(
      path.join(args.outputRoot, 'budget.json'),
      JSON.stringify(budget, null, 2),
      'utf8',
    );
  }
  await writeMarkdown(args.outputRoot, results);
  process.stdout.write(`[arch-eval] done. summary at ${args.outputRoot}/summary.md\n`);
}

main().catch((err) => {
  process.stderr.write(`[arch-eval] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
