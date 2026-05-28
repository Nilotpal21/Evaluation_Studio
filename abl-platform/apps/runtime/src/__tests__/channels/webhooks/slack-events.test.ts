/**
 * Slack Event Normalization Tests
 *
 * Tests that SlackAdapter correctly normalizes all Slack interaction types
 * (message events, block_actions, view_submission) into NormalizedIncomingMessage.
 */

import { describe, it, expect } from 'vitest';
import { SlackAdapter } from '../../../channels/adapters/slack-adapter.js';

describe('SlackAdapter.shouldProcess', () => {
  const adapter = new SlackAdapter();

  it('accepts event_callback with message event', () => {
    const body = {
      type: 'event_callback',
      event: { type: 'message', text: 'Hello', channel: 'C1', ts: '1', event_ts: '1' },
    };
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('accepts event_callback with app_mention', () => {
    const body = {
      type: 'event_callback',
      event: { type: 'app_mention', text: '<@U123> help', channel: 'C1', ts: '1', event_ts: '1' },
    };
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('accepts block_actions interactions', () => {
    const body = {
      type: 'block_actions',
      trigger_id: 'tr1',
      user: { id: 'U1', team_id: 'T1', name: 'user' },
      team: { id: 'T1' },
      actions: [{ type: 'button', action_id: 'btn1', block_id: 'b1', value: 'v1' }],
    };
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('accepts view_submission interactions', () => {
    const body = {
      type: 'view_submission',
      trigger_id: 'tr2',
      user: { id: 'U1', team_id: 'T1', name: 'user' },
      team: { id: 'T1' },
      view: { id: 'V1', callback_id: 'form1', state: { values: {} } },
    };
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('accepts slash command payloads', () => {
    const body = {
      command: '/ask-bot',
      text: 'help',
      team_id: 'T1',
      channel_id: 'C1',
      user_id: 'U1',
      trigger_id: 'tr-slash-1',
    };
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('rejects bot messages', () => {
    const body = {
      type: 'event_callback',
      event: {
        type: 'message',
        text: 'bot msg',
        channel: 'C1',
        ts: '1',
        event_ts: '1',
        bot_id: 'B1',
      },
    };
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('rejects bot_message subtype', () => {
    const body = {
      type: 'event_callback',
      event: {
        type: 'message',
        subtype: 'bot_message',
        text: 'bot',
        channel: 'C1',
        ts: '1',
        event_ts: '1',
      },
    };
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('rejects message_changed subtype', () => {
    const body = {
      type: 'event_callback',
      event: {
        type: 'message',
        subtype: 'message_changed',
        text: 'edit',
        channel: 'C1',
        ts: '1',
        event_ts: '1',
      },
    };
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('rejects message_deleted subtype', () => {
    const body = {
      type: 'event_callback',
      event: {
        type: 'message',
        subtype: 'message_deleted',
        text: 'del',
        channel: 'C1',
        ts: '1',
        event_ts: '1',
      },
    };
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('rejects empty text', () => {
    const body = {
      type: 'event_callback',
      event: { type: 'message', text: '', channel: 'C1', ts: '1', event_ts: '1' },
    };
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('rejects url_verification', () => {
    const body = { type: 'url_verification', challenge: 'abc', token: 't' };
    expect(adapter.shouldProcess(body)).toBe(false);
  });
});

describe('SlackAdapter.buildNormalizedMessage', () => {
  const adapter = new SlackAdapter();

  it('normalizes standard message event', () => {
    const body = {
      type: 'event_callback',
      team_id: 'T123',
      event: {
        type: 'message',
        channel: 'C456',
        user: 'U789',
        text: 'Hello agent',
        ts: '1700000000.000100',
        event_ts: '1700000000.000100',
        channel_type: 'im',
      },
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('Hello agent');
    expect(msg.externalSessionKey).toBe('slack:T123:C456');
    expect(msg.externalMessageId).toBe('1700000000.000100');
    expect(msg.actionEvent).toBeUndefined();
    expect(msg.metadata?.slackTeamId).toBe('T123');
    expect(msg.metadata?.slackChannelId).toBe('C456');
    expect(msg.metadata?.slackUserId).toBe('U789');
    expect(msg.metadata?.slackChannelType).toBe('im');
  });

  it('normalizes app_mention by stripping mention prefix', () => {
    const body = {
      type: 'event_callback',
      team_id: 'T123',
      event: {
        type: 'app_mention',
        channel: 'C456',
        user: 'U789',
        text: '<@U000BOT> what is the status?',
        ts: '1700000000.000200',
        event_ts: '1700000000.000200',
      },
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('what is the status?');
  });

  it('includes thread_ts in session key when threaded', () => {
    const body = {
      type: 'event_callback',
      team_id: 'T123',
      event: {
        type: 'message',
        channel: 'C456',
        user: 'U789',
        text: 'reply',
        ts: '1700000000.000300',
        event_ts: '1700000000.000300',
        thread_ts: '1700000000.000001',
      },
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.externalSessionKey).toBe('slack:T123:C456:1700000000.000001');
  });

  it('normalizes block_actions button click as ActionEvent', () => {
    const body = {
      type: 'block_actions',
      trigger_id: 'tr123',
      user: { id: 'U789', team_id: 'T123', name: 'testuser' },
      team: { id: 'T123' },
      channel: { id: 'C456' },
      message: { ts: '1700000000.000100' },
      actions: [
        {
          type: 'button',
          action_id: 'approve_btn',
          block_id: 'b1',
          value: 'approved',
        },
      ],
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('');
    expect(msg.actionEvent).toBeDefined();
    expect(msg.actionEvent!.type).toBe('action_event');
    expect(msg.actionEvent!.actionId).toBe('approve_btn');
    expect(msg.actionEvent!.value).toBe('approved');
    expect(msg.actionEvent!.source).toBe('slack');
    expect(msg.externalSessionKey).toBe('slack:T123:C456');
    expect(msg.metadata?.slackEventType).toBe('block_actions');
  });

  it('normalizes block_actions select as ActionEvent', () => {
    const body = {
      type: 'block_actions',
      trigger_id: 'tr124',
      user: { id: 'U789', team_id: 'T123', name: 'testuser' },
      team: { id: 'T123' },
      channel: { id: 'C456' },
      actions: [
        {
          type: 'static_select',
          action_id: 'color_select',
          block_id: 'b2',
          selected_option: { value: 'red', text: { text: 'Red' } },
        },
      ],
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.actionEvent).toBeDefined();
    expect(msg.actionEvent!.actionId).toBe('color_select');
    expect(msg.actionEvent!.value).toBe('red');
  });

  it('normalizes block_actions state values as formData', () => {
    const body = {
      type: 'block_actions',
      trigger_id: 'tr-form',
      user: { id: 'U789', team_id: 'T123', name: 'testuser' },
      team: { id: 'T123' },
      channel: { id: 'C456' },
      actions: [
        {
          type: 'button',
          action_id: 'route_agent',
          block_id: 'action-render:render-123',
          value: 'submit',
        },
      ],
      state: {
        values: {
          input_comment: {
            comment: { value: 'handoff requested' },
          },
          select_target: {
            target: { selected_option: { value: 'Agent_A' } },
          },
        },
      },
    };

    const msg = adapter.buildNormalizedMessage(body);

    expect(msg.actionEvent).toMatchObject({
      actionId: 'route_agent',
      value: 'submit',
      renderId: 'render-123',
      formData: {
        comment: 'handoff requested',
        target: 'Agent_A',
      },
      source: 'slack',
    });
  });

  it('rejects malformed block_actions formData at adapter ingress', () => {
    const body = {
      type: 'block_actions',
      trigger_id: 'tr-invalid-form',
      user: { id: 'U789', team_id: 'T123', name: 'testuser' },
      team: { id: 'T123' },
      channel: { id: 'C456' },
      actions: [
        {
          type: 'button',
          action_id: 'route_agent',
          block_id: 'action-render:render-123',
          value: 'submit',
        },
      ],
      state: {
        values: {
          unsafe_block: {
            constructor: { value: 'polluted' },
          },
        },
      },
    };

    expect(() => adapter.buildNormalizedMessage(body)).toThrow(/Invalid formData in action_submit/);
  });

  it('normalizes block_actions date picker', () => {
    const body = {
      type: 'block_actions',
      trigger_id: 'tr125',
      user: { id: 'U789', team_id: 'T123', name: 'testuser' },
      team: { id: 'T123' },
      actions: [
        {
          type: 'datepicker',
          action_id: 'date_pick',
          block_id: 'b3',
          selected_date: '2025-01-15',
        },
      ],
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.actionEvent!.actionId).toBe('date_pick');
    expect(msg.actionEvent!.value).toBe('2025-01-15');
  });

  it('normalizes view_submission as ActionEvent with formData', () => {
    const body = {
      type: 'view_submission',
      trigger_id: 'tr200',
      user: { id: 'U789', team_id: 'T123', name: 'testuser' },
      team: { id: 'T123' },
      view: {
        id: 'V1',
        callback_id: 'feedback_form',
        state: {
          values: {
            block_name: {
              name_input: { value: 'Alice' },
            },
            block_rating: {
              rating_select: { selected_option: { value: '5' } },
            },
          },
        },
      },
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('');
    expect(msg.actionEvent).toBeDefined();
    expect(msg.actionEvent!.actionId).toBe('feedback_form');
    expect(msg.actionEvent!.source).toBe('slack');
    expect(msg.actionEvent!.formData).toBeDefined();
    expect(msg.actionEvent!.formData!.name_input).toBe('Alice');
    expect(msg.actionEvent!.formData!.rating_select).toBe('5');
    expect(msg.externalSessionKey).toBe('slack:T123:U789');
    expect(msg.metadata?.slackEventType).toBe('view_submission');
    expect(msg.metadata?.slackViewId).toBe('V1');
  });

  it('uses dm fallback for block_actions without channel', () => {
    const body = {
      type: 'block_actions',
      trigger_id: 'tr300',
      user: { id: 'U789', team_id: 'T123', name: 'testuser' },
      team: { id: 'T123' },
      actions: [{ type: 'button', action_id: 'btn1', block_id: 'b1', value: 'v1' }],
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.externalSessionKey).toBe('slack:T123:dm');
  });

  it('normalizes slash command payload as a standard message', () => {
    const body = {
      command: '/ask-bot',
      text: 'what is the status?',
      team_id: 'T123',
      channel_id: 'C456',
      channel_name: 'support',
      user_id: 'U789',
      user_name: 'alice',
      trigger_id: 'tr-slash-1',
      response_url: 'https://hooks.slack.com/commands/123',
      api_app_id: 'A111',
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('/ask-bot what is the status?');
    expect(msg.externalMessageId).toBe('slash:tr-slash-1:C456:U789');
    expect(msg.externalSessionKey).toBe('slack:T123:C456');
    expect(msg.metadata?.isSlashCommand).toBe(true);
    expect(msg.metadata?.slashCommand).toBe('/ask-bot');
    expect(msg.metadata?.slashArgs).toBe('what is the status?');
    expect(msg.metadata?.slackEventType).toBe('slash_command');
    expect(msg.metadata?.responseUrl).toBe('https://hooks.slack.com/commands/123');
  });

  it('normalizes slash command without trailing args', () => {
    const body = {
      command: '/ask-bot',
      text: '   ',
      team_id: 'T123',
      channel_id: 'C456',
      user_id: 'U789',
      trigger_id: 'tr-slash-2',
    };

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('/ask-bot');
    expect(msg.metadata?.slashArgs).toBe('');
  });
});

describe('SlackAdapter.handleVerificationChallenge', () => {
  const adapter = new SlackAdapter();

  it('returns challenge for url_verification event', () => {
    const body = { type: 'url_verification', challenge: 'abc123', token: 't' };
    expect(adapter.handleVerificationChallenge(body)).toBe('abc123');
  });

  it('returns null for non-verification events', () => {
    const body = { type: 'event_callback', event: {} };
    expect(adapter.handleVerificationChallenge(body)).toBeNull();
  });
});

describe('SlackAdapter.extractEventId', () => {
  const adapter = new SlackAdapter();

  it('returns event_id from event_callback', () => {
    const body = { type: 'event_callback', event_id: 'Ev123' };
    expect(adapter.extractEventId(body)).toBe('Ev123');
  });

  it('returns null for non-event_callback', () => {
    const body = { type: 'block_actions' };
    expect(adapter.extractEventId(body)).toBeNull();
  });
});

describe('SlackAdapter.extractExternalIdentifier', () => {
  const adapter = new SlackAdapter();

  it('returns team_id:api_app_id for event_callback', () => {
    const body = {
      type: 'event_callback',
      team_id: 'T12345ABC',
      api_app_id: 'A67890XYZ',
      event: { type: 'message', text: 'hi', channel: 'C1', ts: '1', event_ts: '1' },
    };
    expect(adapter.extractExternalIdentifier(body)).toBe('T12345ABC:A67890XYZ');
  });

  it('falls back to team_id when api_app_id is missing', () => {
    const body = {
      type: 'event_callback',
      team_id: 'T12345ABC',
      event: { type: 'message', text: 'hi', channel: 'C1', ts: '1', event_ts: '1' },
    };
    expect(adapter.extractExternalIdentifier(body)).toBe('T12345ABC');
  });

  it('extracts team_id:api_app_id from block_actions', () => {
    const body = {
      type: 'block_actions',
      trigger_id: 'tr1',
      api_app_id: 'A123',
      user: { id: 'U1', team_id: 'T1', name: 'user' },
      team: { id: 'T1' },
      actions: [{ type: 'button', action_id: 'btn1', block_id: 'b1', value: 'v1' }],
    };
    expect(adapter.extractExternalIdentifier(body)).toBe('T1:A123');
  });

  it('extracts team_id:api_app_id from view_submission', () => {
    const body = {
      type: 'view_submission',
      trigger_id: 'tr2',
      api_app_id: 'A123',
      user: { id: 'U1', team_id: 'T1', name: 'user' },
      team: { id: 'T1' },
      view: { id: 'V1', callback_id: 'form1', state: { values: {} } },
    };
    expect(adapter.extractExternalIdentifier(body)).toBe('T1:A123');
  });

  it('returns team_id only for block_actions without api_app_id', () => {
    const body = {
      type: 'block_actions',
      trigger_id: 'tr1',
      user: { id: 'U1', team_id: 'T1', name: 'user' },
      team: { id: 'T1' },
      actions: [{ type: 'button', action_id: 'btn1', block_id: 'b1', value: 'v1' }],
    };
    expect(adapter.extractExternalIdentifier(body)).toBe('T1');
  });

  it('extracts team_id:api_app_id from slash commands', () => {
    const body = {
      command: '/ask-bot',
      team_id: 'T1',
      api_app_id: 'A123',
      channel_id: 'C1',
      user_id: 'U1',
      trigger_id: 'tr1',
    };
    expect(adapter.extractExternalIdentifier(body)).toBe('T1:A123');
  });

  it('falls back to team_id for slash commands without api_app_id', () => {
    const body = {
      command: '/ask-bot',
      team_id: 'T1',
      channel_id: 'C1',
      user_id: 'U1',
      trigger_id: 'tr1',
    };
    expect(adapter.extractExternalIdentifier(body)).toBe('T1');
  });

  it('returns null for url_verification', () => {
    const body = { type: 'url_verification', challenge: 'abc', token: 't' };
    expect(adapter.extractExternalIdentifier(body)).toBeNull();
  });
});
