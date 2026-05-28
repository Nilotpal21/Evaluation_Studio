import type {
  ExecutorEfficiencyBudget,
  FailureAdvisoryCategory,
  Session,
  Slice,
  StageDefinition,
  StageResult,
} from '../types.js';
import { buildStageOutputInstructions } from './stage-output-schema.js';
import { formatPlanReviewCarryForward, getVisiblePlanFindings } from './plan-review-state.js';
import { getSliceFiles } from './slice-view.js';

const MAX_STAGE_OUTPUT_CHARS = 60_000;
const MAX_PROMPT_CONTEXT_CHARS = 16_000;
const MAX_FINDINGS = 200;
const MAX_COMMITS = 10;

export const PLAN_QUALITY_REVIEW_GUIDANCE = [
  'Review the proposed slice plan as a blocking architect, but preserve slices that are already sound.',
  'For EVERY slice in the proposed plan, emit a slice assessment: approved or revise.',
  'Reject only the slices that still have blocking issues. Do not reopen unrelated slices that are already sound.',
  'If a slice is structurally correct but needs stronger evidence, keep the slice and use requiredTestAmendments instead of rewriting the whole plan.',
  'Treat missing required regression coverage, wrong dependency ordering, shared seam mistakes, missing runtime consumers, auth/isolation/security gaps, and incomplete consumer wiring as blocking.',
  'Only use deferred backlog findings when postponing them does not weaken dependency order, seam stability, security/isolation, or regression confidence.',
  'Use advisory findings for non-blocking polish or future cleanup.',
].join('\n');

export const IMPLEMENTATION_QUALITY_REVIEW_GUIDANCE = [
  'Review the implementation as a blocking quality gate.',
  'Reject the change when it patches symptoms in multiple consumers instead of fixing the shared invariant at the seam.',
  'Reject the change when superseded or duplicate paths remain even though this pass could safely converge or remove them.',
  'Reject the change when imports, exports, or downstream consumers are left partially wired.',
  'Reject the change when regression coverage proves only a local branch instead of the invariant the slice is meant to stabilize.',
  'Reject the change when negative-path proof is missing for a changed invariant, especially auth/isolation, validation, downgrade/update, or persistence-layer behavior.',
  'Reject the change when validation or model invariants were only proven at the service/route layer even though the seam also lives in schemas, repos, or models.',
  'Approve only when the fix is architecturally sound, complete, robust, and maintainable for follow-on work.',
].join('\n');

export const WIRING_VERIFICATION_REVIEW_GUIDANCE = [
  'Review the change as a blocking wiring verification gate.',
  'Reject the change when imports, exports, consumers, routes, middleware registration, or downstream callers are only partially updated.',
  'Reject the change when the direct seam was fixed locally but dependents or exported contracts still reference stale assumptions.',
  'Reject the change when duplicate or superseded routes, adapters, or consumers remain alive and create ambiguous behavior.',
  'Approve only when the seam is fully connected end-to-end for the current implementation pass.',
].join('\n');

export const SECURITY_ISOLATION_REVIEW_GUIDANCE = [
  'Review the change as a blocking security and isolation gate.',
  'Reject the change when auth, tenant/project/user isolation, validation, or authorization negative paths are missing or only implied.',
  'Reject the change when public-boundary behavior is only proven through service/unit tests and not through the boundary that enforces auth, validation, or isolation.',
  'Reject the change when persistence or repo updates can still violate the intended invariant even though the route/service path looks correct.',
  'Approve only when the immediate security/isolation invariants are explicitly proven and no obvious bypass remains.',
].join('\n');

