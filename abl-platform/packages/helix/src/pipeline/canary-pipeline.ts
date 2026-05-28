import type { PipelineTemplate, StageDefinition } from '../types.js';

const CANARY_STAGE_COUNT = 6;
const MAX_CANARY_FINDINGS = 5;
const MAX_CANARY_DECISIONS = 3;
const MAX_CANARY_ORACLE_NEW_FINDINGS = 1;
const MAX_CANARY_ORACLE_DECISIONS = 1;
const DEFAULT_DEEP_SCAN_MAX_TURNS = 12;
const DEFAULT_FALLBACK_MAX_TURNS = 18;
const DEFAULT_CANARY_ORACLE_MAX_TURNS = 12;
const DEFAULT_PLAN_MAX_TURNS = 18;
const CANARY_DEEP_SCAN_EFFORT = 'medium';
const CANARY_ORACLE_EFFORT = 'medium';
const CANARY_PLAN_EFFORT = 'medium';
const CANARY_ORACLE_MODEL = 'sonnet';
const CANARY_PLAN_REVIEW_MODEL = 'sonnet';
const CANARY_PLAN_REVIEW_EFFORT = 'medium';
const DEFAULT_CANARY_PLAN_REVIEW_MAX_TURNS = 8;
const DEFAULT_CANARY_PLAN_REVIEW_MAX_BUDGET_USD = 4;
const DEFAULT_CANARY_ORACLE_MAX_BUDGET_USD = 4;

const CANARY_PLAN_REVIEW_GUIDANCE = [
  'This is a bounded HELIX canary review, not a fresh repository audit.',
  'Treat the open findings snapshot and the plan output under review as the primary source of truth.',
  'Do not reread repository files unless a slice references a file outside the declared scope or a finding-to-slice assignment is ambiguous.',
  'Prefer preserving sound slices and requesting narrow requiredTestAmendments over reopening the whole plan.',
].join('\n');

const CANARY_ORACLE_REVIEW_GUIDANCE = [
  'This is a bounded HELIX canary oracle, not a fresh repository audit.',
  'Start from the supplied findings and their file paths. Confirm, narrow, or challenge those findings before considering anything new.',
  'Do not fan out across the repository. Only read scoped files and at most one directly referenced helper when the supplied finding cannot be judged otherwise.',
  'Treat the supplied findings as the full review queue for this run. Assess them first and stop once every finding you can judge has a verdict.',
  'If a finding looks directionally correct and you cannot disprove it quickly, confirm it and move on.',
  `Add at most ${MAX_CANARY_ORACLE_NEW_FINDINGS} new finding and at most ${MAX_CANARY_ORACLE_DECISIONS} decision.`,
  'Do not invent broad backlog programs, minimum-coverage quotas, or repo-wide audits in canary mode.',
].join('\n');

function buildCanaryOracleGuidance(name: string): string {
  const lines = [CANARY_ORACLE_REVIEW_GUIDANCE];
  if (name.toLowerCase().includes('testing')) {
    lines.push(
      'For testing review, focus only on regressions directly needed for the scoped findings. Do not require feature-wide E2E or integration minimums unless an existing finding already calls for that gap.',
    );
  }
  return lines.join('\n\n');
}

export function createCanaryPipeline(
  basePipeline: PipelineTemplate,
  scope: string[],
  canaryStageTimeoutMs: number,
): PipelineTemplate {
  const pipeline = structuredClone(basePipeline);
  pipeline.name = `${basePipeline.name} Canary`;
  pipeline.description =
    'Bounded orchestration canary that validates scan, oracle, planning, and manifest stages.';
  pipeline.stages = pipeline.stages
    .filter((stage) => stage.type !== 'bootstrap')
    .slice(0, CANARY_STAGE_COUNT)
    .map((stage) => tuneStageForCanary(stage, scope, canaryStageTimeoutMs));
  return pipeline;
}

