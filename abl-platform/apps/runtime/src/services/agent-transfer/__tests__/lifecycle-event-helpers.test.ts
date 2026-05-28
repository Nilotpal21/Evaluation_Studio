import { describe, it, expect } from 'vitest';
import {
  extractAgentDisconnectedFields,
  parseAcwMessageFields,
} from '../lifecycle-event-helpers.js';

describe('extractAgentDisconnectedFields', () => {
  it('extracts all four selective fields when present', () => {
    const result = extractAgentDisconnectedFields({
      originalType: 'start_kore_agent_chat_message_for_user',
      syntheticDisconnect: true,
      isACWEnabled: true,
      acwStartTime: '2026-05-16T11:51:51.804Z',
    });

    expect(result.originalType).toBe('start_kore_agent_chat_message_for_user');
    expect(result.syntheticDisconnect).toBe(true);
    expect(result.isACWEnabled).toBe(true);
    expect(result.acwStartTime).toBe('2026-05-16T11:51:51.804Z');
  });

  it('returns all undefined when event data is undefined', () => {
    const result = extractAgentDisconnectedFields(undefined);

    expect(result.originalType).toBeUndefined();
    expect(result.syntheticDisconnect).toBeUndefined();
    expect(result.isACWEnabled).toBeUndefined();
    expect(result.acwStartTime).toBeUndefined();
  });

  it('omits syntheticDisconnect when false', () => {
    const result = extractAgentDisconnectedFields({ syntheticDisconnect: false });
    expect(result.syntheticDisconnect).toBeUndefined();
  });

  it('omits isACWEnabled when false', () => {
    const result = extractAgentDisconnectedFields({ isACWEnabled: false });
    expect(result.isACWEnabled).toBeUndefined();
  });

  it('omits acwStartTime when value is a number not a string', () => {
    const result = extractAgentDisconnectedFields({ acwStartTime: 1747389111804 });
    expect(result.acwStartTime).toBeUndefined();
  });

  it('omits originalType when value is not a string', () => {
    const result = extractAgentDisconnectedFields({ originalType: 42 });
    expect(result.originalType).toBeUndefined();
  });

  it('omits absent fields without polluting the spread', () => {
    const result = extractAgentDisconnectedFields({
      originalType: 'remove_id_to_acc_identity',
    });

    expect(result.originalType).toBe('remove_id_to_acc_identity');
    expect(result.syntheticDisconnect).toBeUndefined();
    expect(result.isACWEnabled).toBeUndefined();
    expect(result.acwStartTime).toBeUndefined();
  });
});

describe('parseAcwMessageFields', () => {
  it('parses a normal agent-closed ACW submission', () => {
    const result = parseAcwMessageFields({
      closeStatus: 'Resolved',
      closeRemarks: 'Submitted plan',
      acwTimedOut: false,
      timestamp: '2026-05-16T11:52:06.593Z',
    });

    expect(result.dispositionCode).toBe('Resolved');
    expect(result.wrapUpNotes).toBe('Submitted plan');
    expect(result.acwTimedOut).toBe(false);
    expect(result.acwCloseReason).toBe('agent_closed');
    expect(result.acwEventTimestamp).toBe('2026-05-16T11:52:06.593Z');
  });

  it('parses an ACW timeout scenario', () => {
    const result = parseAcwMessageFields({
      closeStatus: 'Resolution',
      closeRemarks: '',
      acwTimedOut: true,
      reason: 'ACW_TIMED_OUT',
      timestamp: '2026-05-16T11:55:00.000Z',
    });

    expect(result.acwTimedOut).toBe(true);
    expect(result.acwCloseReason).toBe('timeout');
    expect(result.dispositionCode).toBe('Resolution');
    expect(result.wrapUpNotes).toBe('');
    expect(result.acwEventTimestamp).toBe('2026-05-16T11:55:00.000Z');
  });

  it('returns undefined dispositionCode when closeStatus is missing', () => {
    const result = parseAcwMessageFields({ acwTimedOut: false });
    expect(result.dispositionCode).toBeUndefined();
    expect(result.acwCloseReason).toBe('agent_closed');
  });

  it('returns undefined wrapUpNotes when closeRemarks is missing', () => {
    const result = parseAcwMessageFields({ closeStatus: 'Closed', acwTimedOut: false });
    expect(result.wrapUpNotes).toBeUndefined();
  });

  it('returns undefined timestamp when timestamp field is absent', () => {
    const result = parseAcwMessageFields({ closeStatus: 'Resolved', acwTimedOut: false });
    expect(result.acwEventTimestamp).toBeUndefined();
  });

  it('returns undefined timestamp when timestamp is a number not a string', () => {
    const result = parseAcwMessageFields({ timestamp: 1747389126000 });
    expect(result.acwEventTimestamp).toBeUndefined();
  });

  it('defaults acwTimedOut to false when field is absent', () => {
    const result = parseAcwMessageFields({ closeStatus: 'Resolved' });
    expect(result.acwTimedOut).toBe(false);
    expect(result.acwCloseReason).toBe('agent_closed');
  });

  it('ignores non-string closeStatus', () => {
    const result = parseAcwMessageFields({ closeStatus: 123, acwTimedOut: false });
    expect(result.dispositionCode).toBeUndefined();
  });
});
