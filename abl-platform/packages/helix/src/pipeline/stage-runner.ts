import type {
  DecisionClassification,
  ExecutorEfficiencyBudget,
  Session,
  Slice,
  SliceChecklist,
  StageDefinition,
} from '../types.js';
import { formatDeferredBulkReviewQueue, formatSliceAutonomySummary } from './autonomy-policy.js';
import { buildStageOutputInstructions } from './stage-output-schema.js';
import { defaultPrompts } from './default-stage-prompts.js';
import {
  formatPlanReviewCarryForward,
  getApprovedPlanFindingIds,
  getDeferredPlanFindingIds,
  getFollowUpPlanFindings,
  getVisiblePlanFindings,
} from './plan-review-state.js';
import { formatPlanningBatches } from './planning-batches.js';
import { renderPromptContext } from './prompt-context.js';
import { getSliceFiles } from './slice-view.js';
import { isTestFilePath } from './workspace-status.js';

const MAX_PLAN_PREVIOUS_OUTPUT_CHARS = 7000;
const MIN_SLICE_TURN_BUDGET = 18;
const MAX_SLICE_TURN_BUDGET = 120;
const MIN_SLICE_EXPLORATION_BUDGET = 6;
const EXPLORATION_RATIO = 0.3;
const MIN_ARCH_REVIEW_TURN_BUDGET = 10;
const MAX_ARCH_REVIEW_TURN_BUDGET = 40;
const MIN_ARCH_REVIEW_EXPLORATION_BUDGET = 3;
const ARCH_REVIEW_EXPLORATION_RATIO = 0.25;
const MIN_PLAN_TURN_BUDGET = 12;
const MAX_PLAN_TURN_BUDGET = 22;
const MIN_PLAN_EXPLORATION_BUDGET = 4;
const PLAN_EXPLORATION_RATIO = 0.35;
const PLAN_REVISION_EXPLORATION_RATIO = 0.25;
const MIN_DEEP_SCAN_TURN_BUDGET = 12;
const MAX_DEEP_SCAN_TURN_BUDGET = 24;
const MIN_DEEP_SCAN_EXPLORATION_BUDGET = 4;
const DEEP_SCAN_EXPLORATION_RATIO = 0.35;
const MIN_REPRODUCE_TURN_BUDGET = 10;
const MAX_REPRODUCE_TURN_BUDGET = 16;
const MIN_REPRODUCE_EXPLORATION_BUDGET = 3;
const REPRODUCE_EXPLORATION_RATIO = 0.35;
const MIN_ROOT_CAUSE_TURN_BUDGET = 10;
const MAX_ROOT_CAUSE_TURN_BUDGET = 18;
const MIN_ROOT_CAUSE_EXPLORATION_BUDGET = 3;
const ROOT_CAUSE_EXPLORATION_RATIO = 0.3;

/**
 * Builds the prompt for a pipeline stage based on:
 * - The stage definition (type, prompt template)
 * - The current session state (findings, decisions, commits)
 * - Previous output (for loop iterations)
 * - Iteration count
 *
 * Each stage type has a default prompt template that can be
 * overridden via stage.prompt or stage.promptFile.
 */
export function buildStagePrompt(
  stage: StageDefinition,
  session: Session,
  previousOutput: string,
  iteration: number,
): string {
  const template =
    stage.prompt ??
    defaultPrompts[stage.type] ??
    `Execute stage: ${stage.name}\n\nDescription: ${stage.description}`;

  return finalizePrompt(
    substituteVariables(template, session, previousOutput, iteration, stage.type),
    stage,
    session,
  );
}

/**
 * Build a slice-scoped prompt for implementation stages.
 * Injects slice-specific context as an issue-shaped slice packet: objective,
 * findings, contracts, proof, and definition of done.
 */
export function buildSlicePrompt(
  stage: StageDefinition,
  session: Session,
  slice: Slice,
  checklist: SliceChecklist,
  previousOutput: string,
  iteration: number,
  contextPacket?: string,
): string {
  const prioritizedRecoveryContext = getPrioritizedSliceRecoveryContext(previousOutput);
  const basePrompt = buildStagePrompt(
    stage,
    session,
    prioritizedRecoveryContext ? '' : previousOutput,
    iteration,
  );
  const efficiencyBudget = estimateSliceEfficiencyBudget(slice, session);
  const sliceFiles = getSliceFiles(slice);
  const sliceNumber = slice.index + 1;
  const dependentSlices = session.slices
    .filter((candidate) => candidate.dependencies.includes(slice.index))
    .map((candidate) => candidate.index);

  const sliceFindings = session.findings.filter((f) => slice.findings.includes(f.id));
  const findingsList =
    sliceFindings.length > 0
      ? sliceFindings
          .map(
            (f) =>
              `  - [${f.severity}] [${f.category}] ${f.title}${f.description ? `: ${f.description}` : ''}`,
          )
          .join('\n')
      : '(none)';
  const findingIds = slice.findings.length > 0 ? slice.findings.join(', ') : '(none)';

  const checklistItems =
    checklist.items.length > 0
      ? checklist.items
          .map(
            (item) =>
              `  - [${item.status === 'passed' ? 'x' : ' '}] ${item.label}${item.detail ? ` — ${item.detail}` : ''}`,
          )
          .join('\n')
      : '(none yet)';

  const requiredTests =
    slice.testLock.requiredTests.length > 0
      ? slice.testLock.requiredTests
          .map((test) => `  - ${test.testFile}${test.description ? ` — ${test.description}` : ''}`)
          .join('\n')
      : '(none declared — the plan must specify at least one required test for this slice)';
  const regressionSuite =
    slice.testLock.regressionSuite.length > 0
      ? slice.testLock.regressionSuite.map((testFile) => `  - ${testFile}`).join('\n')
      : '(none)';
  const affectedTests =
    slice.impactAnalysis.affectedTests.length > 0
      ? slice.impactAnalysis.affectedTests.map((testFile) => `  - ${testFile}`).join('\n')
      : '(none)';
  const acceptanceObligations = renderSliceAcceptanceObligations(slice, session);

  const entryConditions =
    slice.manifest.entryConditions.length > 0
      ? slice.manifest.entryConditions
          .map(
            (condition) =>
              `  - [${condition.type}] ${condition.reference} — ${condition.description}`,
          )
          .join('\n')
      : '(none)';
  const directFiles =
    sliceFiles.length > 0 ? sliceFiles.map((file) => `  - ${file}`).join('\n') : '(none)';

  const fileContracts =
    slice.manifest.fileContracts.length > 0
      ? slice.manifest.fileContracts
          .map((contract) => {
            const expectedExports =
              contract.expectedExports && contract.expectedExports.length > 0
                ? ` | exports: ${contract.expectedExports.join(', ')}`
                : '';
            const dependents =
              contract.dependents && contract.dependents.length > 0
                ? ` | dependents: ${contract.dependents.join(', ')}`
                : '';
            return `  - [${contract.action}] ${contract.path} — ${contract.reason}${expectedExports}${dependents}`;
          })
          .join('\n')
      : '(none)';
  const completenessHints =
    slice.manifest.completeness?.hints && slice.manifest.completeness.hints.length > 0
      ? slice.manifest.completeness.hints
          .map(
            (hint) =>
              `  - [${hint.kind}] ${hint.path} — ${hint.reason}${hint.suggestedAction ? ` | action: ${hint.suggestedAction}` : ''}`,
          )
          .join('\n')
      : '(none)';

  const exportContracts =
    slice.manifest.exportContracts.length > 0
      ? slice.manifest.exportContracts
          .map(
            (contract) =>
              `  - ${contract.sourceFile} :: ${contract.exportName}${contract.isNew ? ' (new)' : ''}${contract.consumers.length > 0 ? ` -> ${contract.consumers.join(', ')}` : ' -> no known consumers yet'}`,
          )
          .join('\n')
      : '(none)';
  const impactedDependents = formatPathList(collectSliceDependents(slice));

  const impactSummary = [
    `Direct files: ${slice.impactAnalysis.directFiles.length}`,
    `Dependent files: ${slice.impactAnalysis.dependentFiles.length}`,
    `Affected tests: ${slice.impactAnalysis.affectedTests.length}`,
    `Risk: ${slice.impactAnalysis.riskLevel}`,
  ].join(' | ');

  const legacySection =
    slice.legacyPaths.length > 0
      ? `\n### Legacy Cleanup Already Identified\n${slice.legacyPaths.map((lp) => `  - ${lp.path}: ${lp.reason}`).join('\n')}`
      : '';

  const autonomySection = slice.autonomy
    ? `\n### Review Posture\n${formatSliceAutonomySummary(slice)}`
    : '';
  const impactNotes = slice.impactAnalysis.notes ? `\n${slice.impactAnalysis.notes}` : '';
  const contextPacketSection = contextPacket?.trim() ? `\n\n${contextPacket.trim()}` : '';
  const replayStartupGuardrails = buildReplaySliceStartupGuardrails(session, slice);
  const sliceOverview = [
    `- Slice: ${sliceNumber}/${session.slices.length} — ${slice.title}`,
    `- Work item type: ${session.workItem.type}`,
    `- Finding IDs: ${findingIds}`,
    `- Depends on: ${formatSliceReferenceList(slice.dependencies)}`,
    `- Unlocks: ${formatSliceReferenceList(dependentSlices)}`,
    `- Risk: ${slice.impactAnalysis.riskLevel}`,
    `- Impact: ${slice.impactAnalysis.directFiles.length} direct file(s), ${slice.impactAnalysis.dependentFiles.length} dependent file(s), ${slice.impactAnalysis.affectedTests.length} affected test(s)`,
    '- Source of truth: this issue brief is authoritative for scope, contracts, tests, and definition of done',
  ].join('\n');

  const recoverySection = prioritizedRecoveryContext
    ? `## TOP PRIORITY RECOVERY MODE\n${prioritizedRecoveryContext}\n\n`
    : '';

  return `${recoverySection}${basePrompt}

## SLICE ISSUE BRIEF
${sliceOverview}

### Objective
${slice.description}

### Why This Slice Exists
${findingsList}

### Efficiency Budget
- Target total turns: ${efficiencyBudget.targetTurns}
- Exploration budget: ${efficiencyBudget.explorationTurns} turn(s) before you should be implementing with the evidence already gathered
- Complexity drivers: ${efficiencyBudget.summary}
- Batch related reads/searches/writes in single turns whenever possible
- Avoid re-reading the same file or re-running the same search unless new evidence changes the plan

### Implementation Contract
#### Entry Conditions
${entryConditions}

#### Expected Direct Edits
${directFiles}

#### File Contracts
${fileContracts}

#### Manifest Completeness Preflight
${slice.manifest.completeness?.summary ?? 'Manifest completeness preflight has not run yet.'}
${completenessHints}

#### Export and Consumer Wiring
${exportContracts}

### Proof and Regression Coverage
#### Required Tests
${requiredTests}

#### Regression Suite That Must Stay Green
${regressionSuite}

#### Affected Tests Discovered During Impact Analysis
${affectedTests}

### Impact Watchlist
- ${impactSummary}
#### Impacted Dependents and Consumers
${impactedDependents}${impactNotes}

### Invariant, Coverage, and Acceptance Obligations
${acceptanceObligations}

### Definition of Done
${checklistItems}
${legacySection}${autonomySection}${contextPacketSection}
${replayStartupGuardrails}

### Execution Notes
1. Use this issue brief as the source of truth for the slice. Do not search \`.helix/sessions\`, \`session.json\`, or \`progress.log\` just to restate scope already captured here.
2. Treat this like a good engineering issue: objective, contracts, proof, and done are all declared above.
3. Implement ONLY the findings listed above — do not scope-creep.
4. Stabilize the shared seam or invariant first when multiple consumers are affected.
5. After each file change, verify TypeScript compiles.
6. If you find redundant/legacy code paths that should be removed in a future slice, output:
   LEGACY: path/to/file.ts — reason this is redundant
7. Prefer removing or converging duplicate/superseded paths now when the slice can do it safely.
8. Write or update every required test listed above before declaring the slice done.
9. Run the preloaded build/typecheck verification command before running any test command. Only widen to \`pnpm build\` or a broader app/package build if that scoped command fails and you can explain the missing contract.
10. Run prettier on all changed files.
10a. When formatting an exact changed-file list, prefer \`npx prettier --write --ignore-unknown <files>\` so unsupported file types do not block the slice proof path.
11. Treat the preloaded Verification Commands above as the authoritative minimal proof set. Do not rediscover broader package or app builds unless one of those commands fails and you can explain the missing contract.
12. Do not edit \`AGENTS.md\`, \`CLAUDE.md\`, \`docs/sdlc-logs\`, \`next-env.d.ts\`, or other generated/tool-owned files unless they are explicit file contracts or HELIX blocks on them.
13. Once the build/typecheck, formatting, and required test commands are green, stop and hand control back immediately instead of spending extra turns on line-number collection, status sweeps, or documentation/journal updates.
14. Ensure all imports, exports, dependents, and regression coverage are complete.
15. Use the efficiency budget above to avoid wandering: batch reads/searches, then implement.
16. If you exhaust the exploration budget and are still blocked, summarize the missing evidence instead of looping on the same files.
17. For Jira-bound bug fixes, use \`studio_video_evidence\` for Studio UI proof when the issue has a UI or conversation scenario, then use \`jira_update\` to add the QA note, attach evidence files, transition to Development Completed, and assign to Prakash Rochkari.`;
}

