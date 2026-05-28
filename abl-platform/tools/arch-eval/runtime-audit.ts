/**
 * Runtime audit — validates auto-generated arch-ai projects against the
 * platform runtime's actual contracts.
 *
 * Runtime contract source: `apps/runtime/src/tools/load-project-tools-as-ir.ts`,
 *   `apps/runtime/src/services/execution/agent-lookup.ts`,
 *   `apps/runtime/src/services/pipeline/null-safe-eval.ts`,
 *   `packages/compiler/src/__tests__/session-memory-validation.test.ts`.
 *
 * Audits performed (per project):
 *   1. Tool integrity   — TOOLS declared in ABL exist as ProjectTool records
 *                         (same tenant + project + name).
 *   2. Handoff targets  — HANDOFF TO names point to agents in the same project,
 *                         OR look like remote URLs.
 *   3. CEL hygiene      — identifiers in WHEN clauses are either intrinsic
 *                         (intent.*, gathered.*) or declared+writable in MEMORY.
 *                         Non-intrinsic identifiers without a population source
 *                         resolve to null at runtime, making WHEN clauses dead.
 *   4. Exit/COMPLETION  — every agent without a HANDOFF must have a COMPLETE
 *                         block or terminal FLOW step, else the conversation
 *                         can run indefinitely.
 *   5. Channel reality  — topology declares channels, but no
 *                         ChannelConnection records exist for the project, so
 *                         the project is not addressable from any channel.
 *
 * Reads from MongoDB (via docker exec) to cross-check project_tools and
 * project_channel_connections.
 *
 * Output: <run-dir>/RUNTIME-AUDIT.md with per-project + aggregate findings.
 *
 * Usage:
 *   pnpm exec tsx tools/arch-eval/runtime-audit.ts \
 *     --run-dirs docs/testing/arch-eval/run-20260510-235649,docs/testing/arch-eval/postfix-004903
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface CliArgs {
  runDirs: string[];
  outFile?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = { runDirs: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-dirs') out.runDirs = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--out') out.outFile = argv[++i];
  }
  if (!out.runDirs?.length) {
    process.stderr.write('Required: --run-dirs <dir1>,<dir2>\n');
    process.exit(1);
  }
  return out as CliArgs;
}

interface ProjectAuditInput {
  runDir: string;
  scenarioId: string;
  projectId: string;
  projectSlug?: string;
  agents: Array<{ name: string; abl: string }>;
  topologyChannels: string[];
}

async function loadProject(runDir: string, scenarioDir: string): Promise<ProjectAuditInput | null> {
  const finalPath = path.join(runDir, scenarioDir, 'final.json');
  let final: { scenarioId?: string; projectId?: string; projectSlug?: string };
  try {
    final = JSON.parse(await fs.readFile(finalPath, 'utf8'));
  } catch {
    return null;
  }
  if (!final.projectId) return null;

  const ablDir = path.join(runDir, scenarioDir, 'abl');
  let ablFiles: string[] = [];
  try {
    ablFiles = (await fs.readdir(ablDir)).filter((f) => f.endsWith('.abl'));
  } catch {
    return null;
  }
  const agents = await Promise.all(
    ablFiles.map(async (f) => ({
      name: path.basename(f, '.abl'),
      abl: await fs.readFile(path.join(ablDir, f), 'utf8'),
    })),
  );

  let channels: string[] = [];
  try {
    const sessionDoc = JSON.parse(
      await fs.readFile(path.join(runDir, scenarioDir, 'session.json'), 'utf8'),
    );
    const meta = sessionDoc?.session?.metadata as Record<string, unknown> | undefined;
    const spec = meta?.specification as { channels?: string[] } | undefined;
    channels = spec?.channels ?? [];
  } catch {
    channels = [];
  }

  return {
    runDir,
    scenarioId: final.scenarioId ?? scenarioDir,
    projectId: final.projectId,
    projectSlug: final.projectSlug,
    agents,
    topologyChannels: channels,
  };
}

async function mongoshQuery(query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        'abl-mongo',
        'mongosh',
        '--quiet',
        '-u',
        'abl_admin',
        '-p',
        'abl_dev_password',
        '--authenticationDatabase',
        'admin',
        'abl_platform',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(`mongosh exited with code ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(`${query}\n`);
  });
}

async function fetchProjectTools(projectId: string): Promise<Set<string>> {
  const out = await mongoshQuery(
    `const projectId = ${JSON.stringify(projectId)};
db.project_tools.find({ projectId }, { name: 1, _id: 0 }).forEach((t) => print(t.name));`,
  );
  return new Set(
    out
      .split('\n')
      .map((s) => s.replace(/^.*?\]\s+\S+>\s*/, '').trim())
      .filter((s) => /^[a-z][a-z0-9_]{0,62}[a-z0-9]$/.test(s)),
  );
}

