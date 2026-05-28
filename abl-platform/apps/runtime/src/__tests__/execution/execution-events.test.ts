import { describe, it, expect } from 'vitest';
import { ServerMessages, parseClientMessage } from '../../websocket/events.js';

describe('Execution lifecycle events', () => {
  describe('ServerMessages', () => {
    it('creates executionQueued event', () => {
      const msg = ServerMessages.executionQueued('exec-1', 2, 15000);
      expect(msg).toEqual({
        type: 'execution_queued',
        executionId: 'exec-1',
        position: 2,
        estimatedWaitMs: 15000,
      });
    });

    it('creates executionStarted event', () => {
      const msg = ServerMessages.executionStarted('exec-1', 'booking_agent');
      expect(msg).toEqual({
        type: 'execution_started',
        executionId: 'exec-1',
        agentName: 'booking_agent',
      });
    });

    it('creates executionCancelled event', () => {
      const msg = ServerMessages.executionCancelled('exec-1', 'preempted');
      expect(msg).toEqual({
        type: 'execution_cancelled',
        executionId: 'exec-1',
        reason: 'preempted',
      });
    });

    it('creates executionRejected event', () => {
      const msg = ServerMessages.executionRejected('queue_full', 10, 5000);
      expect(msg).toEqual({
        type: 'execution_rejected',
        reason: 'queue_full',
        message: 'Agent is currently processing multiple messages. Please wait.',
        queueDepth: 10,
        retryAfterMs: 5000,
      });
    });
  });

  describe('parseClientMessage', () => {
    it('parses cancel_execution message', () => {
      const msg = parseClientMessage(
        JSON.stringify({
          type: 'cancel_execution',
          executionId: 'exec-abc',
        }),
      );
      expect(msg).toEqual({
        type: 'cancel_execution',
        executionId: 'exec-abc',
      });
    });

    it('parses cancel_execution without executionId', () => {
      const msg = parseClientMessage(
        JSON.stringify({
          type: 'cancel_execution',
        }),
      );
      expect(msg).toEqual({ type: 'cancel_execution' });
    });
  });
});