export const SECURITY_AUDIT_STAGE_GUIDANCE = [
  'You are the HELIX Security Audit stage.',
  'Audit the current implementation for blocking security, auth, validation, and tenant/project/user isolation risks.',
  'Use the current workspace diff, preloaded context, and targeted tools first; do not rediscover the whole repo.',
  'Prefer package-local scripts, previously proven verification commands, and repo-native test configs over ad hoc raw test invocations.',
  'When Python proof is required and the repo carries a checked-in local interpreter or virtualenv, invoke tests through that interpreter (for example `.venv/bin/python -m pytest`) instead of assuming bare `pytest` will resolve the right environment.',
  'Match the test runner config to the file type: if the repo provides a dedicated E2E config, do not route `*.e2e.*` files through a unit or core Vitest config.',
  'When you find a scoped, clearly-correct security fix, apply it directly before you emit your final report.',
  'Only leave findings in the final report when they are still blocking after your attempted remediation.',
  'Focus on authn/authz, fail-closed isolation, input validation, secret leakage, insecure defaults, data exposure, and boundary-level negative paths.',
  'If the change does not touch a security-sensitive or externally reachable surface, complete quickly and return zero findings.',
].join('\n');

export const UX_DESIGN_AUDIT_STAGE_GUIDANCE = [
  'You are the HELIX UX Design Audit stage.',
  'Audit the current implementation for blocking user-experience and accessibility regressions on the touched user-facing surfaces.',
  'Use the current workspace diff, preloaded context, and targeted tools first; do not rediscover the whole repo.',
  'When you find a scoped, clearly-correct UX improvement, apply it directly before you emit your final report.',
  'Only leave findings in the final report when they are still blocking after your attempted remediation.',
  'Focus on discoverability, clarity of labels and calls to action, empty/loading/error states, keyboard/accessibility issues, destructive action safety, and consistency with the existing product/design language.',
  'If the change does not affect a user-facing surface, complete quickly and return zero findings.',
].join('\n');

export const ACCEPTANCE_VERIFICATION_REVIEW_GUIDANCE = [
  'Review the completed feature pass as a blocking acceptance gate.',
  'Reject the result when immediate or next findings are still only partially addressed, even if the narrow local proof is green.',
  'Reject the result when changed invariants lack a positive-path and negative-path proof, or when integration/E2E proof is too weak to show real user-facing behavior.',
  'Reject Jira-backed work when the final evidence does not map Jira scenario -> root cause -> fix commit -> exact evidence artifact -> verification command -> residual risk.',
  'Reject UI tickets that only captured a generic page load instead of Studio video/screenshots for the specific Jira scenario.',
  'Reject API/runtime tickets that cite only unit-test JSON instead of actual response/header/body artifacts.',
  'Reject the result when discovered model/schema/repo seams were left untouched without an explicit equivalence argument.',
  'Approve only when correctness, coverage, and acceptance confidence are at least as strong as the intended feature outcome.',
].join('\n');

export const PRODUCTION_READINESS_REVIEW_GUIDANCE = [
  'Review the result as a blocking production-readiness gate.',
  'Reject the result when required schema/model/index changes, audit logging, docs, or operational wiring are missing for the implemented behavior.',
  'Reject the result when the system can pass local proof while still leaving persistence, indexing, migration, or rollout risks unresolved.',
  'Treat missing immediate/next readiness work as blocking; near-term or long-term follow-up can remain deferred only when it does not weaken correctness or safety.',
  'Start from the carried regression proof and required tests already declared for the stage. Do not rediscover a broader repo-wide test plan unless that carried proof fails.',
  'Use the same config-aware, targeted command shapes that the stage used to prove the seam. Prefer focused package builds and explicit Vitest configs over repo-root `pnpm test -- --runInBand` style retries.',
  'When Python proof is required and the repo carries a checked-in local interpreter or virtualenv, invoke tests through that interpreter (for example `.venv/bin/python -m pytest`) instead of assuming bare `pytest` resolves the correct environment.',
  'Approve only when the resulting change is safe to carry forward without hidden operational or persistence gaps.',
].join('\n');

