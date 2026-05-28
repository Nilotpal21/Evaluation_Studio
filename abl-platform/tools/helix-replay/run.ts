#!/usr/bin/env npx tsx

import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  bootstrapWorktree,
  buildRunId,
  clearActiveReplayProcess,
  checkReplayModelEndpointReachability,
  computeComparison,
  defaultReplayWorktreeDir,
  ensureDir,
  ensureHelixBuild,
  findLatestSessionSummary,
  prepareDetachedWorktree,
  readScenario,
  removeWorktree,
  resolveScenarioGitRefs,
  stopExistingReplayProcess,
  summarizeRun,
  writeActiveReplayProcess,
  writeJson,
  writeText,
} from './shared.js';
import type { ReplayHelixCommand, ReplayRunRecord, ReplayScenario } from './types.js';

interface CliOptions {
  scenarioPath: string;
  sourceRepo: string;
  worktreeDir?: string;
  budgetUsd: number;
  keepWorktree: boolean;
  skipBootstrap: boolean;
  skipHelixBuild: boolean;
  autoApprove: boolean;
  autoCommit: boolean;
  verbose: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const sourceRepo = resolve(options.sourceRepo);
  const scenario = await resolveScenarioGitRefs(
    sourceRepo,
    await readScenario(options.scenarioPath),
  );
  const runId = buildRunId();
  const replayRoot = join(sourceRepo, '.helix', 'replays');
  const runDir = join(replayRoot, 'runs', scenario.id, runId);
  const worktreeDir = options.worktreeDir
    ? resolve(options.worktreeDir)
    : defaultReplayWorktreeDir(sourceRepo, scenario.id, runId);

  await ensureDir(runDir);
  await writeJson(join(runDir, 'scenario.json'), scenario);

  if (!options.skipHelixBuild) {
    process.stdout.write('Building current HELIX CLI...\n');
    await ensureHelixBuild(sourceRepo);
  }

  process.stdout.write(`Preparing replay worktree at ${worktreeDir}\n`);
  await stopExistingReplayProcess(worktreeDir);
  await prepareDetachedWorktree(sourceRepo, worktreeDir, scenario.baseCommit);

  try {
    const preflightError = await checkReplayModelEndpointReachability();
    if (preflightError) {
      const record: ReplayRunRecord = {
        version: 1,
        runId,
        scenarioId: scenario.id,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        sourceRepo,
        worktreeDir,
        runDir,
        helixCommand: scenario.helixCommand,
        helixArgs: [],
        exitCode: 69,
        preflightError,
        comparison: await computeComparison(sourceRepo, worktreeDir, scenario),
      };
      await writeJson(join(runDir, 'result.json'), record);
      await writeText(join(runDir, 'summary.txt'), summarizeRun(record) + '\n');
      process.stdout.write(`${preflightError}\n`);
      process.stdout.write(`Replay result: ${summarizeRun(record)}\n`);
      process.stdout.write(`Artifacts: ${runDir}\n`);
      process.stdout.write(`Worktree: ${worktreeDir}\n`);
      return;
    }

    if (!options.skipBootstrap) {
      process.stdout.write(
        'Bootstrapping replay worktree with pnpm install --frozen-lockfile...\n',
      );
      await bootstrapWorktree(worktreeDir);
    }

    const helixArgs = buildHelixArgs(scenario, options);
    const helixCli = join(sourceRepo, 'packages', 'helix', 'dist', 'cli.js');
    const stdoutPath = join(runDir, 'helix.stdout.log');
    const stderrPath = join(runDir, 'helix.stderr.log');

    process.stdout.write(`Launching HELIX replay: node ${helixCli} ${helixArgs.join(' ')}\n`);
    const startedAt = new Date().toISOString();
    const exitCode = await runHelixProcess({
      helixCli,
      helixArgs,
      scenario,
      sourceRepo,
      worktreeDir,
      stdoutPath,
      stderrPath,
    });
    const session = await findLatestSessionSummary(worktreeDir);
    const comparison = await computeComparison(sourceRepo, worktreeDir, scenario);
    const record: ReplayRunRecord = {
      version: 1,
      runId,
      scenarioId: scenario.id,
      startedAt,
      completedAt: new Date().toISOString(),
      sourceRepo,
      worktreeDir,
      runDir,
      helixCommand: scenario.helixCommand,
      helixArgs,
      exitCode,
      session,
      comparison,
    };
    await writeJson(join(runDir, 'result.json'), record);
    await writeText(join(runDir, 'summary.txt'), summarizeRun(record) + '\n');

    process.stdout.write(`Replay result: ${summarizeRun(record)}\n`);
    process.stdout.write(`Artifacts: ${runDir}\n`);
    process.stdout.write(`Worktree: ${worktreeDir}\n`);
  } finally {
    if (!options.keepWorktree) {
      process.stdout.write(`Removing replay worktree ${worktreeDir}\n`);
      await removeWorktree(sourceRepo, worktreeDir);
    }
  }
}

