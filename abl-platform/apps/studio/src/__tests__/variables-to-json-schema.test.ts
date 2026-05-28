import { describe, expect, it } from 'vitest';
import { deriveWorkflowOutputSchema } from '../lib/variables-to-json-schema';

describe('deriveWorkflowOutputSchema', () => {
  it('merges declared output fields from every end node', () => {
    const nodes = [
      {
        id: 'end-1',
        nodeType: 'end',
        config: {
          outputMapping: {
            customer: {
              expression: '{{context.steps.FetchCustomer.output.body}}',
              type: 'json',
              description: 'Customer payload',
            },
          },
        },
      },
      {
        id: 'end-2',
        nodeType: 'end',
        config: {
          outputMapping: {
            orderId: {
              expression: '{{context.steps.FetchOrder.output.body.id}}',
              type: 'string',
            },
          },
        },
      },
    ];

    expect(deriveWorkflowOutputSchema(nodes as never)).toEqual({
      type: 'object',
      properties: {
        customer: { description: 'Customer payload' },
        orderId: { type: 'string' },
      },
    });
  });
});
