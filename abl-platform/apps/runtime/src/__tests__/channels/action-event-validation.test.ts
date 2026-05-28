import { describe, expect, it } from 'vitest';
import {
  normalizeActionEvent,
  validateActionSubmitEnvelope,
} from '../../services/channels/action-event-validation';

describe('channel action-event validation', () => {
  it('accepts canonical formData envelopes', () => {
    const result = validateActionSubmitEnvelope({
      actionId: 'approve',
      value: 'yes',
      renderId: 'action-render-1',
      formData: { ticketId: 'T-123', approved: true },
      formDataPresent: true,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        actionId: 'approve',
        value: 'yes',
        renderId: 'action-render-1',
        formData: { ticketId: 'T-123', approved: true },
      },
    });
  });

  it('rejects malformed formData before it can become _action.formData', () => {
    expect(
      validateActionSubmitEnvelope({
        actionId: 'approve',
        formData: ['not', 'an', 'object'],
        formDataPresent: true,
      }),
    ).toMatchObject({
      ok: false,
      message: 'Invalid formData in action_submit',
    });
  });

  it('rejects unsafe formData keys from channel adapters', () => {
    expect(
      validateActionSubmitEnvelope({
        actionId: 'approve',
        formData: { constructor: 'polluted' },
        formDataPresent: true,
      }),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining('unsafe field key'),
    });
  });

  it('builds a canonical ActionEvent for channel adapters', () => {
    expect(
      normalizeActionEvent({
        actionId: 'approve',
        value: 'yes',
        renderId: 'render-1',
        formData: { comment: 'looks good' },
        formDataPresent: true,
        source: 'slack',
      }),
    ).toEqual({
      ok: true,
      value: {
        type: 'action_event',
        actionId: 'approve',
        value: 'yes',
        renderId: 'render-1',
        formData: { comment: 'looks good' },
        source: 'slack',
      },
    });
  });

  it('rejects invalid ActionEvents before channel messages enter execution', () => {
    expect(
      normalizeActionEvent({
        actionId: 'approve',
        formData: { constructor: 'polluted' },
        formDataPresent: true,
        source: 'teams',
      }),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining('unsafe field key'),
    });
  });
});