function getPrioritizedSliceRecoveryContext(previousOutput: string): string | null {
  const trimmed = previousOutput.trim();
  if (
    trimmed.startsWith('RESUME FROM CURRENT DIFF') ||
    trimmed.startsWith('IMPLEMENTATION RECOVERY MODE') ||
    trimmed.startsWith('TYPECHECK REPAIR REQUIRED') ||
    trimmed.startsWith('REQUIRED TEST REPAIR REQUIRED')
  ) {
    return trimmed;
  }

  return null;
}

function buildReplaySliceStartupGuardrails(session: Session, slice: Slice): string {
  const replayChangedFiles = session.replayContext?.changedFiles ?? [];
  if (replayChangedFiles.length === 0) {
    return '';
  }

  const directFiles = getSliceFiles(slice);
  const historicalHints = session.replayContext?.historicalFileHints ?? {};
  const avoidPaths = session.replayContext?.avoidPaths?.filter(Boolean) ?? [];
  const futureTargets = directFiles.filter((path) => historicalHints[path]?.length);
  const substitutedBaseFiles = futureTargets.flatMap((path) => historicalHints[path] ?? []);

  const lines = ['### Replay Startup Guardrails'];
  lines.push(
    '- This is a historical replay slice. Start from the direct file contracts, required tests, and the preloaded slice context packet before doing any new discovery.',
  );
  lines.push(
    '- Do not start by reading `AGENTS.md`, `agents.md`, `CLAUDE.md`, journals, or broad repo docs. The slice packet already carries the package guidance you need unless a file contract explicitly proves otherwise.',
  );
  lines.push(
    '- Do not inventory the package with `ls`, `find`, `rg --files`, or broad caller searches before you inspect the direct seam files listed in this issue brief.',
  );
  if (avoidPaths.length > 0) {
    lines.push(
      `- Replay-specific out-of-bounds paths for this slice: ${avoidPaths.join(', ')}. Treat them as forbidden during implementation unless a direct file contract or an already-open seam file explicitly proves one is required for correctness.`,
    );
  }
  if (futureTargets.length > 0) {
    lines.push(
      `- Future target files may be missing at the replay base commit: ${futureTargets.join(', ')}. Treat those missing paths as confirmation of the historical gap, not as a reason to restart broad discovery.`,
    );
  }
  if (substitutedBaseFiles.length > 0) {
    lines.push(
      `- Historical seam substitutes are already known: ${Array.from(new Set(substitutedBaseFiles)).join(', ')}. Read those base-commit files first before searching for more context.`,
    );
  }
  lines.push(
    '- After the direct seam is understood, expand by at most one hop for a concrete shared contract (for example a shared RBAC type, audit helper, or exported repo barrel).',
  );
  lines.push(
    '- If a direct file contract is missing at the replay base commit and the historical substitute already explains the gap, begin writing the replacement immediately instead of searching for more consumers or surrounding infrastructure.',
  );

  return `\n\n${lines.join('\n')}`;
}

function renderSliceAcceptanceObligations(slice: Slice, session: Session): string {
  const sliceFindings = session.findings.filter((finding) => slice.findings.includes(finding.id));
  const activeFindings = sliceFindings.filter(
    (finding) =>
      finding.horizon == null || finding.horizon === 'immediate' || finding.horizon === 'next',
  );
  const categories = new Set(activeFindings.map((finding) => finding.category));
  const directFiles = getSliceFiles(slice);
  const routeOrApiTouched = directFiles.some(
    (file) =>
      file.includes('/app/api/') ||
      file.includes('/routes/') ||
      file.includes('middleware') ||
      file.includes('auth'),
  );
  const schemaOrModelTouched = directFiles.some(
    (file) =>
      file.includes('.schema.') ||
      file.includes('/models/') ||
      file.includes('/repos/') ||
      file.includes('validation'),
  );

  const obligations = [
    '- Discharge every immediate/next finding at the shared seam, not only in the nearest caller.',
    '- For every changed invariant or contract, prove at least one happy-path and one negative-path regression. If the negative path already exists, strengthen it so it explicitly proves the invariant.',
  ];

  if (categories.has('missing-test') || slice.testLock.requiredTests.length > 0) {
    obligations.push(
      '- Required tests are minimum coverage, not the whole bar. Add any missing negative, integration, or E2E proof needed to show the invariant actually holds.',
    );
  }

  if (routeOrApiTouched || categories.has('security') || categories.has('isolation')) {
    obligations.push(
      '- Verify auth, tenant/project/user isolation, and full middleware-chain behavior through the public boundary. Missing negative authorization/isolation proof keeps the slice incomplete.',
    );
  }

  if (schemaOrModelTouched || categories.has('bug') || categories.has('security')) {
    obligations.push(
      '- If validation, schema, repo, or model contracts are involved, prove the invariant at the persistence/contract layer as well as the service/route layer. Service-only proof is not enough.',
    );
  }

  if (
    slice.manifest.exportContracts.length > 0 ||
    slice.impactAnalysis.dependentFiles.length > 0 ||
    categories.has('wiring-gap')
  ) {
    obligations.push(
      '- Verify export/import wiring and downstream consumers. A slice is incomplete if the seam is fixed locally but dependents or exported contracts are left partially wired.',
    );
  }

  obligations.push(
    '- If the current proof passes without touching a discovered direct seam file, justify that omission explicitly or update the seam. Silent omissions are not accepted.',
  );

  if ((session.replayContext?.changedFiles?.length ?? 0) > 0) {
    obligations.push(
      `- Historical replay seam obligations: ${session.replayContext?.changedFiles?.join(', ')}. Missing target seam files must either be updated or clearly proven unnecessary by an equivalent invariant fix before replay can be called successful.`,
    );
  }

  return obligations.join('\n');
}