function buildHelixArgs(scenario: ReplayScenario, options: CliOptions): string[] {
  const args: string[] = [scenario.helixCommand, scenario.summary];

  if (scenario.description) {
    args.push('--description', scenario.description);
  }
  if (scenario.scope.length > 0) {
    args.push('--scope', scenario.scope.join(','));
  }
  if (scenario.featureSpec) {
    args.push('--spec', scenario.featureSpec);
  }
  if (scenario.testSpec) {
    args.push('--test-spec', scenario.testSpec);
  }
  if (scenario.hldSpec) {
    args.push('--hld', scenario.hldSpec);
  }
  if (scenario.lldPlan) {
    args.push('--lld', scenario.lldPlan);
  }
  if (scenario.jiraKey) {
    args.push('--jira', scenario.jiraKey);
  }
  args.push('--budget', String(options.budgetUsd));
  if (options.autoApprove) {
    args.push('--auto-approve');
  }
  if (options.autoCommit) {
    args.push('--auto-commit');
  }
  if (options.verbose) {
    args.push('--verbose');
  }

  return args;
}

const REPLAY_SEAM_PACKET_LIMIT = 6;
const REPLAY_SEAM_PACKET_MAX_LINES = 220;

function buildReplayLiveContext(scenario: ReplayScenario, worktreeDir: string): Promise<string[]> {
  return buildReplayLiveContextInternal(scenario, worktreeDir);
}

async function buildReplayLiveContextInternal(
  scenario: ReplayScenario,
  worktreeDir: string,
): Promise<string[]> {
  const guidance: string[] = [
    `Replay workspace root: ${worktreeDir}. Resolve all replay file paths relative to this worktree and perform reads/edits here. If a source-checkout path appears anywhere, treat it as reference-only and continue in the replay worktree.`,
    `Replay guidance for ${scenario.jiraKey}: bias toward the smallest patch that satisfies the bug report and stop widening once the described seam is explained.`,
    'Replay discipline: do not read AGENTS.md, agents.md, CLAUDE.md, or package learning journals during replay. Start with the historical seam and the nearest scoped regression target before any repo-wide searches.',
  ];

  if (scenario.notes && scenario.notes.length > 0) {
    guidance.push(`Scenario notes: ${scenario.notes.join(' ')}`);
  }

  if (scenario.changedFiles.length > 0) {
    guidance.push(
      `Historical narrow seam candidates for this replay: ${scenario.changedFiles.join(', ')}. Start with these files before generic repo-wide searches, and justify any broader exploration.`,
    );
    guidance.push(
      'Before broad test discovery, prefer one nearby regression target that is adjacent to the historical seam. Only widen beyond that first candidate if the local test surface clearly cannot express the bug.',
    );
  }

  if (scenario.historicalFileHints && Object.keys(scenario.historicalFileHints).length > 0) {
    const hintLines = Object.entries(scenario.historicalFileHints)
      .map(([futurePath, existingPaths]) => `- ${futurePath} -> ${existingPaths.join(', ')}`)
      .join('\n');
    guidance.push(`Historical file substitutions for replay-only future targets:\n${hintLines}`);
  }

  if (scenario.avoidPaths && scenario.avoidPaths.length > 0) {
    guidance.push(
      `Replay out-of-bounds paths: ${scenario.avoidPaths.join(', ')}. Do not inspect these unless the already-read historical seam directly proves one is required for correctness.`,
    );
  }

  const seamPacket = await buildReplaySeamPacket(scenario, worktreeDir);
  if (seamPacket) {
    guidance.push(seamPacket);
  }

  return guidance;
}

async function buildReplaySeamPacket(
  scenario: ReplayScenario,
  worktreeDir: string,
): Promise<string | undefined> {
  const candidateFiles: string[] = [];
  const seen = new Set<string>();

  const pushCandidate = (filePath: string): void => {
    if (!filePath || seen.has(filePath)) {
      return;
    }
    seen.add(filePath);
    candidateFiles.push(filePath);
  };

  for (const filePath of scenario.changedFiles) {
    pushCandidate(filePath);
  }
  for (const substitutePaths of Object.values(scenario.historicalFileHints ?? {})) {
    for (const filePath of substitutePaths) {
      pushCandidate(filePath);
    }
  }

  const packetEntries: string[] = [];
  for (const relativePath of candidateFiles) {
    const absolutePath = join(worktreeDir, relativePath);
    try {
      const content = await readFile(absolutePath, 'utf8');
      const limitedContent = content.split('\n').slice(0, REPLAY_SEAM_PACKET_MAX_LINES).join('\n');
      packetEntries.push(`### ${relativePath}\n\`\`\`\n${limitedContent}\n\`\`\``);
      if (packetEntries.length >= REPLAY_SEAM_PACKET_LIMIT) {
        break;
      }
    } catch {
      // Missing future target at the replay base commit; ignore here.
    }
  }

  if (packetEntries.length === 0) {
    return undefined;
  }

  return `Replay seam packet — use these historical files before any repo-wide search:\n\n${packetEntries.join(
    '\n\n',
  )}`;
}

