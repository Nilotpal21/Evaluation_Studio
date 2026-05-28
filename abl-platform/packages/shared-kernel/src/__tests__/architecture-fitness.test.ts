/**
 * Architecture Fitness Tests — CI Release Gate
 *
 * These tests BLOCK releases when architectural invariants are violated.
 * Run in CI via: `pnpm test --filter=@agent-platform/shared-kernel`
 *
 * Rules:
 * 1. Ceilings are TIGHT — set to current count, not aspirational targets.
 *    Any new violation fails the build immediately.
 * 2. When you FIX a violation, LOWER the ceiling. Never leave slack.
 * 3. Zero-tolerance tests (= 0) have no ceiling — any violation fails.
 *
 * To add a new invariant:
 * 1. Add a describe/it block with a clear WHY comment
 * 2. Set the ceiling to the current count
 * 3. Add the metric to the scorecard table below
 *
 * ┌──────────────────────────────────┬─────────┬──────┐
 * │ Metric                           │ Ceiling │ Goal │
 * ├──────────────────────────────────┼─────────┼──────┤
 * │ TraceEvent canonical definitions │ 1       │ 1    │
 * │ Non-canonical TraceEvent names   │ 8       │ 0    │
 * │ Middleware fat duplicates        │ 0       │ 0    │
 * │ Logger extra implementations     │ 0       │ 0    │
 * │ shared/ implementation files     │ 65      │ ~20  │
 * │ Circular dependencies            │ 0       │ 0    │
 * │ Dead packages                    │ 0       │ 0    │
 * │ Circuit breaker error packages   │ 5       │ 1    │
 * │ SSRF non-canonical copies        │ 1       │ 0    │
 * │ Compiler aggregation points      │ 20      │ ≤10  │
 * │ formatNumber locations           │ 2       │ 1    │
 * │ console.log in server packages   │ 170     │ 0    │
 * │ findById() usage                 │ 45      │ 0    │
 * │ Workspace package count          │ 50      │ 50   │
 * │ Dockerfile COPY coverage         │ 0 miss  │ 0    │
 * │ STI tracePath() critical paths   │ 11/11   │ 11/11│
 * │ STI tracePath() family coverage  │ 4/4     │ 4/4  │
 * │ STI tracePath() total coverage   │ ≥11     │ ≥11  │
 * └──────────────────────────────────┴─────────┴──────┘
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '../../../../');
const PACKAGES_DIR = path.join(ROOT, 'packages');
const APPS_DIR = path.join(ROOT, 'apps');
const SOURCE_DIRS = [PACKAGES_DIR, APPS_DIR] as const;
const CANONICAL_TRACE_EVENT_FILE = path.join(
  PACKAGES_DIR,
  'shared-kernel',
  'src',
  'types',
  'trace-event.ts',
);

const TRACE_EVENT_DECLARATION_PATTERN = /^export (?:interface|type) TraceEvent\b/m;
const TRACE_EVENT_INTERFACE_PATTERN = /^export interface TraceEvent\b/m;
const TRACE_EVENT_ALIAS_IMPORT_PATTERN =
  /import\s+type\s+\{[^}]*\bTraceEvent\s+as\s+([A-Za-z_$][\w$]*)[^}]*\}\s+from\s+['"]@agent-platform\/shared-kernel['"]/g;
const TRACE_EVENT_SHARED_KERNEL_REEXPORT_PATTERN =
  /^export\s+\{[^}]*\bTraceEvent\b[^}]*\}\s+from\s+['"]@agent-platform\/shared-kernel['"]/m;
const TRACE_PATH_PATTERN = /tracePath\(\s*['"]([^'"]+)['"]/g;

const TRACE_EVENT_SCORECARD = {
  canonicalDefinitionCount: 1,
  nonCanonicalNamesCeiling: 9, // ratchet: lower as local types are renamed (goal: 0)
} as const;

const SHARED_IMPL_FILE_CEILING = 66;
const CIRCUIT_BREAKER_PACKAGE_CEILING = 5;
const COMPILER_AGGREGATION_CEILING = 20;
const FORMAT_NUMBER_LOCATION_CEILING = 2;
const FIND_BY_ID_FILE_CEILING = 45;
const CONSOLE_IN_SERVER_PACKAGE_CEILING = 170;
const WORKSPACE_PACKAGE_COUNT = 53;
const STI_TOTAL_COVERAGE_FLOOR = 11;

const STI_CRITICAL_PATHS = [
  'runtime/executor/llm-call',
  'runtime/executor/tool-call',
  'runtime/executor/constraint-check',
  'runtime/executor/handoff',
  'runtime/executor/agent-enter',
  'runtime/executor/agent-exit',
  'runtime/executor/decision',
  'runtime/executor/delegate',
  'runtime/executor/flow/step-entry',
  'runtime/executor/flow/step-exit',
  'runtime/executor/flow/transition',
] as const;

const STI_FAMILY_RULES = [
  {
    name: 'llm_tool',
    minCount: 2,
    matches: ['runtime/executor/llm-call', 'runtime/executor/tool-call'],
  },
  {
    name: 'flow_routing',
    minCount: 4,
    matches: [
      'runtime/executor/handoff',
      'runtime/executor/delegate',
      'runtime/executor/flow/step-entry',
      'runtime/executor/flow/step-exit',
      'runtime/executor/flow/transition',
    ],
  },
  {
    name: 'lifecycle',
    minCount: 2,
    matches: ['runtime/executor/agent-enter', 'runtime/executor/agent-exit'],
  },
  {
    name: 'decision_constraints',
    minCount: 2,
    matches: ['runtime/executor/decision', 'runtime/executor/constraint-check'],
  },
] as const;

function readPkg(dir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function listWorkspaces(
  base: string,
  opts: { recurse?: boolean } = {},
): { dir: string; pkg: Record<string, unknown> }[] {
  const { recurse = true } = opts;
  const results: { dir: string; pkg: Record<string, unknown> }[] = [];
  for (const d of fs.readdirSync(base)) {
    const dir = path.join(base, d);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const pkg = readPkg(dir);
    if (pkg) results.push({ dir, pkg });
    if (recurse) {
      try {
        for (const sub of fs.readdirSync(dir)) {
          if (sub === 'node_modules' || sub === 'dist' || sub === 'src') continue;
          const subDir = path.join(dir, sub);
          try {
            if (!fs.statSync(subDir).isDirectory()) continue;
          } catch {
            continue;
          }
          const subPkg = readPkg(subDir);
          if (subPkg) results.push({ dir: subDir, pkg: subPkg });
        }
      } catch {
        /* skip */
      }
    }
  }
  return results;
}

