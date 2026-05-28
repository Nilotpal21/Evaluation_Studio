import { describe, expect, it } from 'vitest';

import {
  buildSessionWatchSignature,
  formatSessionWatchSummary,
  isSessionHeartbeatStale,
  resolveCurrentStageLabel,
} from '../session-watch.js';
import type { PipelineTemplate, Session, WorkItem } from '../types.js';

describe('session-watch', () => {
  it('formats live stage summaries with heartbeat details', () => {
    const session = createSession({
      currentStageIndex: 0,
      heartbeat: {
        at: '2026-04-06T09:14:49.000Z',
        eventType: 'stage-progress',
        stage: 'Deep Scan',
        message: 'Command exit 0: packages/compiler/src/platform/ir/compiler.ts',
      },
    });

    expect(resolveCurrentStageLabel(session)).toBe('Deep Scan');
    expect(
      formatSessionWatchSummary(session, {
        nowMs: Date.parse('2026-04-06T09:14:55.000Z'),
      }),
    ).toContain('state=scanning');
    expect(
      formatSessionWatchSummary(session, {
        nowMs: Date.parse('2026-04-06T09:14:55.000Z'),
      }),
    ).toContain('stage=Deep Scan (1/2)');
    expect(
      formatSessionWatchSummary(session, {
        nowMs: Date.parse('2026-04-06T09:14:55.000Z'),
      }),
    ).toContain('Command exit 0');
  });

  it('marks active sessions stale when the heartbeat ages out', () => {
    const session = createSession({
      heartbeat: {
        at: '2026-04-06T09:14:49.000Z',
        eventType: 'model-stream',
        stage: 'Deep Scan',
        message: 'Bash: sed -n "1,200p" feature.ts',
      },
    });

    expect(
      isSessionHeartbeatStale(session, {
        nowMs: Date.parse('2026-04-06T09:16:00.000Z'),
        staleAfterMs: 30_000,
      }),
    ).toBe(true);
    expect(
      formatSessionWatchSummary(session, {
        nowMs: Date.parse('2026-04-06T09:16:00.000Z'),
        staleAfterMs: 30_000,
      }),
    ).toContain('stale=');
  });

  it('never marks terminal sessions stale', () => {
    const session = createSession({
      state: 'completed',
      currentStageIndex: 2,
      heartbeat: {
        at: '2026-04-06T09:14:49.000Z',
        eventType: 'stage-exit',
        stage: 'Doc Sync',
        message: 'Pipeline complete',
      },
    });

    expect(
      isSessionHeartbeatStale(session, {
        nowMs: Date.parse('2026-04-06T09:30:00.000Z'),
        staleAfterMs: 30_000,
      }),
    ).toBe(false);
  });

  it('changes the watch signature when the heartbeat message changes', () => {
    const session = createSession();
    const initial = buildSessionWatchSignature(session);

    session.heartbeat = {
      at: '2026-04-06T09:14:49.000Z',
      eventType: 'stage-progress',
      stage: 'Deep Scan',
      message: 'Read parser.ts',
    };

    expect(buildSessionWatchSignature(session)).not.toBe(initial);
  });
});

function createSession(overrides: Partial<Session> = {}): Session {
  const pipeline = createPipeline();
  return {
    id: 'watch-1',
    workItem: createWorkItem(),
    pipelineName: pipeline.name,
    pipelineVersion: 'watch@1',
    pipelineSnapshot: pipeline,
    state: 'scanning',
    currentStageIndex: 0,
    currentSliceIndex: 0,
    totalSlices: 0,
    slices: [],
    findings: [],
    decisions: [],
    commits: [],
    journal: [],
    stageHistory: [],
    startedAt: '2026-04-06T09:14:40.000Z',
    updatedAt: '2026-04-06T09:14:49.000Z',
    ...overrides,
  };
}

function createPipeline(): PipelineTemplate {
  return {
    name: 'watch-pipeline',
    description: 'Watch test pipeline',
    applicableTo: ['feature-audit'],
    stages: [
      {
        name: 'Deep Scan',
        type: 'deep-scan',
        description: 'Analyze deeply',
        model: { primary: { engine: 'codex-cli', model: 'gpt-5.5' } },
        canLoop: false,
        maxLoopIterations: 1,
      },
      {
        name: 'Plan Generation',
        type: 'plan-generation',
        description: 'Plan work',
        model: { primary: { engine: 'codex-cli', model: 'gpt-5.5' } },
        canLoop: false,
        maxLoopIterations: 1,
      },
    ],
  };
}

function createWorkItem(): WorkItem {
  return {
    id: 'work-watch',
    type: 'feature-audit',
    title: 'Watch Bruce run',
    description: 'Observe a live HELIX session',
    scope: ['packages/helix'],
    targetBranch: 'current',
    createdAt: '2026-04-06T09:14:40.000Z',
  };
}