interface BlockingModelReviewPromptParams {
  stageName: string;
  session: Session;
  stageOutput?: string;
  reviewEvidence?: string;
  promptContext?: string;
  reviewInstructions?: string;
}

interface WorkspaceReconcilePromptParams {
  session: Session;
  slice: Slice;
  stageName: string;
  reviewScopeEntries: string[];
  actualChangedFiles: string[];
  outOfScopeChanges: string[];
}

interface FailureAdvisoryPromptParams {
  session: Session;
  stage: StageDefinition;
  result: StageResult;
  failureCategory: FailureAdvisoryCategory;
  failureSignature: string;
  priorRetryCount: number;
  currentEfficiencyBudget?: ExecutorEfficiencyBudget;
}

export function buildBlockingModelReviewPrompt({
  stageName,
  session,
  stageOutput,
  reviewEvidence,
  promptContext,
  reviewInstructions,
}: BlockingModelReviewPromptParams): string {
  const sections = [
    'You are a blocking HELIX quality gate reviewer.',
    '',
    'Verify claims against the current workspace before approving. Use Read, Grep, Glob, and Bash when needed.',
    'Do not use git history (`git log`, `git show HEAD~N`, `git diff HEAD~N`) as a proxy for the current fix. Review the current workspace diff and the evidence packet instead.',
    'If any earlier stage output or notes mention file paths outside the current execution workspace, ignore those paths and reopen the corresponding files inside the current workspace before making a decision.',
    'Emit findings only for issues that should block the stage and force another pass.',
    'Approve only when the result is correct, complete, architecturally sound, future-proof, and regression-safe.',
    'Treat the findings snapshot and stage output in this prompt as the current source of truth. Do not inspect `.helix/sessions` or progress logs to reconstruct missing context.',
    '',
    '## Stage',
    `Name: ${stageName}`,
    '',
    '## Work Item',
    `Title: ${session.workItem.title}`,
    `Description: ${session.workItem.description}`,
    `Scope: ${session.workItem.scope.join(', ') || '(none)'}`,
  ];

  const findingsSnapshot = formatFindingsSnapshot(session);
  if (findingsSnapshot) {
    sections.push('', '## Open Findings Snapshot', findingsSnapshot);
  }

  const commitsSnapshot = formatCommitSnapshot(session);
  if (commitsSnapshot) {
    sections.push('', '## Commits So Far', commitsSnapshot);
  }

  sections.push(
    '',
    '## Review Standard',
    '1. Correctness and completeness',
    '2. Shared seams and invariants are stabilized at the right layer, not patched ad hoc in consumers',
    '3. Duplicate, legacy, or superseded paths are removed or clearly converged',
    '4. Imports, exports, and dependents are fully wired',
    '5. Regression coverage proves the invariant, not just the happy path',
    '6. The result improves or preserves long-term architectural clarity',
  );

  if (reviewInstructions?.trim()) {
    sections.push('', '## Gate-Specific Review Criteria', reviewInstructions.trim());
  }

  if (promptContext?.trim()) {
    sections.push(
      '',
      '## Preloaded Context',
      truncateBlock(promptContext.trim(), MAX_PROMPT_CONTEXT_CHARS),
    );
  }

  if (reviewEvidence?.trim()) {
    sections.push('', '## Precomputed Evidence Package', reviewEvidence.trim());
  }

  if (stageOutput?.trim()) {
    sections.push(
      '',
      '## Stage Output Under Review',
      truncateBlock(stageOutput.trim(), MAX_STAGE_OUTPUT_CHARS),
    );
  }

  return sections.join('\n');
}

