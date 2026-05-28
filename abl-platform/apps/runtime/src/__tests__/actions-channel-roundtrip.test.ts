/**
 * Actions Channel Roundtrip Tests
 *
 * Tests the full pipeline: ActionSetIR → transformOutput() → platform-native
 * → buildNormalizedMessage() → ActionEvent for each channel adapter that
 * supports interactive round-trips.
 *
 * This validates that an action rendered to the user can be correctly
 * normalized back into an ActionEvent when the user interacts with it.
 */

import { describe, it, expect } from 'vitest';
import { SlackAdapter } from '../channels/adapters/slack-adapter.js';
import { MSTeamsAdapter } from '../channels/adapters/msteams-adapter.js';
import { WhatsAppAdapter } from '../channels/adapters/whatsapp-adapter.js';
import { MessengerAdapter } from '../channels/adapters/messenger-adapter.js';
import type { ActionSetIR } from '@abl/compiler';

// Shared test data: a simple button ActionSetIR
const buttonActions: ActionSetIR = {
  elements: [
    { id: 'confirm', type: 'button', label: 'Confirm', value: 'yes' },
    { id: 'cancel', type: 'button', label: 'Cancel', value: 'no' },
  ],
};

// Shared test data: a select ActionSetIR
const selectActions: ActionSetIR = {
  elements: [
    {
      id: 'priority',
      type: 'select',
      label: 'Priority',
      options: [
        { id: 'high', label: 'High' },
        { id: 'medium', label: 'Medium' },
        { id: 'low', label: 'Low' },
      ],
    },
  ],
};

describe('Slack roundtrip: ActionSetIR → Block Kit → ActionEvent', () => {
  const adapter = new SlackAdapter();

  it('button click roundtrip', () => {
    // Step 1: Transform to Block Kit
    const output = adapter.transformOutput('Confirm order?', buttonActions);
    expect(output.kind).toBe('slack_blocks');
    if (output.kind !== 'slack_blocks') return;

    // Verify the outbound button has the right action_id and value
    const actionsBlock = output.blocks.find((b: any) => b.type === 'actions') as any;
    expect(actionsBlock.elements[0].action_id).toBe('confirm');
    expect(actionsBlock.elements[0].value).toBe('yes');

    // Step 2: Simulate user clicking the button → Slack sends block_actions
    const inboundPayload = {
      type: 'block_actions',
      trigger_id: 'tr1',
      user: { id: 'U1', team_id: 'T1', name: 'user' },
      team: { id: 'T1' },
      channel: { id: 'C1' },
      actions: [
        {
          type: 'button',
          action_id: 'confirm',
          block_id: 'b1',
          value: 'yes',
        },
      ],
    };

    // Step 3: Normalize back to ActionEvent
    const msg = adapter.buildNormalizedMessage(inboundPayload);
    expect(msg.actionEvent).toBeDefined();
    expect(msg.actionEvent!.actionId).toBe('confirm');
    expect(msg.actionEvent!.value).toBe('yes');
    expect(msg.actionEvent!.source).toBe('slack');
  });

  it('select roundtrip', () => {
    const output = adapter.transformOutput('Set priority:', selectActions);
    expect(output.kind).toBe('slack_blocks');
    if (output.kind !== 'slack_blocks') return;

    const actionsBlock = output.blocks.find((b: any) => b.type === 'actions') as any;
    expect(actionsBlock.elements[0].type).toBe('static_select');
    expect(actionsBlock.elements[0].action_id).toBe('priority');

    // Simulate user selecting "high"
    const inboundPayload = {
      type: 'block_actions',
      trigger_id: 'tr2',
      user: { id: 'U1', team_id: 'T1', name: 'user' },
      team: { id: 'T1' },
      channel: { id: 'C1' },
      actions: [
        {
          type: 'static_select',
          action_id: 'priority',
          block_id: 'b1',
          selected_option: { value: 'high', text: { text: 'High' } },
        },
      ],
    };

    const msg = adapter.buildNormalizedMessage(inboundPayload);
    expect(msg.actionEvent!.actionId).toBe('priority');
    expect(msg.actionEvent!.value).toBe('high');
  });
});