interface ChannelConnectionAuditRecord {
  channelType: string;
  externalIdentifier: string;
  status: string;
}

async function fetchChannelConnections(projectId: string): Promise<ChannelConnectionAuditRecord[]> {
  const collections = ['channel_connections', 'project_channel_connections', 'channels'];
  for (const c of collections) {
    try {
      const out = await mongoshQuery(`const projectId = ${JSON.stringify(projectId)};
const collectionName = ${JSON.stringify(c)};
if (!db.getCollectionNames().includes(collectionName)) {
  print("__MISSING__");
} else {
  db.getCollection(collectionName)
    .find({ projectId }, { channelType: 1, externalIdentifier: 1, status: 1, _id: 0 })
    .forEach((connection) => print(JSON.stringify(connection)));
}`);
      if (out.includes('__MISSING__')) continue;
      return out
        .split('\n')
        .map((line) => {
          const trimmed = line.trim();
          const jsonStart = trimmed.indexOf('{');
          return jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed;
        })
        .filter((line) => line.startsWith('{') && line.endsWith('}'))
        .map((line) => JSON.parse(line) as ChannelConnectionAuditRecord);
    } catch {
      // collection might not exist; try next
    }
  }
  return [];
}

interface AblParsed {
  agentName: string;
  isSupervisor: boolean;
  toolsDeclared: string[];
  handoffTargets: Array<{ to: string; when: string; isRemoteUrl: boolean }>;
  whenIdentifiers: Set<string>;
  memoryDeclared: Set<string>;
  hasComplete: boolean;
  hasHandoff: boolean;
  hasCatchAllHandoff: boolean;
  jsStyleSyntax: string[];
}

const INTRINSIC_TOP_LEVEL = new Set([
  'abl', // ABL namespace — abl.intent, abl.memory.* etc. per platform CEL grammar
  'intent',
  'gathered',
  'gather',
  'memory',
  'session',
  'persistent',
  'user',
  'history',
  'tool_result',
  'tool',
  'input',
  'output',
  'env',
  'now',
  'utterance',
  'sentiment', // populated by NLU pipeline if classifier enabled
  'channel',
  'request',
  'response',
]);

const SECTION_END_LOOKAHEAD = '(?=^[A-Z_]+:|(?![\\s\\S]))';