export function buildPlanModelReviewPrompt({
  stageName,
  session,
  stageOutput,
  reviewEvidence,
  promptContext,
  reviewInstructions,
}: BlockingModelReviewPromptParams): string {
  const sections = [
    'You are a HELIX plan quality reviewer.',
    '',
    'Verify claims against the current workspace before approving or revising slices. Use Read, Grep, Glob, and Bash when needed.',
    'Preserve slices that are already sound. Request revisions only where the plan still has a blocking issue.',
    'Use blocking findings only for issues that must force another planning pass.',
    'Use advisory findings only for non-blocking polish or later follow-up.',
    'Treat the findings snapshot and stage output in this prompt as the current source of truth. Do not inspect `.helix/sessions` or progress logs to reconstruct missing context.',
    '',
    '## Stage',
    `Name: ${stageName}`,
    '',
    '## Work Item',
    `Title: ${session.workItem.title}`,
    `Description: ${session.workItem.description}`,
    `Scope: ${session.workItem.scope.join(', ') || '(none)'}`,
  ];

  const findingsSnapshot = formatFindingsSnapshot(session);
  if (findingsSnapshot) {
    sections.push('', '## Open Findings Snapshot', findingsSnapshot);
  }

  const commitsSnapshot = formatCommitSnapshot(session);
  if (commitsSnapshot) {
    sections.push('', '## Commits So Far', commitsSnapshot);
  }

  if (session.planReviewState) {
    sections.push('', '## Carry-Forward From Prior Review', formatPlanReviewCarryForward(session));
  }

  sections.push(
    '',
    '## Review Standard',
    '1. Dependency order and seam stabilization stay correct',
    '2. Shared contracts and runtime consumers are wired before downstream consumers are patched',
    '3. Required regression coverage proves each slice invariant',
    '4. Safe backlog deferrals are explicit and narrow',
    '5. Approved slices stay intact unless a revised dependency truly forces change',
  );

  sections.push(
    '',
    '## Review Efficiency Policy',
    '1. Treat the proposed slice plan as the primary artifact under review; do not reconstruct the entire repo from scratch.',
    '2. Start with slices called out in the carry-forward state, blocking findings, or missing required tests before exploring untouched slices.',
    '3. Do not reread every file listed in the plan. Spot-check the highest-risk seams, dependencies, and required tests first.',
    '4. Prefer targeted HELIX tools and direct symbol lookups over broad grep loops when the prompt already names the seam to verify.',
    '5. Replay substitutions are authoritative. If the prompt says a future-path file does not exist at the replay base, review against the listed substitute seam instead of checking file existence with `test -f`, `ls`, or broad globs.',
    '6. Treat directory inventory commands (`ls`, `find`, `fd`, `rg --files`) as off-limits unless the evidence packet is contradictory. Review the named seam, not the whole package tree.',
    '7. Emit only the final `plan-review` JSON. Do not prefix it with narration, markdown, or exploratory notes.',
  );

  if (reviewInstructions?.trim()) {
    sections.push('', '## Gate-Specific Review Criteria', reviewInstructions.trim());
  }

  if (promptContext?.trim()) {
    sections.push(
      '',
      '## Preloaded Context',
      truncateBlock(promptContext.trim(), MAX_PROMPT_CONTEXT_CHARS),
    );
  }

  if (reviewEvidence?.trim()) {
    sections.push('', '## Precomputed Evidence Package', reviewEvidence.trim());
  }

  if (stageOutput?.trim()) {
    sections.push(
      '',
      '## Stage Output Under Review',
      truncateBlock(stageOutput.trim(), MAX_STAGE_OUTPUT_CHARS),
    );
  }

  return sections.join('\n');
}