export function buildCanaryDeepScanPrompt(scope: string[]): string {
  const renderedScope = scope.length > 0 ? scope : ['packages/helix/src'];

  return [
    'You are running a bounded HELIX canary, not a full repository audit.',
    '',
    '## Goal',
    'Validate that Deep Scan can inspect the provided scope, produce structured output, and stop quickly.',
    '',
    '## Scope',
    ...renderedScope.map((entry) => `- ${entry}`),
    '',
    '## Operating Rules',
    '1. Stay inside the listed scope. Do not fan out into the rest of the repository unless a scoped file directly references it.',
    '2. Use lightweight inspection only. Prefer Read, Grep, and Glob.',
    '3. Do NOT run package-manager, build, test, formatter, or git commands.',
    '4. Do NOT use shell commands for exploration unless inspection tools cannot answer the question.',
    '5. Sample the highest-signal files first; exhaustive coverage is not required for this canary.',
    '6. If a scoped file is large, grep for the report keywords or failing contract first, then read only the matching sections plus directly adjacent callers/tests.',
    '7. Ignore unrelated exports, workflow states, stores, or UI flows in the same file unless a scoped doc line or grep hit points directly at them.',
    `8. Return at most ${MAX_CANARY_FINDINGS} findings and at most ${MAX_CANARY_DECISIONS} decisions.`,
    '9. If nothing important stands out quickly, returning an empty findings list is valid.',
    '',
    '## What To Look For',
    '- Broken stage contracts or schema mismatches',
    '- Wiring gaps between HELIX stages, routers, parsers, and session persistence',
    '- Clear orchestration risks that would block autonomous execution',
    '- Missing validation or artifact persistence that makes failures hard to debug',
    '',
    'Prefer concrete, scoped findings with file paths over speculative architecture commentary.',
  ].join('\n');
}

export function buildCanaryPlanPrompt(scope: string[]): string {
  const renderedScope = scope.length > 0 ? scope : ['packages/helix/src'];

  return [
    'You are creating a bounded HELIX canary implementation plan.',
    '',
    '## Feature',
    'Title: {{title}}',
    'Description: {{description}}',
    'JIRA: {{jiraKey}}',
    '',
    '## Scope',
    ...renderedScope.map((entry) => `- ${entry}`),
    '',
    '## Findings to Address',
    '{{findings}}',
    '',
    '## Decisions Made',
    '{{decisions}}',
    '',
    '## Goal',
    'Produce a compact slice plan that assigns every open finding exactly once.',
    '',
    '## Operating Rules',
    '1. Stay inside the provided scope and directly referenced helpers. Do not fan out across the repository for exhaustive discovery.',
    '2. Reuse the files already named in the findings unless a directly adjacent helper or test file is clearly required.',
    '3. Copy the exact HELIX finding IDs from the Findings to Address section into each slice `findings` array.',
    '4. Prefer 1-4 small slices. Stop as soon as every open finding is assigned, files are listed, and each slice has at least one required test.',
    '5. Stabilize one seam or shared contract at a time. Prefer foundation-first slices over repeated consumer patches.',
    '6. Prefer existing nearby tests when known; otherwise propose the most specific regression test path you can infer.',
    '7. Note duplicate or superseded paths when the slice should converge or remove them.',
    '8. Use the finding registry and scoped docs as authoritative. Do not reread large files unless a finding description is still ambiguous.',
    '9. Do not re-audit the feature. This stage is planning only.',
  ].join('\n');
}

