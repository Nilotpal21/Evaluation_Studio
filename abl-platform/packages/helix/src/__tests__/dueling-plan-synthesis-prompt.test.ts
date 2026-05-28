/**
 * UT-4: Anti-anchor tests for the dueling-plan synthesis prompt builder.
 *
 * Verifies:
 *   - No provider-identifying literals ("claude-code", "openai-api", "Opus", "GPT-5")
 *     leak into the synthesis prompt.
 *   - Solo-pass branch trims Candidate B and includes advisory.
 *   - Both-planners branch labels candidates "Candidate A" / "Candidate B".
 */
import { describe, expect, it } from 'vitest';

import { buildDuelingSynthesisPrompt } from '../pipeline/engine/dueling-plan-synthesis-prompt.js';
import { PLAN_A_FIXTURE, PLAN_B_FIXTURE } from './test-helpers/plan-fixtures.js';

describe('UT-4: buildDuelingSynthesisPrompt anti-anchor invariant', () => {
  const FORBIDDEN_LITERALS = ['claude-code', 'openai-api', 'Opus', 'GPT-5'];

  it('both candidates: prompt contains "Candidate A" and "Candidate B"', () => {
    const prompt = buildDuelingSynthesisPrompt({
      candidateA: PLAN_A_FIXTURE,
      candidateB: PLAN_B_FIXTURE,
      featureContext: 'Fix the shared validation seam.',
    });

    expect(prompt).toContain('# Candidate A');
    expect(prompt).toContain('# Candidate B');
    expect(prompt).toContain(PLAN_A_FIXTURE.output);
    expect(prompt).toContain(PLAN_B_FIXTURE.output);
  });

  it('both candidates: prompt does NOT contain provider-identifying literals', () => {
    const prompt = buildDuelingSynthesisPrompt({
      candidateA: PLAN_A_FIXTURE,
      candidateB: PLAN_B_FIXTURE,
      featureContext: 'Fix the shared validation seam.',
    });

    for (const literal of FORBIDDEN_LITERALS) {
      expect(prompt).not.toContain(literal);
    }
  });

  it('solo-pass (B absent): prompt contains Candidate A and solo-pass advisory', () => {
    const prompt = buildDuelingSynthesisPrompt({
      candidateA: PLAN_A_FIXTURE,
      candidateB: undefined,
      featureContext: 'Fix the shared validation seam.',
    });

    expect(prompt).toContain('# Candidate A');
    expect(prompt).toContain(PLAN_A_FIXTURE.output);
    // Advisory about failed planner
    expect(prompt).toContain('Planner B failed');
    expect(prompt).toContain('sole input');
    // Still instructs divergence-notes format
    expect(prompt).toContain('divergenceNotes');
  });

  it('solo-pass: prompt does NOT contain provider-identifying literals', () => {
    const prompt = buildDuelingSynthesisPrompt({
      candidateA: PLAN_A_FIXTURE,
      candidateB: undefined,
      featureContext: 'Fix the shared validation seam.',
    });

    for (const literal of FORBIDDEN_LITERALS) {
      expect(prompt).not.toContain(literal);
    }
  });

  it('includes feature context section', () => {
    const context = 'Refactor auth middleware for compliance.';
    const prompt = buildDuelingSynthesisPrompt({
      candidateA: PLAN_A_FIXTURE,
      candidateB: PLAN_B_FIXTURE,
      featureContext: context,
    });

    expect(prompt).toContain('# Feature Context');
    expect(prompt).toContain(context);
  });

  it('includes synthesis instructions with output format requirements', () => {
    const prompt = buildDuelingSynthesisPrompt({
      candidateA: PLAN_A_FIXTURE,
      candidateB: PLAN_B_FIXTURE,
      featureContext: 'Test.',
    });

    expect(prompt).toContain('# Synthesis Instructions');
    expect(prompt).toContain('plan-c-with-divergence');
    expect(prompt).toContain('divergenceNotes');
    expect(prompt).toContain('Tool use is disabled');
  });
});
