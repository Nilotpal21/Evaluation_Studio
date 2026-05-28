// apps/runtime/src/__tests__/e2e/ai4hc-payer/generate-comparison.ts

/**
 * AI4HC Payer — Comparison Report Generator
 *
 * Generates a markdown report comparing Kore.ai baseline vs ABL Runtime results.
 *
 * Usage:
 *   npx tsx src/__tests__/e2e/ai4hc-payer/generate-comparison.ts \
 *     --baseline koreai-results.json \
 *     --abl abl-results.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ScenarioResult {
  scenario: string;
  userMessage: string;
  response: string;
  agentName: string | null;
  timing: {
    ttfb: number;
    ttft: number;
    total: number;
  };
  toolCalls: string[];
  passed: boolean;
}

interface RunReport {
  timestamp: string;
  platform: 'koreai' | 'abl';
  model: string;
  scenarios: ScenarioResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    avgTotalMs: number;
    avgTtfbMs: number;
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function ms(n: number): string {
  return `${(n / 1000).toFixed(1)}s`;
}

function pctDelta(baseline: number, current: number): string {
  if (baseline === 0) return 'N/A';
  const pct = ((current - baseline) / baseline) * 100;
  const sign = pct >= 0 ? '+' : '';
  const bold = pct < 0 ? '**' : '';
  return `${bold}${sign}${pct.toFixed(0)}%${bold}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

// ─── Report Generator ───────────────────────────────────────────────────────

function generateComparison(baseline: RunReport, abl: RunReport, outputPath: string): void {
  const lines: string[] = [];
  const now = new Date().toISOString().split('T')[0];

  const w = (line: string) => lines.push(line);
  const blank = () => lines.push('');

  w('# AI4HC Payer — ABL Runtime vs Kore.ai Baseline Comparison');
  blank();
  w(`> **Generated:** ${now}`);
  w(`> **Baseline:** Kore.ai production (${baseline.timestamp})`);
  w(`> **ABL Runtime:** Model: ${abl.model} (${abl.timestamp})`);
  blank();
  w('---');
  blank();

  // Executive Summary
  w('## Executive Summary');
  blank();
  w('| Metric | Kore.ai | ABL Runtime | Delta |');
  w('| --- | --- | --- | --- |');
  w(
    `| Pass Rate | ${baseline.summary.passed}/${baseline.summary.total} | ${abl.summary.passed}/${abl.summary.total} | |`,
  );
  w(
    `| Avg TTFB | ${ms(baseline.summary.avgTtfbMs)} | ${ms(abl.summary.avgTtfbMs)} | ${pctDelta(baseline.summary.avgTtfbMs, abl.summary.avgTtfbMs)} |`,
  );
  w(
    `| Avg Total | ${ms(baseline.summary.avgTotalMs)} | ${ms(abl.summary.avgTotalMs)} | ${pctDelta(baseline.summary.avgTotalMs, abl.summary.avgTotalMs)} |`,
  );
  blank();

  // Per-scenario comparison
  w('## Scenario Comparison');
  blank();
  w('| Scenario | Kore.ai Total | ABL Total | Delta | Kore.ai Agent | ABL Agent | Both Pass |');
  w('| --- | --- | --- | --- | --- | --- | --- |');

  for (const blScenario of baseline.scenarios) {
    const ablScenario = abl.scenarios.find((s) => s.scenario === blScenario.scenario);
    if (!ablScenario) {
      w(
        `| ${blScenario.scenario} | ${ms(blScenario.timing.total)} | N/A | N/A | ${blScenario.agentName ?? '-'} | - | - |`,
      );
      continue;
    }
    const delta = pctDelta(blScenario.timing.total, ablScenario.timing.total);
    const bothPass = blScenario.passed && ablScenario.passed ? 'YES' : 'NO';
    w(
      `| ${blScenario.scenario} | ${ms(blScenario.timing.total)} | ${ms(ablScenario.timing.total)} | ${delta} | ${blScenario.agentName ?? '-'} | ${ablScenario.agentName ?? '-'} | ${bothPass} |`,
    );
  }
  blank();

  // Transcripts
  w('## Response Transcripts');
  blank();
  for (const blScenario of baseline.scenarios) {
    const ablScenario = abl.scenarios.find((s) => s.scenario === blScenario.scenario);
    w(`### ${blScenario.scenario}`);
    blank();
    w(`**User:** "${blScenario.userMessage}"`);
    blank();
    w(`**Kore.ai (${ms(blScenario.timing.total)}):** "${truncate(blScenario.response, 500)}"`);
    blank();
    if (ablScenario) {
      w(`**ABL (${ms(ablScenario.timing.total)}):** "${truncate(ablScenario.response, 500)}"`);
    } else {
      w(`**ABL:** Not tested`);
    }
    blank();
    w('---');
    blank();
  }

  const output = lines.join('\n');
  writeFileSync(outputPath, output, 'utf-8');
  console.log(`\nComparison report: ${outputPath}`);
  console.log(`   ${baseline.scenarios.length} scenarios compared`);
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const currentDir = dirname(fileURLToPath(import.meta.url));

  let baselinePath = '';
  let ablPath = '';
  let outputPath = resolve(currentDir, 'AI4HC_ABL_VS_BASELINE_COMPARISON.md');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--baseline' && args[i + 1]) {
      baselinePath = resolve(args[++i]);
    } else if (args[i] === '--abl' && args[i + 1]) {
      ablPath = resolve(args[++i]);
    } else if (args[i] === '--out' && args[i + 1]) {
      outputPath = resolve(args[++i]);
    }
  }

  if (!baselinePath || !ablPath) {
    console.error(
      'Usage: --baseline <koreai-results.json> --abl <abl-results.json> [--out <file>]',
    );
    process.exit(1);
  }

  if (!existsSync(baselinePath)) {
    console.error(`Baseline not found: ${baselinePath}`);
    process.exit(1);
  }
  if (!existsSync(ablPath)) {
    console.error(`ABL results not found: ${ablPath}`);
    process.exit(1);
  }

  const baseline: RunReport = JSON.parse(readFileSync(baselinePath, 'utf-8'));
  const abl: RunReport = JSON.parse(readFileSync(ablPath, 'utf-8'));

  generateComparison(baseline, abl, outputPath);
}

main();
