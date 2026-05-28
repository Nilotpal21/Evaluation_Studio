/**
 * Aggregate quality scoring across all scenarios in a run directory.
 *
 * Loads every scenario's artifacts and scores along five axes:
 *
 *   topology_quality  (0-5)  — agent count vs expected, edge sanity, entryPoint
 *   abl_structure     (0-5)  — ABL constructs present (FLOW, GATHER, TOOLS, HANDOFF, COMPLETE)
 *   compile_health    (0-5)  — % agents fully compiled vs warning/error
 *   spec_fidelity     (0-5)  — channels + capabilities reflected in topology/agents
 *   diagnostic_signal (0-5)  — health endpoint surfaces real issues
 *
 * Writes:
 *   <run>/scoring.json      — per-scenario row + averages
 *   <run>/scoring.md        — human-readable scoreboard with issue clusters
 *   <run>/findings.md       — categorized issues across all scenarios
 *
 * Usage: pnpm exec tsx tools/arch-eval/score-projects.ts <run-dir>
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Scenario } from './scenarios.js';

interface AblConstructPresence {
  hasFlow: boolean;
  hasGather: boolean;
  hasTools: boolean;
  hasHandoff: boolean;
  hasComplete: boolean;
  hasMemory: boolean;
  hasConfirmationSignal: boolean;
  hasAuditSignal: boolean;
  reasoningSteps: number;
  scriptedSteps: number;
  toolCount: number;
  toolCallCount: number;
  setCount: number;
  onResultCount: number;
  onSuccessCount: number;
  onFailureCount: number;
  handoffCount: number;
  hasCatchAllHandoff: boolean;
  hasReturn: boolean;
  warnings: string[];
}

interface ScenarioRow {
  scenarioId: string;
  status: string;
  agentCount?: number;
  errorCount: number;
  durationMs: number;
  expectedAgents: number;
  topologyAgents: number;
  topologyEdges: number;
  topologyEntryPoint?: string;
  agentsCompiled: number;
  agentsWarning: number;
  agentsError: number;
  healthPercent?: number;
  topIssue?: string;
  channelsFromSpec: string[];
  agentsMentioningChannel: number;
  capabilitiesFromSpec: string;
  agentsMatchingCapabilities: number;
  ablBreakdown: Record<string, AblConstructPresence>;
  scores: {
    topologyQuality: number;
    ablStructure: number;
    compileHealth: number;
    specFidelity: number;
    diagnosticSignal: number;
    intelligenceFit: number;
    overall: number;
  };
  scoreNotes: string[];
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const txt = await fs.readFile(file, 'utf8');
    return JSON.parse(txt) as T;
  } catch {
    return null;
  }
}

async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

function analyzeAbl(content: string): AblConstructPresence {
  const upper = content.toUpperCase();
  const warnings: string[] = [];

  const hasFlow = /\bFLOW:\s*$/m.test(content) || /\bFLOW:\s/m.test(content);
  const hasGather = /\bGATHER:\s*$/m.test(content) || /\bGATHER:\s/m.test(content);
  const hasTools = /\bTOOLS:\s*$/m.test(content) || /\bTOOLS:\s/m.test(content);
  const hasHandoff = /\bHANDOFF:\s*$/m.test(content) || /\bHANDOFF:\s/m.test(content);
  const hasComplete = /\bCOMPLETE:\s*$/m.test(content) || /\bCOMPLETE:\s/m.test(content);
  const hasMemory = /\bMEMORY:\s*$/m.test(content) || /\bMEMORY:\s/m.test(content);
  const hasConfirmationSignal =
    /\b(confirm|confirmed|approval|approved|authorize|authorized|consent)\b/i.test(content);
  const hasAuditSignal = /\b(audit|log|trace|compliance|worm|pii|phi)\b/i.test(content);

  const reasoningSteps = (content.match(/\bREASONING:\s*true\b/gi) ?? []).length;
  const scriptedSteps = (content.match(/\bREASONING:\s*false\b/gi) ?? []).length;
  const toolCallCount = (content.match(/^\s*CALL:\s*[A-Za-z_][\w.]*/gm) ?? []).length;
  const setCount =
    (content.match(/^\s*SET:\s*$/gm) ?? []).length +
    (content.match(/^\s*SET:\s*\w+\s*=/gm) ?? []).length;
  const onResultCount = (content.match(/\bON_RESULT\b/g) ?? []).length;
  const onSuccessCount = (content.match(/\bON_SUCCESS\b/g) ?? []).length;
  const onFailureCount = (content.match(/\bON_FAILURE\b/g) ?? []).length;

  let toolCount = 0;
  if (hasTools) {
    const toolsBlock = content.split(/\bTOOLS:\s*$/m)[1] ?? content.split(/\bTOOLS:\s/m)[1] ?? '';
    const next = toolsBlock.split(
      /\b(FLOW|GATHER|HANDOFF|COMPLETE|MEMORY|MODEL|AGENT|GUARDRAILS):/m,
    )[0];
    toolCount = (next.match(/^\s+\w+\s*\(/gm) ?? []).length;
  }

  let handoffCount = 0;
  let hasCatchAllHandoff = false;
  let hasReturn = false;
  if (hasHandoff) {
    const handoffBlock =
      content.split(/\bHANDOFF:\s*$/m)[1] ?? content.split(/\bHANDOFF:\s/m)[1] ?? '';
    const next = handoffBlock.split(
      /\b(FLOW|GATHER|TOOLS|COMPLETE|MEMORY|MODEL|AGENT|GUARDRAILS):/m,
    )[0];
    handoffCount = (next.match(/^\s+-\s*TO:/gm) ?? []).length;
    hasCatchAllHandoff = /WHEN:\s*("?true"?|always)/i.test(next);
    hasReturn = /RETURN:\s*true/i.test(next);
  }

  if (!hasFlow && !hasGather && upper.includes('REASONING:')) {
    warnings.push('REASONING declared without FLOW/GATHER scaffolding');
  }
  if (hasHandoff && !hasCatchAllHandoff) {
    warnings.push('HANDOFF lacks catch-all (WHEN: true) edge');
  }
  if (hasFlow && reasoningSteps + scriptedSteps === 0) {
    warnings.push('FLOW present but no REASONING flag on any step');
  }
  if (hasTools && toolCount === 0) {
    warnings.push('TOOLS section parsed but no tool entries detected');
  }

  return {
    hasFlow,
    hasGather,
    hasTools,
    hasHandoff,
    hasComplete,
    hasMemory,
    hasConfirmationSignal,
    hasAuditSignal,
    reasoningSteps,
    scriptedSteps,
    toolCount,
    toolCallCount,
    setCount,
    onResultCount,
    onSuccessCount,
    onFailureCount,
    handoffCount,
    hasCatchAllHandoff,
    hasReturn,
    warnings,
  };
}