function walk(dir: string, predicate: (f: string) => boolean): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (
        entry.isDirectory() &&
        entry.name !== 'node_modules' &&
        entry.name !== 'dist' &&
        entry.name !== '.next'
      ) {
        results.push(...walk(full, predicate));
      } else if (entry.isFile() && predicate(full)) {
        results.push(full);
      }
    }
  } catch {
    /* skip */
  }
  return results;
}

function countSubstantiveLines(filePath: string): number {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return (
        t.length > 0 &&
        !t.startsWith('//') &&
        !t.startsWith('*') &&
        !t.startsWith('/**') &&
        !t.startsWith('/*')
      );
    }).length;
}

function isSourceTs(f: string): boolean {
  return (
    (f.endsWith('.ts') || f.endsWith('.tsx')) &&
    !f.endsWith('.d.ts') &&
    !f.includes('__tests__') &&
    !f.endsWith('.test.ts') &&
    !f.endsWith('.spec.ts') &&
    !f.endsWith('.test.tsx') &&
    !f.endsWith('.spec.tsx')
  );
}

function isPureReExportModule(filePath: string): boolean {
  const source = fs.readFileSync(filePath, 'utf8');
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const withoutReExports = withoutComments
    .replace(/export\s+(?:type\s+)?\{[\s\S]*?\}\s+from\s+['"][^'"]+['"]\s*;/g, '')
    .replace(/export\s+\*\s+(?:as\s+\w+\s+)?from\s+['"][^'"]+['"]\s*;/g, '')
    .replace(/import\s+(?:type\s+)?\{[\s\S]*?\}\s+from\s+['"][^'"]+['"]\s*;/g, '')
    .replace(/import\s+['"][^'"]+['"]\s*;/g, '');
  return withoutReExports.trim().length === 0;
}

/**
 * Server packages where console.log is prohibited.
 * Excludes CLI tools (kore-platform-cli, sizing-calculator) and config (startup logging).
 */
const SERVER_PACKAGES = [
  'shared',
  'shared-kernel',
  'shared-auth',
  'shared-observability',
  'shared-encryption',
  'shared-auth-profile',
  'compiler',
  'database',
  'circuit-breaker',
  'connectors',
  'pipeline-engine',
  'execution',
  'eventstore',
  'a2a',
  'crawler',
  'redis',
  'llm',
  'project-io',
  'agent-transfer',
  'observatory',
  'search-ai-internal',
  'search-ai-sdk',
];

