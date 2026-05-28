import { describe, expect, it } from 'vitest';
import { transformAI4WOutput } from '../../channels/adapters/ai4w-content-transformer.js';

describe('AI4W capability contract', () => {
  it('flattens rich content and actions into markdown text without structured sideband fields', () => {
    const output = transformAI4WOutput(
      'Choose an option:',
      {
        elements: [{ id: 'approve', type: 'button' as const, label: 'Approve', value: 'approve' }],
        submit_id: 'approval-submit',
      },
      {
        markdown: '**Approval required**',
      },
    );

    expect(output).toEqual({
      kind: 'text',
      text: expect.stringContaining('Choose an option:'),
    });
    expect(output).not.toHaveProperty('richContent');
    expect(output).not.toHaveProperty('actions');
    expect(output.text).toContain('**Approval required**');
    expect(output.text).toContain('[Approve]');
  });
});
