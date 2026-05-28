import { describe, expect, it, vi } from 'vitest';

import { PipelineEngine } from '../pipeline/pipeline-engine.js';
import type { HelixConfig, ProgressEvent, ProgressReporter, Session } from '../types.js';

describe('PipelineEngine control API', () => {
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

  function createReporter(): ProgressReporter & { events: ProgressEvent[] } {
    const events: ProgressEvent[] = [];
    return {
      events,
      emit(event: ProgressEvent) {
        events.push(event);
      },
      async onQuestion() {
        return 'test answer';
      },
      async onCheckpoint() {
        return true;
      },
    };
  }

  describe('getStatus()', () => {
    it('returns null when no session is running', () => {
      const engine = new PipelineEngine(createConfig(), createReporter());
      expect(engine.getStatus()).toBeNull();
    });
  });

  describe('injectContext()', () => {
    it('adds context to the live context accumulator', async () => {
      const reporter = createReporter();
      const engine = new PipelineEngine(createConfig(), reporter);

      const id = await engine.injectContext('focus on auth middleware');
      expect(id).toBeTruthy();
      expect(engine.liveContext.pendingCount).toBe(1);
      expect(engine.liveContext.getPending()[0].content).toBe('focus on auth middleware');
    });

    it('emits a progress event on inject', async () => {
      const reporter = createReporter();
      const engine = new PipelineEngine(createConfig(), reporter);

      await engine.injectContext('check token refresh');
      const event = reporter.events.find(
        (e) => e.stage === 'interactive' && e.message.includes('Context injected'),
      );
      expect(event).toBeTruthy();
      expect(event!.message).toContain('check token refresh');
    });

    it('truncates long context in progress message', async () => {
      const reporter = createReporter();
      const engine = new PipelineEngine(createConfig(), reporter);

      const longContent = 'a'.repeat(100);
      await engine.injectContext(longContent);
      const event = reporter.events.find((e) => e.message.includes('Context injected'));
      expect(event!.message).toContain('…');
    });
  });

  describe('skipStage()', () => {
    it('returns false when no pipeline is loaded', () => {
      const engine = new PipelineEngine(createConfig(), createReporter());
      expect(engine.skipStage('regression')).toBe(false);
    });
  });

  describe('prioritizeFinding()', () => {
    it('returns false when no session is running', () => {
      const engine = new PipelineEngine(createConfig(), createReporter());
      expect(engine.prioritizeFinding('F-1')).toBe(false);
    });
  });

  describe('pause() and unpause()', () => {
    it('pause and unpause do not throw', () => {
      const engine = new PipelineEngine(createConfig(), createReporter());
      expect(() => engine.pause()).not.toThrow();
      expect(() => engine.unpause()).not.toThrow();
    });
  });

  describe('abort()', () => {
    it('abort does not throw', () => {
      const engine = new PipelineEngine(createConfig(), createReporter());
      expect(() => engine.abort()).not.toThrow();
    });
  });

  describe('liveContext property', () => {
    it('exposes the LiveContext instance', () => {
      const engine = new PipelineEngine(createConfig(), createReporter());
      expect(engine.liveContext).toBeTruthy();
      expect(engine.liveContext.size).toBe(0);
    });

    it('context renders into prompt format', async () => {
      const engine = new PipelineEngine(createConfig(), createReporter());
      await engine.injectContext('look at the session handling');

      const rendered = engine.liveContext.renderForPrompt();
      expect(rendered).toContain('## Live Context');
      expect(rendered).toContain('look at the session handling');
    });
  });
});