function clamp5(value: number): number {
  return Math.max(0, Math.min(5, Math.round(value * 100) / 100));
}

async function scoreScenario(
  scenarioDir: string,
  scenarioMeta: Scenario | null,
): Promise<ScenarioRow | null> {
  const finalRaw = await readJson<{
    scenarioId?: string;
    status?: string;
    agentCount?: number;
    errorCount?: number;
    durationMs?: number;
    projectId?: string;
  }>(path.join(scenarioDir, 'final.json'));
  if (!finalRaw) return null;

  const topology = await readJson<{
    agents?: Array<{ name: string; description?: string; executionMode?: string }>;
    edges?: Array<{ from: string; to: string; type?: string; expectReturn?: boolean }>;
    entryPoint?: string;
  }>(path.join(scenarioDir, 'topology.json'));

  const agentsResp = await readJson<{
    agents?: Array<{
      name: string;
      dslContent?: string;
      ablContent?: string;
      dslValidationStatus?: string;
      dslDiagnostics?: { warnings?: unknown[]; errors?: unknown[] };
      description?: string;
    }>;
  }>(path.join(scenarioDir, 'agents.json'));

  const health = await readJson<{
    healthPercent?: number;
    topIssue?: string;
    passing?: number;
    warnings?: number;
    errors?: number;
    totalAgents?: number;
    overall?: string;
  }>(path.join(scenarioDir, 'health.json'));

  const ablBreakdown: Record<string, AblConstructPresence> = {};
  let agentsCompiled = 0;
  let agentsWarning = 0;
  let agentsError = 0;
  let agentsMentioningChannel = 0;
  let agentsMatchingCapabilities = 0;
  const channelKeywords = (scenarioMeta?.channels ?? []).map((c) => c.toLowerCase());
  const capWords = (scenarioMeta?.capabilities ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 4);

  for (const a of agentsResp?.agents ?? []) {
    const dsl = a.dslContent ?? a.ablContent ?? '';
    if (dsl) ablBreakdown[a.name] = analyzeAbl(dsl);

    const status = a.dslValidationStatus ?? '';
    if (status === 'compiled' || status === 'valid') agentsCompiled += 1;
    else if (status === 'warning') agentsWarning += 1;
    else if (status === 'error') agentsError += 1;

    const blob = `${a.description ?? ''}\n${dsl}`.toLowerCase();
    if (channelKeywords.some((c) => blob.includes(c))) agentsMentioningChannel += 1;
    if (capWords.some((w) => blob.includes(w))) agentsMatchingCapabilities += 1;
  }

  const expectedAgents = scenarioMeta?.expectedAgents ?? 5;
  const actualAgents = topology?.agents?.length ?? finalRaw.agentCount ?? 0;
  const totalAgents = agentsResp?.agents?.length ?? actualAgents;

  // Topology Quality (0-5):
  //  +2 for entryPoint set, +1 if agent count within ±1 of expected, +1 if any
  //  edges, +1 if expectReturn semantics present.
  let topologyQuality = 0;
  const tqNotes: string[] = [];
  if (topology?.entryPoint) {
    topologyQuality += 2;
  } else {
    tqNotes.push('topology missing entryPoint');
  }
  const agentDelta = Math.abs(actualAgents - expectedAgents);
  if (agentDelta <= 1) topologyQuality += 1;
  else if (agentDelta <= 2) topologyQuality += 0.5;
  if ((topology?.edges?.length ?? 0) > 0) topologyQuality += 1;
  if ((topology?.edges ?? []).some((e) => e.expectReturn !== undefined)) topologyQuality += 1;

  // ABL Structure (0-5): per-agent average. Each agent gets:
  //   1 for FLOW or GATHER, 1 for TOOLS, 1 for HANDOFF (or COMPLETE for terminal),
  //   1 for catch-all WHEN: true, 1 for no analyzer warnings.
  const ablScores: number[] = [];
  for (const [name, a] of Object.entries(ablBreakdown)) {
    let s = 0;
    if (a.hasFlow || a.hasGather) s += 1;
    if (a.hasTools) s += 1;
    if (a.hasHandoff || a.hasComplete) s += 1;
    if (a.hasCatchAllHandoff || a.hasComplete) s += 1;
    if (a.warnings.length === 0) s += 1;
    ablScores.push(s);
  }
  const ablStructure = ablScores.length
    ? ablScores.reduce((sum, n) => sum + n, 0) / ablScores.length
    : 0;

  // Compile Health (0-5):
  let compileHealth = 0;
  if (totalAgents > 0) {
    const passingFraction = (health?.passing ?? agentsCompiled) / totalAgents;
    const warningFraction = (health?.warnings ?? agentsWarning) / totalAgents;
    const errorFraction = (health?.errors ?? agentsError) / totalAgents;
    compileHealth = 5 * passingFraction + 2.5 * warningFraction - 5 * errorFraction;
  }

  // Spec Fidelity (0-5): half on channel mention, half on capability match.
  const channelFidelity = totalAgents > 0 ? agentsMentioningChannel / totalAgents : 0;
  const capFidelity = totalAgents > 0 ? agentsMatchingCapabilities / totalAgents : 0;
  const specFidelity = (channelFidelity + capFidelity) * 2.5;

  // Diagnostic Signal (0-5): 5 if topIssue is concrete & matches a real warning;
  // partial if generic; 0 if missing.
  let diagnosticSignal = 0;
  if (health?.topIssue) {
    if (/\bagent\b|\bstep\b|\btool\b|\bgather\b|\bhandoff\b|\bzone\b/i.test(health.topIssue)) {
      diagnosticSignal = 5;
    } else {
      diagnosticSignal = 3;
    }
  }

  const scenarioText = `${scenarioMeta?.seedMessage ?? ''}\n${scenarioMeta?.capabilities ?? ''}`;
  const requiresToolCalls =
    (scenarioMeta?.expectedToolHints?.length ?? 0) > 0 ||
    /\b(lookup|search|book|create|update|send|score|upload|parse|classify|schedule|submit|approve|deny|invite|connect|export|verify|check|pull|apply|file|generate|open|page|post|translate|detect|route|queue|draft|track|correlate|ingest)\b/i.test(
      scenarioText,
    );
  const requiresFlow =
    /\b(workflow|stepwise|state machine|pipeline|approval|authorize|consent|eligib|criteria|threshold|fraud|risk|sla|policy|booking|schedule|submit|multi-day|resume|deadline|milestone)\b/i.test(
      scenarioText,
    );
  const requiresConfirmation =
    /\b(confirm|approval|authorize|authorization|consent|credit pull|containment|refund|payment|payout|book|submit|approve|deny|sar|911|medical|legal)\b/i.test(
      scenarioText,
    );
  const requiresState =
    /\b(resume|multi-day|multiday|state machine|deadline|milestone|pending|reminder|callback|long-running)\b/i.test(
      scenarioText,
    );
  const requiresAudit =
    /\b(audit|log|worm|immutable|trace|compliance|hipaa|pci|kyc|aml|coppa|ferpa|gdpr|tila|respa|soc2|pii|phi)\b/i.test(
      scenarioText,
    );
  const allAbl = Object.values(agentsResp?.agents ?? [])
    .map((agent) => `${agent.description ?? ''}\n${agent.dslContent ?? agent.ablContent ?? ''}`)
    .join('\n')
    .toLowerCase();
  const expectedToolHints = scenarioMeta?.expectedToolHints ?? [];
  const expectedToolHits =
    expectedToolHints.length > 0
      ? expectedToolHints.filter((hint) => allAbl.includes(hint.toLowerCase())).length /
        expectedToolHints.length
      : requiresToolCalls
        ? 0
        : 1;
  const hasAnyToolCall = Object.values(ablBreakdown).some((agent) => agent.toolCallCount > 0);
  const hasAnyFlow = Object.values(ablBreakdown).some((agent) => agent.hasFlow);
  const hasAnyConfirmation = Object.values(ablBreakdown).some(
    (agent) => agent.hasConfirmationSignal,
  );
  const hasAnyState = Object.values(ablBreakdown).some(
    (agent) => agent.hasMemory || agent.hasFlow || agent.setCount > 0,
  );
  const hasAnyAudit = Object.values(ablBreakdown).some((agent) => agent.hasAuditSignal);
  const intelligenceParts = [
    requiresToolCalls ? Math.min(expectedToolHits, hasAnyToolCall ? 1 : expectedToolHits) : 1,
    requiresFlow ? (hasAnyFlow ? 1 : 0) : 1,
    requiresConfirmation ? (hasAnyConfirmation ? 1 : 0) : 1,
    requiresState ? (hasAnyState ? 1 : 0) : 1,
    requiresAudit ? (hasAnyAudit ? 1 : 0) : 1,
  ];
  const intelligenceFit =
    (intelligenceParts.reduce((sum, item) => sum + item, 0) / intelligenceParts.length) * 5;

  const overall =
    (clamp5(topologyQuality) +
      clamp5(ablStructure) +
      clamp5(compileHealth) +
      clamp5(specFidelity) +
      clamp5(diagnosticSignal) +
      clamp5(intelligenceFit)) /
    6;

  return {
    scenarioId: finalRaw.scenarioId ?? path.basename(scenarioDir),
    status: finalRaw.status ?? '?',
    agentCount: finalRaw.agentCount,
    errorCount: finalRaw.errorCount ?? 0,
    durationMs: finalRaw.durationMs ?? 0,
    expectedAgents,
    topologyAgents: actualAgents,
    topologyEdges: topology?.edges?.length ?? 0,
    topologyEntryPoint: topology?.entryPoint,
    agentsCompiled: health?.passing ?? agentsCompiled,
    agentsWarning: health?.warnings ?? agentsWarning,
    agentsError: health?.errors ?? agentsError,
    healthPercent: health?.healthPercent,
    topIssue: health?.topIssue,
    channelsFromSpec: scenarioMeta?.channels ?? [],
    agentsMentioningChannel,
    capabilitiesFromSpec: scenarioMeta?.capabilities ?? '',
    agentsMatchingCapabilities,
    ablBreakdown,
    scores: {
      topologyQuality: clamp5(topologyQuality),
      ablStructure: clamp5(ablStructure),
      compileHealth: clamp5(compileHealth),
      specFidelity: clamp5(specFidelity),
      diagnosticSignal: clamp5(diagnosticSignal),
      intelligenceFit: clamp5(intelligenceFit),
      overall: clamp5(overall),
    },
    scoreNotes: tqNotes,
  };
}

