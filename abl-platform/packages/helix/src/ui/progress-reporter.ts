import type {
  CheckpointOptions,
  Decision,
  Finding,
  ProgressEvent,
  ProgressReporter,
} from '../types.js';

const DEFAULT_AUTO_APPROVE_ANSWER =
  'Always apply a robust, architecturally sound solution. Do not take shortcuts. Fix the root cause — if the code is hard to test or integrate, redesign the interface. If the answer requires a breaking change, classify as AMBIGUOUS so the user can confirm.';

/**
 * Terminal-based progress reporter.
 *
 * Streams chatty, incremental output to stdout so the user sees
 * exactly what HELIX is doing at every step. Designed for both
 * standalone CLI and VS Code terminal.
 *
 * Output is ALWAYS visible — no silent running. The `verbose` flag
 * controls whether full model output is shown vs summaries.
 */
export class TerminalProgressReporter implements ProgressReporter {
  private currentStage = '';
  private stageStartTime = 0;
  private findingCount = 0;
  private sliceCount = 0;
  private sessionCostUsd = 0;

  constructor(
    private readonly verbose: boolean = false,
    private readonly autoApprove: boolean = false,
    private readonly autoApproveAnswer: string = DEFAULT_AUTO_APPROVE_ANSWER,
  ) {}

  emit(event: ProgressEvent): void {
    const ts = this.shortTime(event.timestamp);

    switch (event.type) {
      case 'session-start':
        this.printHeader(event.message);
        break;

      case 'stage-enter':
        this.currentStage = event.stage ?? '';
        this.stageStartTime = Date.now();
        this.printStageEnter(event.stage ?? '', event.message);
        break;

      case 'stage-progress':
        this.printProgress(ts, event.message, event.details);
        break;

      case 'stage-exit':
        this.printStageExit(event.stage ?? '', event.message, event.details);
        break;

      case 'finding-new':
        this.findingCount++;
        this.printFinding(event.details as unknown as Finding);
        break;

      case 'decision-needed':
        this.printDecisionNeeded(event.details as unknown as Decision);
        break;

      case 'decision-resolved':
        this.printDecisionResolved(event.details as unknown as Decision);
        break;

      case 'slice-start':
        this.sliceCount = event.slice ?? this.sliceCount;
        this.printSliceStart(event.slice ?? 0, event.message);
        break;

      case 'slice-complete':
        this.printSliceComplete(event.slice ?? 0, event.message);
        break;

      case 'commit':
        this.printCommit(event.message);
        break;

      case 'quality-gate-result':
        this.printQualityGate(event.message, event.details);
        break;

      case 'oracle-vote':
        this.printOracleVote(event.message, event.details);
        break;

      case 'model-stream':
        // Always show tool usage and turn summaries
        this.printModelStream(event.message, event.details);
        break;

      case 'error':
        this.printError(event.message);
        break;

      case 'session-complete':
        this.printSessionComplete(event.message, event.details);
        break;
    }
  }

  async onQuestion(decision: Decision): Promise<string> {
    if (this.autoApprove) {
      this.printDecisionNeeded(decision);
      write(dim(`  Auto-answer: ${this.autoApproveAnswer}`) + '\n');
      return this.autoApproveAnswer;
    }

    this.printDecisionNeeded(decision);
    return this.promptUser(`  Your answer: `);
  }

  async onCheckpoint(
    message: string,
    data?: unknown,
    options?: CheckpointOptions,
  ): Promise<boolean> {
    write('\n');
    write(dim('━'.repeat(60)) + '\n');
    write(bold(`  CHECKPOINT: ${message}`) + '\n');
    if (options?.forceInteractive) {
      write(dim('  (escalation: interactive prompt forced even with --auto-approve)') + '\n');
    }
    write(dim('━'.repeat(60)) + '\n');

    this.renderCheckpointData(data);

    if (this.autoApprove && !options?.forceInteractive) {
      write(dim('  Auto-approving checkpoint') + '\n');
      return true;
    }

    const answer = await this.promptUser('  Approve? (y/n): ');
    return answer.toLowerCase().startsWith('y');
  }