/**
 * Substitute variables in a prompt template:
 *
 *   {{title}}           — work item title
 *   {{description}}     — work item description
 *   {{scope}}           — affected packages/areas
 *   {{findings}}        — current findings summary
 *   {{decisions}}       — current decisions summary
 *   {{previousOutput}}  — output from previous iteration
 *   {{iteration}}       — current iteration number
 *   {{commits}}         — commits made so far
 *   {{featureSpec}}     — path to feature spec if available
 *   {{planCarryForward}} — approved/deferred guidance from the previous plan review
 */
function substituteVariables(
  template: string,
  session: Session,
  previousOutput: string,
  iteration: number,
  stageType: StageDefinition['type'],
): string {
  const vars: Record<string, string> = {
    title: session.workItem.title,
    description: session.workItem.description,
    scope: session.workItem.scope.join(', '),
    findings: formatFindingsSummary(session, stageType),
    openFindingsRegistry: formatOpenFindingsRegistry(session, stageType),
    followUpFindings: formatFollowUpFindings(session, stageType),
    decisions: formatDecisions(session, stageType),
    previousOutput: formatPreviousOutput(previousOutput, stageType, session),
    iteration: String(iteration),
    commits: formatCommits(session),
    featureSpec: session.workItem.featureSpec ?? '(none)',
    testSpec: session.workItem.testSpec ?? '(none)',
    hldSpec: session.workItem.hldSpec ?? '(none)',
    lldPlan: session.workItem.lldPlan ?? '(none)',
    jiraKey: session.workItem.jiraKey ?? '(none)',
    deferredSlices: formatDeferredBulkReviewQueue(session),
    planningBatches: formatPlanningBatches(session),
    planCarryForward: formatPlanReviewCarryForward(session),
  };

  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

export function estimateSliceEfficiencyBudget(
  slice: Slice,
  session?: Session,
): ExecutorEfficiencyBudget {
  const directFiles = slice.manifest.fileContracts.length;
  const dependentFiles = slice.impactAnalysis.dependentFiles.length;
  const requiredTests = slice.testLock.requiredTests.length;
  const regressionTests = slice.testLock.regressionSuite.length;
  const replayBreadth = session ? getReplayBreadth(session) : null;
  const replayChangedFiles = session?.replayContext?.changedFiles?.length ?? 0;
  const replayAvoidPaths = session?.replayContext?.avoidPaths?.filter(Boolean) ?? [];
  const broadReplayImplementation = replayChangedFiles > 0 && Boolean(replayBreadth?.broad);
  const riskWeight =
    slice.impactAnalysis.riskLevel === 'high'
      ? 10
      : slice.impactAnalysis.riskLevel === 'medium'
        ? 6
        : 2;
  const rawBudget =
    12 +
    directFiles * 6 +
    dependentFiles * 2 +
    requiredTests * 3 +
    regressionTests * 2 +
    riskWeight;
  const targetTurns = clamp(rawBudget, MIN_SLICE_TURN_BUDGET, MAX_SLICE_TURN_BUDGET);
  const defaultExplorationTurns = clamp(
    Math.ceil(targetTurns * EXPLORATION_RATIO),
    MIN_SLICE_EXPLORATION_BUDGET,
    Math.max(MIN_SLICE_EXPLORATION_BUDGET, targetTurns - 4),
  );
  const explorationTurns =
    replayChangedFiles > 0
      ? Math.min(defaultExplorationTurns, broadReplayImplementation ? 3 : 2)
      : defaultExplorationTurns;
  const summary = [
    `${directFiles} direct file contract(s)`,
    `${dependentFiles} dependent file(s)`,
    `${requiredTests} required test(s)`,
    `${regressionTests} inherited regression test(s)`,
    `${slice.impactAnalysis.riskLevel} risk`,
    replayChangedFiles > 0
      ? broadReplayImplementation
        ? 'broad replay implementation mode'
        : 'narrow replay implementation mode'
      : '',
  ].join(', ');

  const replayImplementationGuardrails =
    replayChangedFiles > 0
      ? {
          shellWarnFloor: broadReplayImplementation
            ? Math.max(8, directFiles + dependentFiles + requiredTests)
            : Math.max(4, Math.ceil(directFiles / 2) + 1),
          shellAbortFloor: broadReplayImplementation
            ? Math.max(
                12,
                directFiles + dependentFiles + requiredTests + Math.min(replayChangedFiles, 4),
              )
            : Math.max(6, directFiles + 1),
          abortExploratoryToolUseAfterTargetTurns: true,
          allowScopedShellInspection: true,
          scopedShellInspectionCountLimit: broadReplayImplementation
            ? Math.max(
                10,
                directFiles + dependentFiles + requiredTests + Math.min(replayChangedFiles, 3),
              )
            : Math.max(4, directFiles + Math.min(requiredTests, 1)),
          forbiddenShellPatterns: [
            '^ls(?:\\s|$)',
            '^find(?:\\s|$)',
            '^fd(?:\\s|$)',
            '^git\\s+ls-files\\b',
            '^rg\\s+--files\\b',
            ...buildReplayAvoidPathPatterns(replayAvoidPaths),
          ],
        }
      : {};

  return {
    targetTurns,
    explorationTurns,
    ...replayImplementationGuardrails,
    summary,
  };
}

export function estimateArchitectureReviewEfficiencyBudget(slice: Slice): ExecutorEfficiencyBudget {
  const directFiles = slice.manifest.fileContracts.length;
  const requiredTests = slice.testLock.requiredTests.length;
  const dependents = slice.impactAnalysis.dependentFiles.length;
  const findings = slice.findings.length;
  const riskWeight =
    slice.impactAnalysis.riskLevel === 'high'
      ? 5
      : slice.impactAnalysis.riskLevel === 'medium'
        ? 3
        : 1;
  const rawBudget =
    6 + directFiles * 2 + requiredTests * 2 + Math.ceil(dependents / 2) + findings + riskWeight;
  const targetTurns = clamp(rawBudget, MIN_ARCH_REVIEW_TURN_BUDGET, MAX_ARCH_REVIEW_TURN_BUDGET);
  const explorationTurns = clamp(
    Math.ceil(targetTurns * ARCH_REVIEW_EXPLORATION_RATIO),
    MIN_ARCH_REVIEW_EXPLORATION_BUDGET,
    Math.max(MIN_ARCH_REVIEW_EXPLORATION_BUDGET, targetTurns - 4),
  );
  const summary = [
    `${directFiles} direct file contract(s)`,
    `${requiredTests} required test file(s)`,
    `${dependents} dependent file(s)`,
    `${findings} slice finding(s)`,
    `${slice.impactAnalysis.riskLevel} risk`,
  ].join(', ');

  return {
    targetTurns,
    explorationTurns,
    summary,
  };
}

export function estimatePlanningEfficiencyBudget(session: Session): ExecutorEfficiencyBudget {
  const visibleFindings = getVisiblePlanFindings(session).length;
  const ambiguousDecisions = countDecisionsByClassification(session, 'AMBIGUOUS');
  const decidedDecisions =
    countDecisionsByClassification(session, 'DECIDED') +
    countDecisionsByClassification(session, 'ANSWERED') +
    countDecisionsByClassification(session, 'INFERRED');
  const approvedSlices = session.planReviewState?.approvedSlices.length ?? 0;
  const slicesToRevise = session.planReviewState?.slicesToRevise.length ?? 0;
  const scopeEntries = session.workItem.scope.length;
  const targetedRevisionMode = approvedSlices > 0 && slicesToRevise > 0;
  const replayBreadth = getReplayBreadth(session);
  const broadReplayPlanning = replayBreadth.changedFiles > 0 && replayBreadth.broad;
  const compactReplayPlanning = shouldUseCompactReplayPlanningStart(session);

  const rawBudget =
    8 +
    visibleFindings +
    ambiguousDecisions * 2 +
    Math.ceil(decidedDecisions / 4) +
    slicesToRevise * 3 +
    Math.ceil(approvedSlices / (targetedRevisionMode ? 4 : 1)) +
    Math.ceil(scopeEntries / 2);
  const targetTurns = compactReplayPlanning
    ? Math.min(clamp(rawBudget, MIN_PLAN_TURN_BUDGET, MAX_PLAN_TURN_BUDGET), 10)
    : clamp(rawBudget, MIN_PLAN_TURN_BUDGET, MAX_PLAN_TURN_BUDGET);
  const explorationRatio = targetedRevisionMode
    ? PLAN_REVISION_EXPLORATION_RATIO
    : PLAN_EXPLORATION_RATIO;
  const explorationTurns = compactReplayPlanning
    ? 0
    : clamp(
        Math.ceil(targetTurns * explorationRatio),
        MIN_PLAN_EXPLORATION_BUDGET,
        Math.max(MIN_PLAN_EXPLORATION_BUDGET, targetTurns - 4),
      );
  const summary = [
    `${visibleFindings} visible finding(s)`,
    `${ambiguousDecisions} ambiguous decision(s)`,
    `${approvedSlices} approved slice(s) carried forward`,
    `${slicesToRevise} slice(s) still under revision`,
    `${scopeEntries} scope entry(s)`,
    compactReplayPlanning ? 'compact replay synthesis mode' : '',
    targetedRevisionMode ? 'targeted revision mode' : 'full planning mode',
  ]
    .filter((entry) => entry.length > 0)
    .join(', ');

  return {
    targetTurns,
    explorationTurns,
    ...(compactReplayPlanning
      ? {
          hardTurnCap: targetTurns,
          shellWarnFloor: 0,
          shellAbortFloor: 1,
          disableToolUse: true,
        }
      : {}),
    forbiddenShellPatterns:
      session.replayContext?.changedFiles && session.replayContext.changedFiles.length > 0
        ? broadReplayPlanning
          ? [
              '^ls(?:\\s|$)',
              '^find(?:\\s|$)',
              '^fd(?:\\s|$)',
              '^git\\s+ls-files\\b',
              '^rg\\s+--files\\b',
            ]
          : ['^ls(?:\\s|$)', '^find(?:\\s|$)', '^fd(?:\\s|$)', '^git\\s+ls-files\\b']
        : undefined,
    ...(broadReplayPlanning ? { abortExploratoryToolUseAfterTargetTurns: true } : {}),
    ...(broadReplayPlanning
      ? { scopedShellInspectionCountLimit: Math.max(3, Math.ceil(replayBreadth.changedFiles / 4)) }
      : {}),
    summary,
  };
}

export function estimateDeepScanEfficiencyBudget(session: Session): ExecutorEfficiencyBudget {
  const scopeEntries = session.workItem.scope.length;
  const replayBreadth = getReplayBreadth(session);
  const replayTags = session.replayContext?.tags ?? [];
  const hasHistoricalSubstitutions = Boolean(
    session.replayContext?.historicalFileHints &&
    Object.keys(session.replayContext.historicalFileHints).length > 0,
  );
  const isServiceExtractionReplay = replayTags.some((tag) =>
    ['service-extraction', 'rbac', 'route-migration'].includes(tag),
  );
  const rawBudget =
    10 +
    Math.ceil(scopeEntries / 2) +
    Math.ceil(replayBreadth.changedFiles / 3) +
    replayBreadth.packageRoots * 2 +
    (replayBreadth.broad ? 2 : 0);
  const targetTurns = clamp(rawBudget, MIN_DEEP_SCAN_TURN_BUDGET, MAX_DEEP_SCAN_TURN_BUDGET);
  const explorationTurns = clamp(
    Math.ceil(targetTurns * DEEP_SCAN_EXPLORATION_RATIO),
    MIN_DEEP_SCAN_EXPLORATION_BUDGET,
    Math.max(MIN_DEEP_SCAN_EXPLORATION_BUDGET, targetTurns - 5),
  );

  const shellFloors =
    replayBreadth.changedFiles > 0
      ? replayBreadth.broad
        ? hasHistoricalSubstitutions
          ? isServiceExtractionReplay
            ? {
                shellWarnFloor: Math.max(12, targetTurns - 6),
                shellAbortFloor: Math.max(20, targetTurns + 2),
                zeroTurnShellAbortFloor: 11,
                zeroTurnElapsedAbortMs: 30_000,
              }
            : {
                shellWarnFloor: Math.max(11, targetTurns - 6),
                shellAbortFloor: Math.max(18, targetTurns + 2),
                zeroTurnShellAbortFloor: Math.max(14, targetTurns + 1),
              }
          : {
              shellWarnFloor: Math.max(10, targetTurns - 5),
              shellAbortFloor: Math.max(16, targetTurns + 1),
              zeroTurnShellAbortFloor: Math.max(12, targetTurns),
            }
        : {
            shellWarnFloor: Math.max(8, targetTurns - 4),
            shellAbortFloor: Math.max(14, targetTurns),
            zeroTurnShellAbortFloor: Math.max(10, targetTurns - 2),
          }
      : {};

  const forbiddenShellPatterns =
    replayBreadth.changedFiles > 0
      ? replayBreadth.broad
        ? ['^ls(?:\\s|$)', '^find(?:\\s|$)', '^fd(?:\\s|$)', '^rg\\s+--files\\b']
        : ['^ls(?:\\s|$)', '^find(?:\\s|$)', '^fd(?:\\s|$)']
      : undefined;
  const scopedShellInspectionCountLimit =
    replayBreadth.changedFiles > 0 && replayBreadth.broad
      ? hasHistoricalSubstitutions
        ? Math.max(8, Math.ceil(replayBreadth.changedFiles / 2) + replayBreadth.packageRoots)
        : Math.max(6, Math.ceil(replayBreadth.changedFiles / 3) + replayBreadth.packageRoots)
      : undefined;
  const scopedToolInspectionCountLimit =
    replayBreadth.changedFiles > 0 && replayBreadth.broad && hasHistoricalSubstitutions
      ? 2
      : undefined;

  return {
    targetTurns,
    explorationTurns,
    ...shellFloors,
    ...(replayBreadth.changedFiles > 0 && replayBreadth.broad
      ? {
          abortExploratoryToolUseAfterTargetTurns: true,
          abortScopedShellInspectionAfterLimit: hasHistoricalSubstitutions,
          abortScopedToolInspectionAfterLimit: hasHistoricalSubstitutions,
          ...(hasHistoricalSubstitutions ? { hardTurnCap: targetTurns } : {}),
        }
      : {}),
    forbiddenShellPatterns,
    allowScopedShellInspection: replayBreadth.changedFiles > 0,
    ...(scopedShellInspectionCountLimit != null ? { scopedShellInspectionCountLimit } : {}),
    ...(scopedToolInspectionCountLimit != null ? { scopedToolInspectionCountLimit } : {}),
    summary: [
      `${scopeEntries} scope entry(s)`,
      replayBreadth.summary,
      hasHistoricalSubstitutions ? 'explicit historical substitutions' : 'no substitutions',
      isServiceExtractionReplay ? 'service-extraction replay' : 'standard replay',
      replayBreadth.broad ? 'broader replay deep scan' : 'narrow replay deep scan',
    ].join(', '),
  };
}

export function estimateReproduceEfficiencyBudget(session: Session): ExecutorEfficiencyBudget {
  const scopeEntries = session.workItem.scope.length;
  const scopedTests = session.workItem.scope.filter((entry) => isTestFilePath(entry)).length;
  const replayBreadth = getReplayBreadth(session);
  const rawBudget =
    8 +
    Math.ceil(scopeEntries / 2) +
    scopedTests * 3 +
    (isNarrowFileScope(session.workItem.scope) ? 0 : 2);
  const targetTurns = clamp(rawBudget, MIN_REPRODUCE_TURN_BUDGET, MAX_REPRODUCE_TURN_BUDGET);
  const explorationTurns = clamp(
    Math.ceil(targetTurns * REPRODUCE_EXPLORATION_RATIO),
    MIN_REPRODUCE_EXPLORATION_BUDGET,
    Math.max(MIN_REPRODUCE_EXPLORATION_BUDGET, targetTurns - 4),
  );
  const summary = [
    `${scopeEntries} scope entry(s)`,
    `${scopedTests} scoped test target(s)`,
    replayBreadth.summary,
    isNarrowFileScope(session.workItem.scope) ? 'narrow file scope' : 'broader scope',
  ].join(', ');
  const shellFloors = buildReplayShellFloors(session, replayBreadth, targetTurns, explorationTurns);

  return {
    targetTurns,
    explorationTurns,
    ...shellFloors,
    allowScopedShellInspection: replayBreadth.changedFiles > 0,
    summary,
  };
}

export function estimateRootCauseEfficiencyBudget(session: Session): ExecutorEfficiencyBudget {
  const scopeEntries = session.workItem.scope.length;
  const openFindings = session.findings.filter((finding) => finding.status === 'open').length;
  const ambiguousDecisions = countDecisionsByClassification(session, 'AMBIGUOUS');
  const replayBreadth = getReplayBreadth(session);
  const rawBudget = 8 + Math.ceil(scopeEntries / 2) + openFindings + ambiguousDecisions * 2;
  const targetTurns = clamp(rawBudget, MIN_ROOT_CAUSE_TURN_BUDGET, MAX_ROOT_CAUSE_TURN_BUDGET);
  const explorationTurns = clamp(
    Math.ceil(targetTurns * ROOT_CAUSE_EXPLORATION_RATIO),
    MIN_ROOT_CAUSE_EXPLORATION_BUDGET,
    Math.max(MIN_ROOT_CAUSE_EXPLORATION_BUDGET, targetTurns - 4),
  );
  const summary = [
    `${scopeEntries} scope entry(s)`,
    `${openFindings} open finding(s)`,
    `${ambiguousDecisions} ambiguous decision(s)`,
    replayBreadth.summary,
    isNarrowFileScope(session.workItem.scope) ? 'narrow file scope' : 'broader scope',
  ].join(', ');
  const shellFloors = buildReplayShellFloors(session, replayBreadth, targetTurns, explorationTurns);

  return {
    targetTurns,
    explorationTurns,
    ...shellFloors,
    allowScopedShellInspection: replayBreadth.changedFiles > 0,
    summary,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface ReplayBreadth {
  changedFiles: number;
  packageRoots: number;
  broad: boolean;
  summary: string;
}

function getReplayBreadth(session: Session): ReplayBreadth {
  const changedFiles = session.replayContext?.changedFiles?.length ?? 0;
  const packageRoots = new Set(
    (session.replayContext?.changedFiles ?? []).map((filePath) => replayPackageRoot(filePath)),
  ).size;
  const broad =
    changedFiles >= 8 ||
    packageRoots >= 2 ||
    (session.replayContext?.tags ?? []).some((tag) =>
      ['service-extraction', 'refactor', 'rbac', 'route-migration'].includes(tag),
    );

  return {
    changedFiles,
    packageRoots,
    broad,
    summary:
      changedFiles > 0
        ? `${changedFiles} historical changed file(s), ${packageRoots} package root(s)`
        : 'no replay breadth metadata',
  };
}

function buildReplayShellFloors(
  session: Session,
  replayBreadth: ReplayBreadth,
  targetTurns: number,
  explorationTurns: number,
): Partial<ExecutorEfficiencyBudget> {
  if (session.workItem.type !== 'bug-fix') {
    return {};
  }

  if (replayBreadth.changedFiles > 0 && replayBreadth.broad) {
    return {
      shellWarnFloor: Math.max(12, targetTurns - 1),
      shellAbortFloor: Math.max(18, targetTurns + explorationTurns + 3),
    };
  }

  if (replayBreadth.changedFiles > 0 || session.workItem.scope.length <= 2) {
    return {
      shellWarnFloor: Math.max(8, targetTurns - 1),
      shellAbortFloor: Math.max(14, targetTurns + explorationTurns + 1),
    };
  }

  return {};
}

function replayPackageRoot(filePath: string): string {
  const segments = filePath.split('/').filter((segment) => segment.length > 0);
  return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : filePath;
}

function buildReplayAvoidPathPatterns(paths: string[]): string[] {
  return paths
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .map((path) => escapeRegExp(path));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatFindingsSummary(session: Session, stageType: StageDefinition['type']): string {
  if (session.findings.length === 0) return '(no findings yet)';

  const open =
    stageType === 'plan-generation'
      ? getVisiblePlanFindings(session)
      : session.findings.filter((f) => f.status === 'open');
  const followUp = stageType === 'plan-generation' ? getFollowUpPlanFindings(session) : [];
  const fixed = session.findings.filter((f) => f.status === 'fixed');
  const maxFindings = stageType === 'plan-generation' ? 12 : 20;
  const deferredPlanCount =
    stageType === 'plan-generation' ? getDeferredPlanFindingIds(session).size : 0;
  const approvedPlanCount =
    stageType === 'plan-generation' ? getApprovedPlanFindingIds(session).size : 0;
  const lines =
    stageType === 'plan-generation'
      ? [
          `${session.findings.length} total (${open.length} immediate/next to plan now, ${followUp.length} near-term/long-term follow-up, ${approvedPlanCount} already covered by approved slices, ${deferredPlanCount} proposed for backlog, ${fixed.length} fixed)`,
        ]
      : [`${session.findings.length} total (${open.length} open, ${fixed.length} fixed)`];
  for (const f of open.slice(0, maxFindings)) {
    lines.push(
      `  - ID: ${f.id} | [${getFindingHorizon(f)}] [${f.severity}] [${f.category}] ${f.title}`,
    );
    if (f.description && f.description !== f.title) {
      lines.push(`    Description: ${truncateInlineText(f.description, 280)}`);
    }
    if (f.files.length > 0) {
      const files = stageType === 'plan-generation' ? f.files.slice(0, 4) : f.files;
      lines.push(`    Files: ${files.map((r) => r.path).join(', ')}`);
      if (stageType === 'plan-generation' && f.files.length > files.length) {
        lines.push(`    Files: ... and ${f.files.length - files.length} more`);
      }
    }
  }
  if (open.length > maxFindings) {
    lines.push(`  ... and ${open.length - maxFindings} more`);
  }
  return lines.join('\n');
}

function formatOpenFindingsRegistry(session: Session, stageType: StageDefinition['type']): string {
  const compactForPlanning = stageType === 'plan-generation';
  const sourceFindings = compactForPlanning
    ? getVisiblePlanFindings(session)
    : session.findings.filter((finding) => finding.status === 'open');
  const openFindings = sourceFindings.map((finding) => ({
    id: finding.id,
    horizon: getFindingHorizon(finding),
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    description: compactForPlanning
      ? truncateInlineText(finding.description, 220)
      : finding.description,
    files: (compactForPlanning ? finding.files.slice(0, 4) : finding.files).map(
      (file) => file.path,
    ),
    ...(compactForPlanning && finding.files.length > 4
      ? { additionalFiles: finding.files.length - 4 }
      : {}),
  }));

  return ['```json', JSON.stringify(openFindings, null, 2), '```'].join('\n');
}

function formatFollowUpFindings(session: Session, stageType: StageDefinition['type']): string {
  if (stageType !== 'plan-generation') {
    return '(none)';
  }

  const followUpFindings = getFollowUpPlanFindings(session).map((finding) => ({
    id: finding.id,
    horizon: getFindingHorizon(finding),
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    description: truncateInlineText(finding.description, 220),
    files: finding.files.slice(0, 4).map((file) => file.path),
  }));

  if (followUpFindings.length === 0) {
    return '(none)';
  }

  return ['```json', JSON.stringify(followUpFindings, null, 2), '```'].join('\n');
}

function formatDecisions(session: Session, stageType: StageDefinition['type']): string {
  if (session.decisions.length === 0) return '(no decisions yet)';

  if (stageType !== 'plan-generation') {
    return session.decisions
      .map((d) => `  - [${d.classification}] ${d.question}${d.answer ? ` → ${d.answer}` : ''}`)
      .join('\n');
  }

  const ambiguous = session.decisions.filter((decision) => decision.classification === 'AMBIGUOUS');
  const decided = session.decisions.filter((decision) => decision.classification !== 'AMBIGUOUS');
  const ordered = [...ambiguous, ...decided];
  const maxDecisions = 12;
  const lines = [
    `${session.decisions.length} total decisions (${ambiguous.length} ambiguous, ${decided.length} decided)`,
  ];

  for (const decision of ordered.slice(0, maxDecisions)) {
    const summary = decision.answer
      ? `${decision.question} → ${decision.answer}`
      : decision.question;
    lines.push(`  - [${decision.classification}] ${truncateInlineText(summary, 220)}`);
  }

  if (ordered.length > maxDecisions) {
    lines.push(`  ... and ${ordered.length - maxDecisions} more`);
  }

  return lines.join('\n');
}

function getFindingHorizon(
  finding: Session['findings'][number],
): 'immediate' | 'next' | 'near-term' | 'long-term' {
  if (finding.horizon) {
    return finding.horizon;
  }

  switch (finding.severity) {
    case 'critical':
    case 'high':
      return 'immediate';
    case 'medium':
      return 'next';
    case 'low':
      return 'near-term';
    case 'info':
    default:
      return 'long-term';
  }
}

function truncateInlineText(value: string | undefined, maxChars: number): string {
  if (!value) {
    return '';
  }

  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(maxChars - 14, 0)).trimEnd()} [truncated]`;
}

function formatPreviousOutput(
  previousOutput: string,
  stageType: StageDefinition['type'],
  session: Session,
): string {
  if (!previousOutput) {
    return '(none)';
  }

  if (stageType !== 'plan-generation') {
    return previousOutput;
  }

  return compactPlanningPreviousOutput(previousOutput, session.planReviewState != null);
}

function compactPlanningPreviousOutput(
  previousOutput: string,
  hasPlanCarryForward: boolean,
): string {
  const trimmed = previousOutput.trim();
  const previousOutputMarker = 'PREVIOUS OUTPUT:';
  const markerIndex = trimmed.indexOf(previousOutputMarker);
  if (hasPlanCarryForward && markerIndex >= 0) {
    const header = trimmed.slice(0, markerIndex).trimEnd();
    const omissionNote =
      '[prior rejected plan body omitted; use Carry-Forward From Prior Review above as the authoritative prior plan state]';
    return header ? `${header}\n${omissionNote}` : omissionNote;
  }

  if (trimmed.length <= MAX_PLAN_PREVIOUS_OUTPUT_CHARS) {
    return trimmed;
  }

  if (markerIndex < 0) {
    return truncateMultilineMiddle(trimmed, MAX_PLAN_PREVIOUS_OUTPUT_CHARS);
  }

  const header = trimmed.slice(0, markerIndex + previousOutputMarker.length).trimEnd();
  const body = trimmed.slice(markerIndex + previousOutputMarker.length).trim();
  const remainingBudget = Math.max(MAX_PLAN_PREVIOUS_OUTPUT_CHARS - header.length - 80, 1200);
  return `${header}\n${truncateMultilineMiddle(body, remainingBudget)}\n[retry output truncated]`;
}

function truncateMultilineMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const headChars = Math.max(Math.floor(maxChars * 0.6), 1);
  const tailChars = Math.max(maxChars - headChars - 32, 1);
  const head = value.slice(0, headChars).trimEnd();
  const tail = value.slice(-tailChars).trimStart();
  return `${head}\n...\n[truncated for retry context]\n...\n${tail}`;
}

function formatCommits(session: Session): string {
  if (session.commits.length === 0) return '(no commits yet)';

  return session.commits.map((c) => `  - ${c.sha.slice(0, 7)} ${c.message}`).join('\n');
}

function appendOutputSchemaInstructions(prompt: string, stage: StageDefinition): string {
  if (!stage.outputSchema) {
    return prompt;
  }

  return `${prompt}\n\n${buildStageOutputInstructions(stage.outputSchema)}`;
}

function finalizePrompt(prompt: string, stage: StageDefinition, session: Session): string {
  if (shouldUseCompactReplayRecoveryPrompt(prompt, stage, session)) {
    return appendOutputSchemaInstructions(prompt, stage);
  }

  const promptSections = [prompt];
  const deepScanStopPolicy = buildDeepScanStopPolicy(stage, session);
  const scopeDiscipline = buildScopeDiscipline(stage, session);
  const reproductionStopPolicy = buildReproductionStopPolicy(stage, session);
  const rootCauseStopPolicy = buildRootCauseStopPolicy(stage, session);
  const planningStopPolicy = buildPlanningStopPolicy(stage, session);
  const targetedPlanRevisionMode = buildTargetedPlanRevisionMode(stage, session);
  const jiraScenarioEvidencePolicy = buildJiraScenarioEvidencePolicy(stage, session);
  const promptContext = renderPromptContext(stage.type, session.promptContext);

  if (deepScanStopPolicy) {
    promptSections.push(deepScanStopPolicy);
  }

  if (scopeDiscipline) {
    promptSections.push(scopeDiscipline);
  }

  if (reproductionStopPolicy) {
    promptSections.push(reproductionStopPolicy);
  }

  if (rootCauseStopPolicy) {
    promptSections.push(rootCauseStopPolicy);
  }

  if (planningStopPolicy) {
    promptSections.push(planningStopPolicy);
  }

  if (targetedPlanRevisionMode) {
    promptSections.push(targetedPlanRevisionMode);
  }

  if (jiraScenarioEvidencePolicy) {
    promptSections.push(jiraScenarioEvidencePolicy);
  }

  if (promptContext) {
    promptSections.push(promptContext);
  }

  return appendOutputSchemaInstructions(promptSections.join('\n\n'), stage);
}

function shouldUseCompactReplayRecoveryPrompt(
  prompt: string,
  stage: StageDefinition,
  session: Session,
): boolean {
  if (!['deep-scan', 'reproduce', 'root-cause', 'plan-generation'].includes(stage.type)) {
    return false;
  }

  if ((session.replayContext?.changedFiles?.length ?? 0) === 0) {
    return false;
  }

  return /^## (TOP PRIORITY|EVIDENCE-ONLY) RECOVERY MODE\b/m.test(prompt);
}

function buildScopeDiscipline(stage: StageDefinition, session: Session): string {
  if (stage.type !== 'deep-scan') {
    return '';
  }

  const replayGuidance = buildReplayDeepScanGuidance(session);

  if (isNarrowFileScope(session.workItem.scope)) {
    const baseGuidance = `## Scope Discipline
This is a narrow file-scoped audit. Treat the declared scope as the hard boundary by default.
- Read every listed file.
- Leave scope only to verify directly referenced signatures, imported helpers, route bindings, auth wrappers, or required tests.
- Do NOT read whole packages, unrelated dashboard pages, or transitive dependency trees unless a scoped file directly points there.
- Stop once the in-scope findings are supported by the read evidence; do not keep scanning for unrelated opportunities.`;
    return replayGuidance ? `${replayGuidance}\n\n${baseGuidance}` : baseGuidance;
  }

  const baseGuidance = `## Scope Discipline
Start inside the declared scope and exhaust it first.
- Expand outside scope only when a scoped file directly references a shared helper, contract, route registration point, or regression test you must verify.
- Prefer one-hop verification over repository-wide fan-out.`;
  return replayGuidance ? `${replayGuidance}\n\n${baseGuidance}` : baseGuidance;
}

function buildDeepScanStopPolicy(stage: StageDefinition, session: Session): string {
  if (stage.type !== 'deep-scan') {
    return '';
  }

  const changedFiles = session.replayContext?.changedFiles?.filter(Boolean) ?? [];
  if (changedFiles.length === 0) {
    return '';
  }

  const replayTargets = buildReplayDeepScanTargets(session);
  const replayTargetSection =
    replayTargets.length > 0
      ? `- For this replay, treat the following stabilization targets as sufficient stopping points once the already-read evidence supports them:\n${replayTargets
          .map((target, index) => `  ${index + 1}. ${target}`)
          .join('\n')}`
      : '';

  return `## Deep Scan Replay Stop Policy
- This is a historical replay. Your goal is to explain the known seam and surface the missing contracts around it, not to sample every adjacent product area.
- You have enough evidence to emit findings once you have covered:
  1. the primary route or handler seam,
  2. the primary repo/service/model seam that backs it,
  3. one directly affected regression test or direct consumer, and
  4. any one-hop permission, audit, or schema dependency that the seam directly references.
- For service-extraction and RBAC replays, a missing future service/repo file after the route + repo/model + regression-test seam is already evidence of the extraction gap. Treat that absence as a finding instead of proving it by scanning unrelated packages.
- For service-extraction and RBAC replays, do not use \`rg\`, \`grep\`, or broad path-pattern searches to reconfirm that a future service/repo/memberId route is absent once you have already checked that exact seam path.
- Once those coverage points are satisfied, prefer emitting the best supported findings you have over continuing to validate every downstream consumer.
${replayTargetSection ? `${replayTargetSection}\n` : ''}- After the core seam is explained, downstream consumers that are not in the historical changed-file list should be treated as confirmation-only, not as new discovery surfaces.
- After those four coverage points are satisfied, stop broadening into unrelated APIs, E2E suites, or neighboring features unless the already-read seam directly contradicts your current findings.
- Treat consumer files that are NOT in the historical replay file list as out-of-bounds by default. Only inspect one if the already-read route/service/repo/model seam explicitly points to it as the next required contract.
- Once you have inspected one auth, audit, or schema dependency, do not inspect a second helper of the same class unless the first one directly contradicts the route/repo/model seam.
- Do not sample unrelated tests just because they mention a similar helper or audit action name.
- Package-level model tests and shared role-definition sources outside the historical changed-file list are confirmation-only. Do not inspect them unless the already-read route/repo/model seam directly imports or references them.
- Generic wrappers such as \`route-handler\`, \`api-response\`, and similar framework helpers are confirmation-only in replay mode. Do not inspect them unless the route source itself is still ambiguous after the primary route/repo/model/test seam is already covered.
- Do not read UI surfaces, generic test harness helpers, or broad cross-feature API suites merely because they also hit a similar \`/members\` route.`;
}

function buildReplayDeepScanGuidance(session: Session): string {
  const changedFiles = session.replayContext?.changedFiles?.filter(Boolean) ?? [];
  const historicalFileHints = session.replayContext?.historicalFileHints;
  const avoidPaths = session.replayContext?.avoidPaths?.filter(Boolean) ?? [];
  const replayTargets = buildReplayDeepScanTargets(session);
  const replaySeam = buildReplaySeamSections(session);
  const replayWorkspaceDir =
    session.workspaceContext?.worktreeDir?.trim() ??
    session.workspaceContext?.sourceWorkDir?.trim() ??
    '';
  if (
    changedFiles.length === 0 &&
    avoidPaths.length === 0 &&
    (!historicalFileHints || Object.keys(historicalFileHints).length === 0) &&
    replayTargets.length === 0
  ) {
    return '';
  }

  return `## Replay Seam Guidance
This audit is replaying a known historical change. Start from the current base-commit seam below before any broad repo search.

### Current Base-Commit Seam To Inspect First
${replaySeam.currentBaseCommitSeam}
${replaySeam.futureTargetSection}
${replaySeam.historicalHintSection}

- Current replay execution workspace: ${replayWorkspaceDir || 'the current worktree'}.
- Resolve the relative seam paths above against that workspace. If you encounter source-checkout paths, treat them as reference-only and continue in the replay worktree.
- Treat the current base-commit seam above as the first-pass seam for Deep Scan.
- Future target files are expected to be absent at the replay base commit. A missing future target confirms the seam gap; it does not mean the current base-commit seam is missing.
- Some historical target files may not exist yet at the replay base commit. If a candidate path is missing, inspect the nearest existing sibling route, service, repo, model, or test file in that directory instead of widening to unrelated packages.
- When a missing future target has an explicit historical substitution above, prefer those substitute files before any other same-directory siblings or repo-wide search.
- Do not pass missing future targets directly into \`rg --files\`, \`find\`, or other inventory commands. Use the substitutions above or same-directory siblings and treat the missing file itself as evidence of a seam gap.
- Once a future seam file has already been confirmed missing, do not re-check that absence with \`rg\`, \`grep\`, or any other pattern search. The missing path is already valid seam evidence.
- If you absolutely need to confirm a single future seam path, use one exact path existence check such as \`test -f <path>\` and then move on. Do not escalate to broader search when that exact path is absent.
- Treat the historical changed-file list as the default allowlist for first-order consumers. If a consumer is not listed there, only read it after the route/repo/model/test seam you already inspected explicitly forces you to.
- Do not treat a missing historical target file as a reason to fan out into unrelated runtime, UI, or workspace flows.
- Do not inspect settings pages, workspace-member routes, shared auth packages, or UI consumers until the primary route, repo, model, and regression-test seam is exhausted and still cannot explain the gap.
- Shared RBAC maps and package-level model tests are confirmation-only in replay mode unless the already-read route/repo/model seam directly imports them.
- Treat shared role/permission maps under \`packages/shared\` or \`packages/shared-auth\` (including \`role-permissions.ts\` and \`PROJECT_ROLE_NAMES\`) as confirmation-only. Do not inspect them unless the already-read route/repo/model seam directly imports or references them.
- Prefer direct consumers that appear in the historical changed-file list, adjacent tests, and same-directory siblings before repo-wide searches.
- Avoid broad helper harnesses and unrelated API suites unless the seam cannot be explained without them.
- After the seam files above are identified, do not use directory inventory commands such as \`ls\`, \`find\`, \`fd\`, or \`rg --files\` to re-enumerate those directories. Read the known files directly or synthesize the finding.
${avoidPaths.length > 0 ? `\n- Replay-specific out-of-bounds paths for this historical seam:\n${avoidPaths.map((path) => `  - ${path}`).join('\n')}\n- Treat those paths as forbidden during Deep Scan unless the already-read route/repo/model/test seam directly proves one is required for correctness.` : ''}
${replayTargets.length > 0 ? `\n- For this replay, bias findings toward these stabilization targets before exploring any additional consumers:\n${replayTargets.map((target) => `  - ${target}`).join('\n')}` : ''}`;
}

function buildReplayDeepScanTargets(session: Session): string[] {
  const tags = new Set(session.replayContext?.tags?.filter(Boolean) ?? []);
  const targets: string[] = [];

  if (tags.has('service-extraction')) {
    targets.push(
      'whether the route handlers should thin down into a dedicated service/repository seam instead of inlining persistence, audit, and validation logic',
    );
  }

  if (tags.has('rbac')) {
    targets.push(
      'whether permission checks, custom-role validation, and audit actions stay consistent across the project-member seam without needing to inspect unrelated workspace or runtime member flows',
    );
  }

  if (tags.has('route-migration')) {
    targets.push(
      'whether the canonical route shape and identifier contract changed (for example userId -> memberId) and which adjacent tests or consumers must move with it',
    );
  }

  if (tags.has('model-contract')) {
    targets.push(
      'whether the database model and repository contract already support the extracted seam or need a focused contract update',
    );
  }

  return targets;
}

function buildReproductionStopPolicy(stage: StageDefinition, session: Session): string {
  if (stage.type !== 'reproduce') {
    return '';
  }

  const scopedTests = session.workItem.scope.filter((entry) => isTestFilePath(entry));
  const scopedTestSummary =
    scopedTests.length > 0 ? scopedTests.join(', ') : 'the declared scoped regression file';
  const efficiencyBudget = estimateReproduceEfficiencyBudget(session);

  return `## Reproduce Efficiency Budget
- Target total turns: ${efficiencyBudget.targetTurns}
- Exploration budget: ${efficiencyBudget.explorationTurns} turn(s) for discovery before you should emit the best scoped reproduction artifact from the evidence already gathered
- Complexity drivers: ${efficiencyBudget.summary}

## Reproduce Stop Policy
- The goal of Reproduce is to leave one failing scoped regression artifact and a correct \`reproduction-report\`, not to fully validate or fix the product.
- Preferred regression target(s): ${scopedTestSummary}
- Once that scoped failing test artifact exists, stop widening the investigation and emit the structured reproduction report.
- Do not edit \`AGENTS.md\`, \`agents.md\`, \`CLAUDE.md\`, journals, or unrelated docs during Reproduce.
- Prefer direct focused test runners (for example \`pnpm --dir <package> exec vitest run <file>\`) over package \`test\` scripts when proving a single regression file.
- Do not run broad \`pnpm build\`, \`next build\`, \`turbo build\`, or repo-wide proof commands during Reproduce unless the scoped verification command failed first and you need the broader build to explain the missing contract.`;
}

function buildRootCauseStopPolicy(stage: StageDefinition, session: Session): string {
  if (stage.type !== 'root-cause') {
    return '';
  }

  const efficiencyBudget = estimateRootCauseEfficiencyBudget(session);
  return `## Root Cause Efficiency Budget
- Target total turns: ${efficiencyBudget.targetTurns}
- Exploration budget: ${efficiencyBudget.explorationTurns} turn(s) for new discovery before you should emit the best root-cause analysis from the evidence already gathered
- Complexity drivers: ${efficiencyBudget.summary}

## Root Cause Stop Policy
- Treat the confirmed reproduction artifact, bug description, and directly implicated seam as the primary evidence.
- Stay inside the confirmed seam unless a read file directly points to one adjacent route, store, API client, or contract you must verify.
- Prefer \`helix_find_symbol\`, \`helix_find_references\`, \`helix_get_route_info\`, and \`helix_get_schema_info\` over repo-wide grep loops when they answer the question faster.
- Do not read \`AGENTS.md\`, \`agents.md\`, journals, \`~/.claude\` tool-result files, or unrelated docs during Root Cause Analysis.
- Do not search the whole repo once the minimal causal chain is clear. Emit the root cause, affected paths, and minimal fix as soon as the seam is explained.
- If uncertainty remains after the exploration budget, summarize the remaining gap instead of widening the search further.`;
}

function buildJiraScenarioEvidencePolicy(stage: StageDefinition, session: Session): string {
  const jiraKey = session.workItem.jiraKey?.trim();
  if (!jiraKey || !/^[A-Z][A-Z0-9]+-\d+$/.test(jiraKey)) {
    return '';
  }

  if (!['implementation', 'testing', 'review', 'regression', 'bulk-review'].includes(stage.type)) {
    return '';
  }

  return `## Jira Scenario Evidence Policy
This work item is tied to Jira ticket ${jiraKey}. Before claiming the ticket is complete, HELIX must run an evidence-only pass that proves the exact Jira scenario, not just generic tests.

Evidence requirements:
- UI / Studio tickets: capture actual Studio video or screenshots showing the specific Jira scenario. Use \`pnpm studio:video:evidence\`. If no reusable scenario exists, first scaffold one with \`pnpm studio:video:evidence -- --scaffold-scenario ${jiraKey.toLowerCase()}-<short-scenario> --surface <surface>\`, then run that scenario. A page-load-only capture is not enough.
- API / runtime tickets: save actual API response artifacts, including response, headers, and body, under \`.codex-artifacts/helix-evidence/${jiraKey}/\`. Unit test JSON alone is not enough.
- The final evidence output must map exactly: Jira scenario -> root cause -> fix commit -> exact evidence artifact -> verification command -> residual risk.
- If scenario-specific evidence cannot be produced, stop and emit a blocking finding titled \`BLOCKED: scenario-specific evidence unavailable\` with the missing scenario, attempted command, and the reason it is blocked.
- Do not post or prepare Jira completion comments that omit any required mapping field.`;
}

function buildPlanningStopPolicy(stage: StageDefinition, session: Session): string {
  if (stage.type !== 'plan-generation') {
    return '';
  }

  const efficiencyBudget = estimatePlanningEfficiencyBudget(session);
  const compactReplayPlanning = shouldUseCompactReplayPlanningStart(session);
  const basePolicy = `## Planning Efficiency Budget
- Target total turns: ${efficiencyBudget.targetTurns}
- Exploration budget: ${efficiencyBudget.explorationTurns} turn(s) for new discovery before you should be emitting the best full slice plan from the evidence already gathered
- Complexity drivers: ${efficiencyBudget.summary}

## Planning Stop Policy
- Treat the findings registry, planning batches, carry-forward review state, and prompt context as the primary planning evidence.
- Each open finding ID must appear in exactly one slice. If a seam-wide finding spans multiple slices, assign it only to the earliest slice that establishes or extracts that seam; make later slices depend on that slice instead of repeating the same finding ID.
- Spend exploration turns only on unresolved seams, dependency ordering, or test scope that those artifacts do not already answer.
- Batch related reads/searches in single turns; do not read one file at a time across whole packages.
- Prefer \`helix_find_symbol\`, \`helix_find_references\`, \`helix_get_route_info\`, \`helix_get_schema_info\`, and \`helix_get_impacted_tests\` over repeated grep loops when they answer the question faster.
- Once the exploration budget is exhausted, stop broad discovery and emit the best complete \`slice-plan\` JSON you can.
- If small uncertainty remains, keep the slice narrow or emit a decision/question instead of continuing to scout the repo.
- Do not re-read the same file or rerun the same lookup unless new evidence changes the plan.`;

  const replayGuidance = buildReplayPlanningGuidance(session);
  const compactGuidance = compactReplayPlanning
    ? `## Compact Replay Planning Mode
- The open replay findings are already seam-anchored immediate/next work. Plan directly from the findings registry and historical seam.
- Tool use is disabled for this planning pass. Do not reopen files, list directories, or inventory packages again.
- Emit the narrowest complete \`slice-plan\` JSON now. If one dependency remains ambiguous, record it as a decision or blocker note instead of rediscovering the repo.
- Keep only immediate and next-horizon work in this plan. Near-term and long-term follow-up belongs in deferred findings, not in the current slices.`
    : '';
  const sections = [compactGuidance, replayGuidance, basePolicy].filter((section) => section);
  return sections.join('\n\n');
}

function buildReplayPlanningGuidance(session: Session): string {
  const changedFiles = session.replayContext?.changedFiles?.filter(Boolean) ?? [];
  const historicalFileHints = session.replayContext?.historicalFileHints;
  const replaySeam = buildReplaySeamSections(session);
  const replayWorkspaceDir =
    session.workspaceContext?.worktreeDir?.trim() ??
    session.workspaceContext?.sourceWorkDir?.trim() ??
    '';
  if (
    changedFiles.length === 0 &&
    (!historicalFileHints || Object.keys(historicalFileHints).length === 0)
  ) {
    return '';
  }

  return `## Replay Planning Guidance
This plan is replaying a known historical change. Use the current base-commit seam below as the default planning surface instead of rediscovering the repository.

### Current Base-Commit Seam To Plan From
${replaySeam.currentBaseCommitSeam}
${replaySeam.futureTargetSection}
${replaySeam.historicalHintSection}

- Current replay execution workspace: ${replayWorkspaceDir || 'the current worktree'}.
- Resolve the relative seam paths above against that workspace. If you encounter source-checkout paths, treat them as reference-only and keep planning against the replay worktree.
- Begin by drafting the full \`slice-plan\` directly from the findings registry, planning batches, and historical seam listed here. Treat extra repository reads as a last resort, not a starting point.
- Draft the plan from the current base-commit seam first. Treat future target files as expected outputs of the replay, not as current files you must locate before planning can begin.
- Start from the findings registry plus this historical seam. Do not rerun \`find\`, \`git ls-files\`, \`git show HEAD:<file>\`, line-count commands, or repo-wide lookups just to rediscover paths already listed above.
- After the exploration budget, treat workspace inventory commands (\`ls\`, \`find\`, \`fd\`, repo-root globs) as off-limits. If the seam still feels incomplete, produce the best plan you can with a blocker note instead of listing the repo again.
- Treat the historical changed-file list as the default slice allowlist. Keep slices centered on those files and only add one-hop dependencies that the already-read seam explicitly requires.
- Historical seam findings should anchor the earliest slice that establishes the seam. Do not repeat the same finding ID across follow-on slices; use dependencies plus descriptions/tests to express the continuation work.
- If a historical target file does not exist at the replay base commit, use the explicit substitution above or the nearest same-directory sibling route, repo, model, service, or test file. Do not widen to unrelated packages or neighboring features.
- Non-listed consumers are out-of-bounds by default during planning. Only add one when the findings or already-read seam make it necessary for a concrete slice dependency or regression-proof reason.
- Prefer patching the known route/repo/model/test seam into slices over re-auditing UI tabs, runtime repos, or broad auth helpers.`;
}

function buildReplaySeamSections(session: Session): {
  currentBaseCommitSeam: string;
  futureTargetSection: string;
  historicalHintSection: string;
} {
  const changedFiles = session.replayContext?.changedFiles?.filter(Boolean) ?? [];
  const historicalFileHints = session.replayContext?.historicalFileHints ?? {};
  const futureTargets = new Set(Object.keys(historicalFileHints).map((path) => path.trim()));
  const currentSeamPaths = new Set<string>();

  for (const filePath of changedFiles) {
    const trimmed = filePath.trim();
    if (trimmed.length === 0 || futureTargets.has(trimmed)) {
      continue;
    }
    currentSeamPaths.add(trimmed);
  }

  for (const hintPaths of Object.values(historicalFileHints)) {
    for (const hintPath of hintPaths) {
      const trimmed = hintPath.trim();
      if (trimmed.length > 0) {
        currentSeamPaths.add(trimmed);
      }
    }
  }

  const currentBaseCommitSeam = [...currentSeamPaths]
    .slice(0, 12)
    .map((filePath) => `  - ${filePath}`)
    .join('\n');
  const futureTargetSection =
    futureTargets.size > 0
      ? `\n\n### Future Target Files Expected To Be Missing At The Base Commit\n${[...futureTargets]
          .slice(0, 12)
          .map((filePath) => `  - ${filePath}`)
          .join('\n')}`
      : '';
  const historicalHintSection =
    Object.keys(historicalFileHints).length > 0
      ? `\n\n### Historical Replay Substitutions\n${Object.entries(historicalFileHints)
          .map(([futurePath, existingPaths]) => `  - ${futurePath} -> ${existingPaths.join(', ')}`)
          .join('\n')}`
      : '';

  return {
    currentBaseCommitSeam:
      currentBaseCommitSeam || '  - (no current base-commit seam paths recorded)',
    futureTargetSection,
    historicalHintSection,
  };
}

function shouldUseCompactReplayPlanningStart(session: Session): boolean {
  const replayBreadth = getReplayBreadth(session);
  if (!replayBreadth.broad || replayBreadth.changedFiles === 0) {
    return false;
  }

  const visibleFindings = getVisiblePlanFindings(session);
  if (visibleFindings.length === 0) {
    return false;
  }

  return visibleFindings.every((finding) => {
    const horizon = getFindingHorizon(finding);
    return horizon === 'immediate' || horizon === 'next';
  });
}

function buildTargetedPlanRevisionMode(stage: StageDefinition, session: Session): string {
  if (stage.type !== 'plan-generation' || !session.planReviewState) {
    return '';
  }

  const approvedSlices = session.planReviewState.approvedSlices.map((slice) => slice.sliceNumber);
  const slicesToRevise = session.planReviewState.slicesToRevise.map((slice) => slice.sliceNumber);
  if (approvedSlices.length === 0 || slicesToRevise.length === 0) {
    return '';
  }

  return `## Targeted Plan Revision Mode
- Most of the prior plan is already approved. Preserve approved slices unless a dependency change is strictly required.
- Approved slices to keep stable: ${approvedSlices.join(', ')}
- Slices that actually need revision: ${slicesToRevise.join(', ')}
- Start from the reviewer rationale for the contested slices. Do not reopen approved slices just to rediscover the same plan.
- Keep approved slice numbering, findings, files, and tests stable whenever possible.
- Keep each finding ID attached to a single owning slice. If a previously contested seam-wide finding affects multiple slices, keep it on the earliest owning slice and revise later slices via dependencies, file scope, and tests instead of duplicating the finding assignment.
- If a contested slice only needs file, dependency, or test amendments, patch that slice instead of re-slicing the whole plan.`;
}

function isNarrowFileScope(scope: string[]): boolean {
  return scope.length > 0 && scope.every((entry) => looksLikeFileScopeEntry(entry));
}

function looksLikeFileScopeEntry(entry: string): boolean {
  const lastSegment = entry.split('/').pop() ?? entry;
  return lastSegment.includes('.') && !entry.endsWith('.');
}

function countDecisionsByClassification(
  session: Session,
  classification: DecisionClassification,
): number {
  return session.decisions.filter((decision) => decision.classification === classification).length;
}

function formatSliceReferenceList(indices: number[]): string {
  if (indices.length === 0) {
    return 'none';
  }

  return indices.map((index) => `Slice ${index + 1}`).join(', ');
}

function collectSliceDependents(slice: Slice): string[] {
  const paths = new Set<string>();

  for (const path of slice.impactAnalysis.dependentFiles) {
    const trimmed = path.trim();
    if (trimmed) {
      paths.add(trimmed);
    }
  }

  for (const contract of slice.manifest.fileContracts) {
    for (const dependent of contract.dependents ?? []) {
      const trimmed = dependent.trim();
      if (trimmed) {
        paths.add(trimmed);
      }
    }
  }

  for (const contract of slice.manifest.exportContracts) {
    for (const consumer of contract.consumers) {
      const trimmed = consumer.trim();
      if (trimmed) {
        paths.add(trimmed);
      }
    }
  }

  return [...paths];
}

function formatPathList(paths: string[]): string {
  if (paths.length === 0) {
    return '(none)';
  }

  return paths.map((path) => `  - ${path}`).join('\n');
}
