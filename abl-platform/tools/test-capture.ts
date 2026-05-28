#!/usr/bin/env npx tsx
/**
 * test-capture.ts — Run all tests once, capture structured failure reports.
 *
 * Produces per-package JSON reports in test-reports/ that can be fed to
 * aggregate-failures.ts for a single consolidated failure log.
 *
 * Usage:
 *   npx tsx tools/test-capture.ts                  # all packages, test:fast tier
 *   npx tsx tools/test-capture.ts --tier test      # full test tier (integration)
 *   npx tsx tools/test-capture.ts --filter studio   # only packages matching "studio"
 *   npx tsx tools/test-capture.ts --skip-build     # skip turbo build step
 *   npx tsx tools/test-capture.ts --parallel 4     # run up to 4 packages concurrently
 */
import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const REPORT_DIR = join(ROOT, 'test-reports');
const VITEST_TIMEOUT_MS = Number(process.env.TEST_CAPTURE_TIMEOUT_MS ?? 30 * 60 * 1000); // default 30 min per package

// ── CLI args ──────────────────────────────────────────────────────────────────

interface CliArgs {
  tier: 'test:fast' | 'test';
  filter: string | null;
  skipBuild: boolean;
  parallel: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { tier: 'test:fast', filter: null, skipBuild: false, parallel: 1 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tier' && argv[i + 1]) {
      args.tier = argv[++i] as CliArgs['tier'];
    } else if (argv[i] === '--filter' && argv[i + 1]) {
      args.filter = argv[++i];
    } else if (argv[i] === '--skip-build') {
      args.skipBuild = true;
    } else if (argv[i] === '--parallel' && argv[i + 1]) {
      args.parallel = parseInt(argv[++i], 10) || 1;
    }
  }
  return args;
}

// ── Package discovery ─────────────────────────────────────────────────────────

interface PackageEntry {
  dir: string; // relative to ROOT, e.g. "apps/studio"
  name: string; // package name, e.g. "@agent-platform/studio"
  testScript: string; // "test:fast" or "test"
}

/**
 * Parse pnpm-workspace.yaml to extract excluded package patterns (entries
 * prefixed with `!`). Packages outside the workspace don't get their deps
 * installed by pnpm, so running their tests produces import errors. Skip
 * them to match what `pnpm install` actually wires up.
 */
function loadWorkspaceExclusions(): string[] {
  const wsPath = join(ROOT, 'pnpm-workspace.yaml');
  if (!existsSync(wsPath)) return [];
  const content = readFileSync(wsPath, 'utf-8');
  const exclusions: string[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    // YAML list entry: `- '!packages/helix'` or `- "!packages/helix"` or `- !packages/helix`
    const match = line.match(/^-\s*['"]?!([^'"\s]+)['"]?\s*$/);
    if (match) exclusions.push(match[1]);
  }
  return exclusions;
}

function isExcluded(relDir: string, exclusions: string[]): boolean {
  return exclusions.some((pattern) => {
    if (pattern.endsWith('/*')) {
      const base = pattern.slice(0, -2);
      return relDir.startsWith(base + '/') && !relDir.slice(base.length + 1).includes('/');
    }
    return relDir === pattern;
  });
}