function parseAbl(name: string, abl: string): AblParsed {
  const isSupervisor = /^SUPERVISOR:/m.test(abl);
  const hasComplete = /^COMPLETE:/m.test(abl);
  const hasHandoff = /^HANDOFF:/m.test(abl);

  // TOOLS section
  const toolsMatch = abl.match(
    new RegExp(`^TOOLS:\\s*\\n([\\s\\S]*?)${SECTION_END_LOOKAHEAD}`, 'm'),
  );
  const toolsDeclared: string[] = [];
  if (toolsMatch) {
    const block = toolsMatch[1];
    // Either signature form: "  tool_name(arg: type) -> { ... }"
    // Or list form:        "  - name: tool_name"
    const sigMatches = block.matchAll(/^\s+(\w+)\s*\(/gm);
    for (const m of sigMatches) toolsDeclared.push(m[1]);
    const listMatches = block.matchAll(/^\s+-\s*name:\s*([\w-]+)/gm);
    for (const m of listMatches) toolsDeclared.push(m[1]);
  }

  // HANDOFF section
  const handoffMatch = abl.match(
    new RegExp(`^HANDOFF:\\s*\\n([\\s\\S]*?)${SECTION_END_LOOKAHEAD}`, 'm'),
  );
  const handoffTargets: AblParsed['handoffTargets'] = [];
  let hasCatchAllHandoff = false;
  if (handoffMatch) {
    const block = handoffMatch[1];
    const entries = block.split(/^\s+-\s*TO:\s*/m).slice(1);
    for (const entry of entries) {
      const lines = entry.split('\n');
      const to = (lines[0] ?? '').trim();
      const whenLine = lines.find((l) => /^\s*WHEN:/.test(l));
      const when = whenLine ? whenLine.replace(/^\s*WHEN:\s*/, '').trim() : '';
      const isRemoteUrl = /^https?:\/\//.test(to) || to.startsWith('http');
      handoffTargets.push({ to, when, isRemoteUrl });
      if (/^"?(true|always)"?$/i.test(when)) hasCatchAllHandoff = true;
    }
  }

  // Collect WHEN top-level identifiers (from FLOW IF, HANDOFF WHEN, COMPLETE WHEN, etc.)
  // Pre-strip JS-style regex literals (/pattern/flags) — they yield false-positive
  // "identifier" matches on the trailing flag chars like /\bfoo\b/i.test(...).
  const whenIdentifiers = new Set<string>();
  const jsStyleSyntax: string[] = [];
  const whenMatches = abl.matchAll(/WHEN:\s*"?([^"\n]+)"?/g);
  for (const m of whenMatches) {
    let expr = m[1];
    // Flag JS-style regex and method calls — CEL evaluator rejects these
    if (/\/[^/]+\/[gim]+\s*\.test\b/.test(expr)) jsStyleSyntax.push('regex-literal .test()');
    if (/\.(toLowerCase|toUpperCase|includes|match|startsWith|endsWith|trim|split)\(/.test(expr))
      jsStyleSyntax.push('JS method call');
    // Strip /pattern/i so regex flags don't look like identifiers
    expr = expr.replace(/\/[^/\n]+\/[gim]+/g, '');
    const idents = expr.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\.[a-zA-Z_]/g);
    for (const im of idents) whenIdentifiers.add(im[1]);
  }

  // MEMORY session vars
  const memoryDeclared = new Set<string>();
  const memMatch = abl.match(
    new RegExp(`^MEMORY:\\s*\\n([\\s\\S]*?)${SECTION_END_LOOKAHEAD}`, 'm'),
  );
  if (memMatch) {
    const block = memMatch[1];
    const namedFields = block.matchAll(/^\s+-\s*name:\s*([\w-]+)/gm);
    for (const m of namedFields) memoryDeclared.add(m[1]);
  }

  return {
    agentName: name,
    isSupervisor,
    toolsDeclared,
    handoffTargets,
    whenIdentifiers,
    memoryDeclared,
    hasComplete,
    hasHandoff,
    hasCatchAllHandoff,
    jsStyleSyntax,
  };
}

interface ProjectAuditResult {
  scenarioId: string;
  projectId: string;
  projectSlug?: string;
  agentCount: number;
  toolsInProject: number;
  channelsDeclared: string[];
  channelConnections: number;
  webChatIngressConnections: number;
  totalToolReferences: number;
  unresolvedToolReferences: Array<{ agent: string; tool: string }>;
  unresolvedHandoffTargets: Array<{ agent: string; to: string; when: string }>;
  remoteHandoffs: Array<{ agent: string; to: string }>;
  nonIntrinsicWhenIdentifiers: Array<{ agent: string; ident: string }>;
  jsStyleCelViolations: Array<{ agent: string; kinds: string[] }>;
  agentsWithoutExit: string[];
  ablOnlySupervisors: number;
  channelGap: boolean;
  webChatIngressGap: boolean;
}

