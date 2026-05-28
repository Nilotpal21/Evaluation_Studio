import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCanaryPipeline } from '../pipeline/canary-pipeline.js';
import { selectPipeline } from '../pipeline/templates/index.js';
import { SessionManager } from '../session/session-manager.js';
import {
  loadManagedSessionFromConfigs,
  resolveResumePipeline,
} from '../session/session-resolution.js';
import type { HelixConfig, WorkItem } from '../types.js';

describe('session-resolution', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('resolves local canary sessions after standard session lookup misses them', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-session-resolution-'));
    const standardConfig = createConfig(tempDir, false);
    const canaryConfig = createConfig(tempDir, true);
    const canaryPipeline = createCanaryPipeline(
      selectPipeline('feature-audit'),
      ['packages/helix/src'],
      120_000,
    );
    const session = await new SessionManager(canaryConfig).create(createWorkItem(), canaryPipeline);

    const resolved = await loadManagedSessionFromConfigs(session.id, [
      standardConfig,
      canaryConfig,
    ]);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.sessionDir).toBe(canaryConfig.sessionDir);
    expect(resolved?.session.id).toBe(session.id);
  });

  it('prefers the persisted pipeline snapshot when resuming canary sessions', () => {
    const canaryPipeline = createCanaryPipeline(
      selectPipeline('feature-audit'),
      ['packages/helix/src'],
      120_000,
    );
    const resumedPipeline = resolveResumePipeline(
      {
        pipelineSnapshot: canaryPipeline,
        workItem: createWorkItem(),
      },
      selectPipeline,
    );

    expect(resumedPipeline).toEqual(canaryPipeline);
    expect(resumedPipeline.name).toContain('Canary');
    expect(resumedPipeline).not.toEqual(selectPipeline('feature-audit'));
  });

  it('refreshes persisted snapshots when the current pipeline template still matches by identity', () => {
    const latestPipeline = selectPipeline('feature-audit');
    const stalePipeline = structuredClone(latestPipeline);
    const implementationStageIndex = stalePipeline.stages.findIndex(
      (stage) => stage.name === 'Implementation',
    );
    stalePipeline.stages[implementationStageIndex] = {
      ...stalePipeline.stages[implementationStageIndex],
      timeoutMs: 1_800_000,
    };

    const resumedPipeline = resolveResumePipeline(
      {
        pipelineSnapshot: stalePipeline,
        workItem: createWorkItem(),
      },
      selectPipeline,
    );

    expect(resumedPipeline).toEqual(latestPipeline);
    expect(resumedPipeline.stages[implementationStageIndex]?.timeoutMs).toBe(
      latestPipeline.stages[implementationStageIndex]?.timeoutMs,
    );
    expect(resumedPipeline.stages[implementationStageIndex]?.timeoutMs).not.toBe(
      stalePipeline.stages[implementationStageIndex]?.timeoutMs,
    );
  });
});

function createConfig(workDir: string, canary: boolean): HelixConfig {
  return {
    workDir,
    sessionDir: join(workDir, '.helix', canary ? 'canary-sessions' : 'sessions'),
    journalDir: join(workDir, '.helix', canary ? 'canary-journal' : 'journals'),
    defaultModel: {
      engine: 'codex-cli',
      model: 'gpt-5.5',
      effort: 'medium',
      maxTurns: 20,
    },
    codexPath: 'codex',
    claudePath: 'claude',
    maxConcurrentOracles: 2,
    maxSliceRetries: 2,
    autoCommit: false,
    autoApprove: true,
    budgetLimitUsd: 25,
    verbose: false,
  };
}

function createWorkItem(): WorkItem {
  return {
    id: 'work-1',
    type: 'feature-audit',
    title: 'Resume canary session',
    description: 'Ensure HELIX can resume canary runs from persisted state',
    scope: ['packages/helix/src'],
    targetBranch: 'current',
    createdAt: '2026-04-10T00:00:00.000Z',
  };
}
