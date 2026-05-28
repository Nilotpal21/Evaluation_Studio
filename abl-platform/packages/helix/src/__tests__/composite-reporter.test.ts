import { describe, expect, it, vi } from 'vitest';

import { CompositeReporter } from '../ui/composite-reporter.js';
import type { Decision, ProgressEvent, ProgressReporter } from '../types.js';

describe('CompositeReporter', () => {
  it('fans out checkpoints and questions to secondary reporters while returning the primary response', async () => {
    const checkpointSpy = vi.fn(async () => true);
    const questionSpy = vi.fn(async () => '');
    const secondaryCheckpointSpy = vi.fn(async () => true);
    const secondaryQuestionSpy = vi.fn(async () => '');

    const primary = createReporter({
      onCheckpoint: checkpointSpy,
      onQuestion: questionSpy,
    });
    const secondary = createReporter({
      onCheckpoint: secondaryCheckpointSpy,
      onQuestion: secondaryQuestionSpy,
    });

    const reporter = new CompositeReporter(primary, secondary);
    const decision = createDecision();

    const approved = await reporter.onCheckpoint('Commit slice 1?', {
      autonomy: 'high risk / low confidence',
    });
    const answer = await reporter.onQuestion(decision);

    expect(approved).toBe(true);
    expect(answer).toBe('');
    expect(checkpointSpy).toHaveBeenCalledWith(
      'Commit slice 1?',
      {
        autonomy: 'high risk / low confidence',
      },
      undefined,
    );
    expect(questionSpy).toHaveBeenCalledWith(decision);
    expect(secondaryCheckpointSpy).toHaveBeenCalledWith(
      'Commit slice 1?',
      {
        autonomy: 'high risk / low confidence',
      },
      undefined,
    );
    expect(secondaryQuestionSpy).toHaveBeenCalledWith(decision);
  });
});

function createReporter(overrides: Partial<ProgressReporter> = {}): ProgressReporter {
  return {
    emit(_event: ProgressEvent): void {},
    async onQuestion(_decision: Decision): Promise<string> {
      return '';
    },
    async onCheckpoint(_message: string, _data?: unknown): Promise<boolean> {
      return true;
    },
    ...overrides,
  };
}

function createDecision(): Decision {
  return {
    id: 'decision-1',
    classification: 'AMBIGUOUS',
    question: 'Should HELIX continue?',
    context: 'Approval is required before the slice can commit.',
    oracleVotes: [],
    stage: 'Implementation',
  };
}
