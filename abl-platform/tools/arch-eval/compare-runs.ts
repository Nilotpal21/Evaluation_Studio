/**
 * Compare two arch-eval runs side-by-side.
 *
 * Usage: pnpm exec tsx tools/arch-eval/compare-runs.ts <baseline-dir> <postfix-dir>
 *
 * Writes <postfix-dir>/comparison.md with per-scenario score deltas and
 * diagnostic-warning count deltas.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

interface ScoringRow {
  scenarioId: string;
  status: string;
  agentCount?: number;
  errorCount: number;
  topologyAgents: number;
  agentsCompiled: number;
  agentsWarning: number;
  agentsError: number;
  healthPercent?: number;
  topIssue?: string;
  scores: {
    topologyQuality: number;
    ablStructure: number;
    compileHealth: number;
    specFidelity: number;
    diagnosticSignal: number;
    overall: number;
  };
}

async function readScoring(runDir: string): Promise<ScoringRow[]> {
  const txt = await fs.readFile(path.join(runDir, 'scoring.json'), 'utf8');
  const d = JSON.parse(txt) as { rows: ScoringRow[] };
  return d.rows;
}

async function countWarnings(
  runDir: string,
): Promise<{ total: number; byCode: Record<string, number> }> {
  const dirs = (await fs.readdir(runDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && d.name.startsWith('s'))
    .map((d) => d.name);
  let total = 0;
  const byCode: Record<string, number> = {};
  for (const d of dirs) {
    try {
      const txt = await fs.readFile(path.join(runDir, d, 'agents.json'), 'utf8');
      const j = JSON.parse(txt) as { agents?: Array<{ dslDiagnostics?: unknown }> };
      for (const a of j.agents ?? []) {
        const diags = a.dslDiagnostics;
        if (!Array.isArray(diags)) continue;
        for (const w of diags) {
          if (w && typeof w === 'object' && (w as { severity?: string }).severity === 'warning') {
            total += 1;
            const msg = ((w as { message?: string }).message ?? '') as string;
            const m = msg.match(/\b([WE]\d{3,4})\b/);
            if (m) byCode[m[1]] = (byCode[m[1]] ?? 0) + 1;
          }
        }
      }
    } catch {
      // skip missing
    }
  }
  return { total, byCode };
}

function fmtDelta(a: number, b: number): string {
  const d = b - a;
  const sign = d > 0 ? '+' : '';
  return `${sign}${d.toFixed(1)}`;
}

async function main(): Promise<void> {
  const [baselineDir, postfixDir] = process.argv.slice(2);
  if (!baselineDir || !postfixDir) {
    process.stderr.write('Usage: tsx compare-runs.ts <baseline-dir> <postfix-dir>\n');
    process.exit(1);
  }
  const a = await readScoring(baselineDir);
  const b = await readScoring(postfixDir);
  const aMap = new Map(a.map((r) => [r.scenarioId, r]));

  const lines: string[] = [];
  lines.push('# Baseline vs Post-fix Comparison');
  lines.push('');
  lines.push(`Baseline: \`${baselineDir}\``);
  lines.push(`Post-fix: \`${postfixDir}\``);
  lines.push('');
  lines.push('## Score deltas (post-fix minus baseline)');
  lines.push('');
  lines.push(
    '| Scenario | Overall | Topology | ABL | Compile | SpecFid | Diag | agents pass→ | warn→ | err→ | health% |',
  );
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of b) {
    const base = aMap.get(r.scenarioId);
    if (!base) {
      lines.push(`| ${r.scenarioId} | (no baseline) | | | | | | | | | |`);
      continue;
    }
    lines.push(
      `| ${r.scenarioId} | ${base.scores.overall.toFixed(1)} → ${r.scores.overall.toFixed(1)} (${fmtDelta(base.scores.overall, r.scores.overall)}) | ${fmtDelta(base.scores.topologyQuality, r.scores.topologyQuality)} | ${fmtDelta(base.scores.ablStructure, r.scores.ablStructure)} | ${fmtDelta(base.scores.compileHealth, r.scores.compileHealth)} | ${fmtDelta(base.scores.specFidelity, r.scores.specFidelity)} | ${fmtDelta(base.scores.diagnosticSignal, r.scores.diagnosticSignal)} | ${base.agentsCompiled}→${r.agentsCompiled} | ${base.agentsWarning}→${r.agentsWarning} | ${base.agentsError}→${r.agentsError} | ${base.healthPercent ?? '—'}→${r.healthPercent ?? '—'} |`,
    );
  }

  const baseWarn = await countWarnings(baselineDir);
  const postWarn = await countWarnings(postfixDir);

  lines.push('');
  lines.push('## Aggregate diagnostic warnings');
  lines.push('');
  lines.push(`Baseline (across same scenarios): ${baseWarn.total} total warnings`);
  lines.push(`Post-fix:                          ${postWarn.total} total warnings`);
  lines.push('');
  const allCodes = new Set([...Object.keys(baseWarn.byCode), ...Object.keys(postWarn.byCode)]);
  lines.push('| Code | Baseline | Post-fix | Δ |');
  lines.push('|---|---:|---:|---:|');
  for (const code of [...allCodes].sort()) {
    const aN = baseWarn.byCode[code] ?? 0;
    const bN = postWarn.byCode[code] ?? 0;
    lines.push(`| ${code} | ${aN} | ${bN} | ${bN - aN} |`);
  }

  lines.push('');
  lines.push('## Top issue per scenario');
  lines.push('');
  for (const r of b) {
    const base = aMap.get(r.scenarioId);
    lines.push(`- **${r.scenarioId}**`);
    lines.push(`  - baseline: ${base?.topIssue ?? '—'}`);
    lines.push(`  - post-fix: ${r.topIssue ?? '—'}`);
  }

  await fs.writeFile(path.join(postfixDir, 'comparison.md'), lines.join('\n'), 'utf8');
  process.stdout.write(`[compare] wrote ${path.join(postfixDir, 'comparison.md')}\n`);
}

main().catch((err) => {
  process.stderr.write(`[compare] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
