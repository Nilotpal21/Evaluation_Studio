import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryExecutionQueue } from '../execution-queue.js';
import { createExecution } from '../types.js';

function makeExec(sessionId: string, message: string) {
  return createExecution({
    sessionId,
    tenantId: 'tenant-1',
    message,
    agentName: 'test_agent',
  });
}

describe('InMemoryExecutionQueue', () => {
  let queue: InMemoryExecutionQueue;

  beforeEach(() => {
    queue = new InMemoryExecutionQueue();
  });

  it('enqueue and dequeue in FIFO order', async () => {
    const e1 = makeExec('sess-1', 'first');
    const e2 = makeExec('sess-1', 'second');

    await queue.enqueue('sess-1', e1);
    await queue.enqueue('sess-1', e2);

    expect(await queue.length('sess-1')).toBe(2);

    const d1 = await queue.dequeue('sess-1');
    expect(d1?.message).toBe('first');

    const d2 = await queue.dequeue('sess-1');
    expect(d2?.message).toBe('second');

    const d3 = await queue.dequeue('sess-1');
    expect(d3).toBeNull();
  });

  it('peek returns front without removing', async () => {
    const e1 = makeExec('sess-1', 'hello');
    await queue.enqueue('sess-1', e1);

    const peeked = await queue.peek('sess-1');
    expect(peeked?.message).toBe('hello');
    expect(await queue.length('sess-1')).toBe(1);
  });

  it('cancelAll returns and clears all queued executions', async () => {
    const e1 = makeExec('sess-1', 'a');
    const e2 = makeExec('sess-1', 'b');
    await queue.enqueue('sess-1', e1);
    await queue.enqueue('sess-1', e2);

    const cancelled = await queue.cancelAll('sess-1');
    expect(cancelled).toHaveLength(2);
    expect(cancelled[0].status).toBe('cancelled');
    expect(cancelled[1].status).toBe('cancelled');
    expect(await queue.length('sess-1')).toBe(0);
  });

  it('getActive / setActive track the running execution', async () => {
    const e1 = makeExec('sess-1', 'running');
    e1.status = 'running';
    await queue.setActive('sess-1', e1);

    const active = await queue.getActive('sess-1');
    expect(active?.message).toBe('running');

    await queue.clearActive('sess-1');
    expect(await queue.getActive('sess-1')).toBeNull();
  });

  it('isolates queues between sessions', async () => {
    await queue.enqueue('sess-1', makeExec('sess-1', 'a'));
    await queue.enqueue('sess-2', makeExec('sess-2', 'b'));

    expect(await queue.length('sess-1')).toBe(1);
    expect(await queue.length('sess-2')).toBe(1);

    const d1 = await queue.dequeue('sess-1');
    expect(d1?.message).toBe('a');
    expect(await queue.length('sess-2')).toBe(1);
  });

  it('throws when queue exceeds max size', async () => {
    const small = new InMemoryExecutionQueue({ maxQueueSize: 2 });

    await small.enqueue('sess-1', makeExec('sess-1', 'a'));
    await small.enqueue('sess-1', makeExec('sess-1', 'b'));

    await expect(small.enqueue('sess-1', makeExec('sess-1', 'c'))).rejects.toThrow(
      'Queue full: session sess-1 has 2 pending executions (max: 2)',
    );
  });

  it('respects custom maxQueueSize option', async () => {
    const tiny = new InMemoryExecutionQueue({ maxQueueSize: 1 });

    await tiny.enqueue('sess-1', makeExec('sess-1', 'a'));

    await expect(tiny.enqueue('sess-1', makeExec('sess-1', 'b'))).rejects.toThrow(/Queue full/);

    // Default queue allows many more
    const defaultQueue = new InMemoryExecutionQueue();
    for (let i = 0; i < 100; i++) {
      await defaultQueue.enqueue('sess-1', makeExec('sess-1', `msg-${i}`));
    }
    // 101st should fail with default max of 100
    await expect(defaultQueue.enqueue('sess-1', makeExec('sess-1', 'overflow'))).rejects.toThrow(
      /Queue full/,
    );
  });
});