export function buildSliceArchitectureReviewPrompt(
  session: Session,
  slice: Slice,
  implementationOutput: string,
  reviewEvidence?: string,
  promptContext?: string,
  efficiencyBudget?: ExecutorEfficiencyBudget,
): string {
  const sliceFiles = getSliceFiles(slice);
  const sliceFindings = session.findings.filter((finding) => slice.findings.includes(finding.id));
  const workspaceGuardrails = buildWorkspaceGuardrails(session);

  const reviewInstructionSections = [
    'Review the CURRENT SLICE as a blocking architecture gate before commit.',
    'Start with the precomputed architecture review packet below. Only inspect the live workspace diff or open more files when the packet is missing, contradictory, or insufficient to make a judgment.',
    'Treat the ACTUAL CHANGED FILES list in the evidence packet as the source of truth. If the current workspace diff extends beyond the declared slice scope, block the slice until the diff or scope is reconciled.',
    'Block the slice if it stabilizes symptoms instead of the shared seam, leaves duplicate paths alive, misses consumer wiring, or keeps a brittle abstraction in place.',
    'Block the slice if regression coverage is too narrow to prove the invariant that this slice claims to fix.',
    'Do not reread the same file or test repeatedly once the packet already contains its current contents and proof status.',
    'Emit only the final `analysis-report` JSON. Do not prefix it with markdown or exploratory narration.',
    '',
    workspaceGuardrails,
    '',
    '## Slice Summary',
    `Title: ${slice.title}`,
    `Description: ${slice.description}`,
    `Dependencies: ${slice.dependencies.length > 0 ? slice.dependencies.map((dependency) => dependency + 1).join(', ') : 'none'}`,
    '',
    '## Findings This Slice Must Resolve',
    sliceFindings.length > 0
      ? sliceFindings
          .map(
            (finding) =>
              `- ${finding.id}: [${finding.severity}] [${finding.category}] ${finding.title}${finding.description ? ` — ${finding.description}` : ''}`,
          )
          .join('\n')
      : '- (none declared)',
    '',
    '## File Contracts',
    slice.manifest.fileContracts.length > 0
      ? slice.manifest.fileContracts
          .map((contract) => {
            const exports =
              contract.expectedExports && contract.expectedExports.length > 0
                ? ` | exports: ${contract.expectedExports.join(', ')}`
                : '';
            const dependents =
              contract.dependents && contract.dependents.length > 0
                ? ` | dependents: ${contract.dependents.join(', ')}`
                : '';
            return `- [${contract.action}] ${contract.path} — ${contract.reason}${exports}${dependents}`;
          })
          .join('\n')
      : '- (none)',
    '',
    '## Export Contracts',
    slice.manifest.exportContracts.length > 0
      ? slice.manifest.exportContracts
          .map(
            (contract) =>
              `- ${contract.sourceFile} :: ${contract.exportName}${contract.consumers.length > 0 ? ` -> ${contract.consumers.join(', ')}` : ' -> no known consumers'}`,
          )
          .join('\n')
      : '- (none)',
    '',
    '## Required Tests',
    slice.testLock.requiredTests.length > 0
      ? slice.testLock.requiredTests
          .map(
            (test) =>
              `- ${test.testFile}${test.description ? ` — ${test.description}` : ''} [${test.status}]`,
          )
          .join('\n')
      : '- (none)',
    '',
    '## Review Efficiency Budget',
    efficiencyBudget
      ? `- Target turns: ${efficiencyBudget.targetTurns}
- Exploration budget: ${efficiencyBudget.explorationTurns}
- Complexity drivers: ${efficiencyBudget.summary ?? '(not specified)'}
- Use the packet first, then spot-check only the highest-risk seams still in doubt.`
      : '- (no explicit budget configured)',
    '',
    '## Impact Snapshot',
    `- Direct files: ${slice.impactAnalysis.directFiles.length}`,
    `- Dependent files: ${slice.impactAnalysis.dependentFiles.length}`,
    `- Affected tests: ${slice.impactAnalysis.affectedTests.length}`,
    `- Risk: ${slice.impactAnalysis.riskLevel}`,
    slice.impactAnalysis.notes ? `- Notes: ${slice.impactAnalysis.notes}` : '- Notes: (none)',
    '',
    '## Files In Scope',
    sliceFiles.length > 0 ? sliceFiles.map((file) => `- ${file}`).join('\n') : '- (none declared)',
  ];

  const reviewInstructions = reviewInstructionSections.filter(Boolean).join('\n');

  return buildBlockingModelReviewPrompt({
    stageName: `Slice Architecture Review — ${slice.title}`,
    session,
    stageOutput: implementationOutput,
    reviewEvidence,
    promptContext,
    reviewInstructions,
  });
}

