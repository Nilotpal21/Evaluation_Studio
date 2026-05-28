#!/usr/bin/env node

import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
import { loadHelixEnvFromDotEnv } from './env-loader.js';

// ── Load explicit HELIX env keys from .env (read-only, no `source`) ──
loadHelixEnvFromDotEnv();

import { ModelRouter } from './models/model-router.js';
import { parseFlags } from './cli-args.js';
import {
  buildJiraAssigneeWorkflowPlan,
  buildJiraIssueModelTriagePayload,
  buildJiraIssueModelTriagePrompt,
  buildSimpleIssueHelixCommand,
  parseJiraIssueModelDecisions,
  renderJiraAssigneeWorkflowReport,
  type JiraIssueModelDecision,
} from './integrations/jira-assignee-workflow.js';
import { createRealDriftJiraClient } from './integrations/drift-jira-adapter.js';
import { runDriftSync, type DriftSyncIo } from './integrations/drift-sync-command.js';
import { getIssue, searchAssignedIssues } from './integrations/jira-client.js';
import {
  enumerateWorkspacePackages,
  formatBootstrapFailureLine,
  formatBootstrapSuccessLine,
  isRealJiraKey,
  mapJiraIssueToWorkItem,
  type BootstrapResult,
  type CliOverrides,
} from './integrations/jira-bootstrap.js';
import { createLlmInputClassifier } from './interactive/input-classifier.js';
import { InteractiveReporter } from './interactive/interactive-reporter.js';
import { SessionRepl } from './interactive/session-repl.js';
import { createCanaryPipeline } from './pipeline/canary-pipeline.js';
import { PipelineEngine } from './pipeline/pipeline-engine.js';
import { parseAnalysisOutput } from './pipeline/stage-output-parsers.js';
import { buildStageOutputInstructions } from './pipeline/stage-output-schema.js';
import {
  findPipelineByName,
  selectPipeline,
  selectPipelineForWorkItem,
  listPipelines,
} from './pipeline/templates/index.js';
import { formatReadinessSummary, runHelixDoctor } from './readiness/doctor.js';
import { buildRuntimeReadinessPolicy } from './readiness/runtime-policy.js';
import { rebuildEmbeddingIndex } from './intelligence/helix-indexer.js';
import {
  applyStageMaxTurnsOverrides,
  parseStageMaxTurnsFlag,
} from './pipeline/stage-max-turns-override.js';
import { applyCheapImplementerOverride } from './pipeline/cheap-implementer-override.js';
import {
  ensureVerificationBootstrap,
  formatVerificationBootstrapSummary,
} from './pipeline/verification-bootstrap.js';
import {
  buildDefaultEmbeddingProviderConfig,
  buildDefaultHelixMcpServers,
  DEFAULT_ENABLE_DUELING_PLANNERS,
  DEFAULT_HELIX_EMBEDDINGS_ENABLED,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_STAGE_MODEL_POLICY,
  DEFAULT_USE_OPENAI_ARCHITECTURE_ORACLE,
  isHelixEmbeddingsEnabled,
} from './runtime-config.js';
import {
  buildSessionWatchSignature,
  DEFAULT_WATCH_LINES,
  DEFAULT_WATCH_POLL_MS,
  DEFAULT_WATCH_STALE_AFTER_MS,
  formatSessionWatchSummary,
  isSessionHeartbeatStale,
} from './session-watch.js';
import {
  buildPipelineVersion,
  SessionManager,
  snapshotPipelineTemplate,
} from './session/session-manager.js';
import {
  loadManagedSessionFromConfigs,
  resolveResumePipeline,
} from './session/session-resolution.js';
import type {
  BootstrapMeta,
  HelixConfig,
  Session,
  SessionState,
  StageOutputSchemaId,
  WorkItem,
  WorkspaceExecutionContext,
} from './types.js';
import { CanaryProgressReporter } from './ui/canary-progress-reporter.js';
import { CompositeReporter } from './ui/composite-reporter.js';
import { FileProgressLogger } from './ui/file-progress-logger.js';
import { TerminalProgressReporter } from './ui/progress-reporter.js';
import { captureWorkspaceGitSnapshot } from './workspace-baseline.js';
import {
  listWorktreeLaunchRecords,
  loadWorktreeLaunchRecord,
  prepareWorktreeExecution,
  type WorktreeLaunchCommand,
  type WorktreeLaunchRecord,
  updateWorktreeLaunchRecord,
  writeWorktreeLaunchRecord,
} from './worktree-manager.js';
import {
  resolveCliWorkspaceContext,
  resolveHelixFeatureFlags,
  resolveInitialLiveContext,
  resolveReplayContext,
} from './workspace-context.js';

// ── Output helpers (no console.log — server code rule) ────────

function out(msg: string): void {
  process.stdout.write(msg + '\n');
}

function err(msg: string): void {
  process.stderr.write(msg + '\n');
}

// ── CLI Argument Parsing ──────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === '--help' || command === '-h') {
  printUsage();
  process.exit(0);
}

// Parse flags
const parsed = parseFlags(args.slice(1));
const flag = (name: string): string | undefined => parsed.flags[name];

// ── Configuration ─────────────────────────────────────────────

const HELIX_STATE_DIR = '.helix';
const DEFAULT_SCOPE = 'packages/helix/src';
const DEFAULT_CANARY_TITLE = 'HELIX canary audit';

const invocationDir = resolve(process.cwd());
const requestedWorkDir = resolve(flag('--workdir') ?? invocationDir);
const baseConfig = buildHelixConfig(requestedWorkDir, {
  invocationDir,
  workspaceContext: resolveCliWorkspaceContext(requestedWorkDir),
});

// ── Command Dispatch ──────────────────────────────────────────

