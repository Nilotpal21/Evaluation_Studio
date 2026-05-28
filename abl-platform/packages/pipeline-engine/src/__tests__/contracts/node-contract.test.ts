import { describe, it, expect } from 'vitest';
import { isValidNodeContract, type NodeContract } from '../../pipeline/contracts/node-contract.js';
import { NODE_ENRICHMENT } from '../../pipeline/contracts/node-contract-data.js';
import { ACTIVITY_TYPES } from '../../pipeline/activity-metadata.js';

describe('NodeContract', () => {
  const valid: NodeContract = {
    type: 'read-conversation',
    category: 'data',
    label: 'Read Conversation',
    description: 'x',
    inputRequirements: { fromTrigger: ['sessionId'] },
    configSchema: { required: [], properties: {} },
    outputSchema: { properties: { transcript: { type: 'string' } } },
    compatibleTriggers: ['session-ended'],
    sideEffectClass: 'read',
    contractVersion: 1,
  };

  it('accepts a well-formed contract', () => {
    expect(isValidNodeContract(valid)).toBe(true);
  });

  it("accepts '*' as compatibleTriggers", () => {
    expect(isValidNodeContract({ ...valid, compatibleTriggers: '*' })).toBe(true);
  });

  it('rejects an unknown sideEffectClass', () => {
    expect(
      isValidNodeContract({
        ...valid,
        sideEffectClass: 'magic' as unknown as NodeContract['sideEffectClass'],
      }),
    ).toBe(false);
  });

  it('rejects contractVersion < 1', () => {
    expect(isValidNodeContract({ ...valid, contractVersion: 0 })).toBe(false);
  });
});

describe('NODE_ENRICHMENT coverage', () => {
  it('has an entry for every node in activityMetadata', () => {
    const metaKeys = Object.keys(ACTIVITY_TYPES).sort();
    const enrichmentKeys = Object.keys(NODE_ENRICHMENT).sort();
    expect(enrichmentKeys).toEqual(metaKeys);
  });

  it('read-message-window requires payload from trigger', () => {
    expect(NODE_ENRICHMENT['read-message-window'].inputRequirements.fromTrigger).toContain(
      'payload',
    );
  });

  it('read-message-window is only compatible with message-level triggers', () => {
    expect(NODE_ENRICHMENT['read-message-window'].compatibleTriggers).toEqual([
      'user-message',
      'agent-message',
    ]);
  });

  it('store-results has write side-effect class', () => {
    expect(NODE_ENRICHMENT['store-results'].sideEffectClass).toBe('write');
  });

  it('http-request has external side-effect class', () => {
    expect(NODE_ENRICHMENT['http-request'].sideEffectClass).toBe('external');
  });

  it('every enrichment entry has contractVersion >= 1', () => {
    for (const key of Object.keys(NODE_ENRICHMENT)) {
      expect(NODE_ENRICHMENT[key].contractVersion).toBeGreaterThanOrEqual(1);
    }
  });
});