export function buildWorkspaceReconcilePrompt({
  session,
  slice,
  stageName,
  reviewScopeEntries,
  actualChangedFiles,
  outOfScopeChanges,
}: WorkspaceReconcilePromptParams): string {
  return [
    "You are HELIX's workspace scope reconciler.",
    '',
    'Classify each out-of-scope changed file before HELIX blocks the current slice.',
    'Use "ignore" only when the file is clearly local tool state, generated scratch/cache output, or otherwise irrelevant to the current slice and safe to leave unstaged and unreviewed.',
    'Use "block" for any substantive code, tests, docs, configs, or anything uncertain.',
    'Do not widen the slice or silently include extra files. This pass only decides whether HELIX may ignore a file or must stop.',
    'If HELIX lists a directory path, you may assess the directory itself or specific files inside it.',
    'Use Read, Grep, Glob, and Bash only when the path names are not enough to make a confident call.',
    'When in doubt, choose "block".',
    '',
    '## Stage',
    stageName,
    '',
    '## Work Item',
    `Title: ${session.workItem.title}`,
    `Description: ${session.workItem.description}`,
    `Scope: ${session.workItem.scope.join(', ') || '(none)'}`,
    '',
    '## Slice',
    `Title: ${slice.title}`,
    `Description: ${slice.description}`,
    `Declared files: ${getSliceFiles(slice).join(', ') || '(none declared)'}`,
    '',
    '## Review Scope Entries',
    reviewScopeEntries.length > 0
      ? reviewScopeEntries.map((file) => `- ${file}`).join('\n')
      : '- (none)',
    '',
    '## Actual Changed Files',
    actualChangedFiles.length > 0
      ? actualChangedFiles.map((file) => `- ${file}`).join('\n')
      : '- (none)',
    '',
    '## Out-Of-Scope Files To Classify',
    outOfScopeChanges.length > 0
      ? outOfScopeChanges.map((file) => `- ${file}`).join('\n')
      : '- (none)',
  ].join('\n');
}