switch (command) {
  case 'audit':
    await runAudit();
    break;
  case 'fix':
    await runFix();
    break;
  case 'resume':
    await runResume();
    break;
  case 'smoke':
    await runSmoke();
    break;
  case 'canary':
    await runCanary();
    break;
  case 'status':
    await runStatus();
    break;
  case 'doctor':
    await runDoctor();
    break;
  case 'list':
    await runList();
    break;
  case 'logs':
    await runLogs();
    break;
  case 'watch':
    await runWatch();
    break;
  case 'pipelines':
    runPipelines();
    break;
  case 'index':
    await runIndex();
    break;
  case 'drift':
    await runDriftCommand();
    break;
  case 'jira':
    await runJiraCommand();
    break;
  case 'bootstrap':
    await runBootstrap();
    break;
  case 'review-branch':
    await runReviewBranch();
    break;
  default:
    err(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}

// ── Command Implementations ───────────────────────────────────

/**
 * Detect a Jira-key positional argument and bootstrap a `WorkItem` partial +
 * `BootstrapMeta` from the Jira ticket. Private helper used by `runAudit`,
 * `runFix`, and `runCanary`.
 *
 * Behavior:
 * - If `positional` matches `isRealJiraKey`, treat it as the Jira key.
 * - Else if `--jira <key>` is supplied and matches `isRealJiraKey`, use that.
 * - Else returns `{ partialWorkItem: {}, bootstrapMeta: undefined }` —
 *   pre-feature behavior preserved.
 *
 * `cliOverrides` come from explicit `--title` / `--description` / `--scope`
 * flags. They short-circuit the corresponding Jira-derived value via
 * `mapJiraIssueToWorkItem`. When `cliOverrides.scope` is non-empty, the
 * scope-inference branch is skipped entirely (locked contract: see test
 * spec E2E-7 and LLD task 1.2).
 */
async function bootstrapWorkItemFromCli(
  positional: string | undefined,
  cliOverrides: CliOverrides,
  workDir: string,
  jiraFlag: string | undefined,
): Promise<{
  partial: BootstrapResult['partialWorkItem'] | Record<string, never>;
  bootstrapMeta: BootstrapMeta | undefined;
  jiraKey: string | undefined;
}> {
  // Decide which value (if any) is the Jira key.
  let jiraKey: string | undefined;
  if (isRealJiraKey(positional)) {
    jiraKey = positional;
  } else if (isRealJiraKey(jiraFlag)) {
    jiraKey = jiraFlag;
  }

  if (!jiraKey) {
    return { partial: {}, bootstrapMeta: undefined, jiraKey: undefined };
  }

  // Fetch + map.
  const startedAt = Date.now();
  let issue: Awaited<ReturnType<typeof getIssue>> = null;
  let fallbackReason: BootstrapMeta['fallbackReason'];
  try {
    issue = await getIssue(jiraKey);
    if (issue === null) {
      // jira-client.ts already logged the specific failure; we infer the
      // bucket from env presence so bootstrapMeta carries a useful reason.
      const credsConfigured =
        Boolean(process.env['JIRA_EMAIL']) &&
        Boolean(process.env['JIRA_API_TOKEN'] || process.env['ATLASSIAN_API_KEY']) &&
        Boolean(process.env['JIRA_BASE_URL'] || process.env['ATLASSIAN_BASE_URL']);
      fallbackReason = credsConfigured ? 'auth-failed' : 'credentials-missing';
    }
  } catch {
    // jiraFetch swallows most errors and returns null via getIssue, but guard anyway.
    fallbackReason = 'network-error';
  }
  const fetchLatencyMs = Date.now() - startedAt;

  const workspacePackages = await enumerateWorkspacePackages(workDir);
  const result = mapJiraIssueToWorkItem(
    issue,
    jiraKey,
    cliOverrides,
    workspacePackages,
    fetchLatencyMs,
    fallbackReason,
  );

  // Single stderr line summarizing the bootstrap outcome.
  if (issue) {
    err(
      formatBootstrapSuccessLine(
        jiraKey,
        fetchLatencyMs,
        issue.summary?.length ?? 0,
        issue.descriptionText?.length ?? 0,
        result.bootstrapMeta.inferredScope,
      ),
    );
  } else {
    err(formatBootstrapFailureLine(jiraKey, fallbackReason ?? 'not-found'));
  }

  return {
    partial: result.partialWorkItem,
    bootstrapMeta: result.bootstrapMeta,
    jiraKey,
  };
}

async function runAudit(): Promise<void> {
  if (flag('--concerns') === 'true') {
    await runConcernsScan();
    return;
  }

  if (flag('--template') === 'drift-audit') {
    await runDriftAudit();
    return;
  }

  const positional = parsed.positional[0];
  // If positional looks like a Jira key, the title is filled from the ticket;
  // otherwise the user must supply a title positionally.
  if (!positional) {
    err(
      'Usage: helix audit <ABLP-KEY|"feature title"> [--scope <packages>] [--jira <key>] [--spec <path>] [--test-spec <path>] [--hld <path>] [--lld <path>]\n' +
        '       helix audit --concerns [--only <ids>] [--tier blocking|advisory] [--no-write]\n' +
        '       helix audit --template drift-audit [--scope <packages>] [--only <ids>] [--tier blocking|advisory]',
    );
    process.exit(1);
  }

  const cliOverrides: CliOverrides = buildCliOverridesFromFlags(positional);
  const bootstrap = await bootstrapWorkItemFromCli(
    positional,
    cliOverrides,
    baseConfig.workDir,
    flag('--jira'),
  );

  const title =
    bootstrap.partial.title ??
    cliOverrides.title ??
    (bootstrap.jiraKey ? bootstrap.jiraKey : positional);
  const description = bootstrap.partial.description ?? cliOverrides.description ?? title;
  const scope =
    bootstrap.partial.scope ??
    cliOverrides.scope ??
    (flag('--scope') ?? '').split(',').filter(Boolean);

  const workItem: WorkItem = {
    id: randomUUID().slice(0, 8),
    type: 'feature-audit',
    title,
    description,
    scope,
    jiraKey: bootstrap.jiraKey ?? flag('--jira'),
    featureSpec: flag('--spec'),
    testSpec: flag('--test-spec'),
    hldSpec: flag('--hld'),
    lldPlan: flag('--lld'),
    targetBranch: flag('--branch') ?? 'current',
    createdAt: new Date().toISOString(),
  };

  await runPipeline(workItem, { bootstrapMeta: bootstrap.bootstrapMeta });
}

async function runFix(): Promise<void> {
  const positional = parsed.positional[0];
  if (!positional) {
    err(
      'Usage: helix fix <ABLP-KEY|"bug description"> [--jira <key>] [--scope <packages>] [--spec <path>] [--test-spec <path>] [--hld <path>] [--lld <path>]',
    );
    process.exit(1);
  }

  const cliOverrides: CliOverrides = buildCliOverridesFromFlags(positional);
  const bootstrap = await bootstrapWorkItemFromCli(
    positional,
    cliOverrides,
    baseConfig.workDir,
    flag('--jira'),
  );

  const title =
    bootstrap.partial.title ??
    cliOverrides.title ??
    (bootstrap.jiraKey ? bootstrap.jiraKey : positional);
  const description = bootstrap.partial.description ?? cliOverrides.description ?? title;
  const scope =
    bootstrap.partial.scope ??
    cliOverrides.scope ??
    (flag('--scope') ?? '').split(',').filter(Boolean);

  const workItem: WorkItem = {
    id: randomUUID().slice(0, 8),
    type: 'bug-fix',
    title,
    description,
    scope,
    jiraKey: bootstrap.jiraKey ?? flag('--jira'),
    featureSpec: flag('--spec'),
    testSpec: flag('--test-spec'),
    hldSpec: flag('--hld'),
    lldPlan: flag('--lld'),
    targetBranch: flag('--branch') ?? 'current',
    createdAt: new Date().toISOString(),
  };

  await runPipeline(workItem, { bootstrapMeta: bootstrap.bootstrapMeta });
}

/**
 * Build a `CliOverrides` from the current flags. When `positional` is a Jira
 * key, no implicit title override is created (the Jira summary fills title).
 * When `positional` is a free-form title, it counts as an explicit title
 * override.
 */
function buildCliOverridesFromFlags(positional: string): CliOverrides {
  const explicitDescription = flag('--description');
  const explicitScopeRaw = flag('--scope');
  const explicitScope =
    explicitScopeRaw === undefined ? undefined : explicitScopeRaw.split(',').filter(Boolean);

  const overrides: CliOverrides = {};
  if (explicitDescription !== undefined) {
    overrides.description = explicitDescription;
  }
  if (explicitScope !== undefined && explicitScope.length > 0) {
    overrides.scope = explicitScope;
  }
  // Positional that is NOT a Jira key counts as an explicit title.
  if (!isRealJiraKey(positional)) {
    overrides.title = positional;
  }
  return overrides;
}

async function runResume(): Promise<void> {
  const sessionId = parsed.positional[0];
  if (!sessionId) {
    err('Usage: helix resume <session-id>');
    process.exit(1);
  }

  try {
    const resolvedSession = await resolveManagedSessionConfig(sessionId);
    const session = resolvedSession.session;
    const selectedPipeline = resolveResumePipeline(session, selectPipeline);
    const runtimeReadiness = await resolveRuntimeReadinessPolicy(
      selectedPipeline,
      resolvedSession.config,
    );
    const effectiveConfig = runtimeReadiness?.effectiveConfig ?? resolvedSession.config;
    const sessionManager = new SessionManager(effectiveConfig);
    const effectivePipelineSnapshot = snapshotPipelineTemplate(
      runtimeReadiness?.effectivePipeline ?? selectedPipeline,
    );
    const effectivePipelineVersion = buildPipelineVersion(effectivePipelineSnapshot);
    if (session.pipelineVersion !== effectivePipelineVersion) {
      session.pipelineName = effectivePipelineSnapshot.name;
      session.pipelineVersion = effectivePipelineVersion;
      session.pipelineSnapshot = effectivePipelineSnapshot;
      await sessionManager.persist(session);
    }
    const interactive = flag('--interactive') === 'true' || flag('-i') === 'true';
    const fileLogger = new FileProgressLogger(effectiveConfig.sessionDir, sessionId);
    let repl: SessionRepl | undefined;
    let reporter: CompositeReporter;
    let engine: PipelineEngine;

    if (interactive) {
      const classifierRouter = new ModelRouter(effectiveConfig.codexPath, effectiveConfig.workDir, {
        allowFallbacks: effectiveConfig.allowModelFallbacks ?? false,
        claudeSettingSources: effectiveConfig.claudeSettingSources ?? ['user'],
        mcpServers: effectiveConfig.mcpServers,
        workspaceContext: effectiveConfig.workspaceContext,
      });
      const interactiveReporter = new InteractiveReporter(
        effectiveConfig.verbose,
        effectiveConfig.autoApprove,
        (event) => repl?.onPipelineEvent(event),
      );
      reporter = new CompositeReporter(interactiveReporter, fileLogger);
      engine = new PipelineEngine(effectiveConfig, reporter);
      repl = new SessionRepl(engine, {
        reporter: interactiveReporter,
        historyFilePath: resolveHelixStatePath(effectiveConfig.workDir, 'repl-history'),
        llmClassify: createLlmInputClassifier(classifierRouter, effectiveConfig.defaultModel),
      });
    } else {
      const terminal = new TerminalProgressReporter(
        effectiveConfig.verbose,
        effectiveConfig.autoApprove,
      );
      reporter = new CompositeReporter(terminal, fileLogger);
      engine = new PipelineEngine(effectiveConfig, reporter);
    }

    if (
      runtimeReadiness &&
      !session.decisions.some((decision) => decision.stage === 'Readiness Bootstrap')
    ) {
      await sessionManager.addDecision(session, runtimeReadiness.startupDecision);
    }

    if (runtimeReadiness) {
      for (const line of runtimeReadiness.summaryLines) {
        out(line);
      }
    }
    if (resolvedSession.launchRecord) {
      out(`Worktree: ${resolvedSession.launchRecord.worktreeDir}`);
    }

    reporter.emit({
      type: 'session-start',
      timestamp: new Date().toISOString(),
      message: `Resuming: ${session.workItem.title} (${session.state})`,
    });

    // Reset state so the engine can proceed
    if (session.state === 'failed' || session.state === 'paused') {
      await sessionManager.updateState(session, 'executing');
    }

    // Start REPL before pipeline so user can interact immediately
    await repl?.start();

    process.on('SIGINT', () => {
      out(`\n\nAborting session ${session.id}...`);
      out(`Resume: helix resume ${session.id}\n`);
      repl?.stop();
      engine.abort();
      sessionManager.updateState(session, 'paused').then(() => process.exit(0));
    });

    // Resume from the saved pipeline snapshot; readiness may still wrap it with
    // current repo policy overrides when available.
    const pipeline = applyCheapImplementerFromFlag(
      applyStageMaxTurnsFromFlag(runtimeReadiness?.effectivePipeline ?? selectedPipeline),
    );
    try {
      await engine.run(session, pipeline);
    } finally {
      repl?.stop();
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    err(`Failed to resume session ${sessionId}: ${msg}`);
    out(`Session: ${sessionId}`);
    out(`Resume: helix resume ${sessionId}`);
    process.exit(1);
  }
}

async function runStatus(): Promise<void> {
  const sessions = await listVisibleSessions();

  if (sessions.length === 0) {
    out('No active HELIX sessions.');
    return;
  }

  out('\nHELIX Sessions:\n');
  out('  ID        State              Updated             Title');
  out('  ──────── ────────────────── ─────────────────── ────────────────────');

  for (const s of sessions) {
    const id = s.id.padEnd(8);
    const state = s.state.padEnd(18);
    const updated = new Date(s.updatedAt).toLocaleString().padEnd(19);
    const title = s.worktreeDir ? `${s.title} [wt ${basename(s.worktreeDir)}]` : s.title;
    out(`  ${id} ${state} ${updated} ${title}`);
  }
  out('');
}

async function runList(): Promise<void> {
  await runStatus();
}

async function runDoctor(): Promise<void> {
  try {
    const result = await runHelixDoctor(baseConfig.workDir, {
      configPath: flag('--config'),
      verificationPath: flag('--verification'),
      reportPath: flag('--report'),
      useOpenAiArchitectureOracle: baseConfig.useOpenAiArchitectureOracle,
      enableDuelingPlanners: baseConfig.enableDuelingPlanners,
    });

    if (flag('--json') === 'true') {
      out(JSON.stringify(result.report, null, 2));
      return;
    }

    for (const line of formatReadinessSummary(result.report)) {
      out(line);
    }
    out(`Saved readiness report: ${result.reportPath}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    err(`Doctor failed: ${msg}`);
    process.exit(1);
  }
}

/**
 * Slice 6: pre-warm the verification-bootstrap cache outside any session.
 *
 * The first session in a fresh worktree pays the full cost of cleaning
 * generated type artifacts, prebuilding scoped dependency packages, and
 * capturing the typecheck baseline. Subsequent sessions on the same
 * lock-file hash and clean worktree reuse the cache (see
 * `ensureVerificationBootstrap`'s cache-hit path).
 *
 * `helix bootstrap` lets the operator pay that first-run cost once after
 * a fresh `git pull` instead of inside the next `helix audit/fix` session
 * — cutting wall time on the first session by however long the build /
 * typecheck baseline took.
 *
 * Flags:
 *   --scope <paths>   Comma-separated workspace paths (apps/x, packages/y).
 *                     Defaults to repo root if omitted.
 *   --force           Rebuild even if the cache appears valid.
 */
async function runBootstrap(): Promise<void> {
  const scope = (flag('--scope') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const force = flag('--force') === 'true';

  // Synthesize a minimal Session-shape with just the fields ensureVerificationBootstrap reads.
  const syntheticSession = {
    workItem: { scope },
  } as unknown as Parameters<typeof ensureVerificationBootstrap>[1];

  out('helix bootstrap: pre-warming verification cache...');
  const startedAt = Date.now();
  try {
    const record = await ensureVerificationBootstrap(baseConfig.workDir, syntheticSession, {
      scopeEntries: scope,
      force,
      emitProgress: (message, details) => {
        if (details && Object.keys(details).length > 0) {
          out(`  ${message}`);
        } else {
          out(`  ${message}`);
        }
      },
    });
    const elapsedMs = Date.now() - startedAt;
    out('');
    out(formatVerificationBootstrapSummary(record));
    out('');
    out(`bootstrap complete in ${(elapsedMs / 1000).toFixed(1)}s`);
    if (record.builtPackages.length === 0 && record.notes.some((n) => n.includes('Reused'))) {
      out('  (cache hit — subsequent helix audit/fix will skip this stage entirely)');
    } else if (record.builtPackages.length > 0) {
      out(
        `  (next helix audit/fix in this worktree will reuse the cache for these ${record.builtPackages.length} package(s))`,
      );
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    err(`bootstrap failed: ${msg}`);
    process.exit(1);
  }
}

/**
 * `helix review-branch [--base <ref>]` — sugar for running the existing
 * holistic-audit pipeline against the diff between the current branch and
 * a base ref (defaults to `main`). Same WorkItem shape as `helix audit`,
 * just with scope auto-populated from `git diff --name-only base...HEAD`.
 *
 * Use case: PR / branch review without typing out every changed file in
 * `--scope`. The existing oracle constellation (codebase, architecture,
 * testing, domain, platform, industry, oss, e2e-flow) handles the
 * cross-layer + isolation + security audit. No new pipeline; no API.
 */
async function runReviewBranch(): Promise<void> {
  // Positional arg: branch name (local or remote-tracking). Falls back to
  // current HEAD when omitted. Helix auto-resolves the head ref (tries the
  // bare name first, then origin/<name>) and the merge base (origin/develop
  // if it exists, else origin/main).
  const positional = parsed.positional[0];
  const dryRun = flag('--dry-run') === 'true';
  const titleFlag = flag('--title');

  // Best-effort fetch so remote refs are current; ignore failure (offline,
  // no remote, no network) — diff still works against whatever is local.
  // intentional: best-effort prefetch, not a hard dependency.
  await execAsync('git fetch --quiet --no-tags', { cwd: baseConfig.workDir }).catch((fetchErr) => {
    // intentional: best-effort prefetch — log at debug level only
    void fetchErr;
  });

  const head = await resolveReviewHeadRef(baseConfig.workDir, positional);
  if (!head) {
    err(
      `review-branch: could not resolve "${positional}" as a branch or ref (tried "${positional}" and "origin/${positional}")`,
    );
    process.exit(1);
  }

  const baseFlag = flag('--base');
  const base = baseFlag
    ? escapeShellArg(baseFlag)
    : await detectReviewBaseRef(baseConfig.workDir, head);

  let changedFiles: string[];
  try {
    const { stdout } = await execAsync(
      `git diff --name-only ${escapeShellArg(base)}...${escapeShellArg(head)}`,
      { cwd: baseConfig.workDir, maxBuffer: 4 * 1024 * 1024 },
    );
    changedFiles = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    err(`review-branch: failed to compute diff ${base}...${head}: ${msg}`);
    process.exit(1);
  }

  if (changedFiles.length === 0) {
    out(`review-branch: no files changed between ${base} and ${head}`);
    process.exit(0);
  }

  const headLabel = head === 'HEAD' ? await currentBranchName(baseConfig.workDir) : head;
  const title = titleFlag ?? `branch review: ${headLabel} vs ${base}`;
  const description = `Audit of ${changedFiles.length} file(s) changed on ${headLabel} since ${base}.`;

  out(`review-branch: ${headLabel} vs ${base} — ${changedFiles.length} file(s) changed`);
  for (const file of changedFiles.slice(0, 12)) {
    out(`  ${file}`);
  }
  if (changedFiles.length > 12) {
    out(`  …and ${changedFiles.length - 12} more`);
  }
  out('');

  const workItem: WorkItem = {
    id: randomUUID().slice(0, 8),
    type: 'feature-audit',
    title,
    description,
    scope: changedFiles,
    jiraKey: flag('--jira'),
    targetBranch: flag('--branch') ?? headLabel,
    createdAt: new Date().toISOString(),
  };

  if (dryRun) {
    out('--dry-run: WorkItem that would be passed to the audit pipeline:');
    out(JSON.stringify({ ...workItem, scope: `${workItem.scope.length} file(s)` }, null, 2));
    out('');
    out('Top scope entries:');
    for (const file of workItem.scope.slice(0, 30)) {
      out(`  ${file}`);
    }
    if (workItem.scope.length > 30) {
      out(`  …and ${workItem.scope.length - 30} more`);
    }
    out('');
    out('(skipped pipeline launch — drop --dry-run to run the full holistic audit)');
    return;
  }

  // Pin the worktree to the resolved head ref so the audit reads the
  // target branch's files, not the operator's current branch. When the
  // operator omitted the positional, head === 'HEAD' and the worktree
  // starts at the current HEAD (existing behavior).
  const worktreeHeadRef = head === 'HEAD' ? undefined : head;
  await runPipeline(workItem, { worktreeHeadRef });
}

/**
 * Resolve the user-supplied branch / ref token to a git ref helix can diff.
 * Tries the bare name first, then `origin/<name>`. Returns the first one
 * `git rev-parse` accepts. When the operator omits the positional, returns
 * literal "HEAD".
 */
async function resolveReviewHeadRef(
  workDir: string,
  positional: string | undefined,
): Promise<string | null> {
  if (!positional) return 'HEAD';
  const candidates = [positional, `origin/${positional}`];
  for (const candidate of candidates) {
    if (!/^[A-Za-z0-9._/~^@{}-]+$/.test(candidate)) continue;
    if (await refExists(workDir, candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Auto-detect the merge-base ref for review. Prefers `origin/develop` when
 * the repo uses develop-as-default-target (common Bitbucket flow), else
 * falls back to `origin/main` and finally `main`. Operator can override
 * with --base.
 */
async function detectReviewBaseRef(workDir: string, head: string): Promise<string> {
  const candidates = ['origin/develop', 'origin/main', 'develop', 'main'];
  for (const candidate of candidates) {
    if (candidate === head) continue;
    if (await refExists(workDir, candidate)) {
      return candidate;
    }
  }
  return 'main';
}

async function refExists(workDir: string, ref: string): Promise<boolean> {
  try {
    await execAsync(`git rev-parse --verify --quiet ${escapeShellArg(ref)}`, { cwd: workDir });
    return true;
  } catch (error) {
    // Not a swallowed error — we're explicitly using rev-parse as a
    // membership test, and a non-zero exit means "ref is not present".
    void error;
    return false;
  }
}

async function currentBranchName(workDir: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: workDir });
    return stdout.trim() || 'HEAD';
  } catch {
    return 'HEAD';
  }
}

function escapeShellArg(value: string): string {
  // Allow git ref grammar: alphanumerics, dot, slash, hyphen, underscore,
  // tilde, caret, at-sign, braces (for HEAD@{1}-style refs). Anything else
  // (spaces, shell metachars) is refused — defense against command injection
  // since the value is interpolated into a shell command string.
  if (!/^[A-Za-z0-9._/~^@{}-]+$/.test(value)) {
    throw new Error(`refusing unsafe ref "${value}"`);
  }
  return value;
}

async function runLogs(): Promise<void> {
  const sessionId = parsed.positional[0];
  if (!sessionId) {
    err('Usage: helix logs <session-id> [--follow]');
    process.exit(1);
  }

  const resolvedSession = await resolveManagedSessionConfig(sessionId).catch(() => null);
  const logPath = join(
    resolvedSession?.config.sessionDir ?? baseConfig.sessionDir,
    sessionId,
    'progress.log',
  );
  const follow = flag('--follow') === 'true' || flag('-f') === 'true';

  const { createReadStream, existsSync, watchFile, unwatchFile } = await import('node:fs');

  if (!existsSync(logPath)) {
    err(`No log file found at ${logPath}`);
    err('Logs are only available for sessions started after this feature was added.');
    err('You can still check session state with: helix status');
    process.exit(1);
  }

  // Stream existing content
  const stream = createReadStream(logPath, { encoding: 'utf-8' });
  stream.pipe(process.stdout);

  if (!follow) {
    await new Promise<void>((resolve) => stream.on('end', resolve));
    return;
  }

  // Follow mode: watch for new writes
  await new Promise<void>((resolve) => stream.on('end', resolve));

  let position = 0;
  try {
    const { stat } = await import('node:fs/promises');
    const s = await stat(logPath);
    position = s.size;
  } catch {
    // Start from 0
  }

  out('--- following (Ctrl+C to stop) ---');

  const { open } = await import('node:fs/promises');

  watchFile(logPath, { interval: 500 }, async () => {
    try {
      const { stat: statFn } = await import('node:fs/promises');
      const s = await statFn(logPath);
      if (s.size <= position) return;

      const fh = await open(logPath, 'r');
      try {
        const buf = Buffer.alloc(s.size - position);
        await fh.read(buf, 0, buf.length, position);
        process.stdout.write(buf.toString('utf-8'));
        position = s.size;
      } finally {
        await fh.close();
      }
    } catch {
      // Ignore read errors during follow
    }
  });

  // Keep alive until Ctrl+C
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      unwatchFile(logPath);
      out('\n');
      resolve();
    });
  });
}

async function runWatch(): Promise<void> {
  const sessionId = parsed.positional[0];
  if (!sessionId) {
    err('Usage: helix watch <session-id> [--lines <n>] [--poll-ms <ms>] [--stale-ms <ms>]');
    process.exit(1);
  }

  let resolvedSession: ManagedSessionConfig;
  try {
    resolvedSession = await resolveManagedSessionConfig(sessionId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    err(`Failed to resolve session ${sessionId}: ${msg}`);
    process.exit(1);
  }

  const pollMs = parsePositiveInt(flag('--poll-ms'), DEFAULT_WATCH_POLL_MS);
  const staleAfterMs = parsePositiveInt(flag('--stale-ms'), DEFAULT_WATCH_STALE_AFTER_MS);
  const recentLines = parsePositiveInt(flag('--lines'), DEFAULT_WATCH_LINES);
  const sessionManager = new SessionManager(resolvedSession.config);
  const sessionDir = join(resolvedSession.config.sessionDir, sessionId);
  const sessionPath = join(sessionDir, 'session.json');
  const logPath = join(sessionDir, 'progress.log');
  const { existsSync } = await import('node:fs');
  const { open, readFile, stat } = await import('node:fs/promises');

  const session = await sessionManager.load(sessionId);
  let sessionSignature = buildSessionWatchSignature(session);
  let staleReported = isSessionHeartbeatStale(session, { staleAfterMs });
  let logPosition = 0;
  let stopRequested = false;

  out(`Watching session ${session.id}: ${session.workItem.title}`);
  out(`Session file: ${sessionPath}`);
  if (resolvedSession.launchRecord?.worktreeDir ?? session.workspaceContext?.worktreeDir) {
    out(
      `Worktree: ${resolvedSession.launchRecord?.worktreeDir ?? session.workspaceContext?.worktreeDir}`,
    );
  }
  out(formatSessionWatchSummary(session, { staleAfterMs }));

  const initialLog = await readLastLines(logPath, recentLines);
  if (initialLog) {
    out(`--- recent log (${recentLines} line${recentLines === 1 ? '' : 's'}) ---`);
    process.stdout.write(initialLog.endsWith('\n') ? initialLog : `${initialLog}\n`);
  }

  if (existsSync(logPath)) {
    try {
      logPosition = (await stat(logPath)).size;
    } catch {
      logPosition = 0;
    }
  }

  out(`--- watching every ${pollMs}ms (Ctrl+C to stop) ---`);

  const appendLogDelta = async (): Promise<void> => {
    if (!existsSync(logPath)) {
      return;
    }

    let currentSize = 0;
    try {
      currentSize = (await stat(logPath)).size;
    } catch {
      return;
    }

    if (currentSize <= logPosition) {
      return;
    }

    const fh = await open(logPath, 'r');
    try {
      const buf = Buffer.alloc(currentSize - logPosition);
      await fh.read(buf, 0, buf.length, logPosition);
      process.stdout.write(buf.toString('utf-8'));
      logPosition = currentSize;
    } finally {
      await fh.close();
    }
  };

  const onSigInt = (): void => {
    stopRequested = true;
  };

  process.on('SIGINT', onSigInt);
  try {
    while (!stopRequested) {
      await appendLogDelta();

      let nextSession = session;
      try {
        const raw = await readFile(sessionPath, 'utf-8');
        nextSession = JSON.parse(raw) as Session;
      } catch {
        nextSession = await sessionManager.load(sessionId);
      }

      const nextSignature = buildSessionWatchSignature(nextSession);
      if (nextSignature !== sessionSignature) {
        out(formatSessionWatchSummary(nextSession, { staleAfterMs }));
        sessionSignature = nextSignature;
      }

      const stale = isSessionHeartbeatStale(nextSession, { staleAfterMs });
      if (stale && !staleReported) {
        const referenceIso = nextSession.heartbeat?.at ?? nextSession.updatedAt;
        const ageSeconds = Math.max(1, Math.round((Date.now() - Date.parse(referenceIso)) / 1000));
        err(
          `[watch] No persisted heartbeat for ${ageSeconds}s while session is ${nextSession.state}.`,
        );
      }
      staleReported = stale;

      if (isTerminalSessionState(nextSession.state)) {
        await appendLogDelta();
        out(`[watch] Session reached ${nextSession.state}.`);
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    process.off('SIGINT', onSigInt);
    out('');
  }
}

async function runSmoke(): Promise<void> {
  const scope = (flag('--scope') ?? DEFAULT_SCOPE).split(',').filter(Boolean);
  const schemaId = parseSchemaId(flag('--schema'));
  if (!schemaId) {
    err(
      'Usage: helix smoke [--scope <paths>] [--schema <analysis-report|reproduction-report|slice-plan|impact-analysis|oracle-review|workspace-reconcile|failure-advisory>]',
    );
    process.exit(1);
  }

  const timeoutMs = parseTimeoutMs(flag('--timeout'));
  const router = new ModelRouter(baseConfig.codexPath, baseConfig.workDir, {
    allowFallbacks: baseConfig.allowModelFallbacks ?? false,
    claudeSettingSources: baseConfig.claudeSettingSources ?? ['user'],
    mcpServers: baseConfig.mcpServers,
    workspaceContext: baseConfig.workspaceContext,
  });
  const outputSchema = { id: schemaId, strict: true } as const;
  const prompt =
    flag('--prompt') ??
    [
      'This is a smoke test for the HELIX structured output path, not a full audit.',
      'Read only enough to confirm the target scope is accessible and the schema path works.',
      'If nothing immediately obvious stands out, return empty findings and decisions.',
      schemaId === 'analysis-report'
        ? 'Return at most 1 finding and at most 1 decision.'
        : 'Return only the structured payload that matches the requested schema.',
      'Target scope:',
      ...scope.map((entry) => `- ${entry}`),
      '',
      buildStageOutputInstructions(outputSchema),
    ].join('\n');

  const result = await router.execute(
    prompt,
    {
      primary: {
        ...baseConfig.defaultModel,
      },
    },
    ['Read', 'Grep', 'Glob'],
    (event) => {
      if (baseConfig.verbose || event.type === 'error') {
        const channel = event.type === 'error' ? err : out;
        channel(`[smoke] ${event.message}`);
      }
    },
    outputSchema,
    timeoutMs,
  );

  const parsed =
    schemaId === 'analysis-report' && !result.error
      ? parseAnalysisOutput(result.output, 'Smoke')
      : undefined;

  const smokeDir = resolveHelixStatePath(baseConfig.workDir, 'smoke');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runPath = join(smokeDir, `${timestamp}.json`);
  const latestPath = join(smokeDir, 'latest.json');
  const payload = {
    createdAt: new Date().toISOString(),
    schemaId,
    scope,
    timeoutMs,
    prompt,
    result,
    parsed:
      parsed == null
        ? undefined
        : {
            findings: parsed.findings.length,
            decisions: parsed.decisions.length,
          },
  };

  await mkdir(smokeDir, { recursive: true });
  await writeFile(runPath, JSON.stringify(payload, null, 2), 'utf-8');
  await writeFile(latestPath, JSON.stringify(payload, null, 2), 'utf-8');

  out('');
  out(`Smoke ${result.error ? 'failed' : 'passed'} (${Math.round(result.durationMs / 1000)}s)`);
  out(`Schema: ${schemaId}`);
  out(`Scope: ${scope.join(', ')}`);
  if (parsed) {
    out(`Findings: ${parsed.findings.length}  Decisions: ${parsed.decisions.length}`);
  }
  if (result.error) {
    err(`Error: ${result.error}`);
    err(`Saved smoke report: ${runPath}`);
    process.exit(1);
  }

  out(`Saved smoke report: ${runPath}`);
}

async function runCanary(): Promise<void> {
  const positional = parsed.positional[0];
  const canaryStageTimeoutMs = parseTimeoutMs(flag('--timeout'), 300);

  // runCanary's title comes from --title (NOT positional). When positional is
  // a Jira key, Jira fills the title only if --title is absent.
  const explicitTitleFlag = flag('--title');
  const initialTitle = explicitTitleFlag ?? DEFAULT_CANARY_TITLE;
  const preparedRuntime = await prepareSessionRuntime(initialTitle, { canary: true });
  const canaryConfig: HelixConfig = {
    ...preparedRuntime.config,
    autoCommit: false,
    autoApprove: true,
  };

  // Bootstrap from Jira key if positional matches OR --jira is set. CliOverrides
  // for canary: --title (not positional) acts as the title override; --scope and
  // --description carry their usual meanings.
  const explicitScopeRaw = flag('--scope');
  const cliOverrides: CliOverrides = {};
  if (explicitTitleFlag !== undefined) {
    cliOverrides.title = explicitTitleFlag;
  }
  if (flag('--description') !== undefined) {
    cliOverrides.description = flag('--description')!;
  }
  if (explicitScopeRaw !== undefined) {
    const explicitScope = explicitScopeRaw.split(',').filter(Boolean);
    if (explicitScope.length > 0) cliOverrides.scope = explicitScope;
  }

  const bootstrap = await bootstrapWorkItemFromCli(
    positional,
    cliOverrides,
    canaryConfig.workDir,
    flag('--jira'),
  );

  const title = bootstrap.partial.title ?? initialTitle;
  const description =
    bootstrap.partial.description ??
    flag('--description') ??
    'Bounded canary run for Deep Scan → Oracle Analysis → Plan Generation → Manifest Compilation';
  const scope =
    bootstrap.partial.scope ??
    cliOverrides.scope ??
    (explicitScopeRaw ?? DEFAULT_SCOPE).split(',').filter(Boolean);

  const workItem: WorkItem = {
    id: randomUUID().slice(0, 8),
    type: 'feature-audit',
    title,
    description,
    scope,
    jiraKey: bootstrap.jiraKey ?? flag('--jira'),
    targetBranch: 'current',
    createdAt: new Date().toISOString(),
  };

  const reporter = new CanaryProgressReporter(canaryConfig.verbose);
  const sessionManager = new SessionManager(canaryConfig);
  const pipeline = createCanaryPipeline(
    selectPipeline('feature-audit'),
    scope,
    canaryStageTimeoutMs,
  );
  const session = await sessionManager.create(workItem, pipeline, {
    bootstrapMeta: bootstrap.bootstrapMeta,
  });
  await maybePersistWorktreeLaunch(
    preparedRuntime.launch,
    session,
    canaryConfig,
    workItem.title,
    'canary',
  );

  out(`\nCanary session ${session.id} created.`);
  out(`Pipeline: ${pipeline.name}`);
  out(`Stages: ${pipeline.stages.map((s) => s.name).join(' → ')}\n`);
  if (preparedRuntime.launch) {
    out(`Worktree: ${canaryConfig.workDir}`);
    out(`Source workspace: ${preparedRuntime.launch.sourceWorkDir}\n`);
  }
  out(`Logs: helix logs ${session.id} --follow`);
  out(`Resume: helix resume ${session.id}\n`);

  const engine = new PipelineEngine(canaryConfig, reporter);

  process.on('SIGINT', () => {
    out(`\n\nAborting canary session ${session.id}...\nResume: helix resume ${session.id}\n`);
    engine.abort();
    sessionManager.updateState(session, 'paused').then(() => process.exit(0));
  });

  let finalSession: Session = session;
  try {
    finalSession = await engine.run(session, pipeline);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    err(`\nCanary session failed: ${msg}`);
    out(`Session: ${session.id}`);
    out(`Resume: helix resume ${session.id}`);
    await sessionManager.updateState(session, 'failed');
    session.error = msg;
    await sessionManager.persist(session);
    finalSession = session;
  } finally {
    await maybeFinalizeWorktreeLaunch(preparedRuntime.launch, session.id, finalSession.state, {
      workDir: canaryConfig.workDir,
    });
  }

  const canaryDir = resolveHelixStatePath(canaryConfig.workDir, 'canary');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runPath = join(canaryDir, `${timestamp}-${finalSession.id}.json`);
  const latestPath = join(canaryDir, 'latest.json');
  const payload = buildCanarySummary(finalSession, canaryConfig, reporter.snapshot(), runPath);

  await mkdir(canaryDir, { recursive: true });
  await writeFile(runPath, JSON.stringify(payload, null, 2), 'utf-8');
  await writeFile(latestPath, JSON.stringify(payload, null, 2), 'utf-8');

  out('');
  out(`Canary ${finalSession.state === 'completed' ? 'passed' : 'failed'}`);
  out(`Session: ${finalSession.id}`);
  out(`Scope: ${scope.join(', ')}`);
  out(`Saved canary report: ${runPath}`);

  if (finalSession.state !== 'completed') {
    out(`Resume: helix resume ${finalSession.id}`);
    err(`Error: ${finalSession.error ?? 'Canary did not complete successfully'}`);
    process.exit(1);
  }
}

async function runConcernsScan(): Promise<void> {
  const { runConcernsAudit } = await import('./concerns/audit.js');
  const tierFlag = flag('--tier') ?? flag('--tiers');
  const onlyFlag = flag('--only');
  const outputDirFlag = flag('--output-dir');
  const concernsDirFlag = flag('--concerns-dir');
  const write = flag('--no-write') !== 'true';

  const filterTiers = tierFlag
    ? (tierFlag
        .split(',')
        .map((value) => value.trim())
        .filter(
          (value): value is 'blocking' | 'advisory' => value === 'blocking' || value === 'advisory',
        ) as Array<'blocking' | 'advisory'>)
    : undefined;

  const filterConcernIds = onlyFlag
    ? onlyFlag
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    : undefined;

  try {
    const result = await runConcernsAudit({
      repoRoot: baseConfig.workDir,
      concernsDir: concernsDirFlag,
      outputDir: outputDirFlag,
      filterTiers,
      filterConcernIds,
      write,
    });

    out('');
    out('HELIX Concerns Audit');
    out('────────────────────');
    out(
      `Concerns:  ${result.summary.concernsScanned}/${result.summary.concernsTotal} scanned` +
        (filterTiers ? ` (tiers: ${filterTiers.join(', ')})` : '') +
        (filterConcernIds ? ` (ids: ${filterConcernIds.join(', ')})` : ''),
    );
    out(
      `Detectors: ${result.summary.detectorsRun} run, ${result.summary.detectorsSkipped} skipped`,
    );
    out(`Files:     ${result.summary.filesScanned} scanned`);
    out(`Duration:  ${result.summary.durationMs}ms`);
    out('');
    out(
      `Findings:  ${result.summary.findings} total — blocking ${result.summary.blockingFindings}, advisory ${result.summary.advisoryFindings}`,
    );
    if (result.summary.findings > 0) {
      out(
        `           critical ${result.summary.bySeverity.critical}, high ${result.summary.bySeverity.high}, medium ${result.summary.bySeverity.medium}, low ${result.summary.bySeverity.low}`,
      );
    }

    if (result.loadErrors.length > 0) {
      out('');
      err(`Registry load errors (${result.loadErrors.length}):`);
      for (const e of result.loadErrors) {
        err(`  ${e.sourcePath}`);
        err(`    ${e.message}`);
      }
    }

    if (result.findings.length > 0) {
      const maxPreview = 20;
      const preview = result.findings.slice(0, maxPreview);
      out('');
      out('Top findings:');
      for (const f of preview) {
        const rubricTag = f.rubricConcern ? ` rubric#${f.rubricConcern}` : '';
        out(`  [${f.severity.padEnd(8)}] ${f.concernId}/${f.detectorId}${rubricTag}`);
        out(`    ${f.file}:${f.line}`);
        const firstLine = f.message.split('\n')[0]?.trim();
        if (firstLine) {
          out(`    ${firstLine}`);
        }
      }
      if (result.findings.length > preview.length) {
        out(
          `  … and ${result.findings.length - preview.length} more (see ${result.findingsPath ?? 'findings output'})`,
        );
      }
    }

    if (result.findingsPath && result.summaryPath) {
      out('');
      out(`Findings: ${result.findingsPath}`);
      out(`Summary:  ${result.summaryPath}`);
    } else if (!write) {
      out('');
      out('(--no-write: findings not persisted)');
    }

    if (result.summary.blockingFindings > 0) {
      err('');
      err(
        `${result.summary.blockingFindings} blocking finding${result.summary.blockingFindings === 1 ? '' : 's'} — exit 1`,
      );
      process.exit(1);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    err(`Concerns audit failed: ${msg}`);
    process.exit(1);
  }
}

async function runDriftAudit(): Promise<void> {
  const scope = (flag('--scope') ?? DEFAULT_SCOPE).split(',').filter(Boolean);

  const title =
    parsed.positional[0] ?? (scope.length > 0 ? `Drift audit: ${scope.join(', ')}` : 'Drift audit');

  const workItem: WorkItem = {
    id: randomUUID().slice(0, 8),
    type: 'drift-audit',
    title,
    description: flag('--description') ?? title,
    scope,
    jiraKey: flag('--jira'),
    targetBranch: flag('--branch') ?? 'current',
    createdAt: new Date().toISOString(),
  };

  const driftConfig: HelixConfig = {
    ...baseConfig,
    autoApprove: true,
    autoCommit: false,
  };
  const pipeline = selectPipeline('drift-audit');
  const sessionManager = new SessionManager(driftConfig);
  const session = await sessionManager.create(workItem, pipeline);

  const terminal = new TerminalProgressReporter(driftConfig.verbose, driftConfig.autoApprove);
  const fileLogger = new FileProgressLogger(driftConfig.sessionDir, session.id);
  const reporter = new CompositeReporter(terminal, fileLogger);
  const engine = new PipelineEngine(driftConfig, reporter);

  out(`\nSession ${session.id} created.`);
  out(`Pipeline: ${pipeline.name}`);
  out(`Stages: ${pipeline.stages.map((s) => s.name).join(' → ')}`);
  out(`Scope: ${scope.length > 0 ? scope.join(', ') : '(repo-wide)'}`);
  out(`Logs: helix logs ${session.id} --follow`);
  out('');

  process.on('SIGINT', () => {
    out(`\n\nAborting drift-audit session ${session.id}...`);
    engine.abort();
    sessionManager.updateState(session, 'paused').then(() => process.exit(0));
  });

  let runError: string | undefined;
  try {
    await engine.run(session, pipeline);
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
  }

  const concernsStage = session.stageHistory.find((s) => s.stageName === pipeline.stages[0].name);
  const stageFailed = concernsStage?.status === 'failed';

  out('');
  out('HELIX Drift Audit');
  out('─────────────────');
  out(`Session:   ${session.id}`);
  out(`State:     ${session.state}`);
  out(`Findings:  ${session.findings.length} total`);
  if (concernsStage?.output) {
    out('');
    out(concernsStage.output);
  }

  if (runError) {
    err('');
    err(`Drift audit failed: ${runError}`);
    process.exit(1);
  }

  if (stageFailed) {
    err('');
    err(
      `Blocking concerns detected — exit 1${concernsStage?.error ? ` (${concernsStage.error})` : ''}`,
    );
    process.exit(1);
  }
}

// ── helix index ───────────────────────────────────────────────────────────────

async function runIndex(): Promise<void> {
  const subcommand = parsed.positional[0];
  if (subcommand !== 'rebuild') {
    err('Usage: helix index rebuild [--dry-run] [--session <id>] [--all]');
    process.exit(1);
  }
  await runIndexRebuild();
}

async function runIndexRebuild(): Promise<void> {
  const embeddingConfig = buildHelixConfig(baseConfig.workDir, {
    invocationDir: baseConfig.invocationDir,
    workspaceContext: { mode: 'in-place' },
  });

  if (!isHelixEmbeddingsEnabled(embeddingConfig)) {
    err(
      '[helix:index] Embeddings are disabled. Pass --enable-embeddings or set HELIX_EMBEDDINGS_ENABLED=true to rebuild the index.',
    );
    process.exit(1);
  }

  const provider = embeddingConfig.embeddingProvider;
  if (!provider) {
    err('[helix:index] No embedding provider configured.');
    process.exit(1);
  }

  const dryRun = flag('--dry-run') === 'true';

  try {
    const result = await rebuildEmbeddingIndex(provider, { dryRun });
    out(
      `[helix:index] rebuild complete — ` +
        `filesScanned=${result.filesScanned} ` +
        `findingsWritten=${result.findingsWritten} ` +
        `decisionsWritten=${result.decisionsWritten} ` +
        `shardsCompacted=${result.shardsCompacted} ` +
        `rowsSkipped=${result.rowsSkipped} ` +
        `durationMs=${result.durationMs}` +
        (dryRun ? ' (dry-run)' : ''),
    );
  } catch (error) {
    err(`[helix:index] rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function runDriftCommand(): Promise<void> {
  const subcommand = parsed.positional[0];
  if (subcommand !== 'sync') {
    err('Usage: helix drift sync <session-id> [--project <KEY>] [--auto-approve] [--dry-run]');
    process.exit(1);
  }

  const sessionId = parsed.positional[1];
  if (!sessionId) {
    err('Usage: helix drift sync <session-id> [--project <KEY>] [--auto-approve] [--dry-run]');
    process.exit(1);
  }

  const projectKey = flag('--project') ?? process.env['JIRA_PROJECT_KEY'] ?? 'ABLP';
  const autoApprove = flag('--auto-approve') === 'true';
  const dryRun = flag('--dry-run') === 'true';

  const sessionManager = new SessionManager(baseConfig);
  const jira = createRealDriftJiraClient();

  const io: DriftSyncIo = {
    out,
    err,
    async promptYesNo(question) {
      const readline = await import('node:readline/promises');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await rl.question(question)).trim();
      } finally {
        rl.close();
      }
    },
    now: () => new Date(),
  };

  try {
    const { reason } = await runDriftSync({
      sessionManager,
      jira,
      io,
      options: { sessionId, projectKey, autoApprove, dryRun },
    });
    if (reason === 'user-aborted') {
      process.exit(2);
    }
  } catch (error) {
    err(`drift sync failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function runJiraCommand(): Promise<void> {
  const subcommand = parsed.positional[0];
  if (subcommand !== 'mine' && subcommand !== 'assignee') {
    err(
      'Usage: helix jira mine [--assignee <name|currentUser()>] [--project <KEY>] [--scope <packages>] [--open-only] [--run-simple] [--limit <n>]',
    );
    process.exit(1);
  }

  const defaultScope = (flag('--scope') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const limit = parseInt(flag('--limit') ?? '50', 10);
  const simpleLimit = parseInt(flag('--simple-limit') ?? flag('--limit-simple') ?? '5', 10);
  const projectKey = flag('--project') ?? process.env['JIRA_PROJECT_KEY'] ?? 'ABLP';
  const issues = await searchAssignedIssues({
    assignee: flag('--assignee'),
    projectKey,
    maxResults: Number.isFinite(limit) && limit > 0 ? limit : 50,
    includeDone: flag('--open-only') !== 'true',
  });
  const modelDecisions = await classifyJiraIssuesWithModel(issues);
  const plan = buildJiraAssigneeWorkflowPlan(issues, {
    defaultScope,
    simpleLimit: Number.isFinite(simpleLimit) && simpleLimit > 0 ? simpleLimit : 5,
    modelDecisions,
  });

  out(renderJiraAssigneeWorkflowReport(plan));

  if (plan.runnableSimple.length > 0) {
    out('\nModel-approved simple issue commands:');
    for (const entry of plan.runnableSimple) {
      out(`- ${buildSimpleIssueHelixCommand(entry)}`);
    }
  }

  if (flag('--run-simple') !== 'true') {
    return;
  }

  if (plan.runnableSimple.length === 0) {
    out('\nNo model-approved simple issues are runnable.');
    return;
  }

  out(`\nRunning ${plan.runnableSimple.length} simple issue(s) through HELIX.`);
  for (const entry of plan.runnableSimple) {
    const workItem: WorkItem = {
      id: randomUUID().slice(0, 8),
      type: 'bug-fix',
      title: `[${entry.issue.key}] ${entry.issue.summary}`,
      description: buildJiraIssueWorkDescription(entry),
      scope: entry.inferredScope,
      jiraKey: entry.issue.key,
      targetBranch: 'current',
      createdAt: new Date().toISOString(),
    };
    await runPipeline(workItem);
  }
}

function buildJiraIssueWorkDescription(
  entry: ReturnType<typeof buildJiraAssigneeWorkflowPlan>['runnableSimple'][number],
): string {
  return [
    `JIRA: ${entry.issue.key}`,
    `Status: ${entry.issue.status}`,
    `Complexity: ${entry.complexity} (score ${entry.score})`,
    `Triage reasons: ${entry.reasons.join('; ')}`,
    '',
    entry.issue.descriptionText || entry.issue.description || entry.issue.summary,
    '',
    'HELIX JIRA workflow constraints:',
    '- Keep this to the smallest patch that resolves the issue.',
    '- Use the inferred scope first; do not widen without clear evidence.',
    '- Run package-local build/typecheck before tests.',
    '- Before completion, produce scenario-specific evidence for this Jira ticket.',
    '- UI tickets require Studio video/screenshots from a reusable or newly scaffolded studio:video:evidence scenario.',
    '- API/runtime tickets require actual response, header, and body artifacts under .codex-artifacts/helix-evidence/<ticket>/.',
    '- Jira evidence output must map: Jira scenario -> root cause -> fix commit -> exact evidence artifact -> verification command -> residual risk.',
    '- If scenario-specific evidence cannot be produced, stop and report BLOCKED.',
    '- If the issue is broader than classified, stop and ask a clarifying question instead of spending exploratory turns.',
  ].join('\n');
}

async function classifyJiraIssuesWithModel(
  issues: Awaited<ReturnType<typeof searchAssignedIssues>>,
): Promise<JiraIssueModelDecision[]> {
  const payload = buildJiraIssueModelTriagePayload(issues);
  if (payload.issues.length === 0) {
    return [];
  }

  const router = new ModelRouter(baseConfig.codexPath, baseConfig.workDir, {
    allowFallbacks: true,
    claudeSettingSources: baseConfig.claudeSettingSources ?? ['user'],
    mcpServers: baseConfig.mcpServers,
    workspaceContext: baseConfig.workspaceContext,
  });
  const prompt = buildJiraIssueModelTriagePrompt(payload);
  const result = await router.execute(
    prompt,
    {
      primary: {
        engine: 'openai-api',
        model: baseConfig.openaiModel ?? DEFAULT_OPENAI_MODEL,
        effort: 'high',
        maxBudgetUsd: 10,
      },
      fallback: {
        engine: 'claude-code',
        model: 'sonnet',
        effort: 'high',
        maxTurns: 8,
      },
    },
    [],
    undefined,
    undefined,
    180_000,
  );

  if (result.error) {
    throw new Error(`JIRA model triage failed: ${result.error}`);
  }

  return parseJiraIssueModelDecisions(result.output);
}

function runPipelines(): void {
  const pipelines = listPipelines();
  out('\nAvailable Pipelines:\n');
  for (const p of pipelines) {
    out(`  ${p.name}`);
    out(`    ${p.description}`);
    out(`    Stages: ${p.stages.map((s) => s.name).join(' → ')}`);
    out(`    For: ${p.applicableTo.join(', ')}`);
    out('');
  }
}

// ── Pipeline Runner ───────────────────────────────────────────

async function runPipeline(
  workItem: WorkItem,
  opts?: { bootstrapMeta?: BootstrapMeta; worktreeHeadRef?: string },
): Promise<void> {
  const interactive = flag('--interactive') === 'true' || flag('-i') === 'true';
  const sourceRelativeFiles = [
    workItem.featureSpec,
    workItem.testSpec,
    workItem.hldSpec,
    workItem.lldPlan,
  ].filter((value): value is string => Boolean(value));
  const preparedRuntime = await prepareSessionRuntime(workItem.title, {
    sourceRelativeFiles,
    worktreeHeadRef: opts?.worktreeHeadRef,
  });
  const pipelineSelection = selectPipelineForWorkItem(workItem);
  let selectedPipeline = pipelineSelection.pipeline;
  // ABLP-797 Slice 20: --template overrides automatic selection. Used for
  // quick-fix and other operator-explicit pipeline choices.
  const templateFlag = flag('--template');
  if (templateFlag && templateFlag !== 'true') {
    const explicit = findPipelineByName(templateFlag);
    if (!explicit) {
      err(
        `--template: unknown pipeline "${templateFlag}". Available: ${listPipelines()
          .map((p) => p.name.toLowerCase().replace(/\s+/g, '-'))
          .join(', ')}`,
      );
      process.exit(1);
    }
    selectedPipeline = explicit;
    out(`[helix] using pipeline override: ${explicit.name}`);
  }
  const runtimeReadiness = await resolveRuntimeReadinessPolicy(
    selectedPipeline,
    preparedRuntime.config,
  );
  const effectiveConfig = runtimeReadiness?.effectiveConfig ?? preparedRuntime.config;
  const pipeline = applyCheapImplementerFromFlag(
    applyStageMaxTurnsFromFlag(runtimeReadiness?.effectivePipeline ?? selectedPipeline),
  );
  const sessionManager = new SessionManager(effectiveConfig);

  const session = await sessionManager.create(workItem, pipeline, {
    bootstrapMeta: opts?.bootstrapMeta,
  });
  await maybePersistWorktreeLaunch(
    preparedRuntime.launch,
    session,
    effectiveConfig,
    workItem.title,
    workItem.type === 'bug-fix' ? 'fix' : 'audit',
  );
  if (runtimeReadiness) {
    await sessionManager.addDecision(session, runtimeReadiness.startupDecision);
  }

  // Build the reporter — interactive mode uses InteractiveReporter for event hooks
  let repl: SessionRepl | undefined;
  let engine: PipelineEngine;

  if (interactive) {
    // Interactive mode: the REPL owns stdin and the reporter routes prompts through it.
    const fileLogger = new FileProgressLogger(effectiveConfig.sessionDir, session.id);
    const classifierRouter = new ModelRouter(effectiveConfig.codexPath, effectiveConfig.workDir, {
      allowFallbacks: effectiveConfig.allowModelFallbacks ?? false,
      claudeSettingSources: effectiveConfig.claudeSettingSources ?? ['user'],
      mcpServers: effectiveConfig.mcpServers,
      workspaceContext: effectiveConfig.workspaceContext,
    });
    const interactiveReporter = new InteractiveReporter(
      effectiveConfig.verbose,
      effectiveConfig.autoApprove,
      (event) => repl?.onPipelineEvent(event),
    );
    const reporter = new CompositeReporter(interactiveReporter, fileLogger);
    engine = new PipelineEngine(effectiveConfig, reporter);
    repl = new SessionRepl(engine, {
      reporter: interactiveReporter,
      historyFilePath: resolveHelixStatePath(effectiveConfig.workDir, 'repl-history'),
      llmClassify: createLlmInputClassifier(classifierRouter, effectiveConfig.defaultModel),
    });
  } else {
    const terminal = new TerminalProgressReporter(
      effectiveConfig.verbose,
      effectiveConfig.autoApprove,
    );
    const fileLogger = new FileProgressLogger(effectiveConfig.sessionDir, session.id);
    const reporter = new CompositeReporter(terminal, fileLogger);
    engine = new PipelineEngine(effectiveConfig, reporter);
  }

  out(`\nSession ${session.id} created.`);
  out(`Pipeline: ${pipeline.name}`);
  if (pipelineSelection.reason) {
    out(`Routing: ${pipelineSelection.reason}`);
  }
  out(`Stages: ${pipeline.stages.map((s) => s.name).join(' → ')}`);
  if (preparedRuntime.launch) {
    out(`Worktree: ${effectiveConfig.workDir}`);
    out(`Source workspace: ${preparedRuntime.launch.sourceWorkDir}`);
    out(
      'Note: detached worktree runs start from committed HEAD only; uncommitted source changes are not copied.',
    );
    if (preparedRuntime.launch.syncedPaths.length > 0) {
      out(`Synced source-only inputs: ${preparedRuntime.launch.syncedPaths.join(', ')}`);
    }
  }
  if (runtimeReadiness) {
    for (const line of runtimeReadiness.summaryLines) {
      out(line);
    }
  }
  out(`Logs: helix logs ${session.id} --follow`);
  out(`Resume: helix resume ${session.id}`);
  if (interactive) {
    out('Mode: interactive');
  }
  out('');

  // Start the REPL before the pipeline so the user can interact immediately
  await repl?.start();

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    out(`\n\nAborting session ${session.id}...\nResume: helix resume ${session.id}\n`);
    repl?.stop();
    engine.abort();
    sessionManager.updateState(session, 'paused').then(() => process.exit(0));
  });

  let exitCode = 0;
  try {
    await engine.run(session, pipeline);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    err(`\nSession failed: ${msg}`);
    out(`Session: ${session.id}`);
    out(`Resume: helix resume ${session.id}`);
    await sessionManager.updateState(session, 'failed');
    session.error = msg;
    await sessionManager.persist(session);
    repl?.stop();
    exitCode = 1;
  } finally {
    await maybeFinalizeWorktreeLaunch(preparedRuntime.launch, session.id, session.state, {
      workDir: effectiveConfig.workDir,
    });
  }

  repl?.stop();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

async function resolveRuntimeReadinessPolicy(
  pipeline: ReturnType<typeof selectPipeline>,
  activeConfig: HelixConfig,
): Promise<ReturnType<typeof buildRuntimeReadinessPolicy> | null> {
  try {
    const doctorResult = await runHelixDoctor(activeConfig.workDir, {
      configPath: flag('--config'),
      verificationPath: flag('--verification'),
      reportPath: flag('--report'),
      useOpenAiArchitectureOracle: activeConfig.useOpenAiArchitectureOracle,
      enableDuelingPlanners: activeConfig.enableDuelingPlanners,
    });
    return buildRuntimeReadinessPolicy(activeConfig, pipeline, doctorResult);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (
      isMissingDefaultReadinessContract(msg) &&
      !flag('--config') &&
      !flag('--verification') &&
      !flag('--report')
    ) {
      return null;
    }

    err(`Readiness bootstrap warning: ${msg}`);
    return null;
  }
}

function isMissingDefaultReadinessContract(message: string): boolean {
  return (
    message.includes('Unable to read HELIX config') ||
    message.includes('Unable to read HELIX verification policy')
  );
}

// ── Helpers ───────────────────────────────────────────────────

interface PreparedSessionRuntime {
  config: HelixConfig;
  launch?: Awaited<ReturnType<typeof prepareWorktreeExecution>>;
}

interface ManagedSessionConfig {
  config: HelixConfig;
  session: Session;
  launchRecord?: WorktreeLaunchRecord;
}

interface VisibleSession {
  id: string;
  title: string;
  state: SessionState;
  updatedAt: string;
  worktreeDir?: string;
}

function buildHelixConfig(
  workDir: string,
  options: {
    invocationDir?: string;
    canary?: boolean;
    workspaceContext?: WorkspaceExecutionContext;
    sessionDir?: string;
    journalDir?: string;
  } = {},
): HelixConfig {
  const sessionDir =
    options.sessionDir ??
    resolveHelixStatePath(workDir, options.canary ? 'canary-sessions' : 'sessions');
  const journalDir =
    options.journalDir ??
    (options.canary
      ? resolveHelixStatePath(workDir, 'canary-journal')
      : resolve(workDir, 'docs/sdlc-logs'));

  // Resolve cross-provider quorum feature flags: CLI > env > default
  const featureFlags = resolveHelixFeatureFlags();
  const useOpenAiArchitectureOracle =
    flag('--use-openai-architecture-oracle') === 'true'
      ? true
      : (featureFlags.useOpenAiArchitectureOracle ?? DEFAULT_USE_OPENAI_ARCHITECTURE_ORACLE);
  const enableDuelingPlanners =
    flag('--enable-dueling-planners') === 'true'
      ? true
      : (featureFlags.enableDuelingPlanners ?? DEFAULT_ENABLE_DUELING_PLANNERS);
  const openaiModel = flag('--openai-model') ?? featureFlags.openaiModel ?? DEFAULT_OPENAI_MODEL;
  const embeddingsEnabled =
    parseBooleanFlag(flag('--enable-embeddings')) ??
    featureFlags.embeddingsEnabled ??
    DEFAULT_HELIX_EMBEDDINGS_ENABLED;
  const embeddingProvider = buildDefaultEmbeddingProviderConfig({
    workDir,
    enabled: embeddingsEnabled,
    baseUrl: flag('--embedding-base-url') ?? featureFlags.embeddingBaseUrl,
    authToken: featureFlags.embeddingAuthToken,
    timeoutMs:
      parseOptionalPositiveInt(flag('--embedding-timeout-ms')) ?? featureFlags.embeddingTimeoutMs,
    maxBatchSize:
      parseOptionalPositiveInt(flag('--embedding-max-batch-size')) ??
      featureFlags.embeddingMaxBatchSize,
    requestBudget:
      parseOptionalPositiveInt(flag('--embedding-request-budget')) ??
      featureFlags.embeddingRequestBudget,
    shardBasePath: flag('--embedding-shard-base-path') ?? featureFlags.embeddingShardBasePath,
  });

  return {
    workDir,
    invocationDir: options.invocationDir,
    workspaceContext: options.workspaceContext,
    replayContext: resolveReplayContext(),
    initialLiveContext: resolveInitialLiveContext(),
    sessionDir,
    journalDir,
    defaultModel: {
      engine: 'codex-cli',
      model: 'gpt-5.5',
      effort: 'extra-high',
      maxTurns: 50,
    },
    codexPath: flag('--codex-path') ?? 'codex',
    claudePath: flag('--claude-path') ?? 'claude',
    stageModelPolicy: DEFAULT_STAGE_MODEL_POLICY,
    mcpServers: buildDefaultHelixMcpServers({ workDir, sessionDir, journalDir }),
    claudeSettingSources: ['user'],
    allowModelFallbacks: flag('--allow-model-fallbacks') === 'true',
    maxConcurrentOracles: parseInt(flag('--max-oracles') ?? '8', 10),
    maxSliceRetries: parseInt(flag('--max-retries') ?? '3', 10),
    autoCommit: flag('--auto-commit') === 'true',
    autoApprove: flag('--auto-approve') === 'true',
    autonomy: {
      mode: parseAutonomyMode(flag('--autonomy')),
      autoCommitMaxRisk: parseRiskLevel(flag('--auto-commit-risk')) ?? 'medium',
      minConfidenceScore: parseScore(flag('--auto-commit-confidence')) ?? 6,
      highConfidenceScore: parseScore(flag('--high-confidence-threshold')) ?? 9,
      deferBulkReview: true,
    },
    budgetLimitUsd: parseFloat(flag('--budget') ?? '200'),
    verbose: flag('--verbose') === 'true' || flag('-v') === 'true',
    useOpenAiArchitectureOracle,
    enableDuelingPlanners,
    openaiModel,
    embeddingProvider,
  };
}

async function prepareSessionRuntime(
  title: string,
  options: {
    canary?: boolean;
    sourceRelativeFiles?: string[];
    /**
     * When set, the worktree is pinned to this git ref instead of the
     * source repo's current HEAD. Used by `helix review-branch <branch>`
     * so the audit reads the target branch's files without forcing the
     * operator to checkout that branch in the source repo.
     */
    worktreeHeadRef?: string;
  } = {},
): Promise<PreparedSessionRuntime> {
  const worktreeRequest = resolveWorktreeRequest();
  if (!worktreeRequest.enabled) {
    return {
      config: buildHelixConfig(baseConfig.workDir, {
        invocationDir: baseConfig.invocationDir,
        canary: options.canary,
        workspaceContext: baseConfig.workspaceContext,
      }),
    };
  }

  out(`Preparing git worktree for: ${title}`);
  const launch = await prepareWorktreeExecution(baseConfig.workDir, {
    label: title,
    requestedPath: worktreeRequest.requestedPath,
    bootstrapInstall: flag('--skip-worktree-install') !== 'true',
    sourceRelativeFiles: options.sourceRelativeFiles,
    headRef: options.worktreeHeadRef,
  });
  const config = buildHelixConfig(launch.workDir, {
    invocationDir: launch.sourceWorkDir,
    canary: options.canary,
    workspaceContext: launch.workspaceContext,
  });

  out(`Worktree ready: ${launch.workDir}`);
  if (launch.workspaceContext.bootstrapCommand) {
    out(`Bootstrapped: ${launch.workspaceContext.bootstrapCommand}`);
  }

  return {
    config,
    launch,
  };
}

async function resolveManagedSessionConfig(sessionId: string): Promise<ManagedSessionConfig> {
  // Check the worktree launch record FIRST. If the session was originally
  // launched in a detached worktree, the launch record's worktreeDir is the
  // canonical workDir for resume — committing there advances the worktree's
  // detached HEAD instead of accidentally advancing the source repo's branch
  // (e.g. develop), which is what happened on session bb4116f0 when
  // /Users/<user>/<repo>/.helix/sessions/<id>/session.json took priority over
  // the worktree's launch record and helix wrote slice commits onto develop.
  const launchRecord = await loadWorktreeLaunchRecord(baseConfig.workDir, sessionId);
  if (launchRecord) {
    const config = buildLaunchRecordConfig(launchRecord);
    const session = await new SessionManager(config).load(sessionId);
    return { config, session, launchRecord };
  }

  const localSession = await loadManagedSessionFromConfigs(sessionId, buildLocalSessionConfigs());
  if (localSession) {
    return localSession;
  }

  throw new Error(`Session ${sessionId} not found.`);
}

async function listVisibleSessions(): Promise<VisibleSession[]> {
  const merged: Record<string, VisibleSession> = {};
  const localSessionGroups = await Promise.all(
    buildLocalSessionConfigs().map((config) => new SessionManager(config).list()),
  );
  const localSessions = localSessionGroups.flat();
  const linkedSessions = await listLinkedWorktreeSessions(baseConfig.workDir);

  for (const session of [...localSessions, ...linkedSessions]) {
    const existing = merged[session.id];
    if (!existing || session.updatedAt > existing.updatedAt) {
      merged[session.id] = session;
    }
  }

  return Object.values(merged).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function listLinkedWorktreeSessions(sourceWorkDir: string): Promise<VisibleSession[]> {
  const records = await listWorktreeLaunchRecords(sourceWorkDir);
  const sessions: VisibleSession[] = [];

  for (const record of records) {
    const manager = new SessionManager(buildLaunchRecordConfig(record));

    try {
      const session = await manager.load(record.sessionId);
      sessions.push({
        id: session.id,
        title: session.workItem.title,
        state: session.state,
        updatedAt: session.updatedAt,
        worktreeDir: record.worktreeDir,
      });
    } catch {
      if (!record.finalState) {
        continue;
      }

      sessions.push({
        id: record.sessionId,
        title: record.title,
        state: record.finalState,
        updatedAt: record.updatedAt,
        worktreeDir: record.worktreeDir,
      });
    }
  }

  return sessions;
}

async function maybePersistWorktreeLaunch(
  launch: PreparedSessionRuntime['launch'],
  session: Session,
  config: HelixConfig,
  title: string,
  commandName: WorktreeLaunchCommand,
): Promise<void> {
  if (!launch) {
    return;
  }

  await writeWorktreeLaunchRecord({
    sessionId: session.id,
    title,
    command: commandName,
    sourceWorkDir: launch.sourceWorkDir,
    worktreeDir: config.workDir,
    sessionDir: config.sessionDir,
    journalDir: config.journalDir,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    baseHeadSha: launch.workspaceContext.baseHeadSha,
    baseBranch: launch.workspaceContext.baseBranch,
    requestedPath: launch.workspaceContext.requestedPath,
    autoCreated: launch.workspaceContext.autoCreated ?? true,
    bootstrapCommand: launch.workspaceContext.bootstrapCommand,
  });
}

async function maybeFinalizeWorktreeLaunch(
  launch: PreparedSessionRuntime['launch'],
  sessionId: string,
  state: SessionState,
  context: { workDir: string },
): Promise<void> {
  if (!launch) {
    return;
  }

  const finalHeadSha = (await captureWorkspaceGitSnapshot(context.workDir))?.headSha;
  const finalizedAt = isTerminalSessionState(state) ? new Date().toISOString() : undefined;

  await updateWorktreeLaunchRecord(launch.sourceWorkDir, sessionId, {
    finalState: state,
    finalHeadSha,
    finalizedAt,
  });
}

function buildLaunchRecordConfig(record: WorktreeLaunchRecord): HelixConfig {
  return buildHelixConfig(record.worktreeDir, {
    invocationDir: record.sourceWorkDir,
    canary: record.command === 'canary',
    sessionDir: record.sessionDir,
    journalDir: record.journalDir,
    workspaceContext: {
      mode: 'git-worktree',
      sourceWorkDir: record.sourceWorkDir,
      worktreeDir: record.worktreeDir,
      baseHeadSha: record.baseHeadSha,
      baseBranch: record.baseBranch,
      requestedPath: record.requestedPath,
      autoCreated: record.autoCreated,
      bootstrapCommand: record.bootstrapCommand,
      createdAt: record.createdAt,
    },
  });
}

function buildLocalSessionConfigs(): HelixConfig[] {
  return [
    buildHelixConfig(baseConfig.workDir, {
      invocationDir: baseConfig.invocationDir,
      workspaceContext: { mode: 'in-place' },
    }),
    buildHelixConfig(baseConfig.workDir, {
      invocationDir: baseConfig.invocationDir,
      canary: true,
      workspaceContext: { mode: 'in-place' },
    }),
  ];
}

/**
 * Reads --stage-max-turns and applies it to the resolved pipeline. Returns
 * the same pipeline (mutated in place). Errors in flag syntax are printed
 * to stderr and process.exit(1)'d so operators see the problem early.
 */
function applyStageMaxTurnsFromFlag<
  T extends {
    stages: {
      type: string;
      name: string;
      model: { primary?: unknown; fallback?: unknown; layered?: unknown[] };
    }[];
  },
>(pipeline: T): T {
  const flagValue = flag('--stage-max-turns');
  if (flagValue == null || flagValue === 'true') {
    return pipeline;
  }
  const { overrides, errors } = parseStageMaxTurnsFlag(flagValue);
  if (errors.length > 0) {
    for (const message of errors) err(message);
    process.exit(1);
  }
  if (overrides.length === 0) {
    return pipeline;
  }
  const { applied } = applyStageMaxTurnsOverrides(
    pipeline as unknown as Parameters<typeof applyStageMaxTurnsOverrides>[0],
    overrides,
  );
  if (applied.length === 0) {
    err(
      `--stage-max-turns: no stages in this pipeline matched any of the requested types (${overrides.map((o) => o.stageType).join(', ')})`,
    );
  } else {
    for (const item of applied) {
      out(
        `[helix] stage-max-turns override → ${item.stageName} (${item.stageType}): maxTurns=${item.maxTurns}`,
      );
    }
  }
  return pipeline;
}

/**
 * Reads --cheap-implementer and swaps every implementation-stage primary to
 * claude-code/sonnet, demoting the original primary to fallback. The
 * qualityGate model-review checks and any layered review specs stay on opus
 * — opus remains the discriminator. Returns the same pipeline (mutated).
 */
function applyCheapImplementerFromFlag<
  T extends {
    stages: {
      type: string;
      name: string;
      model: { primary?: unknown; fallback?: unknown; layered?: unknown[] };
    }[];
  },
>(pipeline: T): T {
  const flagValue = flag('--cheap-implementer');
  if (flagValue == null) {
    return pipeline;
  }
  const { applied } = applyCheapImplementerOverride(
    pipeline as unknown as Parameters<typeof applyCheapImplementerOverride>[0],
  );
  if (applied.length === 0) {
    out(
      '[helix] --cheap-implementer: no implementation stages required swapping (already on sonnet)',
    );
  } else {
    for (const item of applied) {
      out(
        `[helix] cheap-implementer override → ${item.stageName}: primary swapped from ${item.previousEngine}/${item.previousModel ?? '(default)'} to claude-code/sonnet (original demoted to fallback)`,
      );
    }
  }
  return pipeline;
}

function resolveWorktreeRequest(): { enabled: boolean; requestedPath?: string } {
  const worktreeFlag = flag('--worktree');
  const explicitPath = flag('--worktree-path');
  const inPlaceFlag = flag('--in-place');
  const requestedPath =
    worktreeFlag && worktreeFlag !== 'true' ? worktreeFlag : (explicitPath ?? undefined);

  // Default: worktree mode ON. Operator must pass --in-place to opt out.
  const enabled = inPlaceFlag === 'true' ? false : true;

  return {
    enabled,
    requestedPath,
  };
}

function isTerminalSessionState(state: SessionState): boolean {
  return ['completed', 'failed', 'paused'].includes(state);
}

function printUsage(): void {
  out(`
HELIX — Harness for Engineering Loops and Intelligent eXecution

Usage:
  helix audit <ABLP-KEY|"<feature title>">
                                   Holistic audit. When the positional matches a Jira key
                                   (e.g. ABLP-123), Helix auto-fetches the ticket and fills
                                   title/description/scope. Otherwise the positional is the title.
  helix audit --concerns           Deterministic cross-cutting concerns scan (stateless, no session)
  helix audit --template drift-audit
                                   Drift audit pipeline: runs concerns audit, lands findings on a session
  helix fix <ABLP-KEY|"<bug description>">
                                   Reproduce, root-cause, fix, and regress a bug. Same Jira-key
                                   auto-bootstrap as 'helix audit'.
  helix resume <session-id>        Resume a paused/interrupted session
  helix logs <session-id>          Show session progress log
  helix logs <session-id> --follow Live-tail session progress (like tail -f)
  helix watch <session-id>         Follow both session state and progress log updates
  helix smoke                      Run a bounded structured-output smoke probe
  helix canary                     Run a bounded multi-stage orchestration canary
  helix doctor                     Inspect repo readiness and write a JSON report
  helix bootstrap                  Pre-warm the verification-bootstrap cache (run once after git pull;
                                   subsequent helix audit/fix sessions reuse the cache instead of paying
                                   the full build + typecheck-baseline cost on first run)
  helix review-branch [<branch>]   Audit a branch's diff. Just pass the branch name; helix resolves
                                   the ref (tries bare, then origin/<name>) and auto-detects the base
                                   (origin/develop, else origin/main). No checkout needed. Use
                                   --dry-run to preview the WorkItem without launching the pipeline.
  helix status                     Show active sessions
  helix pipelines                  List available pipeline templates
  helix jira mine                  Fetch assigned JIRA issues and build a quality-first model-triaged HELIX work plan
  helix index rebuild              Consolidate per-session embedding shards into flat findings.jsonl / decisions.jsonl
                                   (requires --enable-embeddings or HELIX_EMBEDDINGS_ENABLED=true)
  helix drift sync <session-id>    Sync drift-audit findings to JIRA (one ticket per package × concern)

Options:
  --scope <packages>       Comma-separated list of affected packages
  --title <text>           Override the canary title (default: HELIX canary audit)
  --schema <id>            Structured output schema for smoke (default: analysis-report)
  --timeout <seconds>      Hard deadline for smoke/canary deep scan (default: 90 smoke, 300 canary)
  --lines <n>              Recent log lines to print before watch starts (default: 20)
  --poll-ms <ms>           Watch polling interval in milliseconds (default: 1000)
  --stale-ms <ms>          Heartbeat age that triggers a stale warning in watch mode (default: 60000)
  --jira <key>             JIRA ticket key (e.g., ABLP-123)
  --spec <path>            Path to existing feature spec
  --test-spec <path>       Path to existing test specification
  --hld <path>             Path to existing HLD specification
  --lld <path>             Path to existing LLD / implementation plan
  --description <text>     Detailed description of the work
  --branch <name>          Target branch (default: current)
  --assignee <name>        JIRA assignee for helix jira mine (default: currentUser())
  --open-only              Exclude resolved/closed issues from JIRA assignee triage
  --run-simple             Run model-approved simple scoped JIRA issues through HELIX after triage
  --limit <n>              Max JIRA issues to fetch for assignee triage (default: 50)
  --simple-limit <n>       Max simple issues to run or emit commands for (default: 5)
  --codex-path <path>      Path to codex CLI binary (default: codex)
  --claude-path <path>     Path to claude CLI binary (default: claude)
  --allow-model-fallbacks  Permit runtime model fallback after a primary failure (default: false)
  --enable-embeddings      Enable BGE-M3 embeddings retrieval and shard persistence (default: off)
  --embedding-base-url <u> BGE-M3 service URL (default: HELIX_EMBEDDING_BASE_URL or http://localhost:8000)
  --embedding-shard-base-path <path>
                           Embedding shard base directory (default: .helix/cache/embeddings/bge-m3-1024)
  --budget <usd>           Total budget limit in USD (default: 200)
  --auto-commit            Auto-commit slices without approval
  --auto-approve           Auto-approve checkpoints and answer questions conservatively
  --autonomy <mode>        Autonomy mode: manual or thresholded (default: manual)
  --auto-commit-risk <r>   Highest risk HELIX may auto-commit in thresholded mode (default: medium)
  --auto-commit-confidence Minimum confidence score needed for autonomous commits (default: 6)
  --high-confidence-threshold Score HELIX treats as high-confidence evidence (default: 9)
  --interactive, -i        Enable interactive REPL (inject context, skip stages, etc.)
  --verbose, -v            Show model streaming output
  --worktree[=<path>]      Run audit/fix/canary in a detached git worktree (default: ON)
  --worktree-path <path>   Override the detached worktree path explicitly
  --in-place               Disable worktree isolation; run directly in the source tree
  --skip-worktree-install  Skip bootstrap install in freshly created worktrees
  --stage-max-turns <list> Override per-stage maxTurns budgets, e.g.
                           --stage-max-turns regression=40,implementation=200
                           Format: comma-separated <stageType>=<positiveInt>.
                           Applies to primary, fallback, and layered model specs.
  --cheap-implementer      Cheap-loop + expensive-gate cost reduction. Swaps
                           every implementation-stage primary to claude-code/
                           sonnet (cheap, loops via quality gate); the original
                           primary becomes fallback. Layered review and gate
                           model-reviews stay on opus as the discriminator.
  --workdir <path>         Project root directory (default: cwd)
  --config <path>          Path to helix.config.yaml (default: ./helix.config.yaml)
  --verification <path>    Path to helix.verification.yaml (default: ./helix.verification.yaml)
  --report <path>          Override readiness report output path
  --json                   Print the doctor report as JSON
  --concerns               Run deterministic concerns scan (use with helix audit)
  --only <ids>             Concerns audit: comma-separated concern ids to run
  --tier <blocking|advisory> Concerns audit: restrict to one tier (default: both)
  --concerns-dir <path>    Concerns audit: override .helix/concerns root
  --output-dir <path>      Concerns audit: override findings output directory
  --no-write               Concerns audit: skip writing findings files
  --project <KEY>          Drift sync: JIRA project key (default: $JIRA_PROJECT_KEY or ABLP)
  --auto-approve           Drift sync: apply without confirmation prompt
  --dry-run                Drift sync / index rebuild: preview only, no writes
  --all                    Index rebuild: scan all session shards (default behavior)
  --session <id>           Index rebuild: scope rebuild to a single session shard

Examples:
  helix audit --concerns
  helix audit --concerns --tier blocking --only tenant-isolation,test-integrity
  helix audit --template drift-audit --scope packages/compiler
  helix audit --template drift-audit "Helix drift sweep" --scope packages/helix --jira ABLP-406
  helix audit "Channel Parity" --scope apps/runtime,packages/execution --jira ABLP-200
  helix audit "Project RBAC" --scope apps/studio,packages/database --spec docs/features/custom-project-roles.md --test-spec docs/testing/custom-project-roles.md --lld docs/plans/2026-04-09-project-rbac-management-impl-plan.md
  helix audit "Channel Parity" --interactive --scope apps/runtime,packages/execution
  helix audit "HELIX worktree support" --worktree --scope packages/helix
  helix fix "Empty response from voice agent" --jira ABLP-201 --scope apps/runtime
  helix jira mine --scope apps/runtime,packages/compiler --simple-limit 3
  helix smoke --scope packages/helix/src/pipeline --timeout 60
  helix canary --scope packages/helix/src/models,packages/helix/src/pipeline --timeout 240 --jira ABLP-139
  helix doctor
  helix doctor --json
  helix resume a1b2c3d4
  helix watch a1b2c3d4
  helix drift sync a1b2c3d4 --dry-run
  helix drift sync a1b2c3d4 --project ABLP --auto-approve
  helix index rebuild --enable-embeddings --dry-run
  helix index rebuild --enable-embeddings
`);
}

function parseSchemaId(value: string | undefined): StageOutputSchemaId | null {
  const raw = value ?? 'analysis-report';
  switch (raw) {
    case 'analysis-report':
    case 'reproduction-report':
    case 'slice-plan':
    case 'plan-review':
    case 'impact-analysis':
    case 'oracle-review':
    case 'workspace-reconcile':
    case 'failure-advisory':
      return raw;
    default:
      return null;
  }
}

function parseAutonomyMode(value: string | undefined): 'manual' | 'thresholded' {
  return value === 'thresholded' ? 'thresholded' : 'manual';
}

function parseRiskLevel(value: string | undefined): 'low' | 'medium' | 'high' | null {
  switch (value) {
    case 'low':
    case 'medium':
    case 'high':
      return value;
    default:
      return null;
  }
}

function parseScore(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return undefined;
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  if (!/^\d+$/.test(value.trim())) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTimeoutMs(value: string | undefined, defaultSeconds: number = 90): number {
  const seconds = Number.parseInt(value ?? String(defaultSeconds), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return defaultSeconds * 1000;
  }
  return seconds * 1000;
}

async function readLastLines(filePath: string, maxLines: number): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(filePath, 'utf-8');
    const lines = raw.split('\n');
    const tail = lines.slice(-(maxLines + 1)).filter((line, index, list) => {
      return !(index === list.length - 1 && line === '');
    });
    return tail.join('\n');
  } catch {
    return '';
  }
}

function resolveHelixStatePath(workDir: string, ...segments: string[]): string {
  return resolve(workDir, HELIX_STATE_DIR, ...segments);
}

function buildCanarySummary(
  session: Session,
  canaryConfig: HelixConfig,
  events: ReturnType<CanaryProgressReporter['snapshot']>,
  reportPath: string,
): Record<string, unknown> {
  const journalSlug = session.workItem.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return {
    createdAt: new Date().toISOString(),
    reportPath,
    sessionId: session.id,
    state: session.state,
    error: session.error ?? null,
    scope: session.workItem.scope,
    stageCount: session.stageHistory.length,
    findings: session.findings.length,
    decisions: session.decisions.length,
    slices: session.slices.map((slice) => ({
      index: slice.index,
      title: slice.title,
      status: slice.status,
      entryConditions: slice.manifest.entryConditions.length,
      fileContracts: slice.manifest.fileContracts.length,
      exportContracts: slice.manifest.exportContracts.length,
      requiredTests: slice.testLock.requiredTests.length,
      risk: slice.impactAnalysis.riskLevel,
    })),
    stages: session.stageHistory.map((stage) => ({
      name: stage.stageName,
      status: stage.status,
      durationMs: stage.durationMs,
      findings: stage.findings.length,
      decisions: stage.decisions.length,
      error: stage.error ?? null,
      outputPreview: stage.output.slice(0, 1000),
    })),
    artifacts: {
      sessionPath: join(canaryConfig.sessionDir, session.id, 'session.json'),
      journalPath: join(canaryConfig.journalDir, journalSlug, 'journal.md'),
    },
    promptContext: buildPromptContextSummary(session.promptContext),
    recentEvents: events,
  };
}

function buildPromptContextSummary(
  promptContext: Session['promptContext'],
): Record<string, unknown> | null {
  if (!promptContext) {
    return null;
  }

  const scopedFileCount =
    promptContext.codeMap?.repoIndex?.scopedFileCount ??
    promptContext.codeMap?.allFiles?.length ??
    (promptContext.codeMap?.totalSourceFiles ?? 0) + (promptContext.codeMap?.totalTestFiles ?? 0);

  return {
    builtAt: promptContext.builtAt,
    buildDurationMs: promptContext.buildDurationMs ?? null,
    instructionDocCount: promptContext.instructionDocs.length,
    hasFeatureSpecDoc: promptContext.featureSpecDoc != null,
    hasPriorFindingsDoc: promptContext.priorFindingsDoc != null,
    hasPriorDecisionsDoc: promptContext.priorDecisionsDoc != null,
    codeMap: promptContext.codeMap
      ? {
          scope: promptContext.codeMap.scope,
          totalSourceFiles: promptContext.codeMap.totalSourceFiles,
          totalTestFiles: promptContext.codeMap.totalTestFiles,
          keyFileCount: promptContext.codeMap.keyFiles.length,
          scopedFileCount,
          repoIndexCacheStatus: promptContext.codeMap.repoIndex?.cacheStatus ?? null,
          repoIndexLoadDurationMs: promptContext.codeMap.repoIndex?.loadDurationMs ?? null,
          repoIndexDiffHash: promptContext.codeMap.repoIndex?.diffHash ?? null,
        }
      : null,
  };
}