function fmtScore(n: number): string {
  return n.toFixed(1);
}

async function main(): Promise<void> {
  const runDir = process.argv[2];
  if (!runDir) {
    process.stderr.write('Usage: tsx score-projects.ts <run-dir>\n');
    process.exit(1);
  }

  const scenariosFile = await readJson<Scenario[]>(path.join(runDir, 'scenarios.json'));
  const scenarioMap = new Map<string, Scenario>((scenariosFile ?? []).map((s) => [s.id, s]));

  const entries = await readDirSafe(runDir);
  const scenarioDirs = entries.map((e) => path.join(runDir, e));

  const rows: ScenarioRow[] = [];
  for (const dir of scenarioDirs) {
    const id = path.basename(dir);
    const finalRaw = await readJson<{ scenarioId?: string }>(path.join(dir, 'final.json'));
    const meta = scenarioMap.get(finalRaw?.scenarioId ?? id) ?? null;
    const row = await scoreScenario(dir, meta);
    if (row) rows.push(row);
  }

  rows.sort((a, b) => b.scores.overall - a.scores.overall);

  await fs.writeFile(path.join(runDir, 'scoring.json'), JSON.stringify({ rows }, null, 2), 'utf8');

  // Markdown scoreboard
  const lines: string[] = [];
  lines.push('# Arch-AI Eval — Scoring');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()} · ${rows.length} scenarios`);
  lines.push('');
  lines.push(
    '| Rank | Scenario | Overall | Topology | ABL | Compile | Spec Fidelity | Diagnostics | Intelligence | Agents | Errors | Health % |',
  );
  lines.push('|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  rows.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | ${r.scenarioId} | ${fmtScore(r.scores.overall)} | ${fmtScore(r.scores.topologyQuality)} | ${fmtScore(r.scores.ablStructure)} | ${fmtScore(r.scores.compileHealth)} | ${fmtScore(r.scores.specFidelity)} | ${fmtScore(r.scores.diagnosticSignal)} | ${fmtScore(r.scores.intelligenceFit)} | ${r.topologyAgents}/${r.expectedAgents} | ${r.errorCount} | ${r.healthPercent ?? '—'} |`,
    );
  });

  if (rows.length > 0) {
    const avg = (sel: (r: ScenarioRow) => number): string =>
      fmtScore(rows.reduce((sum, r) => sum + sel(r), 0) / rows.length);
    lines.push(
      `| — | **average** | ${avg((r) => r.scores.overall)} | ${avg((r) => r.scores.topologyQuality)} | ${avg((r) => r.scores.ablStructure)} | ${avg((r) => r.scores.compileHealth)} | ${avg((r) => r.scores.specFidelity)} | ${avg((r) => r.scores.diagnosticSignal)} | ${avg((r) => r.scores.intelligenceFit)} | — | — | — |`,
    );
  }

  lines.push('');
  lines.push('## Per-scenario detail');
  for (const r of rows) {
    lines.push('');
    lines.push(`### ${r.scenarioId} — overall ${fmtScore(r.scores.overall)}/5`);
    lines.push('');
    lines.push(
      `**Topology**: ${r.topologyAgents} agents, ${r.topologyEdges} edges, entry=${r.topologyEntryPoint ?? '—'}`,
    );
    lines.push(
      `**Compile**: ${r.agentsCompiled} compiled · ${r.agentsWarning} warnings · ${r.agentsError} errors (overall ${r.healthPercent ?? '—'}%)`,
    );
    if (r.topIssue) lines.push(`**Top issue**: ${r.topIssue}`);
    lines.push('');
    lines.push(
      '| Agent | FLOW | GATHER | TOOLS | CALL | SET | result branches | HANDOFF | catch-all | reasoning/scripted | warnings |',
    );
    lines.push('|---|---|---|---|---:|---:|---:|---|---|---|---|');
    for (const [name, a] of Object.entries(r.ablBreakdown)) {
      lines.push(
        `| ${name} | ${a.hasFlow ? '✓' : ''} | ${a.hasGather ? '✓' : ''} | ${a.hasTools ? '✓' : ''} | ${a.toolCallCount} | ${a.setCount} | ${a.onResultCount + a.onSuccessCount + a.onFailureCount} | ${a.hasHandoff ? `${a.handoffCount}` : a.hasComplete ? 'C' : ''} | ${a.hasCatchAllHandoff ? '✓' : ''} | ${a.reasoningSteps}/${a.scriptedSteps} | ${a.warnings.join('; ')} |`,
      );
    }
  }

  await fs.writeFile(path.join(runDir, 'scoring.md'), lines.join('\n'), 'utf8');

  // Findings rollup — aggregate ABL warnings + topology issues across all scenarios.
  const findingsByMessage = new Map<string, { count: number; samples: string[] }>();
  for (const r of rows) {
    for (const note of r.scoreNotes) {
      const key = note;
      const cur = findingsByMessage.get(key) ?? { count: 0, samples: [] };
      cur.count += 1;
      cur.samples.push(r.scenarioId);
      findingsByMessage.set(key, cur);
    }
    for (const [name, a] of Object.entries(r.ablBreakdown)) {
      for (const w of a.warnings) {
        const key = w;
        const cur = findingsByMessage.get(key) ?? { count: 0, samples: [] };
        cur.count += 1;
        cur.samples.push(`${r.scenarioId}/${name}`);
        findingsByMessage.set(key, cur);
      }
    }
  }
  const fLines: string[] = [];
  fLines.push('# Arch-AI Eval — Findings Rollup');
  fLines.push('');
  fLines.push(`Generated ${new Date().toISOString()} · ${rows.length} scenarios`);
  fLines.push('');
  fLines.push('## Issues clustered across runs');
  fLines.push('');
  fLines.push('| # | Issue | Count | Sample scenarios/agents |');
  fLines.push('|---:|---|---:|---|');
  const sorted = [...findingsByMessage.entries()].sort((a, b) => b[1].count - a[1].count);
  sorted.forEach(([msg, info], i) => {
    fLines.push(`| ${i + 1} | ${msg} | ${info.count} | ${info.samples.slice(0, 5).join(', ')} |`);
  });
  await fs.writeFile(path.join(runDir, 'findings.md'), fLines.join('\n'), 'utf8');

  process.stdout.write(`[score] wrote scoring.md, scoring.json, findings.md to ${runDir}\n`);
}

main().catch((err) => {
  process.stderr.write(`[score] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