async function runHelixProcess(input: {
  helixCli: string;
  helixArgs: string[];
  scenario: ReplayScenario;
  sourceRepo: string;
  worktreeDir: string;
  stdoutPath: string;
  stderrPath: string;
}): Promise<number | null> {
  const { appendFile } = await import('node:fs/promises');
  const initialLiveContext = await buildReplayLiveContext(input.scenario, input.worktreeDir);
  const replayCodexHome = await prepareReplayCodexHome(input.worktreeDir);

  return await new Promise<number | null>((resolvePromise, reject) => {
    const child = spawn('node', [input.helixCli, ...input.helixArgs], {
      cwd: input.worktreeDir,
      env: {
        ...process.env,
        CODEX_HOME: replayCodexHome,
        JIRA_BASE_URL: 'replay-disabled',
        JIRA_EMAIL: 'replay-disabled',
        JIRA_API_TOKEN: 'replay-disabled',
        HELIX_SOURCE_WORKDIR: input.sourceRepo,
        HELIX_WORKTREE_DIR: input.worktreeDir,
        HELIX_REPLAY_CONTEXT_JSON: JSON.stringify({
          changedFiles: input.scenario.changedFiles,
          historicalFileHints: input.scenario.historicalFileHints,
          avoidPaths: input.scenario.avoidPaths,
          tags: input.scenario.tags ?? [],
        }),
        HELIX_INITIAL_LIVE_CONTEXT_JSON: JSON.stringify(initialLiveContext),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (child.pid != null) {
      void writeActiveReplayProcess(input.worktreeDir, {
        pid: child.pid,
        scenarioId: input.scenario.id,
        startedAt: new Date().toISOString(),
      });
    }

    child.stdout.on('data', async (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      await appendFile(input.stdoutPath, text, 'utf8');
    });
    child.stderr.on('data', async (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(text);
      await appendFile(input.stderrPath, text, 'utf8');
    });

    child.on('error', (error) => {
      void clearActiveReplayProcess(input.worktreeDir, child.pid ?? undefined);
      reject(error);
    });
    child.on('close', (code) => {
      void clearActiveReplayProcess(input.worktreeDir, child.pid ?? undefined);
      resolvePromise(code);
    });
  });
}

async function prepareReplayCodexHome(worktreeDir: string): Promise<string> {
  const codexHome = join(worktreeDir, '.helix', 'runtime-home', '.codex');
  const sourceCodexHome = join(process.env.HOME ?? '', '.codex');

  await mkdir(codexHome, { recursive: true });
  await copyIfPresent(join(sourceCodexHome, 'auth.json'), join(codexHome, 'auth.json'));
  await copyIfPresent(join(sourceCodexHome, 'installation_id'), join(codexHome, 'installation_id'));

  return codexHome;
}

async function copyIfPresent(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await access(sourcePath);
  } catch {
    return;
  }
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    scenarioPath: '',
    sourceRepo: process.cwd(),
    worktreeDir: undefined,
    budgetUsd: 1000,
    keepWorktree: true,
    skipBootstrap: false,
    skipHelixBuild: false,
    autoApprove: true,
    autoCommit: true,
    verbose: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--scenario':
        options.scenarioPath = requireValue(argv, ++index, arg);
        break;
      case '--source-repo':
        options.sourceRepo = requireValue(argv, ++index, arg);
        break;
      case '--worktree-dir':
        options.worktreeDir = requireValue(argv, ++index, arg);
        break;
      case '--budget':
        options.budgetUsd = Number.parseFloat(requireValue(argv, ++index, arg));
        break;
      case '--no-keep-worktree':
        options.keepWorktree = false;
        break;
      case '--skip-bootstrap':
        options.skipBootstrap = true;
        break;
      case '--skip-helix-build':
        options.skipHelixBuild = true;
        break;
      case '--no-auto-approve':
        options.autoApprove = false;
        break;
      case '--no-auto-commit':
        options.autoCommit = false;
        break;
      case '--quiet':
        options.verbose = false;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.scenarioPath) {
    throw new Error('A replay scenario path is required via --scenario');
  }

  return options;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printUsage(): void {
  process.stdout.write(`HELIX replay runner

Usage:
  pnpm exec tsx tools/helix-replay/run.ts --scenario <path> [options]

Options:
  --source-repo <path>      Source repo root (default: cwd)
  --worktree-dir <path>     Override detached replay worktree path
  --budget <usd>            HELIX budget for the run (default: 1000)
  --no-keep-worktree        Remove the replay worktree after the run
  --skip-bootstrap          Skip pnpm install in the replay worktree
  --skip-helix-build        Skip rebuilding the current HELIX CLI before launch
  --no-auto-approve         Keep HELIX questions/checkpoints manual
  --no-auto-commit          Require explicit commit checkpoints inside the replay worktree
  --quiet                   Disable --verbose when invoking HELIX
`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