describe('MS Teams roundtrip: ActionSetIR → Adaptive Card → ActionEvent', () => {
  const adapter = new MSTeamsAdapter();

  it('button click roundtrip', () => {
    // Step 1: Transform to Adaptive Card
    const output = adapter.transformOutput('Confirm order?', buttonActions);
    expect(output.kind).toBe('adaptive_card');
    if (output.kind !== 'adaptive_card') return;

    const card = output.card as any;
    expect(card.actions[0].type).toBe('Action.Execute');
    expect(card.actions[0].data._actionId).toBe('confirm');
    expect(card.actions[0].data._value).toBe('yes');

    // Step 2: Simulate user clicking → Teams sends invoke activity
    const inboundPayload = {
      type: 'invoke',
      id: 'act1',
      name: 'adaptiveCard/action',
      from: { id: 'user1', name: 'Test User' },
      recipient: { id: 'bot1', name: 'Bot' },
      channelData: { tenant: { id: 'tenant1' } },
      conversation: { id: 'conv1' },
      serviceUrl: 'https://smba.trafficmanager.net/teams/',
      value: {
        action: {
          type: 'Action.Execute',
          data: { _actionId: 'confirm', _value: 'yes' },
        },
      },
    };

    // Step 3: Normalize back
    const msg = adapter.buildNormalizedMessage(inboundPayload);
    expect(msg.actionEvent).toBeDefined();
    expect(msg.actionEvent!.actionId).toBe('confirm');
    expect(msg.actionEvent!.value).toBe('yes');
    expect(msg.actionEvent!.source).toBe('teams');
  });

  it('rejects malformed Teams action formData at adapter ingress', () => {
    const inboundPayload = {
      type: 'invoke',
      id: 'act-invalid',
      name: 'adaptiveCard/action',
      from: { id: 'user1', name: 'Test User' },
      recipient: { id: 'bot1', name: 'Bot' },
      channelData: { tenant: { id: 'tenant1' } },
      conversation: { id: 'conv1' },
      serviceUrl: 'https://smba.trafficmanager.net/teams/',
      value: {
        action: {
          type: 'Action.Execute',
          data: { _actionId: 'confirm', constructor: 'polluted' },
        },
      },
    };

    expect(() => adapter.buildNormalizedMessage(inboundPayload)).toThrow(
      /Invalid formData in action_submit/,
    );
  });

  it('select roundtrip', () => {
    const output = adapter.transformOutput('Set priority:', selectActions);
    expect(output.kind).toBe('adaptive_card');
    if (output.kind !== 'adaptive_card') return;

    const card = output.card as any;
    const choiceSet = card.body.find((b: any) => b.type === 'Input.ChoiceSet');
    expect(choiceSet.id).toBe('priority');
    expect(choiceSet.choices[0].value).toBe('high');

    // User submits form with select value → invoke with form data
    const inboundPayload = {
      type: 'invoke',
      id: 'act2',
      name: 'adaptiveCard/action',
      from: { id: 'user1', name: 'Test User' },
      recipient: { id: 'bot1', name: 'Bot' },
      channelData: { tenant: { id: 'tenant1' } },
      conversation: { id: 'conv1' },
      serviceUrl: 'https://smba.trafficmanager.net/teams/',
      value: {
        action: {
          type: 'Action.Execute',
          data: { _actionId: 'priority', _value: 'high' },
        },
      },
    };

    const msg = adapter.buildNormalizedMessage(inboundPayload);
    expect(msg.actionEvent!.actionId).toBe('priority');
    expect(msg.actionEvent!.value).toBe('high');
  });
});

