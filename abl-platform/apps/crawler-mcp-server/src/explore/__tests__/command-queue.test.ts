/**
 * Command Queue — Pure Function Tests
 *
 * Tests the per-exploration in-memory command queue used by the depth prober
 * to receive intervention commands between page visits.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  enqueueCommand,
  getNextCommand,
  peekCommands,
  clearQueue,
  queueSize,
  MAX_QUEUED_COMMANDS,
  type Intervention,
} from '../command-queue.js';

const EXPLORE_ID = 'test-explore-001';

function makeCommand(
  type: Intervention['type'] = 'stop',
  payload?: Intervention['payload'],
): Intervention {
  return { type, payload, receivedAt: Date.now() };
}

// ─── Cleanup ───────────────────────────────────────────────────────

beforeEach(() => {
  clearQueue(EXPLORE_ID);
  clearQueue('other-explore');
});

// ─── enqueueCommand ────────────────────────────────────────────────

describe('enqueueCommand', () => {
  it('enqueues a command and returns true', () => {
    const result = enqueueCommand(EXPLORE_ID, makeCommand('stop'));
    expect(result).toBe(true);
    expect(queueSize(EXPLORE_ID)).toBe(1);
  });

  it('enqueues multiple commands in order', () => {
    enqueueCommand(EXPLORE_ID, makeCommand('stop'));
    enqueueCommand(EXPLORE_ID, makeCommand('add-sample', { url: 'https://a.com' }));
    enqueueCommand(EXPLORE_ID, makeCommand('skip-branch', { url: 'https://b.com' }));
    expect(queueSize(EXPLORE_ID)).toBe(3);
  });

  it('isolates queues by exploreId', () => {
    enqueueCommand(EXPLORE_ID, makeCommand('stop'));
    enqueueCommand('other-explore', makeCommand('add-sample'));
    expect(queueSize(EXPLORE_ID)).toBe(1);
    expect(queueSize('other-explore')).toBe(1);
  });

  it('rejects when queue reaches MAX_QUEUED_COMMANDS', () => {
    for (let i = 0; i < MAX_QUEUED_COMMANDS; i++) {
      expect(enqueueCommand(EXPLORE_ID, makeCommand('stop'))).toBe(true);
    }
    // Queue is now full
    const result = enqueueCommand(EXPLORE_ID, makeCommand('stop'));
    expect(result).toBe(false);
    expect(queueSize(EXPLORE_ID)).toBe(MAX_QUEUED_COMMANDS);
  });
});

// ─── getNextCommand (FIFO) ─────────────────────────────────────────

describe('getNextCommand', () => {
  it('returns undefined for empty queue', () => {
    expect(getNextCommand(EXPLORE_ID)).toBeUndefined();
  });

  it('returns undefined for unknown exploreId', () => {
    expect(getNextCommand('nonexistent')).toBeUndefined();
  });

  it('dequeues in FIFO order', () => {
    const cmd1 = makeCommand('stop');
    const cmd2 = makeCommand('add-sample', { url: 'https://a.com' });
    const cmd3 = makeCommand('explore-branch', { url: 'https://b.com' });

    enqueueCommand(EXPLORE_ID, cmd1);
    enqueueCommand(EXPLORE_ID, cmd2);
    enqueueCommand(EXPLORE_ID, cmd3);

    expect(getNextCommand(EXPLORE_ID)).toEqual(cmd1);
    expect(getNextCommand(EXPLORE_ID)).toEqual(cmd2);
    expect(getNextCommand(EXPLORE_ID)).toEqual(cmd3);
    expect(getNextCommand(EXPLORE_ID)).toBeUndefined();
  });

  it('removes the dequeued command from the queue', () => {
    enqueueCommand(EXPLORE_ID, makeCommand('stop'));
    enqueueCommand(EXPLORE_ID, makeCommand('add-sample'));
    expect(queueSize(EXPLORE_ID)).toBe(2);

    getNextCommand(EXPLORE_ID);
    expect(queueSize(EXPLORE_ID)).toBe(1);
  });
});

// ─── peekCommands ──────────────────────────────────────────────────

describe('peekCommands', () => {
  it('returns empty array for unknown exploreId', () => {
    expect(peekCommands('nonexistent')).toEqual([]);
  });

  it('returns all commands without removing them', () => {
    const cmd1 = makeCommand('stop');
    const cmd2 = makeCommand('explore-all', { urls: ['https://a.com'] });

    enqueueCommand(EXPLORE_ID, cmd1);
    enqueueCommand(EXPLORE_ID, cmd2);

    const peeked = peekCommands(EXPLORE_ID);
    expect(peeked).toEqual([cmd1, cmd2]);
    expect(queueSize(EXPLORE_ID)).toBe(2);
  });
});

// ─── clearQueue ────────────────────────────────────────────────────

describe('clearQueue', () => {
  it('removes all commands for an exploreId', () => {
    enqueueCommand(EXPLORE_ID, makeCommand('stop'));
    enqueueCommand(EXPLORE_ID, makeCommand('add-sample'));
    clearQueue(EXPLORE_ID);
    expect(queueSize(EXPLORE_ID)).toBe(0);
    expect(getNextCommand(EXPLORE_ID)).toBeUndefined();
  });

  it('does not affect other exploreIds', () => {
    enqueueCommand(EXPLORE_ID, makeCommand('stop'));
    enqueueCommand('other-explore', makeCommand('stop'));
    clearQueue(EXPLORE_ID);
    expect(queueSize('other-explore')).toBe(1);
  });

  it('is safe to call on unknown exploreId', () => {
    expect(() => clearQueue('nonexistent')).not.toThrow();
  });
});

// ─── queueSize ─────────────────────────────────────────────────────

describe('queueSize', () => {
  it('returns 0 for unknown exploreId', () => {
    expect(queueSize('nonexistent')).toBe(0);
  });

  it('reflects enqueue and dequeue operations', () => {
    expect(queueSize(EXPLORE_ID)).toBe(0);
    enqueueCommand(EXPLORE_ID, makeCommand('stop'));
    expect(queueSize(EXPLORE_ID)).toBe(1);
    enqueueCommand(EXPLORE_ID, makeCommand('add-sample'));
    expect(queueSize(EXPLORE_ID)).toBe(2);
    getNextCommand(EXPLORE_ID);
    expect(queueSize(EXPLORE_ID)).toBe(1);
  });
});

// ─── MAX_QUEUED_COMMANDS cap ───────────────────────────────────────

describe('MAX_QUEUED_COMMANDS cap', () => {
  it('allows exactly MAX_QUEUED_COMMANDS commands', () => {
    for (let i = 0; i < MAX_QUEUED_COMMANDS; i++) {
      enqueueCommand(EXPLORE_ID, makeCommand('undo-skip', { url: `https://u${i}.com` }));
    }
    expect(queueSize(EXPLORE_ID)).toBe(MAX_QUEUED_COMMANDS);
  });

  it('accepts new commands after dequeuing from a full queue', () => {
    for (let i = 0; i < MAX_QUEUED_COMMANDS; i++) {
      enqueueCommand(EXPLORE_ID, makeCommand('stop'));
    }
    // Full — reject
    expect(enqueueCommand(EXPLORE_ID, makeCommand('stop'))).toBe(false);

    // Dequeue one
    getNextCommand(EXPLORE_ID);
    expect(queueSize(EXPLORE_ID)).toBe(MAX_QUEUED_COMMANDS - 1);

    // Now it should accept
    expect(enqueueCommand(EXPLORE_ID, makeCommand('add-sample'))).toBe(true);
    expect(queueSize(EXPLORE_ID)).toBe(MAX_QUEUED_COMMANDS);
  });
});

// ─── All intervention types ────────────────────────────────────────

describe('intervention types', () => {
  const types: Intervention['type'][] = [
    'stop',
    'add-sample',
    'explore-branch',
    'skip-branch',
    'explore-all',
    'undo-skip',
  ];

  it.each(types)('handles "%s" intervention type', (type) => {
    const cmd = makeCommand(type, { url: 'https://example.com' });
    enqueueCommand(EXPLORE_ID, cmd);
    const dequeued = getNextCommand(EXPLORE_ID);
    expect(dequeued).toEqual(cmd);
    expect(dequeued?.type).toBe(type);
  });
});