function discoverPackages(tier: string): PackageEntry[] {
  const patterns = [
    'apps/*/package.json',
    'packages/*/package.json',
    'packages/connectors/*/package.json',
  ];
  const exclusions = loadWorkspaceExclusions();
  const entries: PackageEntry[] = [];

  for (const pattern of patterns) {
    const baseDir = join(ROOT, pattern.split('*')[0]);
    if (!existsSync(baseDir)) continue;

    for (const item of readdirSync(baseDir, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const pkgPath = join(baseDir, item.name, 'package.json');
      if (!existsSync(pkgPath)) continue;

      const relDir = join(baseDir, item.name).replace(ROOT + '/', '');
      if (isExcluded(relDir, exclusions)) {
        console.log(`  (skipping ${relDir} — excluded from pnpm workspace)`);
        continue;
      }

      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const scripts = pkg.scripts || {};

      // Prefer the requested tier, fall back to 'test'
      const testScript = scripts[tier] ? tier : scripts['test'] ? 'test' : null;
      if (!testScript) continue;

      entries.push({
        dir: relDir,
        name: pkg.name,
        testScript,
      });
    }
  }

  return entries.sort((a, b) => a.dir.localeCompare(b.dir));
}

// ── Vitest config resolution ──────────────────────────────────────────────────

interface VitestRun {
  label: string;
  cwd: string;
  configFlag: string | null; // --config=... or null for default
  extraArgs: string[];
}

/**
 * Studio splits tests into light (pure logic) + unit (component shards).
 * We mirror that split here to avoid the happy-dom OOM issue.
 */
function resolveVitestRuns(entry: PackageEntry): VitestRun[] {
  const cwd = join(ROOT, entry.dir);
  const slug = entry.dir.replace(/\//g, '-');

  // Studio: split into light + unit configs (mirrors run-tests-plan.ts)
  if (entry.dir === 'apps/studio') {
    const runs: VitestRun[] = [
      {
        label: `${slug}--light`,
        cwd,
        configFlag: 'vitest.light.config.ts',
        extraArgs: [],
      },
    ];
    // Add unit config shards if the config exists
    if (existsSync(join(cwd, 'vitest.unit.config.ts'))) {
      const SHARDS = 2;
      for (let i = 1; i <= SHARDS; i++) {
        runs.push({
          label: `${slug}--unit-shard-${i}`,
          cwd,
          configFlag: 'vitest.unit.config.ts',
          extraArgs: [`--shard=${i}/${SHARDS}`],
        });
      }
    }
    if (existsSync(join(cwd, 'vitest.node.config.ts'))) {
      runs.push({
        label: `${slug}--node`,
        cwd,
        configFlag: 'vitest.node.config.ts',
        extraArgs: [],
      });
    }
    return runs;
  }

  // For other packages, check if test:fast points to a specific config
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
  const script: string = pkg.scripts?.[entry.testScript] || '';
  const configMatch = script.match(/--config\s+(\S+)/);

  return [
    {
      label: slug,
      cwd,
      configFlag: configMatch?.[1] || null,
      extraArgs:
        entry.name === '@agent-platform/shared-observability' ? ['--exclude', 'dist/**'] : [],
    },
  ];
}

// ── Runner ────────────────────────────────────────────────────────────────────

interface RunResult {
  label: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  jsonReportPath: string | null;
  durationMs: number;
}

function runVitest(run: VitestRun, reportDir: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const jsonPath = join(reportDir, `${run.label}.json`);
    const args = [
      'vitest',
      'run',
      ...(run.configFlag ? ['--config', run.configFlag] : []),
      '--reporter=json',
      '--reporter=default',
      `--outputFile.json=${jsonPath}`,
      '--passWithNoTests',
      ...run.extraArgs,
    ];

    const start = Date.now();
    const child = spawn('npx', args, {
      cwd: run.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      timeout: VITEST_TIMEOUT_MS,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      process.stdout.write(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      process.stderr.write(d);
    });

    child.on('close', (code, signal) => {
      const timedOut =
        signal === 'SIGTERM' && Date.now() - start >= Math.max(0, VITEST_TIMEOUT_MS - 1000);
      resolve({
        label: run.label,
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        jsonReportPath: existsSync(jsonPath) ? jsonPath : null,
        durationMs: Date.now() - start,
      });
    });

    child.on('error', (err) => {
      const timedOut = 'code' in err && (err as NodeJS.ErrnoException).code === 'ETIMEDOUT';
      resolve({
        label: run.label,
        exitCode: null,
        signal: null,
        timedOut,
        jsonReportPath: existsSync(jsonPath) ? jsonPath : null,
        durationMs: Date.now() - start,
      });
    });
  });
}

async function runBatch(
  runs: VitestRun[],
  reportDir: string,
  concurrency: number,
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  const queue = [...runs];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const run = queue.shift()!;
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`▶ ${run.label}`);
      console.log(`${'═'.repeat(60)}\n`);
      const result = await runVitest(run, reportDir);

      const status = result.exitCode === 0 ? '✓ PASS' : result.timedOut ? '⏱ TIMEOUT' : '✗ FAIL';
      console.log(`\n${status} ${run.label} (${(result.durationMs / 1000).toFixed(1)}s)\n`);
      results.push(result);
    }
  }

  // Run workers concurrently
  const workers = Array.from({ length: Math.min(concurrency, runs.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Summary ───────────────────────────────────────────────────────────────────

function writeSummary(results: RunResult[], reportDir: string): void {
  const passed = results.filter((r) => r.exitCode === 0);
  const failed = results.filter((r) => r.exitCode !== 0 && !r.timedOut);
  const timedOut = results.filter((r) => r.timedOut);

  const summary = {
    timestamp: new Date().toISOString(),
    totalPackages: results.length,
    passed: passed.length,
    failed: failed.length,
    timedOut: timedOut.length,
    totalDurationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
    results: results.map((r) => ({
      label: r.label,
      status: r.exitCode === 0 ? 'pass' : r.timedOut ? 'timeout' : 'fail',
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      hasJsonReport: r.jsonReportPath !== null,
    })),
  };

  writeFileSync(join(reportDir, 'run-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nRun summary written to test-reports/run-summary.json`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Prepare report directory
  mkdirSync(REPORT_DIR, { recursive: true });

  // Build first (unless skipped)
  if (!args.skipBuild) {
    console.log('\n🔨 Building packages (turbo build)...\n');
    try {
      execSync('pnpm turbo build --continue', {
        cwd: ROOT,
        stdio: 'inherit',
        timeout: 10 * 60 * 1000,
      });
    } catch {
      console.warn('\n⚠ Build had errors — continuing with test capture anyway.\n');
    }
  }

  // Discover packages
  let packages = discoverPackages(args.tier);
  if (args.filter) {
    const f = args.filter.toLowerCase();
    packages = packages.filter(
      (p) => p.dir.toLowerCase().includes(f) || p.name.toLowerCase().includes(f),
    );
  }

  if (packages.length === 0) {
    console.log('No packages matched. Exiting.');
    process.exit(0);
  }

  console.log(`\nDiscovered ${packages.length} packages for tier "${args.tier}":`);
  for (const p of packages) {
    console.log(`  ${p.dir} (${p.name})`);
  }

  // Resolve vitest runs (handles Studio split, etc.)
  const allRuns: VitestRun[] = [];
  for (const pkg of packages) {
    allRuns.push(...resolveVitestRuns(pkg));
  }

  console.log(`\n${allRuns.length} vitest runs to execute:\n`);
  for (const r of allRuns) {
    console.log(`  ${r.label}${r.configFlag ? ` (${r.configFlag})` : ''}`);
  }

  // Execute
  const results = await runBatch(allRuns, REPORT_DIR, args.parallel);

  // Write run summary
  writeSummary(results, REPORT_DIR);

  // Run aggregation
  console.log('\nAggregating failure reports...\n');
  try {
    execSync('npx tsx tools/aggregate-failures.ts', { cwd: ROOT, stdio: 'inherit' });
  } catch {
    console.error('Aggregation script failed — check test-reports/ for raw JSON files.');
  }

  // Exit code reflects test results
  const anyFailed = results.some((r) => r.exitCode !== 0);
  process.exit(anyFailed ? 1 : 0);
}

main();
