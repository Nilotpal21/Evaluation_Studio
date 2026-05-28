import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { enforceReproductionArtifact } from '../pipeline/engine/enforce-reproduction-artifact.js';
import type { JournalEntry, ProgressEvent, Session, StageDefinition } from '../types.js';

describe('reproduction artifact enforcer', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('recovers when the model declares the wrong test file but changed one scoped test', async () => {
    tempDir = await createGitRepo();
    await writeFile(
      join(tempDir, 'src', 'actual.test.ts'),
      "import { it, expect } from 'vitest';\n\nit('reproduces', () => expect(false).toBe(true));\n",
      'utf-8',
    );

    const journal: JournalEntry[] = [];
    const progress: ProgressEvent[] = [];
    const reproductionOutput = {
      summary: 'Bug reproduced',
      testFile: 'src/wrong.test.ts',
      reproductionSteps: ['Run the focused test'],
      findings: [],
      decisions: [],
    };

    const result = await enforceReproductionArtifact(
      tempDir,
      createSession(),
      createReproduceStage(),
      JSON.stringify(reproductionOutput),
      reproductionOutput,
      [],
      new Map(),
      {
        emitProgress: (event) => progress.push(event),
        journal: async (_session, entry) => {
          journal.push(entry);
        },
      },
    );

    expect(result).toEqual({ ok: true });
    expect(reproductionOutput.testFile).toBe('src/actual.test.ts');
    expect(journal.at(-1)).toMatchObject({
      type: 'progress',
      message: 'Verified reproduction test artifact: src/actual.test.ts',
    });
    expect(progress.at(-1)).toMatchObject({
      type: 'stage-progress',
      message: 'Verified reproduction test artifact: src/actual.test.ts',
    });
  });

  it('recovers when the model declares UNKNOWN but changed one scoped test', async () => {
    tempDir = await createGitRepo();
    await writeFile(
      join(tempDir, 'src', 'actual.test.ts'),
      "import { it, expect } from 'vitest';\n\nit('reproduces', () => expect(false).toBe(true));\n",
      'utf-8',
    );

    const reproductionOutput = {
      summary: 'Bug reproduced',
      testFile: 'UNKNOWN',
      reproductionSteps: ['Run the focused test'],
      findings: [],
      decisions: [],
    };

    const result = await enforceReproductionArtifact(
      tempDir,
      createSession(),
      createReproduceStage(),
      JSON.stringify(reproductionOutput),
      reproductionOutput,
      [],
      new Map(),
      {
        emitProgress: () => {},
        journal: async () => {},
      },
    );

    expect(result).toEqual({ ok: true });
    expect(reproductionOutput.testFile).toBe('src/actual.test.ts');
  });
});

function createSession(): Session {
  return {
    id: 'session-1',
    workItem: {
      id: 'work-1',
      type: 'bug-fix',
      title: 'Bug',
      description: 'Bug',
      scope: ['src'],
      targetBranch: 'current',
      createdAt: '2026-04-27T00:00:00.000Z',
    },
    pipelineName: 'Bug Fix',
    pipelineVersion: 'Bug Fix@test',
    state: 'executing',
    currentStageIndex: 0,
    currentSliceIndex: 0,
    totalSlices: 0,
    slices: [],
    findings: [],
    decisions: [],
    commits: [],
    journal: [],
    stageHistory: [],
    startedAt: '2026-04-27T00:00:00.000Z',
    updatedAt: '2026-04-27T00:00:00.000Z',
  };
}

function createReproduceStage(): StageDefinition {
  return {
    name: 'Reproduce',
    type: 'reproduce',
    description: 'Write a failing test',
    model: {
      primary: {
        engine: 'codex-cli',
        model: 'gpt-5.5',
      },
    },
    canLoop: true,
    maxLoopIterations: 3,
  };
}

async function createGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'helix-repro-enforcer-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'README.md'), '# repro enforcer test\n', 'utf-8');

  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'helix@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'HELIX Test'], { cwd: dir });
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
  return dir;
}