async function auditProject(input: ProjectAuditInput): Promise<ProjectAuditResult> {
  const toolsInProject = await fetchProjectTools(input.projectId);
  const channelConnections = await fetchChannelConnections(input.projectId);
  const webChatIngressConnections = channelConnections.filter(
    (connection) => connection.channelType === 'http_async' && connection.status !== 'inactive',
  ).length;
  const agentNames = new Set(input.agents.map((a) => a.name));

  const unresolvedToolReferences: ProjectAuditResult['unresolvedToolReferences'] = [];
  const unresolvedHandoffTargets: ProjectAuditResult['unresolvedHandoffTargets'] = [];
  const remoteHandoffs: ProjectAuditResult['remoteHandoffs'] = [];
  const nonIntrinsicWhenIdentifiers: ProjectAuditResult['nonIntrinsicWhenIdentifiers'] = [];
  const jsStyleCelViolations: ProjectAuditResult['jsStyleCelViolations'] = [];
  const agentsWithoutExit: string[] = [];
  let totalToolReferences = 0;
  let supervisorCount = 0;

  for (const a of input.agents) {
    const p = parseAbl(a.name, a.abl);
    if (p.isSupervisor) supervisorCount += 1;
    totalToolReferences += p.toolsDeclared.length;
    for (const tn of p.toolsDeclared) {
      if (!toolsInProject.has(tn)) {
        unresolvedToolReferences.push({ agent: a.name, tool: tn });
      }
    }
    for (const h of p.handoffTargets) {
      if (h.isRemoteUrl) {
        remoteHandoffs.push({ agent: a.name, to: h.to });
        continue;
      }
      if (!agentNames.has(h.to)) {
        unresolvedHandoffTargets.push({ agent: a.name, to: h.to, when: h.when });
      }
    }
    for (const ident of p.whenIdentifiers) {
      // Skip values that match the agent's own declared memory vars
      if (p.memoryDeclared.has(ident)) continue;
      if (!INTRINSIC_TOP_LEVEL.has(ident)) {
        nonIntrinsicWhenIdentifiers.push({ agent: a.name, ident });
      }
    }
    if (p.jsStyleSyntax.length > 0) {
      jsStyleCelViolations.push({ agent: a.name, kinds: [...new Set(p.jsStyleSyntax)] });
    }
    // Exit condition: either has COMPLETE, or has HANDOFF with catch-all, or
    // is a supervisor (terminal at session boundary).
    if (!p.hasComplete && !p.hasCatchAllHandoff && !p.isSupervisor) {
      agentsWithoutExit.push(a.name);
    }
  }

  return {
    scenarioId: input.scenarioId,
    projectId: input.projectId,
    projectSlug: input.projectSlug,
    agentCount: input.agents.length,
    toolsInProject: toolsInProject.size,
    channelsDeclared: input.topologyChannels,
    channelConnections: channelConnections.length,
    webChatIngressConnections,
    totalToolReferences,
    unresolvedToolReferences,
    unresolvedHandoffTargets,
    remoteHandoffs,
    nonIntrinsicWhenIdentifiers,
    jsStyleCelViolations,
    agentsWithoutExit,
    ablOnlySupervisors: supervisorCount,
    channelGap: input.topologyChannels.length > 0 && channelConnections.length === 0,
    webChatIngressGap: webChatIngressConnections === 0,
  };
}

