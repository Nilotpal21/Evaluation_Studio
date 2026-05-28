#!/usr/bin/env npx tsx
/**
 * AFG Blue Advisory — Comparison Report Generator
 *
 * Reads run report JSON files and generates a markdown comparison document.
 *
 * Usage:
 *   npx tsx generate-comparison.ts --baseline baseline.json --runs run1.json run2.json
 *   npx tsx generate-comparison.ts --baseline baseline.json --runs afg-run-report.json afg-run-report-no-pipeline.json
 *   npx tsx generate-comparison.ts  # uses defaults: BASELINE_RESULTS.md + afg-run-report*.json
 *
 * Output: writes ABL_VS_BASELINE_COMPARISON.md (or --out <file>)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ScenarioMetrics {
  startMs: number;
  firstChunkMs: number;
  endMs: number;
  ttfb: number;
  total: number;
  chunkCount: number;
  responseLength: number;
}

interface TraceEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

interface Scenario {
  scenario: string;
  userMessage: string;
  agentResponse: string;
  metrics: ScenarioMetrics;
  traces: TraceEvent[];
  toolCalls: unknown[];
  passed: boolean;
}

interface RunReport {
  timestamp: string;
  model: string;
  pipelineModel: string;
  mode: string;
  scenarios: Scenario[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    avgTotalMs: number;
    avgTtfbMs: number;
    totalTraceEvents: number;
  };
}

interface BaselineScenario {
  scenario: string;
  ttfb: number;
  ttft: number;
  total: number;
}

interface BaselineData {
  date: string;
  scenarios: BaselineScenario[];
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

function countTraces(traces: TraceEvent[], type: string): number {
  return traces.filter((t) => t.type === type).length;
}

function getToolCalls(traces: TraceEvent[]): string[] {
  return traces
    .filter((t) => t.type === 'tool_call')
    .map((t) => (t.data as Record<string, string>).toolName);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function findScenario(scenarios: Scenario[], name: string): Scenario | undefined {
  return scenarios.find((s) => s.scenario.toLowerCase().includes(name.toLowerCase()));
}

function findBaselineScenario(
  scenarios: BaselineScenario[],
  name: string,
): BaselineScenario | undefined {
  return scenarios.find((s) => s.scenario.toLowerCase().includes(name.toLowerCase()));
}

// ─── Baseline Parser ────────────────────────────────────────────────────────

function parseBaselineMd(filePath: string): BaselineData {
  const content = readFileSync(filePath, 'utf-8');
  const dateMatch = content.match(/Captured:\s*(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1] : 'unknown';

  const scenarios: BaselineScenario[] = [];
  const tableRegex =
    /\|\s*([^|]+?)\s*\|\s*([\d.]+(?:ms|s))\s*\|\s*([\d.]+(?:ms|s))\s*\|\s*([\d.]+(?:ms|s))\s*\|/g;
  let match;
  while ((match = tableRegex.exec(content)) !== null) {
    const name = match[1].trim();
    if (name.startsWith('---') || name.startsWith('Scenario')) continue;

    const parseTime = (t: string): number => {
      if (t.endsWith('ms')) return parseFloat(t) / 1000;
      return parseFloat(t);
    };

    scenarios.push({
      scenario: name,
      ttfb: parseTime(match[2]),
      ttft: parseTime(match[3]),
      total: parseTime(match[4]),
    });
  }

  return { date, scenarios };
}

// ─── Report Generator ───────────────────────────────────────────────────────

interface RunConfig {
  label: string;
  report: RunReport;
}

function generateComparison(baseline: BaselineData, runs: RunConfig[], outputPath: string): void {
  const lines: string[] = [];
  const now = new Date().toISOString().split('T')[0];

  const w = (line: string) => lines.push(line);
  const blank = () => lines.push('');

  // ── Header ──
  w('# AFG Blue Advisory — ABL Runtime vs Kore.ai Baseline Comparison');
  blank();
  w(`> **Generated:** ${now}`);
  w(`> **Baseline:** Kore.ai production (captured ${baseline.date})`);
  for (const run of runs) {
    w(
      `> **${run.label}:** ${run.report.mode} | Model: ${run.report.model} | Pipeline: ${run.report.pipelineModel}`,
    );
  }
  w('> **Tool:** `generate-comparison.ts`');
  blank();
  w('---');
  blank();

  // ── Configurations Tested ──
  w('## Configurations Tested');
  blank();
  w('| # | Configuration | Model | Pipeline | Mode |');
  w('| --- | --- | --- | --- | --- |');
  w('| 0 | **Kore.ai Baseline** | GPT-4.1 | Internal | Production API |');
  runs.forEach((run, i) => {
    w(
      `| ${i + 1} | **${run.label}** | ${run.report.model} | ${run.report.pipelineModel} | ${run.report.mode} |`,
    );
  });
  blank();
  w('---');
  blank();

  // ── Canonical scenario names ──
  const canonicalScenarios = [
    'Greeting',
    'Product Search',
    'Guard Rail',
    'Delegation',
    'Automobile',
    'Summary Continuity',
  ];

  const multiTurnScenarios = [
    { key: 'Multi-turn (Turn 1', label: 'T1 Greeting' },
    { key: 'Multi-turn (Turn 2', label: 'T2 Search' },
    { key: 'Multi-turn (Turn 3', label: 'T3 Follow-up' },
  ];

  // ── Executive Summary ──
  w('## Executive Summary');
  blank();

  const singleTurnNames = ['Greeting', 'Product Search', 'Guard Rail', 'Automobile'];
  const baselineSingleTurn = singleTurnNames
    .map((n) => findBaselineScenario(baseline.scenarios, n))
    .filter(Boolean) as BaselineScenario[];
  const baselineAvgTtft =
    baselineSingleTurn.reduce((sum, s) => sum + s.ttft, 0) / baselineSingleTurn.length;
  const baselineAvgTotal =
    baselineSingleTurn.reduce((sum, s) => sum + s.total, 0) / baselineSingleTurn.length;

  const headerCols = ['Metric', 'Kore.ai', ...runs.map((r) => r.label)];
  w(`| ${headerCols.join(' | ')} |`);
  w(`| ${headerCols.map(() => '---').join(' | ')} |`);

  const ttftCols = runs.map((r) => {
    const st = singleTurnNames
      .map((n) => findScenario(r.report.scenarios, n))
      .filter(Boolean) as Scenario[];
    const avg = st.reduce((sum, s) => sum + s.metrics.ttfb, 0) / st.length;
    return ms(avg);
  });
  w(`| Avg TTFT (single-turn) | ${baselineAvgTtft.toFixed(2)}s | ${ttftCols.join(' | ')} |`);

  const totalCols = runs.map((r) => {
    const st = singleTurnNames
      .map((n) => findScenario(r.report.scenarios, n))
      .filter(Boolean) as Scenario[];
    const avg = st.reduce((sum, s) => sum + s.metrics.total, 0) / st.length;
    return ms(avg);
  });
  w(`| Avg Total (single-turn) | ${baselineAvgTotal.toFixed(2)}s | ${totalCols.join(' | ')} |`);

  const passCols = runs.map((r) => `${r.report.summary.passed}/${r.report.summary.total}`);
  w(`| Pass Rate | 7/7 | ${passCols.join(' | ')} |`);

  blank();
  w('---');
  blank();

  // ── TTFT Table ──
  w('## TTFT (Time to First Text Token)');
  blank();
  const ttftHeader = ['Scenario', 'Kore.ai', ...runs.map((r) => r.label), 'Best vs Kore.ai'];
  w(`| ${ttftHeader.join(' | ')} |`);
  w(`| ${ttftHeader.map(() => '---').join(' | ')} |`);

  for (const name of canonicalScenarios) {
    const bl = findBaselineScenario(baseline.scenarios, name);
    const blTtft = bl ? bl.ttft : NaN;
    const runTtfts = runs.map((r) => {
      const s = findScenario(r.report.scenarios, name);
      return s ? s.metrics.ttfb : NaN;
    });
    const bestMs = Math.min(...runTtfts.filter((n) => !isNaN(n)));
    const delta = !isNaN(blTtft) && !isNaN(bestMs) ? pctDelta(blTtft * 1000, bestMs) : 'N/A';

    const cols = [
      name,
      !isNaN(blTtft) ? `${blTtft.toFixed(2)}s` : 'N/A',
      ...runTtfts.map((t) => (!isNaN(t) ? ms(t) : 'N/A')),
      delta,
    ];
    w(`| ${cols.join(' | ')} |`);
  }
  blank();

  // ── Total Time Table ──
  w('## Total Time');
  blank();
  const totalHeader = ['Scenario', 'Kore.ai', ...runs.map((r) => r.label), 'Best vs Kore.ai'];
  w(`| ${totalHeader.join(' | ')} |`);
  w(`| ${totalHeader.map(() => '---').join(' | ')} |`);

  for (const name of canonicalScenarios) {
    const bl = findBaselineScenario(baseline.scenarios, name);
    const blTotal = bl ? bl.total : NaN;
    const runTotals = runs.map((r) => {
      const s = findScenario(r.report.scenarios, name);
      return s ? s.metrics.total : NaN;
    });
    const bestMs = Math.min(...runTotals.filter((n) => !isNaN(n)));
    const delta = !isNaN(blTotal) && !isNaN(bestMs) ? pctDelta(blTotal * 1000, bestMs) : 'N/A';

    const cols = [
      name,
      !isNaN(blTotal) ? `${blTotal.toFixed(2)}s` : 'N/A',
      ...runTotals.map((t) => (!isNaN(t) ? ms(t) : 'N/A')),
      delta,
    ];
    w(`| ${cols.join(' | ')} |`);
  }
  blank();

  // ── Multi-Turn ──
  w('## Multi-Turn Performance');
  blank();
  const mtHeader = ['Turn', 'Kore.ai TTFT / Total', ...runs.map((r) => `${r.label} TTFT / Total`)];
  w(`| ${mtHeader.join(' | ')} |`);
  w(`| ${mtHeader.map(() => '---').join(' | ')} |`);

  const blMultiTurn: Record<string, BaselineScenario | undefined> = {
    T1: findBaselineScenario(baseline.scenarios, 'greeting'),
    T2: findBaselineScenario(baseline.scenarios, 'product search'),
    T3: findBaselineScenario(baseline.scenarios, 'follow-up'),
  };

  let totalWallBaseline = 0;
  const totalWallRuns = runs.map(() => 0);

  for (const mt of multiTurnScenarios) {
    const blKey = mt.label.startsWith('T1') ? 'T1' : mt.label.startsWith('T2') ? 'T2' : 'T3';
    const bl = blMultiTurn[blKey];
    if (bl) totalWallBaseline += bl.total;

    const runCols = runs.map((r, i) => {
      const s = r.report.scenarios.find((sc) => sc.scenario.startsWith(mt.key));
      if (!s) return 'N/A';
      totalWallRuns[i] += s.metrics.total;
      return `${ms(s.metrics.ttfb)} / ${ms(s.metrics.total)}`;
    });

    const blCol = bl ? `${bl.ttft.toFixed(2)}s / ${bl.total.toFixed(2)}s` : 'N/A';
    w(`| ${mt.label} | ${blCol} | ${runCols.join(' | ')} |`);
  }

  const wallCols = totalWallRuns.map((t) => `**${ms(t)}**`);
  w(`| **Total wall** | **${totalWallBaseline.toFixed(2)}s** | ${wallCols.join(' | ')} |`);
  blank();
  w('---');
  blank();

  // ── Transcripts ──
  w('## Scenario Transcripts');
  blank();

  for (const run of runs) {
    w(`### ${run.label}`);
    blank();

    for (const scenario of run.report.scenarios) {
      const m = scenario.metrics;
      const llmCalls = countTraces(scenario.traces, 'llm_call');
      const toolCallNames = getToolCalls(scenario.traces);
      const completions = scenario.traces.filter(
        (t) => t.type === 'completion_check' && (t.data as Record<string, boolean>).result,
      );

      w(`#### ${scenario.scenario}`);
      blank();
      w(
        `- **Pass:** ${scenario.passed ? '✅' : '❌'} | **TTFB:** ${ms(m.ttfb)} | **Total:** ${ms(m.total)} | **Chunks:** ${m.chunkCount} | **Chars:** ${m.responseLength}`,
      );
      w(
        `- **LLM calls:** ${llmCalls} | **Tool calls:** ${toolCallNames.length}${toolCallNames.length > 0 ? ` (${[...new Set(toolCallNames)].join(', ')})` : ''}`,
      );
      if (completions.length > 0) {
        w(`- **Completion fired:** ${(completions[0].data as Record<string, string>).condition}`);
      }
      w(`- **User:** "${scenario.userMessage}"`);
      w(`- **Agent:** "${truncate(scenario.agentResponse, 300)}"`);
      blank();

      // Call chain
      w('```');
      const llmTraces = scenario.traces.filter((t) => t.type === 'llm_call');
      const toolTraces = scenario.traces.filter((t) => t.type === 'tool_call');
      const pipelineClassify = scenario.traces.find((t) => t.type === 'pipeline_classify');
      const shortCircuit = scenario.traces.find((t) => t.type === 'pipeline_short_circuit');
      const handoffs = scenario.traces.filter((t) => t.type === 'handoff');
      const agentSwitches = scenario.traces.filter((t) => t.type === 'agent_switch');
      const merges = scenario.traces.filter((t) => t.type === 'pipeline_merge');

      if (pipelineClassify) {
        const data = pipelineClassify.data as Record<string, unknown>;
        const intents = data.intents as Array<{ target: string; confidence: number }>;
        w(
          `[${ms(pipelineClassify.timestamp - m.startMs)}] Pipeline classify: ${intents.map((i) => `${i.target} (${i.confidence})`).join(', ')}`,
        );
      }
      if (shortCircuit) {
        const data = shortCircuit.data as Record<string, string>;
        w(`[${ms(shortCircuit.timestamp - m.startMs)}] Short-circuit → ${data.target}`);
      }
      for (const h of handoffs) {
        const data = h.data as Record<string, string>;
        w(`[${ms(h.timestamp - m.startMs)}] Handoff: ${data.from} → ${data.to}`);
      }
      for (const sw of agentSwitches) {
        const data = sw.data as Record<string, string>;
        w(
          `[${ms(sw.timestamp - m.startMs)}] Agent switch: ${data.previousAgent} → ${data.agentName} (${data.mode})`,
        );
      }
      for (const llm of llmTraces) {
        const data = llm.data as Record<string, unknown>;
        const dur = data.durationMs as number;
        const agent = data.agent as string;
        const hasTools = data.hasToolCalls as boolean;
        const tcs = (data.toolCalls as Array<{ name: string }>) || [];
        const toolNames = hasTools ? tcs.map((tc) => tc.name).join(', ') : 'text response';
        w(`[${ms(llm.timestamp - m.startMs)}] LLM ${agent}: ${dur}ms → ${toolNames}`);
      }
      for (const tc of toolTraces) {
        const data = tc.data as Record<string, unknown>;
        w(`[${ms(tc.timestamp - m.startMs)}] Tool ${data.toolName}: ${data.latencyMs}ms`);
      }
      if (merges.length > 0) {
        const data = merges[0].data as Record<string, number>;
        w(`[${ms(merges[0].timestamp - m.startMs)}] Pipeline merge: ${data.latencyMs}ms`);
      }
      for (const comp of completions) {
        const data = comp.data as Record<string, unknown>;
        w(`[${ms(comp.timestamp - m.startMs)}] COMPLETE: "${data.condition}"`);
      }
      w('```');
      blank();
    }

    w('---');
    blank();
  }

  // ── Summary Stats ──
  w('## Summary Statistics');
  blank();
  const statsHeader = ['Metric', ...runs.map((r) => r.label)];
  w(`| ${statsHeader.join(' | ')} |`);
  w(`| ${statsHeader.map(() => '---').join(' | ')} |`);

  const statRows = [
    ['Scenarios', ...runs.map((r) => String(r.report.summary.total))],
    ['Passed', ...runs.map((r) => String(r.report.summary.passed))],
    ['Failed', ...runs.map((r) => String(r.report.summary.failed))],
    ['Avg TTFB', ...runs.map((r) => ms(r.report.summary.avgTtfbMs))],
    ['Avg Total', ...runs.map((r) => ms(r.report.summary.avgTotalMs))],
    ['Trace Events', ...runs.map((r) => String(r.report.summary.totalTraceEvents))],
  ];
  for (const row of statRows) {
    w(`| ${row.join(' | ')} |`);
  }
  blank();

  // ── Anomalies ──
  w('## Anomalies & Warnings');
  blank();

  for (const run of runs) {
    for (const scenario of run.report.scenarios) {
      const toolCallNames = getToolCalls(scenario.traces);
      const uniqueTools = [...new Set(toolCallNames)];

      for (const tool of uniqueTools) {
        const count = toolCallNames.filter((t) => t === tool).length;
        if (count > 3) {
          w(
            `- ⚠️ **${run.label} / ${scenario.scenario}:** \`${tool}\` called ${count} times (possible retry loop)`,
          );
        }
      }

      if (scenario.metrics.total > 30000) {
        w(
          `- ⚠️ **${run.label} / ${scenario.scenario}:** Total time ${ms(scenario.metrics.total)} exceeds 30s threshold`,
        );
      }

      if (!scenario.passed) {
        w(`- ❌ **${run.label} / ${scenario.scenario}:** FAILED`);
      }
    }
  }
  blank();

  const output = lines.join('\n');
  writeFileSync(outputPath, output, 'utf-8');
  console.log(`\n✅ Comparison report written to ${outputPath}`);
  console.log(`   ${runs.length} run(s) compared against baseline`);
  console.log(`   ${lines.length} lines generated`);
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const currentDir = dirname(fileURLToPath(import.meta.url));

  let baselinePath = resolve(currentDir, 'BASELINE_RESULTS.md');
  let runPaths: string[] = [];
  let runLabels: string[] = [];
  let outputPath = resolve(currentDir, 'ABL_VS_BASELINE_COMPARISON.md');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--baseline' && args[i + 1]) {
      baselinePath = resolve(args[++i]);
    } else if (args[i] === '--runs') {
      while (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        runPaths.push(resolve(args[++i]));
      }
    } else if (args[i] === '--labels') {
      while (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        runLabels.push(args[++i]);
      }
    } else if (args[i] === '--out' && args[i + 1]) {
      outputPath = resolve(args[++i]);
    } else if (args[i] === '--help') {
      console.log(`Usage: npx tsx generate-comparison.ts [options]

Options:
  --baseline <file>     Baseline results markdown (default: BASELINE_RESULTS.md)
  --runs <file...>      Run report JSON files to compare
  --labels <name...>    Labels for each run (default: derived from mode field)
  --out <file>          Output markdown path (default: ABL_VS_BASELINE_COMPARISON.md)

Examples:
  # Default: use BASELINE_RESULTS.md + afg-run-report*.json in same directory
  npx tsx generate-comparison.ts

  # Compare two specific runs with custom labels
  npx tsx generate-comparison.ts --runs run-mar9.json run-mar10.json --labels "Mar 9" "Mar 10"

  # Custom baseline and output
  npx tsx generate-comparison.ts --baseline custom-baseline.md --runs report.json --out comparison.md
`);
      return;
    }
  }

  // Defaults: find afg-run-report*.json in same dir
  if (runPaths.length === 0) {
    const defaultPipeline = resolve(currentDir, 'afg-run-report.json');
    const defaultNoPipeline = resolve(currentDir, 'afg-run-report-no-pipeline.json');
    if (existsSync(defaultPipeline)) runPaths.push(defaultPipeline);
    if (existsSync(defaultNoPipeline)) runPaths.push(defaultNoPipeline);
  }

  if (runPaths.length === 0) {
    console.error(
      'Error: No run report files found. Use --runs <file...> or place afg-run-report*.json in this directory.',
    );
    process.exit(1);
  }

  if (!existsSync(baselinePath)) {
    console.error(`Error: Baseline file not found: ${baselinePath}`);
    process.exit(1);
  }

  const baseline = parseBaselineMd(baselinePath);
  console.log(`Loaded baseline: ${baseline.scenarios.length} scenarios from ${baseline.date}`);

  const runs: RunConfig[] = runPaths.map((path, i) => {
    const report: RunReport = JSON.parse(readFileSync(path, 'utf-8'));
    const label = runLabels[i] || `ABL ${report.mode.replace(/\s+/g, ' ').trim()}`;
    console.log(
      `Loaded run "${label}": ${report.summary.total} scenarios, ${report.summary.passed} passed`,
    );
    return { label, report };
  });

  generateComparison(baseline, runs, outputPath);
}

main();
