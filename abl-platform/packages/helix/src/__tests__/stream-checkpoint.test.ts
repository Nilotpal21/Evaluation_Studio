import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetStreamCheckpointStateForTests,
  createStageStreamHandler,
} from '../pipeline/stage-execution-shared.js';
import type { ProgressEvent, StreamEvent } from '../types.js';

describe('createStageStreamHandler — stream checkpoint', () => {
  let tmpDir: string;

  beforeEach(async () => {
    __resetStreamCheckpointStateForTests();
    tmpDir = await mkdtemp(join(tmpdir(), 'helix-stream-cp-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('does not write a stream file when streamFilePath is omitted', () => {
    const events: ProgressEvent[] = [];
    const handler = createStageStreamHandler((e) => events.push(e), 'TestStage');

    handler({
      type: 'output',
      timestamp: '2026-05-02T00:00:00.000Z',
      message: 'hello',
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.message).toBe('hello');
  });

  it('persists output and tool-use events to the stream file in arrival order', async () => {
    const events: ProgressEvent[] = [];
    const streamFilePath = join(tmpDir, 'streams', 'slice-2-stream.txt');
    const handler = createStageStreamHandler(
      (e) => events.push(e),
      'Implementation',
      2,
      streamFilePath,
    );

    const sample: StreamEvent[] = [
      { type: 'output', timestamp: '2026-05-02T00:00:00.000Z', message: 'turn 1 reasoning' },
      {
        type: 'tool-use',
        timestamp: '2026-05-02T00:00:01.000Z',
        message: 'Bash: pnpm build',
      },
      { type: 'output', timestamp: '2026-05-02T00:00:02.000Z', message: 'turn 2 reasoning' },
    ];
    for (const event of sample) handler(event);

    // Drain the serialized write chain — we need to wait long enough for the
    // chained appendFile promises to resolve. A few macrotask ticks is plenty.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const persisted = await readFile(streamFilePath, 'utf-8');
    expect(persisted).toBe(
      '[output] turn 1 reasoning\n[tool-use] Bash: pnpm build\n[output] turn 2 reasoning\n',
    );
  });

  it('skips progress and complete events (only output and tool-use are checkpointed)', async () => {
    const streamFilePath = join(tmpDir, 'streams', 'progress-test.txt');
    const handler = createStageStreamHandler(
      () => undefined,
      'TestStage',
      undefined,
      streamFilePath,
    );

    handler({
      type: 'progress',
      timestamp: '2026-05-02T00:00:00.000Z',
      message: 'thinking...',
    });
    handler({
      type: 'complete',
      timestamp: '2026-05-02T00:00:01.000Z',
      message: 'final',
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // File should not exist (no output/tool-use events fired)
    await expect(readFile(streamFilePath, 'utf-8')).rejects.toThrow(/ENOENT/);
  });

  it('creates the parent directory if missing (mkdir recursive)', async () => {
    const streamFilePath = join(tmpDir, 'deep', 'nested', 'dir', 'stream.txt');
    const handler = createStageStreamHandler(
      () => undefined,
      'TestStage',
      undefined,
      streamFilePath,
    );

    handler({ type: 'output', timestamp: '2026-05-02T00:00:00.000Z', message: 'first chunk' });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const persisted = await readFile(streamFilePath, 'utf-8');
    expect(persisted).toBe('[output] first chunk\n');
  });

  it('also forwards events to the progress emitter (does not replace base behavior)', () => {
    const events: ProgressEvent[] = [];
    const streamFilePath = join(tmpDir, 'forward.txt');
    const handler = createStageStreamHandler((e) => events.push(e), 'TestStage', 3, streamFilePath);

    handler({
      type: 'output',
      timestamp: '2026-05-02T00:00:00.000Z',
      message: 'forwarded',
      details: { foo: 'bar' },
    });

    expect(events).toEqual([
      {
        type: 'model-stream',
        timestamp: '2026-05-02T00:00:00.000Z',
        stage: 'TestStage',
        slice: 3,
        message: 'forwarded',
        details: { foo: 'bar' },
      },
    ]);
  });
});
