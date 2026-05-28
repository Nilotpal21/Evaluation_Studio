/**
 * Slack Block Kit Transform Tests
 *
 * Tests that SlackAdapter.transformOutput() correctly converts
 * ActionSetIR into Slack Block Kit JSON.
 */

import { describe, it, expect } from 'vitest';
import { SlackAdapter } from '../../../channels/adapters/slack-adapter.js';
import type { ActionSetIR, RichContentIR } from '@abl/compiler';

describe('SlackAdapter.transformOutput', () => {
  const adapter = new SlackAdapter();

  it('returns text-only when no actions', () => {
    const result = adapter.transformOutput('Hello world');
    expect(result).toEqual({ kind: 'text', text: 'Hello world' });
  });

  it('returns text-only when actions is empty', () => {
    const actions: ActionSetIR = { elements: [] };
    const result = adapter.transformOutput('Hello', actions);
    expect(result).toEqual({ kind: 'text', text: 'Hello' });
  });

  it('transforms markdown richContent without actions into Slack blocks', () => {
    const richContent: RichContentIR = { markdown: '**Choose a payment card**' };

    const result = adapter.transformOutput('', undefined, richContent);

    expect(result.kind).toBe('slack_blocks');
    if (result.kind !== 'slack_blocks') return;
    expect(result.text).toBe('**Choose a payment card**');
    expect(result.blocks).toEqual([
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '**Choose a payment card**' },
      },
    ]);
  });

  it('passes native Slack richContent blocks through without changing text-only callers', () => {
    const richContent: RichContentIR = {
      slack: JSON.stringify({
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '*Native block*' },
          },
        ],
      }),
    };

    const result = adapter.transformOutput('Native block', undefined, richContent);

    expect(result.kind).toBe('slack_blocks');
    if (result.kind !== 'slack_blocks') return;
    expect(result.text).toBe('Native block');
    expect(result.blocks).toEqual([
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Native block*' },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'Native block' },
      },
    ]);
  });

  it('transforms buttons into actions block', () => {
    const actions: ActionSetIR = {
      elements: [
        { id: 'btn1', type: 'button', label: 'Option A', value: 'a' },
        { id: 'btn2', type: 'button', label: 'Option B', value: 'b' },
      ],
    };

    const result = adapter.transformOutput('Pick one:', actions);
    expect(result.kind).toBe('slack_blocks');
    if (result.kind !== 'slack_blocks') return;

    // Should have a text section + actions block
    expect(result.blocks.length).toBe(2);
    expect((result.blocks[0] as any).type).toBe('section');
    expect((result.blocks[0] as any).text.text).toBe('Pick one:');
    expect((result.blocks[1] as any).type).toBe('actions');
    expect((result.blocks[1] as any).elements).toHaveLength(2);
    expect((result.blocks[1] as any).elements[0].action_id).toBe('btn1');
    expect((result.blocks[1] as any).elements[0].value).toBe('a');
    expect((result.blocks[1] as any).elements[1].action_id).toBe('btn2');
  });

  it('embeds render correlation ids in interactive action blocks', () => {
    const actions: ActionSetIR = {
      elements: [{ id: 'btn1', type: 'button', label: 'Option A', value: 'a' }],
      renderId: 'action-render-slack-1',
    };

    const result = adapter.transformOutput('Pick one:', actions);
    expect(result.kind).toBe('slack_blocks');
    if (result.kind !== 'slack_blocks') return;

    const actionsBlock = result.blocks.find((b: any) => b.type === 'actions') as any;
    expect(actionsBlock.block_id).toBe('action-render:action-render-slack-1');
    expect(actionsBlock.elements[0].value).toBe('a');
  });

  it('restores render correlation ids from inbound block actions', () => {
    const message = adapter.buildNormalizedMessage({
      type: 'block_actions',
      trigger_id: 'trigger-1',
      team: { id: 'T1' },
      channel: { id: 'C1' },
      user: { id: 'U1' },
      actions: [
        {
          action_id: 'btn1',
          block_id: 'action-render:action-render-slack-1',
          value: 'a',
        },
      ],
    });

    expect(message.actionEvent).toMatchObject({
      actionId: 'btn1',
      value: 'a',
      renderId: 'action-render-slack-1',
      source: 'slack',
    });
  });

  it('chunks buttons into groups of 5 (Slack limit)', () => {
    const actions: ActionSetIR = {
      elements: Array.from({ length: 7 }, (_, i) => ({
        id: `btn${i}`,
        type: 'button' as const,
        label: `Button ${i}`,
      })),
    };

    const result = adapter.transformOutput('Many buttons:', actions);
    expect(result.kind).toBe('slack_blocks');
    if (result.kind !== 'slack_blocks') return;

    // text section + 2 action blocks (5 + 2)
    const actionBlocks = result.blocks.filter((b: any) => b.type === 'actions');
    expect(actionBlocks.length).toBe(2);
    expect((actionBlocks[0] as any).elements).toHaveLength(5);
    expect((actionBlocks[1] as any).elements).toHaveLength(2);
  });

  it('transforms select into static_select', () => {
    const actions: ActionSetIR = {
      elements: [
        {
          id: 'color_select',
          type: 'select',
          label: 'Pick a color',
          options: [
            { id: 'red', label: 'Red' },
            { id: 'blue', label: 'Blue' },
            { id: 'green', label: 'Green' },
          ],
        },
      ],
    };

    const result = adapter.transformOutput('Choose:', actions);
    expect(result.kind).toBe('slack_blocks');
    if (result.kind !== 'slack_blocks') return;

    const actionsBlock = result.blocks.find((b: any) => b.type === 'actions') as any;
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock.elements[0].type).toBe('static_select');
    expect(actionsBlock.elements[0].action_id).toBe('color_select');
    expect(actionsBlock.elements[0].options).toHaveLength(3);
    expect(actionsBlock.elements[0].options[0].value).toBe('red');
  });

  it('transforms input into input block', () => {
    const actions: ActionSetIR = {
      elements: [
        {
          id: 'name_input',
          type: 'input',
          label: 'Your name',
          placeholder: 'Enter your name',
          required: true,
        },
      ],
    };

    const result = adapter.transformOutput('', actions);
    expect(result.kind).toBe('slack_blocks');
    if (result.kind !== 'slack_blocks') return;

    const inputBlock = result.blocks.find((b: any) => b.type === 'input') as any;
    expect(inputBlock).toBeDefined();
    expect(inputBlock.label.text).toBe('Your name');
    expect(inputBlock.element.type).toBe('plain_text_input');
    expect(inputBlock.element.action_id).toBe('name_input');
    expect(inputBlock.optional).toBe(false);
  });

  it('adds primary submit button when submit_label and submit_id set', () => {
    const actions: ActionSetIR = {
      elements: [{ id: 'name', type: 'input', label: 'Name' }],
      submit_label: 'Submit Form',
      submit_id: 'form_submit',
    };

    const result = adapter.transformOutput('Fill this form:', actions);
    expect(result.kind).toBe('slack_blocks');
    if (result.kind !== 'slack_blocks') return;

    const lastBlock = result.blocks[result.blocks.length - 1] as any;
    expect(lastBlock.type).toBe('actions');
    expect(lastBlock.elements[0].action_id).toBe('form_submit');
    expect(lastBlock.elements[0].style).toBe('primary');
    expect(lastBlock.elements[0].text.text).toBe('Submit Form');
  });

  it('truncates text to 3000 chars (Slack mrkdwn limit)', () => {
    const longText = 'x'.repeat(4000);
    const actions: ActionSetIR = {
      elements: [{ id: 'btn', type: 'button', label: 'OK' }],
    };

    const result = adapter.transformOutput(longText, actions);
    expect(result.kind).toBe('slack_blocks');
    if (result.kind !== 'slack_blocks') return;

    const section = result.blocks[0] as any;
    expect(section.text.text).toHaveLength(3000);
  });

  it('truncates button labels to 75 chars', () => {
    const actions: ActionSetIR = {
      elements: [
        {
          id: 'btn',
          type: 'button',
          label: 'A'.repeat(100),
        },
      ],
    };

    const result = adapter.transformOutput('', actions);
    expect(result.kind).toBe('slack_blocks');
    if (result.kind !== 'slack_blocks') return;

    const actionsBlock = result.blocks.find((b: any) => b.type === 'actions') as any;
    expect(actionsBlock.elements[0].text.text).toHaveLength(75);
  });
});
