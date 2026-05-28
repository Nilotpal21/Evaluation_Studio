/**
 * MS Teams Adaptive Card Transform Tests
 *
 * Tests that MSTeamsAdapter.transformOutput() correctly converts
 * ActionSetIR into Adaptive Card 1.4 JSON.
 */

import { describe, it, expect } from 'vitest';
import { MSTeamsAdapter } from '../../../channels/adapters/msteams-adapter.js';
import type { ActionSetIR, RichContentIR } from '@abl/compiler';

describe('MSTeamsAdapter.transformOutput', () => {
  const adapter = new MSTeamsAdapter();

  it('returns text-only when no actions', () => {
    const result = adapter.transformOutput('Hello Teams');
    expect(result).toEqual({ kind: 'text', text: 'Hello Teams' });
  });

  it('returns text-only when actions is empty', () => {
    const result = adapter.transformOutput('Hi', { elements: [] });
    expect(result).toEqual({ kind: 'text', text: 'Hi' });
  });

  it('transforms markdown richContent without actions into an Adaptive Card', () => {
    const richContent: RichContentIR = { markdown: '**Choose a payment card**' };

    const result = adapter.transformOutput('', undefined, richContent);

    expect(result.kind).toBe('adaptive_card');
    if (result.kind !== 'adaptive_card') return;
    const card = result.card as { body?: Array<{ type?: string; text?: string; wrap?: boolean }> };
    expect(result.text).toBe('**Choose a payment card**');
    expect(card.body?.[0]).toEqual({
      type: 'TextBlock',
      text: '**Choose a payment card**',
      wrap: true,
    });
  });

  it('passes native Adaptive Card richContent through additively', () => {
    const nativeCard = {
      type: 'AdaptiveCard',
      version: '1.4',
      body: [{ type: 'TextBlock', text: 'Native card', wrap: true }],
    };
    const richContent: RichContentIR = { adaptive_card: JSON.stringify(nativeCard) };

    const result = adapter.transformOutput('', undefined, richContent);

    expect(result).toEqual({
      kind: 'adaptive_card',
      card: nativeCard,
      text: '',
    });
  });

  it('transforms buttons into Action.Execute', () => {
    const actions: ActionSetIR = {
      elements: [
        { id: 'yes', type: 'button', label: 'Yes', value: 'confirm' },
        { id: 'no', type: 'button', label: 'No', value: 'deny' },
      ],
    };

    const result = adapter.transformOutput('Confirm?', actions);
    expect(result.kind).toBe('adaptive_card');
    if (result.kind !== 'adaptive_card') return;

    const card = result.card as any;
    expect(card.type).toBe('AdaptiveCard');
    expect(card.version).toBe('1.4');

    // Text block
    expect(card.body[0].type).toBe('TextBlock');
    expect(card.body[0].text).toBe('Confirm?');
    expect(card.body[0].wrap).toBe(true);

    // Actions
    expect(card.actions).toHaveLength(2);
    expect(card.actions[0].type).toBe('Action.Execute');
    expect(card.actions[0].title).toBe('Yes');
    expect(card.actions[0].data._actionId).toBe('yes');
    expect(card.actions[0].data._value).toBe('confirm');
  });

  it('embeds render correlation ids in Action.Execute data', () => {
    const actions: ActionSetIR = {
      elements: [{ id: 'yes', type: 'button', label: 'Yes', value: 'confirm' }],
      renderId: 'action-render-teams-1',
    };

    const result = adapter.transformOutput('Confirm?', actions);
    expect(result.kind).toBe('adaptive_card');
    if (result.kind !== 'adaptive_card') return;

    const card = result.card as any;
    expect(card.actions[0].data).toMatchObject({
      _actionId: 'yes',
      _value: 'confirm',
      _renderId: 'action-render-teams-1',
    });
  });

  it('restores render correlation ids from inbound Action.Execute data', () => {
    const message = adapter.buildNormalizedMessage({
      type: 'invoke',
      id: 'activity-1',
      timestamp: '2026-05-02T00:00:00.000Z',
      serviceUrl: 'https://service.example',
      conversation: { id: 'conv-1', tenantId: 'tenant-1' },
      from: { id: 'user-1', name: 'User One' },
      recipient: { id: 'bot-1', name: 'Bot' },
      value: {
        action: {
          type: 'Action.Execute',
          data: {
            _actionId: 'yes',
            _value: 'confirm',
            _renderId: 'action-render-teams-1',
            comment: 'looks good',
          },
        },
      },
    } as any);

    expect(message.actionEvent).toMatchObject({
      actionId: 'yes',
      value: 'confirm',
      renderId: 'action-render-teams-1',
      formData: { comment: 'looks good' },
      source: 'teams',
    });
  });

  it('transforms select into Input.ChoiceSet', () => {
    const actions: ActionSetIR = {
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

    const result = adapter.transformOutput('Set priority:', actions);
    expect(result.kind).toBe('adaptive_card');
    if (result.kind !== 'adaptive_card') return;

    const card = result.card as any;
    const choiceSet = card.body.find((b: any) => b.type === 'Input.ChoiceSet');
    expect(choiceSet).toBeDefined();
    expect(choiceSet.id).toBe('priority');
    expect(choiceSet.choices).toHaveLength(3);
    expect(choiceSet.choices[0].title).toBe('High');
    expect(choiceSet.choices[0].value).toBe('high');
  });

  it('transforms input into Input.Text', () => {
    const actions: ActionSetIR = {
      elements: [
        {
          id: 'comment',
          type: 'input',
          label: 'Add comment',
          placeholder: 'Type here...',
          required: true,
        },
      ],
    };

    const result = adapter.transformOutput('', actions);
    expect(result.kind).toBe('adaptive_card');
    if (result.kind !== 'adaptive_card') return;

    const card = result.card as any;
    const input = card.body.find((b: any) => b.type === 'Input.Text');
    expect(input).toBeDefined();
    expect(input.id).toBe('comment');
    expect(input.label).toBe('Add comment');
    expect(input.placeholder).toBe('Type here...');
    expect(input.isRequired).toBe(true);
  });

  it('adds submit action when submit_label and submit_id set', () => {
    const actions: ActionSetIR = {
      elements: [{ id: 'name', type: 'input', label: 'Name' }],
      submit_label: 'Submit',
      submit_id: 'form_submit',
    };

    const result = adapter.transformOutput('Form:', actions);
    expect(result.kind).toBe('adaptive_card');
    if (result.kind !== 'adaptive_card') return;

    const card = result.card as any;
    const submitAction = card.actions?.find((a: any) => a.data?._actionId === 'form_submit');
    expect(submitAction).toBeDefined();
    expect(submitAction.title).toBe('Submit');
  });

  it('handles mixed element types', () => {
    const actions: ActionSetIR = {
      elements: [
        { id: 'name', type: 'input', label: 'Name', required: true },
        {
          id: 'dept',
          type: 'select',
          label: 'Department',
          options: [
            { id: 'eng', label: 'Engineering' },
            { id: 'sales', label: 'Sales' },
          ],
        },
        { id: 'approve', type: 'button', label: 'Approve' },
      ],
      submit_label: 'Save',
      submit_id: 'save_form',
    };

    const result = adapter.transformOutput('Employee form:', actions);
    expect(result.kind).toBe('adaptive_card');
    if (result.kind !== 'adaptive_card') return;

    const card = result.card as any;
    // TextBlock + Input.Text + Input.ChoiceSet
    expect(card.body.some((b: any) => b.type === 'TextBlock')).toBe(true);
    expect(card.body.some((b: any) => b.type === 'Input.Text')).toBe(true);
    expect(card.body.some((b: any) => b.type === 'Input.ChoiceSet')).toBe(true);
    // Button + Submit
    expect(card.actions.some((a: any) => a.data._actionId === 'approve')).toBe(true);
    expect(card.actions.some((a: any) => a.data._actionId === 'save_form')).toBe(true);
  });
});