function fmtList(items: string[], max = 8): string {
  if (items.length === 0) return '—';
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} … +${items.length - max} more`;
}

function summarizeResults(results: ProjectAuditResult[]): string {
  const lines: string[] = [];
  lines.push('# Runtime Audit — Auto-generated Arch-AI Projects');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()}`);
  lines.push(`Projects audited: ${results.length}`);
  lines.push('');
  lines.push(
    'Audits the generated ABL against the actual platform-runtime contracts ' +
      '(tool registry, agent registry, CEL namespace, exit conditions, channel ' +
      'connections) — not just compiler warnings.',
  );
  lines.push('');
  lines.push('## At a glance');
  lines.push('');
  lines.push(
    '| Scenario | Agents | Tool refs | Unresolved tools | Bad HANDOFF | Remote HANDOFF | Non-intrinsic WHEN ids | No-exit agents | Channels declared | Channel conns | HTTP ingress | Runtime-deployable? |',
  );
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---|');
  for (const r of results) {
    const deployable =
      r.unresolvedHandoffTargets.length === 0 &&
      r.channelConnections > 0 &&
      r.webChatIngressConnections > 0 &&
      r.agentsWithoutExit.length === 0
        ? '✅ yes'
        : '❌ no';
    lines.push(
      `| ${r.scenarioId} | ${r.agentCount} | ${r.totalToolReferences} | ${r.unresolvedToolReferences.length} | ${r.unresolvedHandoffTargets.length} | ${r.remoteHandoffs.length} | ${r.nonIntrinsicWhenIdentifiers.length} | ${r.agentsWithoutExit.length} | ${r.channelsDeclared.join(', ') || '—'} | ${r.channelConnections} | ${r.webChatIngressConnections} | ${deployable} |`,
    );
  }
  lines.push('');

  // Aggregate
  const total = (sel: (r: ProjectAuditResult) => number): number =>
    results.reduce((s, r) => s + sel(r), 0);
  lines.push('## Aggregate runtime gaps');
  lines.push('');
  lines.push(
    `- Total tool references in generated ABL: **${total((r) => r.totalToolReferences)}**`,
  );
  lines.push(
    `- Tool references with no matching ProjectTool record: **${total((r) => r.unresolvedToolReferences.length)}** ` +
      `(every CALL will fail at runtime — agent must invoke an existing ProjectTool by exact name)`,
  );
  lines.push(
    `- HANDOFF targets pointing to non-existent agents: **${total((r) => r.unresolvedHandoffTargets.length)}** ` +
      `(handoffs will fail with "agent not found")`,
  );
  lines.push(
    `- HANDOFF targets that look like remote URLs: **${total((r) => r.remoteHandoffs.length)}** ` +
      `(legal but require the remote agent to actually exist; not validated by this audit)`,
  );
  lines.push(
    `- WHEN-clause identifiers outside intrinsic set (\`intent\`, \`gathered\`, ` +
      `\`memory\`, \`session\`, etc.): **${total((r) => r.nonIntrinsicWhenIdentifiers.length)}** ` +
      `(each one resolves to null at runtime unless a tool/GATHER explicitly populates it; ` +
      `WHEN evaluates false silently)`,
  );
  lines.push(
    `- Agents with no COMPLETE/catch-all HANDOFF (will run indefinitely): **${total((r) => r.agentsWithoutExit.length)}**`,
  );
  lines.push(
    `- Agents using JS-style syntax in WHEN clauses (rejected by CEL): **${total((r) => r.jsStyleCelViolations.length)}** ` +
      `(\`.toLowerCase()\`, \`.includes()\`, \`/regex/i.test()\` — CEL parser will throw; the WHEN clause never matches)`,
  );
  lines.push(
    `- Projects with channels declared in topology but ZERO ChannelConnection records: ` +
      `**${results.filter((r) => r.channelGap).length}/${results.length}** ` +
      `(NOT addressable from any channel — project creation does not auto-provision channels)`,
  );
  lines.push(
    `- Projects without an active HTTP async ingress for CLI/web smoke tests: ` +
      `**${results.filter((r) => r.webChatIngressGap).length}/${results.length}**`,
  );
  lines.push('');

  lines.push('## Per-project detail');
  for (const r of results) {
    lines.push('');
    lines.push(`### ${r.scenarioId}`);
    lines.push('');
    lines.push(`- project: \`${r.projectId}\` (${r.projectSlug ?? '—'})`);
    lines.push(`- ${r.agentCount} agents · ${r.ablOnlySupervisors} supervisor(s)`);
    lines.push(`- ${r.toolsInProject} ProjectTool records exist`);
    lines.push(`- ${r.totalToolReferences} tool references in ABL`);
    lines.push(
      `- ${r.channelConnections} ChannelConnection record(s), ${r.webChatIngressConnections} active HTTP async ingress connection(s)`,
    );
    if (r.unresolvedToolReferences.length > 0) {
      lines.push(`- **unresolved tool references** (${r.unresolvedToolReferences.length}):`);
      for (const u of r.unresolvedToolReferences.slice(0, 12)) {
        lines.push(`  - ${u.agent} → \`${u.tool}\``);
      }
      if (r.unresolvedToolReferences.length > 12) {
        lines.push(`  - … +${r.unresolvedToolReferences.length - 12} more`);
      }
    }
    if (r.unresolvedHandoffTargets.length > 0) {
      lines.push(`- **invalid HANDOFF targets** (${r.unresolvedHandoffTargets.length}):`);
      for (const u of r.unresolvedHandoffTargets.slice(0, 8)) {
        lines.push(`  - ${u.agent} → \`${u.to}\` (WHEN: ${u.when.slice(0, 60) || 'true'})`);
      }
    }
    if (r.remoteHandoffs.length > 0) {
      lines.push(
        `- remote HANDOFFs (${r.remoteHandoffs.length}): ${fmtList(
          r.remoteHandoffs.map((h) => `${h.agent}→${h.to}`),
          4,
        )}`,
      );
    }
    if (r.nonIntrinsicWhenIdentifiers.length > 0) {
      const groups = new Map<string, Set<string>>();
      for (const x of r.nonIntrinsicWhenIdentifiers) {
        if (!groups.has(x.ident)) groups.set(x.ident, new Set());
        groups.get(x.ident)?.add(x.agent);
      }
      lines.push(`- non-intrinsic WHEN identifiers (${groups.size} unique):`);
      const sorted = [...groups.entries()].sort((a, b) => b[1].size - a[1].size);
      for (const [ident, agents] of sorted.slice(0, 12)) {
        lines.push(
          `  - \`${ident}\` referenced by ${agents.size} agent(s): ${fmtList([...agents], 4)}`,
        );
      }
    }
    if (r.agentsWithoutExit.length > 0) {
      lines.push(
        `- agents with no exit (${r.agentsWithoutExit.length}): ${fmtList(r.agentsWithoutExit, 6)}`,
      );
    }
    if (r.jsStyleCelViolations.length > 0) {
      lines.push(`- **CEL syntax violations** (${r.jsStyleCelViolations.length} agent(s)):`);
      for (const v of r.jsStyleCelViolations.slice(0, 6)) {
        lines.push(`  - ${v.agent}: ${v.kinds.join(', ')}`);
      }
    }
    if (r.channelGap) {
      lines.push(
        `- **channel gap**: topology declares ${r.channelsDeclared.join(', ')} but no ChannelConnection records — runtime not addressable.`,
      );
    }
    if (r.webChatIngressGap) {
      lines.push(
        '- **ingress gap**: no active HTTP async ChannelConnection exists, so CLI/web smoke tests have no stable project ingress.',
      );
    }
  }

  lines.push('');
  lines.push('## What "runtime-deployable" means here');
  lines.push('');
  lines.push(
    '* every HANDOFF TO target resolves to an actual agent or remote URL in the same project,',
  );
  lines.push(
    '* every agent has either a COMPLETE block or a catch-all HANDOFF (otherwise conversations run forever),',
  );
  lines.push(
    '* at least one ChannelConnection record exists and one active HTTP async ingress exists (otherwise CLI/web smoke tests have no stable project entry point).',
  );
  lines.push('');
  lines.push(
    'Note: tool references and non-intrinsic WHEN identifiers do NOT block deployability — ' +
      'they cause silent runtime degradation (CALL falls through, WHEN evaluates false). ' +
      'But they reflect quality issues that surface as the agent failing user requests.',
  );
  lines.push('');

  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const results: ProjectAuditResult[] = [];
  for (const runDir of args.runDirs) {
    const entries = await fs.readdir(runDir, { withFileTypes: true });
    const scenarioDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    for (const sd of scenarioDirs) {
      const input = await loadProject(runDir, sd);
      if (!input) continue;
      process.stdout.write(`[audit] ${runDir}/${sd}\n`);
      const result = await auditProject(input);
      results.push(result);
    }
  }
  const out = args.outFile ?? path.join(args.runDirs[0], 'RUNTIME-AUDIT.md');
  await fs.writeFile(out, summarizeResults(results), 'utf8');
  process.stdout.write(`[audit] wrote ${out}\n`);
}

main().catch((err) => {
  process.stderr.write(`[audit] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