describe('WhatsApp roundtrip: ActionSetIR → Interactive → ActionEvent', () => {
  const adapter = new WhatsAppAdapter();

  it('button reply roundtrip', () => {
    // Step 1: Transform to interactive buttons
    const output = adapter.transformOutput('Confirm order?', buttonActions);
    expect(output.kind).toBe('whatsapp_interactive');
    if (output.kind !== 'whatsapp_interactive') return;

    const interactive = output.interactive as any;
    expect(interactive.type).toBe('button');
    expect(interactive.action.buttons[0].reply.id).toBe('confirm');

    // Step 2: Simulate user tapping button → WhatsApp sends button_reply
    const inboundPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry1',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+1234', phone_number_id: 'phone1' },
                messages: [
                  {
                    id: 'msg1',
                    from: '5551234',
                    timestamp: '1700000000',
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: { id: 'confirm', title: 'Confirm' },
                    },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    // Step 3: Normalize back
    const msg = adapter.buildNormalizedMessage(inboundPayload);
    expect(msg.actionEvent).toBeDefined();
    expect(msg.actionEvent!.actionId).toBe('confirm');
    expect(msg.actionEvent!.source).toBe('whatsapp');
  });

  it('list reply roundtrip for >3 buttons', () => {
    const manyButtons: ActionSetIR = {
      elements: Array.from({ length: 5 }, (_, i) => ({
        id: `opt${i}`,
        type: 'button' as const,
        label: `Option ${i}`,
      })),
    };

    // Transform → list
    const output = adapter.transformOutput('Choose:', manyButtons);
    expect(output.kind).toBe('whatsapp_interactive');
    if (output.kind !== 'whatsapp_interactive') return;

    const interactive = output.interactive as any;
    expect(interactive.type).toBe('list');
    expect(interactive.action.sections[0].rows[2].id).toBe('opt2');

    // Simulate list_reply
    const inboundPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry1',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+1234', phone_number_id: 'phone1' },
                messages: [
                  {
                    id: 'msg2',
                    from: '5551234',
                    timestamp: '1700000000',
                    type: 'interactive',
                    interactive: {
                      type: 'list_reply',
                      list_reply: { id: 'opt2', title: 'Option 2' },
                    },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const msg = adapter.buildNormalizedMessage(inboundPayload);
    expect(msg.actionEvent!.actionId).toBe('opt2');
  });
});

describe('Messenger roundtrip: ActionSetIR → Template → ActionEvent', () => {
  const adapter = new MessengerAdapter();

  it('postback roundtrip for button template', () => {
    // Step 1: Transform to button template
    const output = adapter.transformOutput('Confirm order?', buttonActions);
    expect(output.kind).toBe('messenger_template');
    if (output.kind !== 'messenger_template') return;

    const msg = output.message as any;
    expect(msg.attachment.payload.template_type).toBe('button');
    expect(msg.attachment.payload.buttons[0].payload).toBe('confirm');

    // Step 2: Simulate postback
    const inboundPayload = {
      object: 'page',
      entry: [
        {
          id: 'page1',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user1' },
              recipient: { id: 'page1' },
              timestamp: 1700000000000,
              postback: { title: 'Confirm', payload: 'confirm' },
            },
          ],
        },
      ],
    };

    // Step 3: Normalize back
    const normalized = adapter.buildNormalizedMessage(inboundPayload);
    expect(normalized.actionEvent).toBeDefined();
    expect(normalized.actionEvent!.actionId).toBe('confirm');
    expect(normalized.actionEvent!.value).toBe('confirm');
  });

  it('quick_reply roundtrip for >3 buttons', () => {
    const manyButtons: ActionSetIR = {
      elements: Array.from({ length: 5 }, (_, i) => ({
        id: `opt${i}`,
        type: 'button' as const,
        label: `Option ${i}`,
      })),
    };

    // Transform → quick replies
    const output = adapter.transformOutput('Pick:', manyButtons);
    expect(output.kind).toBe('messenger_template');
    if (output.kind !== 'messenger_template') return;

    const msg = output.message as any;
    expect(msg.quick_replies).toBeDefined();
    expect(msg.quick_replies[3].payload).toBe('opt3');

    // Simulate quick_reply
    const inboundPayload = {
      object: 'page',
      entry: [
        {
          id: 'page1',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user1' },
              recipient: { id: 'page1' },
              timestamp: 1700000000000,
              message: { mid: 'mid.1', text: 'Option 3', quick_reply: { payload: 'opt3' } },
            },
          ],
        },
      ],
    };

    const normalized = adapter.buildNormalizedMessage(inboundPayload);
    expect(normalized.actionEvent!.actionId).toBe('opt3');
  });
});