  private renderCheckpointData(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const record = data as Record<string, unknown>;
    const autonomy = normalizeScalarField(record['autonomy']);
    if (autonomy) {
      write(`  Autonomy: ${autonomy}` + '\n');
    }

    const sliceDescription = normalizeScalarField(record['sliceDescription']);
    if (sliceDescription) {
      write(`  Scope: ${sliceDescription}` + '\n');
    }

    // Render findings summary
    const findings = record['findings'] as
      | Array<{ severity?: string; title?: string; status?: string }>
      | undefined;
    if (Array.isArray(findings) && findings.length > 0) {
      write('\n');
      write(bold('  Findings:') + '\n');
      for (const f of findings) {
        const sev = f.severity ? severityColor(f.severity)(`[${f.severity.toUpperCase()}]`) : '';
        const status = f.status ? dim(` (${f.status})`) : '';
        write(`    ${sev} ${f.title ?? 'untitled'}${status}` + '\n');
      }
    }

    // Render slices (the implementation plan)
    const slices = record['slices'] as
      | Array<{
          index?: number;
          title?: string;
          status?: string;
          findings?: string[];
          files?: string[];
          tests?: string[];
        }>
      | undefined;
    if (Array.isArray(slices) && slices.length > 0) {
      write('\n');
      write(bold('  Implementation Plan:') + '\n');
      for (const slice of slices) {
        const idx = slice.index != null ? slice.index + 1 : '?';
        const status = slice.status ? dim(` [${slice.status}]`) : '';
        write(bold(blue(`\n    Slice ${idx}: ${slice.title ?? 'untitled'}`)) + status + '\n');

        if (Array.isArray(slice.files) && slice.files.length > 0) {
          write(dim(`      Files (${slice.files.length}):`) + '\n');
          for (const file of slice.files.slice(0, 10)) {
            write(dim(`        ${file}`) + '\n');
          }
          if (slice.files.length > 10) {
            write(dim(`        ... and ${slice.files.length - 10} more`) + '\n');
          }
        }

        if (Array.isArray(slice.tests) && slice.tests.length > 0) {
          write(dim(`      Tests (${slice.tests.length}):`) + '\n');
          for (const test of slice.tests.slice(0, 5)) {
            write(dim(`        ${test}`) + '\n');
          }
          if (slice.tests.length > 5) {
            write(dim(`        ... and ${slice.tests.length - 5} more`) + '\n');
          }
        }

        if (Array.isArray(slice.findings) && slice.findings.length > 0) {
          write(dim(`      Addresses: ${slice.findings.length} finding(s)`) + '\n');
        }
      }
    }

    const dependencies = normalizeStringList(record['dependencies']);
    if (dependencies.length > 0) {
      write('\n');
      write(bold('  Dependencies:') + '\n');
      for (const dependency of dependencies) {
        write(dim(`    ${dependency}`) + '\n');
      }
    }

    // Render commit-checkpoint data (files, testLock, exitCriteria)
    const files = record['files'] as string[] | undefined;
    if (Array.isArray(files) && files.length > 0 && !slices) {
      write('\n');
      write(bold('  Files:') + '\n');
      for (const file of files.slice(0, 15)) {
        write(dim(`    ${file}`) + '\n');
      }
      if (files.length > 15) {
        write(dim(`    ... and ${files.length - 15} more`) + '\n');
      }
    }

    const requiredTests = normalizeRequiredTests(record['requiredTests']);
    if (requiredTests.length > 0) {
      write('\n');
      write(bold('  Required Tests:') + '\n');
      for (const test of requiredTests.slice(0, 10)) {
        const status = test.status ? dim(` [${test.status}]`) : '';
        const detail = test.description ? dim(` — ${test.description}`) : '';
        write(`    ${test.path}${status}${detail}` + '\n');
      }
      if (requiredTests.length > 10) {
        write(dim(`    ... and ${requiredTests.length - 10} more`) + '\n');
      }
    }

    const regressionTests = normalizeStringList(record['regressionTests']);
    if (regressionTests.length > 0) {
      write('\n');
      write(bold('  Regression Suite:') + '\n');
      for (const test of regressionTests.slice(0, 10)) {
        write(dim(`    ${test}`) + '\n');
      }
      if (regressionTests.length > 10) {
        write(dim(`    ... and ${regressionTests.length - 10} more`) + '\n');
      }
    }

    const testLock = record['testLock'] as string | undefined;
    if (testLock) {
      write(dim(`  Tests: ${testLock}`) + '\n');
    }

    const exitCriteria = record['exitCriteria'] as string | undefined;
    if (exitCriteria) {
      write(dim(`  Exit criteria: ${exitCriteria}`) + '\n');
    }

    const exitCriteriaItems = normalizeExitCriteriaItems(record['exitCriteriaItems']);
    if (exitCriteriaItems.length > 0) {
      write('\n');
      write(bold('  Exit Criteria Detail:') + '\n');
      for (const criterion of exitCriteriaItems) {
        const icon = criterion.passed ? green('✓') : red('✗');
        const detail = criterion.detail ? dim(` — ${criterion.detail}`) : '';
        write(`    ${icon} ${criterion.id}${detail}` + '\n');
      }
    }

    const recommendedAction = record['recommendedAction'] as string | undefined;
    const suspectedCause = record['suspectedCause'] as string | undefined;
    const summary = record['summary'] as string | undefined;
    const promptGuidance = record['promptGuidance'] as string | null | undefined;
    const operatorActions = record['operatorActions'] as string[] | undefined;
    const failureCategory = record['failureCategory'] as string | undefined;
    const failureSignature = record['failureSignature'] as string | undefined;
    const sourceError = record['sourceError'] as string | undefined;
    if (summary || suspectedCause || recommendedAction || sourceError) {
      write('\n');
      write(bold('  Failure Advisory:') + '\n');
      if (summary) {
        write(`    Summary: ${summary}` + '\n');
      }
      if (suspectedCause) {
        write(`    Cause: ${suspectedCause}` + '\n');
      }
      if (recommendedAction) {
        write(`    Recommended action: ${recommendedAction}` + '\n');
      }
      if (failureCategory) {
        write(`    Category: ${failureCategory}` + '\n');
      }
      if (failureSignature) {
        write(dim(`    Signature: ${failureSignature}`) + '\n');
      }
      if (sourceError) {
        write(dim(`    Error: ${sourceError}`) + '\n');
      }
      if (promptGuidance) {
        write(dim(`    Retry guidance: ${promptGuidance}`) + '\n');
      }
      if (Array.isArray(operatorActions) && operatorActions.length > 0) {
        write(dim('    Operator actions:') + '\n');
        for (const action of operatorActions) {
          write(dim(`      - ${action}`) + '\n');
        }
      }
    }

    // Render decisions if present
    const decisions = record['decisions'] as
      | Array<{ question?: string; classification?: string; answer?: string | null }>
      | undefined;
    if (Array.isArray(decisions) && decisions.length > 0) {
      const pending = decisions.filter((d) => d.classification === 'AMBIGUOUS' && !d.answer);
      if (pending.length > 0) {
        write('\n');
        write(bold(yellow(`  ⚠ ${pending.length} pending decision(s):`)) + '\n');
        for (const d of pending) {
          write(`    ${d.question ?? '?'}` + '\n');
        }
      }
    }

    write('\n');
    write(dim('━'.repeat(60)) + '\n');
  }

