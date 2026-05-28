import { describe, expect, it } from 'vitest';

import { TerminalProgressReporter } from '../ui/progress-reporter.js';

/**
 * Verifies the new CheckpointOptions.forceInteractive escape hatch.
 *
 * Operator authorized --auto-approve for routine flow, but Helix may hit
 * unusual state (review oscillation, failure-advisor on a passing slice)
 * that warrants human review beyond what auto-approve was meant to cover.
 * The forceInteractive flag overrides auto-approve for those callsites.
 */
describe('TerminalProgressReporter.onCheckpoint — forceInteractive', () => {
  it('auto-approves when --auto-approve is on and forceInteractive is not set', async () => {
    const reporter = new TerminalProgressReporter(false, true); // verbose=false, autoApprove=true
    const approved = await reporter.onCheckpoint('Routine commit?', { files: ['x.ts'] });
    expect(approved).toBe(true);
  });

  it('auto-approves when --auto-approve is on and forceInteractive is false', async () => {
    const reporter = new TerminalProgressReporter(false, true);
    const approved = await reporter.onCheckpoint(
      'Routine commit?',
      { files: ['x.ts'] },
      { forceInteractive: false },
    );
    expect(approved).toBe(true);
  });

  it('forceInteractive prompts via promptUser (overriding auto-approve)', async () => {
    let promptCount = 0;
    const reporter = new TerminalProgressReporter(false, true);
    // Stub promptUser to assert it's actually invoked despite autoApprove=true
    (reporter as unknown as { promptUser: (prompt: string) => Promise<string> }).promptUser =
      async () => {
        promptCount += 1;
        return 'y';
      };

    const approved = await reporter.onCheckpoint(
      'Unusual: review oscillation. Approve commit?',
      { sliceTitle: 'CLI helix index rebuild' },
      { forceInteractive: true },
    );

    expect(promptCount).toBe(1);
    expect(approved).toBe(true);
  });

  it('forceInteractive returns false when operator answers no', async () => {
    const reporter = new TerminalProgressReporter(false, true);
    (reporter as unknown as { promptUser: (prompt: string) => Promise<string> }).promptUser =
      async () => 'n';

    const approved = await reporter.onCheckpoint(
      'Reject?',
      { sliceTitle: 'X' },
      { forceInteractive: true },
    );

    expect(approved).toBe(false);
  });

  it('non-auto-approve path is unaffected (still prompts as before)', async () => {
    const reporter = new TerminalProgressReporter(false, false);
    (reporter as unknown as { promptUser: (prompt: string) => Promise<string> }).promptUser =
      async () => 'y';

    const approved = await reporter.onCheckpoint('Normal prompt', { files: [] });
    expect(approved).toBe(true);
  });
});
