/**
 * AudioCodes Adapter Tests
 *
 * Tests for buildNormalizedMessage, transformOutput, capabilities,
 * and outbound activity builders.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import {
  AudioCodesAdapter,
  buildMessageActivity,
  buildHangupActivity,
  buildConfigActivity,
  buildTransferActivity,
} from '../../../channels/adapters/audiocodes-adapter.js';
import type { AudioCodesActivity } from '../../../channels/adapters/audiocodes-adapter.js';

// Deterministic UUIDs and timestamps for snapshot-friendly assertions
vi.stubGlobal('crypto', {
  ...globalThis.crypto,
  randomUUID: () => 'test-uuid-0000',
});

const FIXED_NOW = new Date('2026-01-15T12:00:00.000Z');
vi.useFakeTimers();
vi.setSystemTime(FIXED_NOW);

describe('AudioCodesAdapter', () => {
  const adapter = new AudioCodesAdapter();

  // ---------------------------------------------------------------------------
  // buildNormalizedMessage
  // ---------------------------------------------------------------------------
  describe('buildNormalizedMessage', () => {
    it('normalizes a start event with caller/callee', () => {
      const activities: AudioCodesActivity[] = [
        {
          type: 'event',
          name: 'start',
          parameters: {
            caller: '+15551234567',
            callee: '+15559876543',
            callerHost: '10.0.0.1',
            calleeHost: '10.0.0.2',
          },
        },
      ];

      const msg = adapter.buildNormalizedMessage('conv-001', activities);

      expect(msg.externalSessionKey).toBe('audiocodes:conv-001');
      expect(msg.metadata?.isNewCall).toBe(true);
      expect(msg.metadata?.caller).toBe('+15551234567');
      expect(msg.metadata?.callee).toBe('+15559876543');
      expect(msg.metadata?.callerHost).toBe('10.0.0.1');
      expect(msg.metadata?.calleeHost).toBe('10.0.0.2');
      expect(msg.metadata?.eventName).toBe('start');
      expect(msg.text).toBe('');
    });

    it('normalizes a speech message', () => {
      const activities: AudioCodesActivity[] = [
        {
          type: 'message',
          text: 'I need help with my account',
        },
      ];

      const msg = adapter.buildNormalizedMessage('conv-002', activities);

      expect(msg.text).toBe('I need help with my account');
      expect(msg.externalSessionKey).toBe('audiocodes:conv-002');
    });

    it('normalizes a DTMF event', () => {
      const activities: AudioCodesActivity[] = [
        {
          type: 'event',
          name: 'DTMF',
          value: '5',
        },
      ];

      const msg = adapter.buildNormalizedMessage('conv-003', activities);

      expect(msg.text).toBe('5');
      expect(msg.metadata?.isDtmf).toBe(true);
      expect(msg.metadata?.eventName).toBe('DTMF');
    });

    it('normalizes a noInput event', () => {
      const activities: AudioCodesActivity[] = [
        {
          type: 'event',
          name: 'noInput',
        },
      ];

      const msg = adapter.buildNormalizedMessage('conv-004', activities);

      expect(msg.metadata?.isNoInput).toBe(true);
      expect(msg.text).toBe('');
      expect(msg.metadata?.eventName).toBe('noInput');
    });

    it('handles empty activities array', () => {
      const msg = adapter.buildNormalizedMessage('conv-005', []);

      expect(msg.text).toBe('');
      expect(msg.externalSessionKey).toBe('audiocodes:conv-005');
      expect(msg.metadata?.conversationId).toBe('conv-005');
    });

    it('sets externalMessageId with conversation id prefix', () => {
      const msg = adapter.buildNormalizedMessage('conv-006', []);

      expect(msg.externalMessageId).toMatch(/^ac-conv-006-/);
    });

    it('sets timestamp', () => {
      const msg = adapter.buildNormalizedMessage('conv-007', []);

      expect(msg.timestamp).toBeInstanceOf(Date);
    });
  });

  // ---------------------------------------------------------------------------
  // transformOutput
  // ---------------------------------------------------------------------------
  describe('transformOutput', () => {
    it('returns { kind: "text", text } for plain text', () => {
      const result = adapter.transformOutput('Hello, how can I help?');

      expect(result).toEqual({ kind: 'text', text: 'Hello, how can I help?' });
    });

    it('returns empty text correctly', () => {
      const result = adapter.transformOutput('');

      expect(result).toEqual({ kind: 'text', text: '' });
    });
  });

  // ---------------------------------------------------------------------------
  // capabilities
  // ---------------------------------------------------------------------------
  describe('capabilities', () => {
    it('has channelType = audiocodes', () => {
      expect(adapter.channelType).toBe('audiocodes');
    });

    it('does not support async, streaming, media, or threading', () => {
      expect(adapter.capabilities.supportsAsync).toBe(false);
      expect(adapter.capabilities.supportsStreaming).toBe(false);
      expect(adapter.capabilities.supportsMedia).toBe(false);
      expect(adapter.capabilities.supportsThreading).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Activity builders
// ---------------------------------------------------------------------------
describe('Activity builders', () => {
  describe('buildMessageActivity', () => {
    it('creates a message activity with id and timestamp', () => {
      const activity = buildMessageActivity('Hello there');

      expect(activity.type).toBe('message');
      expect(activity.text).toBe('Hello there');
      expect(activity.id).toBe('test-uuid-0000');
      expect(activity.timestamp).toBe(FIXED_NOW.toISOString());
    });

    it('includes sessionParams when provided', () => {
      const params = { language: 'en-US', voiceName: 'en-US-Neural2-F' };
      const activity = buildMessageActivity('Hi', params);

      expect(activity.sessionParams).toEqual(params);
    });

    it('omits sessionParams when not provided', () => {
      const activity = buildMessageActivity('Hi');

      expect(activity.sessionParams).toBeUndefined();
    });
  });

  describe('buildHangupActivity', () => {
    it('creates a hangup event', () => {
      const activity = buildHangupActivity();

      expect(activity.type).toBe('event');
      expect(activity.name).toBe('hangup');
      expect(activity.id).toBe('test-uuid-0000');
      expect(activity.timestamp).toBe(FIXED_NOW.toISOString());
      expect(activity.activityParams).toBeUndefined();
    });

    it('includes reason when provided', () => {
      const activity = buildHangupActivity('call completed');

      expect(activity.activityParams).toEqual({ hangupReason: 'call completed' });
    });
  });

  describe('buildConfigActivity', () => {
    it('creates a config event with sessionParams', () => {
      const params = { language: 'fr-FR', bargeIn: true };
      const activity = buildConfigActivity(params);

      expect(activity.type).toBe('event');
      expect(activity.name).toBe('config');
      expect(activity.sessionParams).toEqual(params);
      expect(activity.id).toBe('test-uuid-0000');
      expect(activity.timestamp).toBe(FIXED_NOW.toISOString());
    });
  });

  describe('buildTransferActivity', () => {
    it('creates a transfer event with target', () => {
      const activity = buildTransferActivity('+15551112222');

      expect(activity.type).toBe('event');
      expect(activity.name).toBe('transfer');
      expect(activity.activityParams).toEqual({ transferTarget: '+15551112222' });
      expect(activity.id).toBe('test-uuid-0000');
    });

    it('includes reason when provided', () => {
      const activity = buildTransferActivity('+15551112222', 'escalation');

      expect(activity.activityParams).toEqual({
        transferTarget: '+15551112222',
        handoverReason: 'escalation',
      });
    });

    it('includes sipHeaders when provided', () => {
      const headers = [{ name: 'X-Custom', value: 'test-value' }];
      const activity = buildTransferActivity('+15551112222', undefined, headers);

      expect(activity.activityParams).toEqual({
        transferTarget: '+15551112222',
        transferSipHeaders: headers,
      });
    });

    it('includes both reason and sipHeaders', () => {
      const headers = [{ name: 'X-Ref', value: '12345' }];
      const activity = buildTransferActivity('+15551112222', 'agent handoff', headers);

      expect(activity.activityParams).toEqual({
        transferTarget: '+15551112222',
        handoverReason: 'agent handoff',
        transferSipHeaders: headers,
      });
    });
  });
});
