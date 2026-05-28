/**
 * Builds the synthesis prompt for the dueling-planners convergence stage.
 *
 * Pure function — no I/O, no side effects.
 *
 * ANTI-ANCHOR INVARIANT (UT-4): The generated prompt string MUST NOT contain
 * the literals "claude-code", "openai-api", "Opus", or "GPT-5". The synthesis
 * prompt is deliberately blind to which provider produced which candidate to
 * reduce anchor bias in the synthesis model.
 */

import type { PlanArtifact } from '../../types.js';

export interface DuelingSynthesisPromptInput {
  candidateA: PlanArtifact;
  candidateB?: PlanArtifact;
  featureContext: string;
}

export function buildDuelingSynthesisPrompt(args: DuelingSynthesisPromptInput): string {
  const sections: string[] = [];

  sections.push(buildCandidateSection('Candidate A', args.candidateA));

  if (args.candidateB !== undefined) {
    sections.push(buildCandidateSection('Candidate B', args.candidateB));
  } else {
    sections.push(buildSoloPassAdvisory());
  }

  sections.push(buildFeatureContextSection(args.featureContext));
  sections.push(buildSynthesisInstructions());

  return sections.join('\n\n');
}

function buildCandidateSection(label: string, artifact: PlanArtifact): string {
  return [`# ${label}`, '', artifact.output].join('\n');
}

function buildSoloPassAdvisory(): string {
  return [
    '# Candidate B',
    '',
    'Planner B failed to produce a plan. Only Candidate A is available.',
    'Treat Candidate A as the sole input. The convergent Plan C should refine',
    'and validate the surviving candidate rather than synthesizing across two plans.',
    'Still emit a divergence-notes section noting that only one candidate was available.',
  ].join('\n');
}

function buildFeatureContextSection(featureContext: string): string {
  return ['# Feature Context', '', featureContext].join('\n');
}

function buildSynthesisInstructions(): string {
  return [
    '# Synthesis Instructions',
    '',
    'You are synthesizing a convergent plan from two candidate plans.',
    'Identify areas of agreement and key divergences.',
    'Produce Plan C that supersedes both, plus a divergence-notes section',
    'with the format specified below.',
    'Tool use is disabled — reason strictly over the provided material.',
    '',
    '## Output Format',
    '',
    'Return a single JSON object conforming to the plan-c-with-divergence schema.',
    'The object must contain "summary" and "slices" fields matching the slice-plan',
    'schema, plus an optional "divergenceNotes" string field.',
    '',
    '## Divergence Notes Format',
    '',
    'The "divergenceNotes" field should be a markdown string with the following structure:',
    '',
    '```',
    '## Divergence Notes',
    '',
    '- **<topic>**: <description of how the two candidates diverged and how Plan C resolves it>',
    '- **<topic>**: <description of divergence and resolution>',
    '```',
    '',
    'Each bullet should identify:',
    '1. What the two candidates disagreed on (ordering, scope, approach, file ownership)',
    '2. Which candidate Plan C favors for that topic and why',
    '3. Any risks introduced by the chosen resolution',
    '',
    'When only one candidate is available, note the absence of a second candidate',
    'and list any areas where the surviving plan could benefit from an alternative perspective.',
  ].join('\n');
}
