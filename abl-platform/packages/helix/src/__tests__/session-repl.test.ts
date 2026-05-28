import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { InteractiveReporter } from '../interactive/interactive-reporter.js';
import { SessionRepl, type SessionReplOptions } from '../interactive/session-repl.js';
import type { PipelineStatus } from '../interactive/types.js';
import { PipelineEngine } from '../pipeline/pipeline-engine.js';
import type { HelixConfig, ProgressReporter } from '../types.js';

describe('SessionRepl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createConfig(): HelixConfig {
    return {
      workDir: '/tmp/test',
      sessionDir: '/tmp/test/.helix/sessions',
      journalDir: '/tmp/test/docs/sdlc-logs',
      defaultModel: { engine: 'codex-cli', model: 'gpt-5.5', effort: 'medium' },
      codexPath: 'codex',
      claudePath: 'claude',
      maxConcurrentOracles: 2,
      maxSliceRetries: 2,
      autoCommit: false,
      autoApprove: false,
      autonomy: {
        mode: 'manual',
        autoCommitMaxRisk: 'medium',
        minConfidenceScore: 6,
        highConfidenceScore: 9,
        deferBulkReview: false,
      },
      budgetLimitUsd: 50,
      verbose: false,
    };
  }

  function createReporter(): ProgressReporter {
    return {
      emit() {},
      async onQuestion() {
        return 'test';
      },
      async onCheckpoint() {
        return true;
      },
    };
  }

  function createEngine(): PipelineEngine {
    return new PipelineEngine(createConfig(), createReporter());
  }

  function createStatus(overrides: Partial<PipelineStatus> = {}): PipelineStatus {
    return {
      sessionId: 'session-1',
      state: 'executing',
      currentStage: 'Deep Scan',
      currentStageIndex: 0,
      totalStages: 4,
      currentSlice: 0,
      totalSlices: 0,
      findingsTotal: 2,
      findingsOpen: 2,
      findingsFixed: 0,
      commits: 0,
      elapsedMs: 12_000,
      pendingContextEntries: 0,
      ...overrides,
    };
  }

  function createMockEngine(status: PipelineStatus = createStatus()): PipelineEngine {
    return {
      getStatus: vi.fn(() => status),
      injectContext: vi.fn(async () => 'ctx-1'),
      skipStage: vi.fn(() => true),
      pause: vi.fn(() => 'requested'),
      unpause: vi.fn(() => 'resumed'),
      abort: vi.fn(),
      prioritizeFinding: vi.fn(() => true),
      listStageNames: vi.fn(() => ['Deep Scan', 'Review']),
      listOpenFindingIds: vi.fn(() => ['F-3']),
    } as unknown as PipelineEngine;
  }

  class FakeReadline extends EventEmitter {
    history: string[] = [];
    line = '';
    cursor = 0;
    promptCalls = 0;
    closeCalls = 0;
    setPromptCalls: string[] = [];
    questions: string[] = [];
    nextAnswer = '';

    prompt(_preserveCursor?: boolean): void {
      this.promptCalls += 1;
    }

    close(): void {
      this.closeCalls += 1;
      this.emit('close');
    }

    question(query: string, callback: (answer: string) => void): void {
      this.questions.push(query);
      callback(this.nextAnswer);
    }

    setPrompt(prompt: string): void {
      this.setPromptCalls.push(prompt);
    }
  }

  type TestReadline = ReturnType<NonNullable<SessionReplOptions['readlineFactory']>>;

  function asManagedReadline(readline: FakeReadline): TestReadline {
    return readline as unknown as TestReadline;
  }

  describe('handleInput()', () => {
    it('classifies "help" and returns help intent', async () => {
      const engine = createEngine();
      const repl = new SessionRepl(engine);

      const result = await repl.handleInput('help');
      expect(result.intent).toBe('help');
    });

    it('classifies "status" and returns status intent', async () => {
      const engine = createEngine();
      const repl = new SessionRepl(engine);

      const result = await repl.handleInput('status');
      expect(result.intent).toBe('status');
    });

    it('classifies "context: check auth" and injects context', async () => {
      const engine = createEngine();
      const repl = new SessionRepl(engine);

      const result = await repl.handleInput('context: check auth');
      expect(result.intent).toBe('inject-context');
      expect(engine.liveContext.pendingCount).toBe(1);
    });

    it('classifies "skip regression" and calls skipStage', async () => {
      const engine = createEngine();
      const skipSpy = vi.spyOn(engine, 'skipStage');
      const repl = new SessionRepl(engine);

      const result = await repl.handleInput('skip regression');
      expect(result.intent).toBe('skip-stage');
      expect(skipSpy).toHaveBeenCalledWith('regression');
    });

    it('classifies "pause" and calls engine.pause()', async () => {
      const engine = createEngine();
      const pauseSpy = vi.spyOn(engine, 'pause');
      const repl = new SessionRepl(engine);

      const result = await repl.handleInput('pause');
      expect(result.intent).toBe('pause');
      expect(pauseSpy).toHaveBeenCalled();
    });

    it('classifies "resume" and calls engine.unpause()', async () => {
      const engine = createEngine();
      const unpauseSpy = vi.spyOn(engine, 'unpause');
      const repl = new SessionRepl(engine);

      const result = await repl.handleInput('resume');
      expect(result.intent).toBe('resume');
      expect(unpauseSpy).toHaveBeenCalled();
    });

    it('classifies "abort" and calls engine.abort()', async () => {
      const engine = createEngine();
      const abortSpy = vi.spyOn(engine, 'abort');
      const repl = new SessionRepl(engine);

      const result = await repl.handleInput('abort');
      expect(result.intent).toBe('abort');
      expect(abortSpy).toHaveBeenCalled();
    });

    it('classifies "prioritize F-3" and calls prioritizeFinding', async () => {
      const engine = createEngine();
      const prioritizeSpy = vi.spyOn(engine, 'prioritizeFinding');
      const repl = new SessionRepl(engine);

      const result = await repl.handleInput('prioritize F-3');
      expect(result.intent).toBe('prioritize');
      expect(prioritizeSpy).toHaveBeenCalledWith('F-3');
    });

    it('handles empty input gracefully', async () => {
      const engine = createEngine();
      const repl = new SessionRepl(engine);

      const result = await repl.handleInput('');
      expect(result.intent).toBe('unknown');
    });

    it('handles unknown single word', async () => {
      const engine = createEngine();
      const repl = new SessionRepl(engine);

      const result = await repl.handleInput('foobar');
      expect(result.intent).toBe('unknown');
    });

    it('handles multi-word ambiguous input as context injection', async () => {
      const engine = createEngine();
      const repl = new SessionRepl(engine);

      const result = await repl.handleInput('maybe check the database layer');
      expect(result.intent).toBe('inject-context');
      expect(result.confidence).toBeLessThan(0.5);
    });
  });

  describe('terminal lifecycle', () => {
    it('starts with history and completion enabled, then stops cleanly', async () => {
      const engine = createMockEngine();
      const fakeReadline = new FakeReadline();
      const interactiveReporter = new InteractiveReporter(false, false);
      let capturedOptions:
        | Parameters<NonNullable<SessionReplOptions['readlineFactory']>>[0]
        | undefined;

      const repl = new SessionRepl(engine, {
        reporter: interactiveReporter,
        historyFilePath: join('/tmp', 'helix-repl-history'),
        readlineFactory: (options) => {
          capturedOptions = options;
          return asManagedReadline(fakeReadline);
        },
      });

      await repl.start();

      expect(repl.isRunning).toBe(true);
      expect(capturedOptions).toMatchObject({
        historySize: 200,
        removeHistoryDuplicates: true,
      });
      expect(typeof capturedOptions?.['completer']).toBe('function');
      expect(fakeReadline.promptCalls).toBeGreaterThan(0);

      repl.stop();

      expect(fakeReadline.closeCalls).toBe(1);
      expect(repl.isRunning).toBe(false);
    });

    it('updates the live prompt when pipeline events arrive', async () => {
      const engine = createMockEngine(
        createStatus({
          currentStage: 'Review',
          currentStageIndex: 2,
          findingsOpen: 1,
          pendingContextEntries: 1,
        }),
      );
      const fakeReadline = new FakeReadline();

      const repl = new SessionRepl(engine, {
        readlineFactory: () => asManagedReadline(fakeReadline),
      });

      await repl.start();
      repl.onPipelineEvent({
        type: 'stage-enter',
        timestamp: new Date().toISOString(),
        stage: 'Review',
        message: 'Starting review',
      });

      expect(fakeReadline.setPromptCalls.at(-1)).toContain('Review 3/4');
      expect(fakeReadline.setPromptCalls.at(-1)).toContain('1 open');
      expect(fakeReadline.setPromptCalls.at(-1)).toContain('1 ctx');

      repl.stop();
    });
  });

  describe('output feedback', () => {
    it('reports when resume is requested while the pipeline is already running', async () => {
      const engine = createMockEngine();
      vi.spyOn(engine, 'unpause').mockReturnValue('not-paused');
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const repl = new SessionRepl(engine);

      await repl.handleInput('resume');

      expect(writeSpy).toHaveBeenCalledWith(
        '\x1b[33m  Pipeline is already running. Nothing to resume.\x1b[0m\n',
      );
    });

    it('reports when a pending pause is cleared before the stage boundary', async () => {
      const engine = createMockEngine();
      vi.spyOn(engine, 'unpause').mockReturnValue('cancelled-pending-pause');
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const repl = new SessionRepl(engine);

      await repl.handleInput('resume');

      expect(writeSpy).toHaveBeenCalledWith(
        '\x1b[32m  Pending pause cleared. The pipeline will continue after the current stage.\x1b[0m\n',
      );
    });
  });

  describe('interactive reporter integration', () => {
    it('routes approval prompts through the existing REPL readline', async () => {
      const engine = createMockEngine();
      const fakeReadline = new FakeReadline();
      fakeReadline.nextAnswer = 'y';
      const interactiveReporter = new InteractiveReporter(false, false);
      const repl = new SessionRepl(engine, {
        reporter: interactiveReporter,
        readlineFactory: () => asManagedReadline(fakeReadline),
      });

      await repl.start();
      const approved = await interactiveReporter.onCheckpoint('Review the plan');

      expect(approved).toBe(true);
      expect(fakeReadline.questions).toEqual(['  Approve? (y/n): ']);
      expect(fakeReadline.promptCalls).toBeGreaterThan(0);

      repl.stop();
    });
  });
});
