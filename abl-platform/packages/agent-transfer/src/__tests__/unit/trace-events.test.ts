import { describe, it, expect, vi } from 'vitest';
import {
  emitTransferTraceEvent,
  type TraceEventEmitter,
  type TransferTraceEvent,
} from '../../observability/trace-events.js';

describe('emitTransferTraceEvent', () => {
  const BASE = {
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    contactId: 'contact-1',
    provider: 'kore',
    channel: 'chat',
    timestamp: 1709000000000,
  };

  function makeEmitter() {
    return { emit: vi.fn() } satisfies TraceEventEmitter;
  }

  it('emits transfer_initiated with correct type string', () => {
    const emitter = makeEmitter();
    const event: TransferTraceEvent = {
      ...BASE,
      kind: 'transfer_initiated',
      queue: 'support',
      skills: ['billing'],
    };

    emitTransferTraceEvent(emitter, event);

    expect(emitter.emit).toHaveBeenCalledWith({
      type: 'agent_transfer.transfer_initiated',
      timestamp: BASE.timestamp,
      data: expect.objectContaining({
        tenantId: 'tenant-1',
        queue: 'support',
        skills: ['billing'],
      }),
    });
  });

  it('emits transfer_completed with status and duration', () => {
    const emitter = makeEmitter();
    emitTransferTraceEvent(emitter, {
      ...BASE,
      kind: 'transfer_completed',
      status: 'transferred',
      durationMs: 1500,
    });

    expect(emitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent_transfer.transfer_completed',
        data: expect.objectContaining({ status: 'transferred', durationMs: 1500 }),
      }),
    );
  });

  it('emits transfer_failed with error info', () => {
    const emitter = makeEmitter();
    emitTransferTraceEvent(emitter, {
      ...BASE,
      kind: 'transfer_failed',
      errorCode: 'TIMEOUT',
      errorMessage: 'Connection timed out',
    });

    expect(emitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent_transfer.transfer_failed',
        data: expect.objectContaining({
          errorCode: 'TIMEOUT',
          errorMessage: 'Connection timed out',
        }),
      }),
    );
  });

  it('emits agent_connected with wait time', () => {
    const emitter = makeEmitter();
    emitTransferTraceEvent(emitter, {
      ...BASE,
      kind: 'agent_connected',
      agentName: 'John',
      waitTimeMs: 30000,
    });

    expect(emitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent_transfer.agent_connected',
        data: expect.objectContaining({ agentName: 'John', waitTimeMs: 30000 }),
      }),
    );
  });

  it('emits agent_disconnected with reason', () => {
    const emitter = makeEmitter();
    emitTransferTraceEvent(emitter, {
      ...BASE,
      kind: 'agent_disconnected',
      reason: 'agent_ended',
      durationMs: 120000,
    });

    expect(emitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent_transfer.agent_disconnected',
        data: expect.objectContaining({ reason: 'agent_ended' }),
      }),
    );
  });

  it('emits csat_completed with score', () => {
    const emitter = makeEmitter();
    emitTransferTraceEvent(emitter, {
      ...BASE,
      kind: 'csat_completed',
      score: 4,
      feedback: 'Good service',
    });

    expect(emitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent_transfer.csat_completed',
        data: expect.objectContaining({ score: 4, feedback: 'Good service' }),
      }),
    );
  });

  it('preserves timestamp from event', () => {
    const emitter = makeEmitter();
    const ts = 1700000000000;
    emitTransferTraceEvent(emitter, {
      ...BASE,
      timestamp: ts,
      kind: 'transfer_initiated',
    });

    expect(emitter.emit).toHaveBeenCalledWith(expect.objectContaining({ timestamp: ts }));
  });

  it('handles async emitter', async () => {
    const emitter: TraceEventEmitter = {
      emit: vi.fn().mockResolvedValue(undefined),
    };
    const result = emitTransferTraceEvent(emitter, {
      ...BASE,
      kind: 'transfer_initiated',
    });

    // Should return a promise when emitter returns a promise
    if (result) {
      await result;
    }
    expect(emitter.emit).toHaveBeenCalled();
  });
});