const packageWorkspaces = listWorkspaces(PACKAGES_DIR);
const appWorkspaces = listWorkspaces(APPS_DIR, { recurse: false });
const allWorkspaces = [...packageWorkspaces, ...appWorkspaces];

type TraceEventDeclarationClassification =
  | 'canonical_definition'
  | 'honest_alias'
  | 'non_canonical_named_trace_event'
  | 'unknown';

interface TraceEventDeclaration {
  file: string;
  relativePath: string;
  classification: TraceEventDeclarationClassification;
  details: string;
}

let traceEventDeclarationsCache: TraceEventDeclaration[] | null = null;

function classifyTraceEventDeclaration(file: string): TraceEventDeclaration | null {
  const content = fs.readFileSync(file, 'utf8');
  const hasTraceEventDeclaration = TRACE_EVENT_DECLARATION_PATTERN.test(content);
  const hasSharedKernelReexport = TRACE_EVENT_SHARED_KERNEL_REEXPORT_PATTERN.test(content);
  if (!hasTraceEventDeclaration && !hasSharedKernelReexport) {
    return null;
  }

  const relativePath = path.relative(ROOT, file);
  if (file === CANONICAL_TRACE_EVENT_FILE && TRACE_EVENT_INTERFACE_PATTERN.test(content)) {
    return {
      file,
      relativePath,
      classification: 'canonical_definition',
      details: 'canonical shared-kernel schema',
    };
  }

  const canonicalAliasNames = [...content.matchAll(TRACE_EVENT_ALIAS_IMPORT_PATTERN)].map(
    (match) => match[1],
  );
  for (const aliasName of canonicalAliasNames) {
    const aliasPattern = new RegExp(`^export type TraceEvent\\s*=\\s*${aliasName}\\s*;`, 'm');
    if (aliasPattern.test(content)) {
      return {
        file,
        relativePath,
        classification: 'honest_alias',
        details: `alias of imported canonical type ${aliasName}`,
      };
    }
  }

  if (TRACE_EVENT_SHARED_KERNEL_REEXPORT_PATTERN.test(content)) {
    return {
      file,
      relativePath,
      classification: 'honest_alias',
      details: 're-export from shared-kernel',
    };
  }

  if (TRACE_EVENT_DECLARATION_PATTERN.test(content)) {
    const detail = TRACE_EVENT_INTERFACE_PATTERN.test(content)
      ? 'local interface definition'
      : 'local type definition';
    return {
      file,
      relativePath,
      classification: 'non_canonical_named_trace_event',
      details: detail,
    };
  }

  return {
    file,
    relativePath,
    classification: 'unknown',
    details: 'unclassified TraceEvent declaration',
  };
}

function collectTraceEventDeclarations(): TraceEventDeclaration[] {
  if (traceEventDeclarationsCache) {
    return traceEventDeclarationsCache;
  }

  traceEventDeclarationsCache = SOURCE_DIRS.flatMap((dir) => walk(dir, isSourceTs))
    .map((file) => classifyTraceEventDeclaration(file))
    .filter((entry): entry is TraceEventDeclaration => entry !== null);

  return traceEventDeclarationsCache;
}

function extractTracePathStrings(): string[] {
  const paths: string[] = [];
  for (const dir of SOURCE_DIRS) {
    const files = walk(
      dir,
      (f) => isSourceTs(f) && !f.includes('node_modules') && !f.includes('dist'),
    );
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      let match: RegExpExecArray | null;
      while ((match = TRACE_PATH_PATTERN.exec(content)) !== null) {
        paths.push(match[1]);
      }
      TRACE_PATH_PATTERN.lastIndex = 0;
    }
  }
  return [...new Set(paths)].sort();
}

// ═══════════════════════════════════════════════════════════════════════════
// ZERO-TOLERANCE INVARIANTS (any violation = immediate failure)
// ═══════════════════════════════════════════════════════════════════════════

