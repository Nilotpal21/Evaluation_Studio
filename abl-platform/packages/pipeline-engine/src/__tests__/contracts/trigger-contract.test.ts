import { describe, it, expect } from 'vitest';
import {
  isValidTriggerContract,
  type TriggerContract,
} from '../../pipeline/contracts/trigger-contract.js';

describe('TriggerContract', () => {
  const valid: TriggerContract = {
    id: 'session-ended',
    type: 'kafka',
    kafkaTopic: 'abl.session.ended',
    category: 'session',
    label: 'Session Ended',
    description: 'x',
    outputSchema: {
      required: ['tenantId', 'sessionId'],
      properties: {
        tenantId: { type: 'string' },
        sessionId: { type: 'string' },
      },
    },
    exampleOutput: { tenantId: 't1', sessionId: 's1' },
  };

  it('accepts a well-formed contract', () => {
    expect(isValidTriggerContract(valid)).toBe(true);
  });

  it('rejects a contract missing exampleOutput', () => {
    const { exampleOutput: _omit, ...missing } = valid;
    expect(isValidTriggerContract(missing)).toBe(false);
  });

  it('rejects a contract with an unknown type', () => {
    expect(
      isValidTriggerContract({ ...valid, type: 'http' as unknown as TriggerContract['type'] }),
    ).toBe(false);
  });

  it('rejects a contract whose outputSchema.required is not an array', () => {
    expect(
      isValidTriggerContract({
        ...valid,
        outputSchema: { required: 'tenantId' as unknown as string[], properties: {} },
      }),
    ).toBe(false);
  });
});