  // ── Formatters ──────────────────────────────────────────────

  private printHeader(message: string): void {
    write('\n');
    write(bold(cyan('━'.repeat(60))) + '\n');
    write(bold(cyan(`  HELIX — ${message}`)) + '\n');
    write(bold(cyan('━'.repeat(60))) + '\n');
    write('\n');
  }

  private printStageEnter(stage: string, message: string): void {
    write('\n');
    write(bold(yellow(`▸ STAGE: ${stage}`)) + '\n');
    write(dim(`  ${message}`) + '\n');
  }

  private printProgress(ts: string, message: string, details?: Record<string, unknown>): void {
    const cost = details?.['costUsd'] as number | undefined;
    const costStr = cost != null && cost > 0 ? dim(` | $${cost.toFixed(2)} spent`) : '';
    write(dim(`  ${ts} `) + message + costStr + '\n');
  }

  private printStageExit(stage: string, message: string, details?: Record<string, unknown>): void {
    const elapsed = Date.now() - this.stageStartTime;
    const stageCost = details?.['costUsd'] as number | undefined;
    if (stageCost != null && stageCost > 0) {
      this.sessionCostUsd += stageCost;
    }
    const costStr =
      this.sessionCostUsd > 0 ? dim(` | $${this.sessionCostUsd.toFixed(2)} total`) : '';
    write(green(`✓ ${stage}`) + dim(` (${formatDuration(elapsed)})`) + costStr + '\n');
    if (message) write(dim(`  ${message}`) + '\n');
  }

