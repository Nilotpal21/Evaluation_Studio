import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileProgressLogger } from '../ui/file-progress-logger.js';
import type { Decision, ProgressEvent } from '../types.js';

describe('FileProgressLogger', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('writes checkpoint and question details to progress.log', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-file-progress-logger-'));
    const logger = new FileProgressLogger(tempDir, 'session-1');

    await logger.onCheckpoint('Commit slice 1: Stabilize parser seam?', {
      autonomy: 'high risk / low confidence',
      sliceDescription: 'Stabilize the parser seam before the slice can commit.',
      files: ['src/parser.ts', 'src/parser.test.ts'],
      findings: [{ severity: 'high', title: 'Parser seam mismatch', status: 'open' }],
      dependencies: ['Slice 2: Wire parser consumers'],
      requiredTests: [
        {
          path: 'src/parser.test.ts',
          status: 'passing',
          description: 'Parser regression',
        },
      ],
      regressionTests: ['src/parser.integration.test.ts'],
      testLock: '2 required tests passed; regression suite locked',
      exitCriteria: 'all met',
      exitCriteriaItems: [
        {
          id: 'typecheck',
          passed: true,
          detail: 'PASS — scoped typecheck succeeded',
        },
      ],
    });
    await logger.onQuestion(createDecision());
    logger.emit(createSessionCompleteEvent());

    await new Promise((resolve) => setTimeout(resolve, 50));

    const log = await readFile(join(tempDir, 'session-1', 'progress.log'), 'utf8');
    expect(log).toContain('[CHECKPOINT] Commit slice 1: Stabilize parser seam?');
    expect(log).toContain('[CHECKPOINT_DATA] autonomy: high risk / low confidence');
    expect(log).toContain(
      '[CHECKPOINT_DATA] scope: Stabilize the parser seam before the slice can commit.',
    );
    expect(log).toContain('[CHECKPOINT_DATA] files: src/parser.ts, src/parser.test.ts');
    expect(log).toContain('[CHECKPOINT_DATA] findings: [high] Parser seam mismatch');
    expect(log).toContain('[CHECKPOINT_DATA] dependencies: Slice 2: Wire parser consumers');
    expect(log).toContain('[CHECKPOINT_DATA] required tests: src/parser.test.ts [passing]');
    expect(log).toContain('[CHECKPOINT_DATA] regression tests: src/parser.integration.test.ts');
    expect(log).toContain('[CHECKPOINT_DATA] exit criteria detail: ✓ typecheck');
    expect(log).toContain('[QUESTION] Should HELIX continue?');
    expect(log).toContain(
      '[QUESTION_DATA] context: Approval is required before the slice can commit.',
    );
    expect(log).toContain(
      'session-complete ━━━ Session paused at Implementation | session=session-1 | resume=helix resume session-1 ━━━',
    );
  });
});

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

function createSessionCompleteEvent(): ProgressEvent {
  return {
    type: 'session-complete',
    timestamp: '2026-04-17T12:00:00.000Z',
    message: 'Session paused at Implementation',
    details: {
      sessionId: 'session-1',
      resumeCommand: 'helix resume session-1',
    },
  };
}