function tuneStageForCanary(
  stage: StageDefinition,
  scope: string[],
  canaryStageTimeoutMs: number,
): StageDefinition {
  const tuned = structuredClone(stage);
  const stageTimeoutMs = canaryStageTimeoutMs > 0 ? canaryStageTimeoutMs : undefined;

  switch (tuned.type) {
    case 'deep-scan': {
      tuned.prompt = buildCanaryDeepScanPrompt(scope);
      tuned.tools = ['Read', 'Grep', 'Glob'];
      tuned.timeoutMs = stageTimeoutMs;
      tuned.model.primary.effort = CANARY_DEEP_SCAN_EFFORT;
      tuned.model.primary.maxTurns = Math.min(
        tuned.model.primary.maxTurns ?? DEFAULT_DEEP_SCAN_MAX_TURNS,
        DEFAULT_DEEP_SCAN_MAX_TURNS,
      );
      if (tuned.model.fallback) {
        tuned.model.fallback.effort = CANARY_DEEP_SCAN_EFFORT;
        tuned.model.fallback.maxTurns = Math.min(
          tuned.model.fallback.maxTurns ?? DEFAULT_FALLBACK_MAX_TURNS,
          DEFAULT_FALLBACK_MAX_TURNS,
        );
        tuned.model.fallback.maxBudgetUsd = Math.min(tuned.model.fallback.maxBudgetUsd ?? 12, 12);
      }
      return tuned;
    }
    case 'oracle-analysis': {
      tuned.timeoutMs = stageTimeoutMs;
      tuned.substages = tuned.substages?.map((substage) => {
        const oracle = structuredClone(substage);
        delete oracle.timeoutMs;
        oracle.prompt = buildCanaryOracleGuidance(oracle.name);
        oracle.tools = ['Read', 'Grep'];
        oracle.model.primary.model = CANARY_ORACLE_MODEL;
        oracle.model.primary.effort = CANARY_ORACLE_EFFORT;
        oracle.model.primary.maxTurns = Math.min(
          oracle.model.primary.maxTurns ?? DEFAULT_CANARY_ORACLE_MAX_TURNS,
          DEFAULT_CANARY_ORACLE_MAX_TURNS,
        );
        oracle.model.primary.maxBudgetUsd = Math.min(
          oracle.model.primary.maxBudgetUsd ?? DEFAULT_CANARY_ORACLE_MAX_BUDGET_USD,
          DEFAULT_CANARY_ORACLE_MAX_BUDGET_USD,
        );
        return oracle;
      });
      return tuned;
    }
    case 'plan-generation': {
      tuned.timeoutMs = stageTimeoutMs;
      tuned.prompt = buildCanaryPlanPrompt(scope);
      if (tuned.qualityGate) {
        delete tuned.qualityGate.timeoutMs;
        tuned.qualityGate.checks = tuned.qualityGate.checks.map((check) => {
          if (check.type !== 'model-review' || !check.model) {
            return check;
          }

          return {
            ...check,
            prompt: [CANARY_PLAN_REVIEW_GUIDANCE, check.prompt].filter(Boolean).join('\n\n'),
            tools: ['Read'],
            model: {
              ...check.model,
              primary: {
                ...check.model.primary,
                model: CANARY_PLAN_REVIEW_MODEL,
                effort: CANARY_PLAN_REVIEW_EFFORT,
                maxTurns: Math.min(
                  check.model.primary.maxTurns ?? DEFAULT_CANARY_PLAN_REVIEW_MAX_TURNS,
                  DEFAULT_CANARY_PLAN_REVIEW_MAX_TURNS,
                ),
                maxBudgetUsd: Math.min(
                  check.model.primary.maxBudgetUsd ?? DEFAULT_CANARY_PLAN_REVIEW_MAX_BUDGET_USD,
                  DEFAULT_CANARY_PLAN_REVIEW_MAX_BUDGET_USD,
                ),
              },
            },
          };
        });
      }
      tuned.model.primary.effort = CANARY_PLAN_EFFORT;
      tuned.model.primary.maxTurns = Math.min(
        tuned.model.primary.maxTurns ?? DEFAULT_PLAN_MAX_TURNS,
        DEFAULT_PLAN_MAX_TURNS,
      );
      tuned.model.primary.maxBudgetUsd = Math.min(tuned.model.primary.maxBudgetUsd ?? 8, 8);
      return tuned;
    }
    case 'manifest-compilation':
      tuned.timeoutMs = stageTimeoutMs;
      return tuned;
    default:
      delete tuned.timeoutMs;
      return tuned;
  }
}