  private printFinding(finding: Finding | undefined): void {
    if (!finding) return;
    const sevColor = severityColor(finding.severity);
    write(
      `  ${sevColor(`[${finding.severity.toUpperCase()}]`)} ` +
        `${bold(finding.title)}` +
        dim(` — ${finding.category}`) +
        '\n',
    );
    if (this.verbose && finding.description) {
      write(dim(`    ${finding.description}`) + '\n');
    }
    if (finding.files.length > 0) {
      write(dim(`    ${finding.files.map((f) => f.path).join(', ')}`) + '\n');
    }
  }

  private printDecisionNeeded(decision: Decision): void {
    write('\n');
    write(bold(magenta('  ? DECISION NEEDED')) + '\n');
    write(`    ${decision.question}` + '\n');
    if (decision.context) {
      write(dim(`    Context: ${decision.context}`) + '\n');
    }
    if (decision.oracleVotes.length > 0) {
      write(dim('    Oracle opinions:') + '\n');
      for (const vote of decision.oracleVotes) {
        const conf = `${(vote.confidence * 100).toFixed(0)}%`;
        write(dim(`      ${vote.oracleName} (${conf}): `) + vote.answer + '\n');
      }
    }
  }

  private printDecisionResolved(decision: Decision): void {
    write(
      green(`  ✓ Decided: `) +
        dim(`[${decision.classification}] `) +
        (decision.answer ?? 'N/A') +
        '\n',
    );
  }

  private printSliceStart(index: number, message: string): void {
    write('\n');
    write(bold(blue(`▶ SLICE ${index + 1}: ${message}`)) + '\n');
  }

  private printSliceComplete(index: number, message: string): void {
    write(green(`✅ Slice ${index + 1} complete`) + dim(` — ${message}`) + '\n');
  }

  private printCommit(message: string): void {
    write(bold(green(`📦 Committed: `)) + message + '\n');
  }

  private printQualityGate(message: string, details?: Record<string, unknown>): void {
    const passed = details?.['passed'] as boolean | undefined;
    const icon = passed ? green('✓') : red('✗');
    write(`  ${icon} Quality gate: ${message}` + '\n');
  }

  private printOracleVote(message: string, details?: Record<string, unknown>): void {
    const oracle = (details?.['oracle'] as string) ?? 'unknown';
    const confidence = details?.['confidence'] as number | undefined;
    const confStr = confidence != null ? ` (${(confidence * 100).toFixed(0)}%)` : '';
    write(dim(`  🔮 ${oracle}${confStr}: `) + message + '\n');
  }

  private printModelStream(message: string, details?: Record<string, unknown>): void {
    // Tool usage — ALWAYS show, this is the key visibility the user wants
    const tool = details?.['tool'] as string | undefined;
    if (tool) {
      write(dim(`    🔧 ${message}`) + '\n');
      return;
    }

    // Turn summaries — always show
    if (message.startsWith('[turn ')) {
      write(dim(`    ${message}`) + '\n');
      return;
    }

    // Heartbeat — always show
    if (message.startsWith('...')) {
      write(dim(`    ${message}`) + '\n');
      return;
    }

    // Tool result line counts — always show
    if (message.startsWith('  ←')) {
      write(dim(`    ${message}`) + '\n');
      return;
    }

    // Full model output — only in verbose mode
    if (this.verbose) {
      write(dim(`    ${message}`) + '\n');
    }
  }