export function buildFailureAdvisoryPrompt({
  session,
  stage,
  result,
  failureCategory,
  failureSignature,
  priorRetryCount,
  currentEfficiencyBudget,
}: FailureAdvisoryPromptParams): string {
  const currentSlice =
    stage.type === 'implementation' && session.slices[session.currentSliceIndex]
      ? session.slices[session.currentSliceIndex]
      : undefined;

  const sections = [
    "You are HELIX's failure advisor.",
    '',
    'A pipeline stage has failed or exhausted its loop budget. Diagnose the blocker and recommend the next move.',
    'Do not default to narrowing scope or taking conservative shortcuts. Prefer broad reuse of the current findings/output when a retry is still likely to work.',
    'Recommend "retry-stage" only when the next attempt can plausibly succeed without hidden manual intervention.',
    'Recommend "pause-and-resume" when manual fixes, environment changes, or repeated failure make an immediate retry unlikely to help.',
    'Keep "promptGuidance" concise and imperative so HELIX can inject it directly into the next attempt.',
    'Do not inspect `.helix/sessions` or progress logs that are not included in this prompt.',
    '',
    '## Stage',
    `Name: ${stage.name}`,
    `Type: ${stage.type}`,
    `Description: ${stage.description}`,
    '',
    '## Work Item',
    `Title: ${session.workItem.title}`,
    `Description: ${session.workItem.description}`,
    `Scope: ${session.workItem.scope.join(', ') || '(none)'}`,
    '',
    '## Failure Metadata',
    `Category: ${failureCategory}`,
    `Signature: ${failureSignature}`,
    `Prior retry count for this signature: ${priorRetryCount}`,
    `Stage result status: ${result.status}`,
    `Iterations used: ${result.iterations}`,
  ];

  if (currentEfficiencyBudget) {
    sections.push(
      '',
      '## Current Efficiency Budget',
      `Target turns: ${currentEfficiencyBudget.targetTurns}`,
      `Exploration turns: ${currentEfficiencyBudget.explorationTurns}`,
      `Shell warn floor: ${currentEfficiencyBudget.shellWarnFloor ?? '(default)'}`,
      `Shell abort floor: ${currentEfficiencyBudget.shellAbortFloor ?? '(default)'}`,
    );
  }

  if (currentSlice) {
    sections.push(
      '',
      '## Current Slice',
      `Title: ${currentSlice.title}`,
      `Description: ${currentSlice.description}`,
      `Files: ${getSliceFiles(currentSlice).join(', ') || '(none declared)'}`,
      `Required tests: ${
        currentSlice.testLock.requiredTests.map((test) => test.testFile).join(', ') ||
        '(none declared)'
      }`,
    );
  }

  const findingsSnapshot = formatFindingsSnapshot(session);
  if (findingsSnapshot) {
    sections.push('', '## Open Findings Snapshot', findingsSnapshot);
  }

  if (result.error?.trim()) {
    sections.push('', '## Stage Error', result.error.trim());
  }

  if (result.executionSummary) {
    sections.push(
      '',
      '## Observed Execution Signals',
      `Progress events: ${result.executionSummary.progressEvents}`,
      `Output events: ${result.executionSummary.outputEvents}`,
      `Tool-use events: ${result.executionSummary.toolUseEvents}`,
      `Shell commands: ${result.executionSummary.shellCommandEvents}`,
      `Error events: ${result.executionSummary.errorEvents}`,
    );

    if (result.executionSummary.recentMessages.length > 0) {
      sections.push(
        'Recent activity:',
        result.executionSummary.recentMessages.map((message) => `- ${message}`).join('\n'),
      );
    }
  }

  if (result.timeoutEvents && result.timeoutEvents.length > 0) {
    sections.push(
      '',
      '## Timeout Signals',
      result.timeoutEvents
        .map((event) => {
          const timeout =
            event.timeoutMs != null ? ` | timeout=${Math.ceil(event.timeoutMs / 1000)}s` : '';
          const elapsed =
            event.elapsedMs != null ? ` | elapsed=${Math.ceil(event.elapsedMs / 1000)}s` : '';
          return `- [${event.scope}] ${event.actor}: ${event.message}${timeout}${elapsed}`;
        })
        .join('\n'),
    );
  }

  if (result.qualityGate) {
    sections.push(
      '',
      '## Quality Gate Result',
      `Name: ${result.qualityGate.name}`,
      `Passed: ${result.qualityGate.passed ? 'yes' : 'no'}`,
      `Feedback: ${result.qualityGate.feedback}`,
    );

    const failedChecks = result.qualityGate.checks.filter((check) => !check.passed);
    if (failedChecks.length > 0) {
      sections.push(
        'Failed checks:',
        failedChecks
          .map((check) => {
            const output = check.output?.trim()
              ? ` :: ${truncateBlock(check.output.trim(), 400)}`
              : '';
            return `- ${check.name}${output}`;
          })
          .join('\n'),
      );
    }
  }

  if (result.output.trim()) {
    sections.push(
      '',
      '## Stage Output Excerpt',
      truncateBlock(result.output.trim(), MAX_STAGE_OUTPUT_CHARS),
    );
  }

  sections.push(
    '',
    '## Continuation Options',
    '- retry-stage: Retry the same stage on the current model when the seam is still correct and a direct retry should work.',
    '- synthesize-stage: Stop exploration and emit the structured artifact now from the gathered evidence.',
    '- switch-model: Continue the same stage immediately on the alternate frontier model when the current model/runtime path is the bottleneck.',
    '- continue-immediate-only: Complete only the immediate + next findings needed to move this stage forward; explicitly defer near-term + long-term follow-up.',
    '- promote-stage: Mark the stage complete directly from the retained seam evidence when HELIX already has enough information to produce a safe minimal artifact without another model pass.',
    '- pause-and-resume: Stop and wait for manual intervention when the stage cannot progress safely right now.',
    '',
    'Choose exactly one recommendedAction from that menu.',
    'Use "switch-model" when the primary blocker is model startup, tool bootstrap, or a repeated model-specific stall rather than missing seam evidence.',
    'Use "continue-immediate-only" when the stage is broadening into near-term or long-term follow-up instead of finishing the immediate seam stabilization.',
    '',
    '## Budget Advisory Rule',
    'If this failure was caused by HELIX efficiency controls and the evidence shows the stage is still exploring the correct seam, you may recommend one higher budget for the retry.',
    'Only recommend a higher budget when the current trajectory is still substantively relevant. If the stage already wandered, leave budgetRecommendation as null and prefer prompt guidance that narrows the next attempt back to the primary seam.',
    'If observed execution signals show shell or tool activity, do not classify the failure as a startup hang even when assistant turns are 0. Treat those signals as evidence that the stage began workspace inspection.',
    'When a replay analysis stage already inspected the historical seam and then stalled, prefer guidance that synthesizes findings from the gathered evidence over guidance that restarts broad rediscovery.',
    'Use "synthesize-stage" when the stage already collected enough seam evidence and the best recovery is an immediate synthesis retry with minimal additional exploration.',
  );

  sections.push('', buildStageOutputInstructions({ id: 'failure-advisory', strict: true }));
  return sections.join('\n');
}