describe('WhatsApp template roundtrip: richContent → Template → button callback → ActionEvent', () => {
  const adapter = new WhatsAppAdapter();

  it('template with quick_reply button → button callback → ActionEvent', () => {
    // Step 1: Transform using richContent.whatsapp
    const richContent = {
      whatsapp: JSON.stringify({
        template_name: 'booking_confirm',
        language: 'en_US',
        parameters: {
          body: [{ type: 'text', text: 'Hotel ABC' }],
          buttons: [
            {
              type: 'quick_reply',
              index: 0,
              parameters: [{ type: 'payload', payload: 'confirm' }],
            },
            { type: 'quick_reply', index: 1, parameters: [{ type: 'payload', payload: 'cancel' }] },
          ],
        },
      }),
    };

    const output = adapter.transformOutput('Booking confirmed', undefined, richContent);
    expect(output.kind).toBe('whatsapp_template');
    if (output.kind !== 'whatsapp_template') return;
    expect(output.template.name).toBe('booking_confirm');

    // Step 2: Simulate user tapping quick_reply → WhatsApp sends type: 'button'
    const inboundPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry1',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+1234', phone_number_id: 'phone1' },
                messages: [
                  {
                    id: 'msg1',
                    from: '5551234',
                    timestamp: '1700000000',
                    type: 'button',
                    button: { text: 'Confirm', payload: 'confirm' },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    // Step 3: Normalize back to ActionEvent
    const msg = adapter.buildNormalizedMessage(inboundPayload);
    expect(msg.actionEvent).toBeDefined();
    expect(msg.actionEvent!.actionId).toBe('confirm');
    expect(msg.actionEvent!.value).toBe('confirm');
    expect(msg.actionEvent!.source).toBe('whatsapp');
    expect(msg.metadata?.whatsappInteractionType).toBe('template_quick_reply');
  });
});

describe('Cross-channel action normalization consistency', () => {
  it('all adapters produce consistent ActionEvent shape', () => {
    const slackAdapter = new SlackAdapter();
    const teamsAdapter = new MSTeamsAdapter();
    const whatsappAdapter = new WhatsAppAdapter();
    const messengerAdapter = new MessengerAdapter();

    // Slack block_actions
    const slackMsg = slackAdapter.buildNormalizedMessage({
      type: 'block_actions',
      trigger_id: 'tr1',
      user: { id: 'U1', team_id: 'T1', name: 'u' },
      team: { id: 'T1' },
      actions: [{ type: 'button', action_id: 'action1', block_id: 'b1', value: 'val1' }],
    });

    // Teams invoke
    const teamsMsg = teamsAdapter.buildNormalizedMessage({
      type: 'invoke',
      id: 'act1',
      name: 'adaptiveCard/action',
      from: { id: 'user1', name: 'User' },
      recipient: { id: 'bot1', name: 'Bot' },
      channelData: { tenant: { id: 't1' } },
      conversation: { id: 'conv1' },
      serviceUrl: 'https://smba.trafficmanager.net/teams/',
      value: { action: { type: 'Action.Execute', data: { _actionId: 'action1', _value: 'val1' } } },
    });

    // WhatsApp button_reply
    const whatsappMsg = whatsappAdapter.buildNormalizedMessage({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'e1',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+1', phone_number_id: 'p1' },
                messages: [
                  {
                    id: 'm1',
                    from: '5551234',
                    timestamp: '1700000000',
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: { id: 'action1', title: 'Action 1' },
                    },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    });

    // Messenger postback
    const messengerMsg = messengerAdapter.buildNormalizedMessage({
      object: 'page',
      entry: [
        {
          id: 'p1',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'u1' },
              recipient: { id: 'p1' },
              timestamp: 1700000000000,
              postback: { title: 'Action 1', payload: 'action1' },
            },
          ],
        },
      ],
    });

    // All should have consistent ActionEvent shape
    for (const msg of [slackMsg, teamsMsg, whatsappMsg, messengerMsg]) {
      expect(msg.actionEvent).toBeDefined();
      expect(msg.actionEvent!.type).toBe('action_event');
      expect(msg.actionEvent!.actionId).toBe('action1');
      expect(msg.text).toBe('');
    }

    // Source should be channel-specific
    expect(slackMsg.actionEvent!.source).toBe('slack');
    expect(teamsMsg.actionEvent!.source).toBe('teams');
    expect(whatsappMsg.actionEvent!.source).toBe('whatsapp');
    expect(messengerMsg.actionEvent!.source).toBe('messenger');
  });
});