  private printError(message: string): void {
    write(bold(red(`  ❌ ERROR: ${message}`)) + '\n');
  }

  private printSessionComplete(message: string, details?: Record<string, unknown>): void {
    write('\n');
    write(bold(green('━'.repeat(60))) + '\n');
    write(bold(green(`  SESSION COMPLETE`)) + '\n');
    write(`  ${message}` + '\n');
    if (details) {
      const sessionId = normalizeScalarField(details['sessionId']);
      const resumeCommand = normalizeScalarField(details['resumeCommand']);
      const findings = details['totalFindings'] as number | undefined;
      const fixed = details['findingsFixed'] as number | undefined;
      const commits = details['totalCommits'] as number | undefined;
      const totalCost = details['totalCostUsd'] as number | undefined;
      if (sessionId) write(`  Session: ${sessionId}` + '\n');
      if (resumeCommand) write(`  Resume: ${resumeCommand}` + '\n');
      if (findings != null) write(`  Findings: ${fixed ?? 0}/${findings} fixed` + '\n');
      if (commits != null) write(`  Commits: ${commits}` + '\n');
      if (totalCost != null && totalCost > 0) {
        write(`  Cost: $${totalCost.toFixed(2)}` + '\n');
      }
    }
    write(bold(green('━'.repeat(60))) + '\n');
    write('\n');
  }

  private shortTime(iso: string): string {
    try {
      return new Date(iso).toLocaleTimeString('en-US', { hour12: false });
    } catch {
      return '';
    }
  }

  protected promptUser(prompt: string): Promise<string> {
    return (async () => {
      const readline = await import('node:readline/promises');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        const answer = await rl.question(prompt);
        return answer.trim();
      } finally {
        rl.close();
      }
    })();
  }
}

// ── ANSI helpers (no dependencies) ────────────────────────────

function write(s: string): void {
  process.stdout.write(s);
}

function normalizeScalarField(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return null;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
}

function normalizeRequiredTests(
  value: unknown,
): Array<{ path: string; status?: string; description?: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        return { path: entry };
      }
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const path = normalizeScalarField(record['path']);
      if (!path) {
        return null;
      }
      return {
        path,
        status: normalizeScalarField(record['status']) ?? undefined,
        description: normalizeScalarField(record['description']) ?? undefined,
      };
    })
    .filter((entry): entry is { path: string; status?: string; description?: string } =>
      Boolean(entry),
    );
}

function normalizeExitCriteriaItems(
  value: unknown,
): Array<{ id: string; passed: boolean; detail?: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: Array<{ id: string; passed: boolean; detail?: string } | null> = value.map(
    (entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const id = normalizeScalarField(record['id']);
      if (!id) {
        return null;
      }
      const detail = normalizeScalarField(record['detail']) ?? undefined;
      return detail == null
        ? { id, passed: Boolean(record['passed']) }
        : { id, passed: Boolean(record['passed']), detail };
    },
  );

  return normalized.filter((entry): entry is { id: string; passed: boolean; detail?: string } =>
    Boolean(entry),
  );
}

const supportsColor = process.stdout.isTTY !== false;

function ansi(code: string): (s: string) => string {
  if (!supportsColor) return (s) => s;
  return (s) => `\x1b[${code}m${s}\x1b[0m`;
}

const bold = ansi('1');
const dim = ansi('2');
const red = ansi('31');
const green = ansi('32');
const yellow = ansi('33');
const blue = ansi('34');
const magenta = ansi('35');
const cyan = ansi('36');

function severityColor(severity: string): (s: string) => string {
  switch (severity) {
    case 'critical':
      return bold;
    case 'high':
      return red;
    case 'medium':
      return yellow;
    case 'low':
      return blue;
    default:
      return dim;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}