function formatFindingsSnapshot(session: Session): string {
  const openFindings = session.planReviewState
    ? getVisiblePlanFindings(session)
    : session.findings.filter((finding) => finding.status === 'open');
  if (openFindings.length === 0) {
    return '';
  }

  const lines = [`${openFindings.length} open finding(s)`];
  for (const finding of openFindings.slice(0, MAX_FINDINGS)) {
    const files =
      finding.files.length > 0
        ? ` | files: ${finding.files.map((file) => file.path).join(', ')}`
        : '';
    lines.push(
      `- ${finding.id}: [${finding.severity}] [${finding.category}] ${finding.title}${finding.description ? ` — ${finding.description}` : ''}${files}`,
    );
  }
  if (openFindings.length > MAX_FINDINGS) {
    lines.push(`- ... and ${openFindings.length - MAX_FINDINGS} more`);
  }

  return lines.join('\n');
}

function formatCommitSnapshot(session: Session): string {
  if (session.commits.length === 0) {
    return '';
  }

  return session.commits
    .slice(-MAX_COMMITS)
    .map((commit) => `- ${commit.sha.slice(0, 7)} ${commit.message}`)
    .join('\n');
}

function truncateBlock(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(0, maxChars).trimEnd()}\n... [truncated]`;
}

function buildWorkspaceGuardrails(session: Session): string {
  const worktreeDir = session.workspaceContext?.worktreeDir?.trim();
  const sourceWorkDir = session.workspaceContext?.sourceWorkDir?.trim();

  if (!worktreeDir && !sourceWorkDir) {
    return '';
  }

  const lines = ['## Workspace Guardrails'];
  lines.push(`- Current execution workspace: ${worktreeDir || sourceWorkDir}`);

  if (worktreeDir && sourceWorkDir && sourceWorkDir !== worktreeDir) {
    lines.push(`- Source checkout reference only: ${sourceWorkDir}`);
    lines.push(
      '- If any file read resolves to the source checkout instead of the execution workspace, discard that read and reopen the file inside the execution workspace before approving.',
    );
  }

  return lines.join('\n');
}