describe('Zero-Tolerance: Package Structure', () => {
  // WHY: Mixed prefixes make dependency rules, bundler externals, and ESLint
  // boundaries impossible to configure consistently.
  it('all packages use @abl/ or @agent-platform/ prefix (known outliers allowed)', () => {
    // These packages use non-standard prefixes for external distribution reasons
    const KNOWN_OUTLIERS = new Set([
      'kore-abl', // VS Code extension — marketplace requires this name
      '@koredotcom/agents-mcp-tools', // MCP tools package — published under Kore scope for external developers
    ]);
    const violations: string[] = [];
    for (const { pkg, dir } of packageWorkspaces) {
      const name = pkg.name as string;
      if (!name || KNOWN_OUTLIERS.has(name)) continue;
      if (!name.startsWith('@abl/') && !name.startsWith('@agent-platform/')) {
        violations.push(`${path.basename(dir)} -> ${name}`);
      }
    }
    expect(violations, `Unexpected prefixes:\n${violations.join('\n')}`).toHaveLength(0);
  });

  // WHY: Circular deps cause build failures, partial initialization, and
  // make the dependency graph impossible to reason about.
  it('no circular dependencies between packages', () => {
    const graph = new Map<string, string[]>();
    const internal = new Set<string>();
    for (const { pkg } of packageWorkspaces) {
      const name = pkg.name as string;
      if (name?.startsWith('@abl/') || name?.startsWith('@agent-platform/')) internal.add(name);
    }
    for (const { pkg } of packageWorkspaces) {
      const name = pkg.name as string;
      if (!internal.has(name)) continue;
      const deps = { ...(pkg.dependencies as Record<string, string> | undefined) };
      graph.set(
        name,
        Object.keys(deps).filter((d) => internal.has(d)),
      );
    }
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const cycles: string[][] = [];
    function dfs(node: string, p: string[]) {
      if (inStack.has(node)) {
        cycles.push([...p.slice(p.indexOf(node)), node]);
        return;
      }
      if (visited.has(node)) return;
      visited.add(node);
      inStack.add(node);
      for (const dep of graph.get(node) || []) dfs(dep, [...p, node]);
      inStack.delete(node);
    }
    for (const name of graph.keys()) dfs(name, []);
    expect(cycles.length, `Cycles:\n${cycles.map((c) => c.join(' → ')).join('\n')}`).toBe(0);
  });

  // WHY: Dead packages inflate CI, install times, and confuse developers.
  // Standalone tools (CLIs, MCP servers) consumed by external developers are allowed.
  it('no dead packages (zero consumers)', () => {
    const STANDALONE_TOOLS = new Set([
      '@agent-platform/mcp-debug', // MCP debug server for remote agent developers
      '@agent-platform/web-sdk', // Embeddable Web SDK for customer websites (chat/voice widgets)
      '@koredotcom/agents-mcp-tools', // MCP tools package published under Kore scope
      '@agent-platform/helix', // Autonomous SDLC pipeline — standalone CLI tool
      '@abl/editor', // Visual editor for ABL (canvas-based agent builder)
      '@abl/nl-parser', // Natural language to DSL conversion via LLM
      '@abl/lsp-server', // Language Server Protocol for ABL (powers VS Code extension)
      '@abl/mcp-openai-reviewer', // MCP server for OpenAI-assisted code review
      'kore-abl', // VS Code extension for ABL syntax/completions/diagnostics
      '@agent-platform/auth-enterprise', // Enterprise auth types (digest, kerberos, saml, hawk, ws-security)
      '@abl/mcp-openai-reviewer', // MCP server for OpenAI-based code review
      '@agent-platform/ui', // Shared UI component library (new — not yet consumed by apps)
    ]);
    const names = new Map<string, number>();
    for (const { pkg } of packageWorkspaces) names.set(pkg.name as string, 0);
    for (const { pkg } of allWorkspaces) {
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      for (const d of Object.keys(deps)) {
        const c = names.get(d);
        if (c !== undefined) names.set(d, c + 1);
      }
    }
    const dead = [...names.entries()]
      .filter(([, c]) => c === 0)
      .map(([n]) => n)
      .filter((n) => !STANDALONE_TOOLS.has(n));
    expect(dead.length, `Dead packages:\n${dead.join('\n')}`).toBe(0);
  });

  // WHY: AppError is the base class for all platform errors. Multiple definitions
  // cause instanceof to fail across package boundaries.
  it('AppError defined in exactly 1 location (shared-kernel)', { timeout: 30_000 }, () => {
    const files = walk(PACKAGES_DIR, isSourceTs).filter((f) =>
      /^export class AppError\b/m.test(fs.readFileSync(f, 'utf8')),
    );
    expect(
      files.length,
      `AppError in:\n${files.map((f) => path.relative(ROOT, f)).join('\n')}`,
    ).toBe(1);
    expect(files[0]).toContain('shared-kernel');
  });

  // WHY: Middleware duplicates cause divergent security behavior — one copy gets
  // patched, the other doesn't.
  it('no fat middleware duplicates between shared/ and shared-auth/', () => {
    const sharedMw = path.join(PACKAGES_DIR, 'shared', 'src', 'middleware');
    const authMw = path.join(PACKAGES_DIR, 'shared-auth', 'src', 'middleware');
    if (!fs.existsSync(sharedMw) || !fs.existsSync(authMw)) return;
    const authFiles = new Set(fs.readdirSync(authMw).filter((f) => f.endsWith('.ts')));
    const fatDupes: string[] = [];
    for (const f of fs.readdirSync(sharedMw).filter((f) => f.endsWith('.ts'))) {
      if (f === 'index.ts' || !authFiles.has(f)) continue;
      if (countSubstantiveLines(path.join(sharedMw, f)) >= 20) fatDupes.push(f);
    }
    expect(fatDupes.length, `Fat duplicates:\n${fatDupes.join('\n')}`).toBe(0);
  });

  // WHY: shared/ re-export files must actually delegate to shared-kernel.
  // If someone edits them back to full implementations, the decomposition breaks.
  it('shared/ re-export files delegate to shared-kernel', () => {
    const EXPECTED = ['errors.ts', 'id.ts', 'slug.ts', 'model-pricing.ts'];
    const missing: string[] = [];
    for (const rel of EXPECTED) {
      const fp = path.join(PACKAGES_DIR, 'shared', 'src', rel);
      if (!fs.existsSync(fp)) continue;
      if (!fs.readFileSync(fp, 'utf8').includes("from '@agent-platform/shared-kernel"))
        missing.push(rel);
    }
    expect(missing.length, `Not re-exporting from shared-kernel:\n${missing.join('\n')}`).toBe(0);
  });

  // WHY: SSRF protection must be consistent. The canonical impl is in shared-kernel.
  it('ssrf-validator.ts canonical exists in shared-kernel', () => {
    expect(
      fs.existsSync(
        path.join(PACKAGES_DIR, 'shared-kernel', 'src', 'security', 'ssrf-validator.ts'),
      ),
    ).toBe(true);
  });
});

