/**
 * Arch-vs-me comparison — diffs arch's generated topology + agents + tools
 * against my-take (independent proposal at tools/arch-eval/my-takes.json).
 *
 * Per scenario, produces:
 *   - pattern match (Pipeline / Triage->Specialists / Hub-and-Spoke / etc)
 *   - entryPoint match
 *   - agent-name overlap + Jaccard similarity
 *   - per-agent: tools declared vs my expected tools (intersection / arch-only /
 *     me-only). Tool comparison uses case-insensitive name match.
 *   - critical-handoff coverage check
 *   - non-negotiables present in arch's output (string-grep over agents.json)
 *
 * Output: <run-dir>/arch-vs-me.md (human-readable) + arch-vs-me.json.
 *
 * Usage:
 *   pnpm exec tsx tools/arch-eval/arch-vs-me.ts <run-dir>
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

interface MyTakeAgent {
  name: string;
  mode: string;
  tools: string[];
}

interface MyTakeScenario {
  id: string;
  pattern: string;
  entryPoint: string;
  agents: MyTakeAgent[];
  criticalHandoffs: string[];
  nonNegotiables: string[];
}

interface MyTakes {
  scenarios: MyTakeScenario[];
}

interface ArchTopologyAgent {
  name: string;
  role?: string;
  executionMode?: string;
  description?: string;
}

interface ArchTopologyEdge {
  from: string;
  to: string;
  type?: string;
  condition?: string;
  expectReturn?: boolean;
}

interface ArchTopology {
  agents?: ArchTopologyAgent[];
  edges?: ArchTopologyEdge[];
  entryPoint?: string;
}

interface ArchAgent {
  name: string;
  dslContent?: string;
  ablContent?: string;
  description?: string;
}

interface ArchAgentsResp {
  agents?: ArchAgent[];
}

function extractToolsFromAbl(abl: string): string[] {
  const toolsMatch = abl.match(/^TOOLS:\s*\n([\s\S]*?)(?=^[A-Z_]+:|\Z)/m);
  if (!toolsMatch) return [];
  const block = toolsMatch[1];
  const tools = new Set<string>();
  // signature form: "  tool_name(args) -> { ... }"
  for (const m of block.matchAll(/^\s+(\w+)\s*\(/gm)) tools.add(m[1]);
  // list form: "  - name: tool_name"
  for (const m of block.matchAll(/^\s+-\s*name:\s*([\w-]+)/gm)) tools.add(m[1]);
  return [...tools];
}

function inferPatternFromTopology(t: ArchTopology): string {
  const agentCount = (t.agents ?? []).length;
  const edges = t.edges ?? [];
  if (agentCount === 0 || edges.length === 0) return 'Unknown';
  if (agentCount === 1) return 'Single Agent';
  const entry = t.entryPoint;
  const outFromEntry = edges.filter((e) => e.from === entry).length;
  const inToEntry = edges.filter((e) => e.to === entry).length;
  // Pipeline: linear chain, each node has roughly 1 in + 1 out
  const allDegrees = (t.agents ?? []).map((a) => ({
    name: a.name,
    out: edges.filter((e) => e.from === a.name).length,
    in: edges.filter((e) => e.to === a.name).length,
  }));
  const maxOut = Math.max(...allDegrees.map((d) => d.out));
  const isHub = outFromEntry >= 3 && inToEntry >= 1; // entry both fans out + receives back
  const isTriage = outFromEntry >= 3 && inToEntry === 0; // entry fans out only
  const isPipeline = maxOut <= 2 && allDegrees.filter((d) => d.in === 0).length === 1;
  if (isHub) return 'Hub-and-Spoke';
  if (isTriage) return 'Triage->Specialists';
  if (isPipeline) return 'Pipeline';
  return 'Mixed';
}

interface ComparisonResult {
  scenarioId: string;
  pattern: { my: string; arch: string; match: boolean };
  entryPoint: { my: string; arch?: string; match: boolean };
  agentCounts: { my: number; arch: number };
  agentJaccard: number;
  agentMatch: {
    overlap: string[];
    archOnly: string[];
    myOnly: string[];
  };
  toolStats: {
    myTotal: number;
    archTotal: number;
    intersectionPercent: number;
    archMissingFromMy: string[]; // tools arch declared that I didn't expect
    myMissingFromArch: string[]; // tools I expected that arch didn't declare
  };
  criticalHandoffCoverage: Array<{ rule: string; coveredBy?: { from: string; to: string } }>;
  nonNegotiableCoverage: Array<{ rule: string; mentioned: boolean }>;
  notes: string[];
}

function similarityName(a: string, b: string): number {
  const la = a.toLowerCase().replace(/[_-]/g, '');
  const lb = b.toLowerCase().replace(/[_-]/g, '');
  if (la === lb) return 1;
  if (la.includes(lb) || lb.includes(la)) return 0.8;
  // simple shared-word
  const wordsA = new Set(
    a
      .toLowerCase()
      .split(/[_\s-]+/)
      .filter((w) => w.length > 2),
  );
  const wordsB = new Set(
    b
      .toLowerCase()
      .split(/[_\s-]+/)
      .filter((w) => w.length > 2),
  );
  const inter = [...wordsA].filter((w) => wordsB.has(w)).length;
  const max = Math.max(wordsA.size, wordsB.size, 1);
  return inter / max;
}

function bestAgentMatch(
  myAgents: MyTakeAgent[],
  archAgents: { name: string }[],
): {
  matches: Array<{ my: string; arch: string; sim: number }>;
  myOnly: string[];
  archOnly: string[];
} {
  const used = new Set<string>();
  const matches: Array<{ my: string; arch: string; sim: number }> = [];
  const myOnly: string[] = [];
  for (const my of myAgents) {
    let best: { arch: string; sim: number } | null = null;
    for (const arch of archAgents) {
      if (used.has(arch.name)) continue;
      const sim = similarityName(my.name, arch.name);
      if (!best || sim > best.sim) best = { arch: arch.name, sim };
    }
    if (best && best.sim >= 0.4) {
      matches.push({ my: my.name, arch: best.arch, sim: best.sim });
      used.add(best.arch);
    } else {
      myOnly.push(my.name);
    }
  }
  const archOnly = archAgents.filter((a) => !used.has(a.name)).map((a) => a.name);
  return { matches, myOnly, archOnly };
}

async function compareScenario(
  runDir: string,
  scenarioId: string,
  myTake: MyTakeScenario,
): Promise<ComparisonResult | null> {
  const dir = path.join(runDir, scenarioId);
  let topology: ArchTopology = {};
  let agentsResp: ArchAgentsResp = {};
  try {
    topology = JSON.parse(await fs.readFile(path.join(dir, 'topology.json'), 'utf8'));
  } catch {
    return null;
  }
  try {
    agentsResp = JSON.parse(await fs.readFile(path.join(dir, 'agents.json'), 'utf8'));
  } catch {
    // continue with topology-only
  }

  const archAgents = topology.agents ?? [];
  const archAgentNames = archAgents.map((a) => a.name);

  // Tool extraction from ABL
  const archToolsByAgent = new Map<string, string[]>();
  for (const a of agentsResp.agents ?? []) {
    const abl = a.dslContent ?? a.ablContent ?? '';
    archToolsByAgent.set(a.name, extractToolsFromAbl(abl));
  }
  const allArchTools = new Set<string>();
  for (const tools of archToolsByAgent.values()) {
    for (const t of tools) allArchTools.add(t);
  }

  const archPattern = inferPatternFromTopology(topology);

  const { matches, myOnly, archOnly } = bestAgentMatch(myTake.agents, archAgents);
  const jaccard = matches.length / Math.max(myTake.agents.length, archAgents.length, 1);

  const allMyTools = new Set(myTake.agents.flatMap((a) => a.tools.map((t) => t.toLowerCase())));
  const allArchToolsLower = new Set([...allArchTools].map((t) => t.toLowerCase()));
  const intersection = [...allMyTools].filter((t) => allArchToolsLower.has(t));
  const intersectionPercent =
    allMyTools.size === 0 ? 0 : Math.round((intersection.length / allMyTools.size) * 100);
  const archMissingFromMy = [...allArchToolsLower].filter((t) => !allMyTools.has(t));
  const myMissingFromArch = [...allMyTools].filter((t) => !allArchToolsLower.has(t));

  // Critical handoff coverage — string-grep arch's edges
  const allEdges = topology.edges ?? [];
  const handoffCoverage = myTake.criticalHandoffs.map((rule) => {
    const lower = rule.toLowerCase();
    // pull "X -> Y" pattern from rule
    const m = lower.match(/(\w+)\s*->\s*(\w+)/);
    if (!m) return { rule };
    const fromHint = m[1];
    const toHint = m[2];
    const covered = allEdges.find((e) => {
      const f = e.from.toLowerCase().replace(/[_-]/g, '');
      const t = e.to.toLowerCase().replace(/[_-]/g, '');
      const fh = fromHint.replace(/[_-]/g, '');
      const th = toHint.replace(/[_-]/g, '');
      return (f.includes(fh) || fh.includes(f)) && (t.includes(th) || th.includes(t));
    });
    return covered ? { rule, coveredBy: { from: covered.from, to: covered.to } } : { rule };
  });

  // Non-negotiable mention check (grep all agent descriptions + dslContent)
  const allText = [
    ...archAgents.map((a) => `${a.role ?? ''}\n${a.description ?? ''}`),
    ...(agentsResp.agents ?? []).map((a) => a.dslContent ?? a.ablContent ?? ''),
  ]
    .join('\n')
    .toLowerCase();
  const nonNegotiableCoverage = myTake.nonNegotiables.map((rule) => {
    const keywords = rule
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4);
    const matched = keywords.filter((k) => allText.includes(k));
    return { rule, mentioned: matched.length / Math.max(keywords.length, 1) >= 0.5 };
  });

  const notes: string[] = [];
  if (archPattern !== myTake.pattern && archPattern !== 'Mixed') {
    notes.push(`pattern mismatch: arch=${archPattern}, me=${myTake.pattern}`);
  }
  if (Math.abs(archAgents.length - myTake.agents.length) > 1) {
    notes.push(`agent-count delta: arch=${archAgents.length}, me=${myTake.agents.length}`);
  }
  if (intersectionPercent < 30 && myTake.agents.length > 0) {
    notes.push(`low tool-overlap (${intersectionPercent}%) — arch's tools differ`);
  }
  if (myOnly.length > 0) {
    notes.push(`missing agents (from my-take): ${myOnly.join(', ')}`);
  }
  if (archOnly.length > 0 && archOnly.length >= 2) {
    notes.push(`extra agents (in arch only): ${archOnly.join(', ')}`);
  }

  return {
    scenarioId,
    pattern: { my: myTake.pattern, arch: archPattern, match: archPattern === myTake.pattern },
    entryPoint: {
      my: myTake.entryPoint,
      arch: topology.entryPoint,
      match:
        topology.entryPoint !== undefined &&
        similarityName(myTake.entryPoint, topology.entryPoint) >= 0.4,
    },
    agentCounts: { my: myTake.agents.length, arch: archAgents.length },
    agentJaccard: Math.round(jaccard * 100) / 100,
    agentMatch: { overlap: matches.map((m) => `${m.my}↔${m.arch}`), archOnly, myOnly },
    toolStats: {
      myTotal: allMyTools.size,
      archTotal: allArchToolsLower.size,
      intersectionPercent,
      archMissingFromMy,
      myMissingFromArch,
    },
    criticalHandoffCoverage: handoffCoverage,
    nonNegotiableCoverage,
    notes,
  };
}

async function main(): Promise<void> {
  const runDir = process.argv[2];
  if (!runDir) {
    process.stderr.write('Usage: tsx arch-vs-me.ts <run-dir>\n');
    process.exit(1);
  }
  const myTakesPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'my-takes.json');
  const myTakes = JSON.parse(await fs.readFile(myTakesPath, 'utf8')) as MyTakes;

  const results: ComparisonResult[] = [];
  for (const my of myTakes.scenarios) {
    const r = await compareScenario(runDir, my.id, my);
    if (r) results.push(r);
  }

  await fs.writeFile(
    path.join(runDir, 'arch-vs-me.json'),
    JSON.stringify({ results }, null, 2),
    'utf8',
  );

  // Markdown report
  const lines: string[] = [];
  lines.push('# Arch vs Me — Comparison');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()} · ${results.length} scenarios`);
  lines.push('');
  lines.push('## At-a-glance');
  lines.push('');
  lines.push(
    '| Scenario | Pattern (me/arch) | Entry match | Agents (me/arch) | Agent overlap | Tool overlap | Handoffs covered | Non-neg mentioned |',
  );
  lines.push('|---|---|---|---|---:|---:|---:|---:|');
  for (const r of results) {
    const handoffsCovered = r.criticalHandoffCoverage.filter((h) => h.coveredBy).length;
    const nonNeg = r.nonNegotiableCoverage.filter((n) => n.mentioned).length;
    lines.push(
      `| ${r.scenarioId} | ${r.pattern.my} / ${r.pattern.arch} ${r.pattern.match ? '✓' : '✗'} | ${r.entryPoint.match ? '✓' : '✗'} (arch: ${r.entryPoint.arch ?? '—'}) | ${r.agentCounts.my} / ${r.agentCounts.arch} | ${Math.round(r.agentJaccard * 100)}% | ${r.toolStats.intersectionPercent}% | ${handoffsCovered}/${r.criticalHandoffCoverage.length} | ${nonNeg}/${r.nonNegotiableCoverage.length} |`,
    );
  }
  lines.push('');

  // Averages
  if (results.length > 0) {
    const avgJac = (results.reduce((s, r) => s + r.agentJaccard, 0) / results.length) * 100;
    const avgTool =
      results.reduce((s, r) => s + r.toolStats.intersectionPercent, 0) / results.length;
    const patternMatchPct = (results.filter((r) => r.pattern.match).length / results.length) * 100;
    const entryMatchPct = (results.filter((r) => r.entryPoint.match).length / results.length) * 100;
    const handoffCovPct =
      results.reduce(
        (s, r) =>
          s +
          r.criticalHandoffCoverage.filter((h) => h.coveredBy).length /
            Math.max(r.criticalHandoffCoverage.length, 1),
        0,
      ) / results.length;
    const nonNegPct =
      results.reduce(
        (s, r) =>
          s +
          r.nonNegotiableCoverage.filter((n) => n.mentioned).length /
            Math.max(r.nonNegotiableCoverage.length, 1),
        0,
      ) / results.length;
    lines.push('## Averages');
    lines.push('');
    lines.push(`- Pattern match: **${patternMatchPct.toFixed(0)}%**`);
    lines.push(`- Entry-point match: **${entryMatchPct.toFixed(0)}%**`);
    lines.push(`- Agent-name overlap (Jaccard): **${avgJac.toFixed(0)}%**`);
    lines.push(`- Tool-name overlap: **${avgTool.toFixed(0)}%**`);
    lines.push(`- Critical-handoff coverage: **${(handoffCovPct * 100).toFixed(0)}%**`);
    lines.push(`- Non-negotiable mention rate: **${(nonNegPct * 100).toFixed(0)}%**`);
    lines.push('');
  }

  lines.push('## Per-scenario detail');
  for (const r of results) {
    lines.push('');
    lines.push(`### ${r.scenarioId}`);
    lines.push('');
    lines.push(
      `- pattern: me=${r.pattern.my} / arch=${r.pattern.arch} ${r.pattern.match ? '✓ match' : '✗ DIFFERENT'}`,
    );
    lines.push(
      `- entry: me=${r.entryPoint.my} / arch=${r.entryPoint.arch ?? '—'} ${r.entryPoint.match ? '✓' : '✗'}`,
    );
    lines.push(`- agents: me=${r.agentCounts.my} / arch=${r.agentCounts.arch}`);
    lines.push(`- agent overlap (Jaccard): ${(r.agentJaccard * 100).toFixed(0)}%`);
    if (r.agentMatch.overlap.length > 0) {
      lines.push(`- name matches: ${r.agentMatch.overlap.join(', ')}`);
    }
    if (r.agentMatch.archOnly.length > 0) {
      lines.push(`- arch-only agents: ${r.agentMatch.archOnly.join(', ')}`);
    }
    if (r.agentMatch.myOnly.length > 0) {
      lines.push(`- me-only agents (missing in arch): ${r.agentMatch.myOnly.join(', ')}`);
    }
    lines.push(
      `- tools: me=${r.toolStats.myTotal} / arch=${r.toolStats.archTotal} / overlap=${r.toolStats.intersectionPercent}%`,
    );
    if (r.toolStats.archMissingFromMy.length > 0) {
      lines.push(
        `  - arch declared not in my-take: ${r.toolStats.archMissingFromMy.slice(0, 8).join(', ')}`,
      );
    }
    if (r.toolStats.myMissingFromArch.length > 0) {
      lines.push(
        `  - me expected, arch missing: ${r.toolStats.myMissingFromArch.slice(0, 8).join(', ')}`,
      );
    }
    lines.push(`- critical-handoff coverage:`);
    for (const h of r.criticalHandoffCoverage) {
      lines.push(
        `  - ${h.coveredBy ? '✓' : '✗'} ${h.rule}${h.coveredBy ? ` (matched edge ${h.coveredBy.from}→${h.coveredBy.to})` : ''}`,
      );
    }
    lines.push(`- non-negotiables mentioned in agents:`);
    for (const n of r.nonNegotiableCoverage) {
      lines.push(`  - ${n.mentioned ? '✓' : '✗'} ${n.rule}`);
    }
    if (r.notes.length > 0) {
      lines.push(`- **notes**:`);
      for (const note of r.notes) lines.push(`  - ${note}`);
    }
  }

  await fs.writeFile(path.join(runDir, 'arch-vs-me.md'), lines.join('\n'), 'utf8');
  process.stdout.write(`[arch-vs-me] wrote ${path.join(runDir, 'arch-vs-me.md')}\n`);
}

main().catch((err) => {
  process.stderr.write(`[arch-vs-me] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