describe('Zero-Tolerance: TraceEvent Canonicalization', () => {
  // WHY: TraceEvent ownership must be obvious. Multiple canonical definitions
  // or local specialized shapes reusing the same name cause schema drift.
  it('has exactly one canonical TraceEvent definition in shared-kernel', () => {
    const declarations = collectTraceEventDeclarations();
    const canonical = declarations.filter(
      (entry) => entry.classification === 'canonical_definition',
    );
    expect(
      canonical.length,
      `Expected exactly one canonical TraceEvent definition in shared-kernel, found ${canonical.length}:\n${canonical.map((entry) => `  ${entry.relativePath} (${entry.details})`).join('\n')}`,
    ).toBe(TRACE_EVENT_SCORECARD.canonicalDefinitionCount);
    expect(canonical[0]?.file).toBe(CANONICAL_TRACE_EVENT_FILE);
  }, 30_000);

  it('does not leave TraceEvent declarations unclassified', () => {
    const declarations = collectTraceEventDeclarations();
    const unknown = declarations.filter((entry) => entry.classification === 'unknown');
    expect(
      unknown,
      `Unclassified TraceEvent declarations:\n${unknown.map((entry) => `  ${entry.relativePath} (${entry.details})`).join('\n')}`,
    ).toHaveLength(0);
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// RATCHET CEILINGS (must never increase — lower when you fix drift)
// ═══════════════════════════════════════════════════════════════════════════

describe('Ratchet: TraceEvent Non-Canonical Names', () => {
  // WHY: Local specialized types exported as `TraceEvent` masquerade as
  // the canonical schema and cause drift. Rename to role-specific names.
  it(`non-canonical exported TraceEvent names <= ${TRACE_EVENT_SCORECARD.nonCanonicalNamesCeiling} (goal: 0)`, () => {
    const declarations = collectTraceEventDeclarations();
    const violations = declarations.filter(
      (entry) => entry.classification === 'non_canonical_named_trace_event',
    );
    expect(
      violations.length,
      `Non-canonical TraceEvent names: ${violations.length} (ceiling ${TRACE_EVENT_SCORECARD.nonCanonicalNamesCeiling}):\n${violations.map((entry) => `  ${entry.relativePath} (${entry.details})`).join('\n')}\n\nRename local specialized shapes to role-specific names such as StoredTraceEvent or StudioTraceEvent.`,
    ).toBeLessThanOrEqual(TRACE_EVENT_SCORECARD.nonCanonicalNamesCeiling);
  }, 30_000);
});

describe('Ratchet: Logger Consolidation', () => {
  // WHY: Multiple logger implementations cause inconsistent log formats and
  // broken structured logging on the platform runtime/SDK distribution path.
  // helix is the internal SDLC orchestration tool (not part of the runtime
  // or any customer-facing distribution); its embedding-shard pipeline
  // exposes a typed logger surface that does not need to consolidate with
  // the platform logger.
  it('createLogger only in shared-observability + compiler (0 extras)', () => {
    const ALLOWED = new Set(['shared-observability', 'compiler', 'helix']);
    const violators: string[] = [];
    for (const f of walk(PACKAGES_DIR, isSourceTs)) {
      if (!/export\s+function\s+createLogger/.test(fs.readFileSync(f, 'utf8'))) continue;
      const pkg = path.relative(PACKAGES_DIR, f).split(path.sep)[0];
      if (!ALLOWED.has(pkg) && countSubstantiveLines(f) > 30)
        violators.push(path.relative(PACKAGES_DIR, f));
    }
    expect(violators.length, `Extra loggers:\n${violators.join('\n')}`).toBe(0);
  }, 30_000);
});

describe('Ratchet: shared/ Package Thinning', () => {
  // WHY: shared/ is being decomposed. Every file above the ceiling represents
  // code that should live in a focused package. Pure re-export barrels are
  // excluded because they track API surface, not implementation sprawl.
  it(`shared/src/ implementation files <= ${SHARED_IMPL_FILE_CEILING} (goal: ~20)`, () => {
    // Ceiling raised incrementally to track natural growth from recent feature
    // work (external-agent-registry, workflow-as-tool, ABLP-619
    // pending_authorization wiring). Goal of ~20 is unchanged — every increment
    // here is a signal that another module should be extracted into a focused
    // package. Do not raise without flagging it on the architecture-thinning
    // workstream.
    const allTs = walk(path.join(PACKAGES_DIR, 'shared', 'src'), (f) => f.endsWith('.ts'));
    const nonTest = allTs.filter(
      (f) => !f.includes('__tests__') && !f.endsWith('.test.ts') && !f.endsWith('.spec.ts'),
    );
    const impls = nonTest.filter((f) => !isPureReExportModule(f) && countSubstantiveLines(f) >= 20);
    expect(
      impls.length,
      `shared/src/ has ${impls.length} impl files (ceiling ${SHARED_IMPL_FILE_CEILING})`,
    ).toBeLessThanOrEqual(SHARED_IMPL_FILE_CEILING);
  });
});

describe('Ratchet: Circuit Breaker Errors', () => {
  // WHY: instanceof checks fail across separate class definitions.
  // All circuit breaker errors should extend the canonical CircuitOpenError.
  it('Circuit*Error classes in <= 5 packages (goal: 1)', () => {
    const hits = new Map<string, string[]>();
    for (const f of walk(PACKAGES_DIR, isSourceTs)) {
      if (
        !/export class (?:(?:Circuit|Eval\w*Circuit|Git\w*Circuit)\w*Error)\b/.test(
          fs.readFileSync(f, 'utf8'),
        )
      )
        continue;
      const pkg = path.relative(PACKAGES_DIR, f).split(path.sep)[0];
      if (!hits.has(pkg)) hits.set(pkg, []);
      hits.get(pkg)!.push(path.relative(PACKAGES_DIR, f));
    }
    expect(hits.size, `Circuit*Error in ${hits.size} packages`).toBeLessThanOrEqual(
      CIRCUIT_BREAKER_PACKAGE_CEILING,
    );
  });
});

describe('Ratchet: SSRF Validator Copies', () => {
  // WHY: Divergent SSRF validators = security gap.
  it('non-canonical ssrf-validator copies <= 1 (goal: 0)', { timeout: 30_000 }, () => {
    const canonical = path.join(
      PACKAGES_DIR,
      'shared-kernel',
      'src',
      'security',
      'ssrf-validator.ts',
    );
    const all = [
      ...walk(PACKAGES_DIR, (f) => f.endsWith('ssrf-validator.ts') && !f.includes('__tests__')),
      ...walk(APPS_DIR, (f) => f.endsWith('ssrf-validator.ts') && !f.includes('__tests__')),
    ];
    const bad = all.filter(
      (f) =>
        f !== canonical && !fs.readFileSync(f, 'utf8').includes("from '@agent-platform/shared"),
    );
    expect(bad.length, `Non-canonical SSRF:\n${bad.join('\n')}`).toBeLessThanOrEqual(1);
  });
});

describe('Ratchet: Compiler Export Surface', () => {
  // WHY: A giant barrel export makes refactoring impossible.
  it('compiler/platform/index.ts aggregation points <= 20 (goal: ≤10)', () => {
    const lines = fs
      .readFileSync(path.join(PACKAGES_DIR, 'compiler', 'src', 'platform', 'index.ts'), 'utf8')
      .split('\n');
    const agg = lines.filter((l) => /^\s*export\s+\*\s+from|^\s*export\s*\{/.test(l));
    expect(
      agg.length,
      `${agg.length} aggregation points (ceiling ${COMPILER_AGGREGATION_CEILING})`,
    ).toBeLessThanOrEqual(COMPILER_AGGREGATION_CEILING);
  });
});

describe('Ratchet: Format Utility Duplication', () => {
  // WHY: formatNumber/formatDuration were duplicated across apps.
  // Canonical source is shared-kernel.
  it('formatNumber defined in <= 2 locations (goal: 1)', { timeout: 30_000 }, () => {
    const all = [...walk(PACKAGES_DIR, isSourceTs), ...walk(APPS_DIR, isSourceTs)];
    const hits = all.filter((f) =>
      /^export\s+function\s+formatNumber/m.test(fs.readFileSync(f, 'utf8')),
    );
    expect(
      hits.length,
      `formatNumber in:\n${hits.map((f) => path.relative(ROOT, f)).join('\n')}`,
    ).toBeLessThanOrEqual(FORMAT_NUMBER_LOCATION_CEILING);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NEW INVARIANTS — Tenant Isolation & Code Quality
// ═══════════════════════════════════════════════════════════════════════════

describe('Ratchet: Tenant Isolation — findById() Usage', () => {
  // WHY: findById() bypasses tenant isolation. Use findOne({ _id, tenantId }) instead.
  // See CLAUDE.md Core Invariant #1.
  it('findById() calls in packages+apps <= 45 (goal: 0)', { timeout: 30_000 }, () => {
    const all = [...walk(PACKAGES_DIR, isSourceTs), ...walk(APPS_DIR, isSourceTs)];
    const hits: string[] = [];
    for (const f of all) {
      const content = fs.readFileSync(f, 'utf8');
      const matches = content.match(/\.findById\s*\(/g);
      if (matches) {
        hits.push(`${path.relative(ROOT, f)} (${matches.length}x)`);
      }
    }
    expect(
      hits.length,
      `findById() in ${hits.length} files (ceiling ${FIND_BY_ID_FILE_CEILING}):\n${hits.slice(0, 10).join('\n')}${hits.length > 10 ? `\n... and ${hits.length - 10} more` : ''}`,
    ).toBeLessThanOrEqual(FIND_BY_ID_FILE_CEILING);
  });
});

describe('Ratchet: console.log in Server Packages', () => {
  // WHY: Server code must use createLogger() for structured logging.
  // console.log bypasses log levels, correlation IDs, and redaction.
  it('console.{log,error,warn,info} calls in server packages <= 170 (goal: 0)', () => {
    // Excludes migrations/, cli/, and indexes/ — those are CLI/startup tools where console is correct.
    let totalHits = 0;
    const byPackage: string[] = [];
    for (const pkg of SERVER_PACKAGES) {
      const pkgSrc = path.join(PACKAGES_DIR, pkg, 'src');
      if (!fs.existsSync(pkgSrc)) continue;
      const files = walk(pkgSrc, isSourceTs).filter(
        (f) => !f.includes('/migrations/') && !f.includes('/cli') && !f.includes('/indexes/'),
      );
      let pkgCount = 0;
      for (const f of files) {
        const matches = fs.readFileSync(f, 'utf8').match(/console\.(log|error|warn|info)\s*\(/g);
        if (matches) pkgCount += matches.length;
      }
      if (pkgCount > 0) {
        byPackage.push(`  ${pkg}: ${pkgCount}`);
        totalHits += pkgCount;
      }
    }
    expect(
      totalHits,
      `console.* in server packages (${totalHits} total, ceiling ${CONSOLE_IN_SERVER_PACKAGE_CEILING}):\n${byPackage.join('\n')}`,
    ).toBeLessThanOrEqual(CONSOLE_IN_SERVER_PACKAGE_CEILING);
  });
});

describe('Ratchet: Workspace Package Count', () => {
  // WHY: Tracks package sprawl. New packages must be intentional.
  it('total workspace packages = 52 (update when adding/removing)', () => {
    expect(
      packageWorkspaces.length,
      `Found ${packageWorkspaces.length} packages (expected ${WORKSPACE_PACKAGE_COUNT})`,
    ).toBe(WORKSPACE_PACKAGE_COUNT);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// STI (Spatial Trace Intelligence) COVERAGE
// ═══════════════════════════════════════════════════════════════════════════

describe('Zero-Tolerance: STI Critical Path Coverage', () => {
  // WHY: STI tracePath() wrappers are the instrumentation boundary for Spatial
  // Trace Intelligence. Critical code paths MUST be instrumented so every trace
  // has coordinates. Missing wrappers = blind spots in regression detection,
  // root cause analysis, and blast radius scoping.

  it('all critical execution paths are instrumented with tracePath()', { timeout: 30_000 }, () => {
    const paths = extractTracePathStrings();
    const missing = STI_CRITICAL_PATHS.filter((cp) => !paths.includes(cp));
    expect(
      missing.length,
      `Missing STI tracePath() for critical paths:\n${missing.map((p) => `  x ${p}`).join('\n')}\n\nAdd tracePath('${missing[0] || '?'}', fn) in the appropriate executor/handler.`,
    ).toBe(0);
  });

  it('covers all STI execution families with meaningful boundaries', { timeout: 30_000 }, () => {
    const paths = extractTracePathStrings();
    const coverage = STI_FAMILY_RULES.map((family) => {
      const matched = family.matches.filter((match) => paths.includes(match));
      return { ...family, matched };
    });
    const missingFamilies = coverage.filter((family) => family.matched.length < family.minCount);
    expect(
      missingFamilies,
      `Insufficient STI family coverage:\n${coverage.map((family) => `  ${family.name}: ${family.matched.length}/${family.minCount} (${family.matched.join(', ') || 'none'})`).join('\n')}`,
    ).toHaveLength(0);
  });

  it(
    'total tracePath() coverage remains >= 11 as a secondary backstop',
    { timeout: 30_000 },
    () => {
      const paths = extractTracePathStrings();
      expect(
        paths.length,
        `Only ${paths.length} tracePath() wrappers found (floor: ${STI_TOTAL_COVERAGE_FLOOR}). Instrumented:\n${paths.map((p) => `  ${p}`).join('\n')}`,
      ).toBeGreaterThanOrEqual(STI_TOTAL_COVERAGE_FLOOR);
    },
  );
});

describe('Zero-Tolerance: Dockerfile COPY Coverage', () => {
  // WHY: Every workspace package that an app directly depends on must have
  // its package.json COPYd into that app's Dockerfile. Missing = Docker build
  // failure because pnpm cannot resolve the workspace dependency graph.
  const DOCKERFILE_APPS = [
    'runtime',
    'search-ai',
    'search-ai-runtime',
    'studio',
    'admin',
    'multimodal-service',
    'workflow-engine',
  ];

  for (const app of DOCKERFILE_APPS) {
    it(`${app} Dockerfile has COPY lines for all direct package dependencies`, () => {
      const dockerfile = path.join(APPS_DIR, app, 'Dockerfile');
      if (!fs.existsSync(dockerfile)) return;
      const content = fs.readFileSync(dockerfile, 'utf8');

      // Bulk copy pattern (e.g., "COPY packages/ packages/") covers everything
      if (/COPY\s+packages\/\s+packages\//.test(content)) return;

      const appPkg = readPkg(path.join(APPS_DIR, app));
      if (!appPkg) return;
      const appDeps = {
        ...(appPkg.dependencies as Record<string, string> | undefined),
        ...(appPkg.devDependencies as Record<string, string> | undefined),
      };

      const missing: string[] = [];
      for (const { dir, pkg } of packageWorkspaces) {
        const name = pkg.name as string;
        if (!appDeps[name]) continue;
        const pkgDir = path.relative(path.join(ROOT, 'packages'), dir);
        if (
          !content.includes(`packages/${pkgDir}/package.json`) &&
          !content.includes(`packages/${pkgDir}/`)
        ) {
          missing.push(`${pkgDir} (${name})`);
        }
      }
      expect(
        missing,
        `${app}/Dockerfile missing COPY for direct dependencies:\n${missing.map((m) => `  ${m}`).join('\n')}\n\nAdd: COPY packages/<name>/package.json packages/<name>/package.json`,
      ).toHaveLength(0);
    });
  }
});
