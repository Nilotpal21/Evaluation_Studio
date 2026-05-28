import { describe, it, expect } from 'vitest';
import { ContractRegistry } from '../../pipeline/contracts/registry.js';

describe('ContractRegistry', () => {
  const registry = new ContractRegistry();

  it('hydrates triggers from seed-data/trigger-definitions.json', () => {
    const sessionEnded = registry.getTrigger('session-ended');
    expect(sessionEnded).toBeDefined();
    expect(sessionEnded!.id).toBe('session-ended');
    expect(sessionEnded!.type).toBe('kafka');
    expect(sessionEnded!.outputSchema.required).toContain('sessionId');
  });

  it('hydrates nodes by merging ACTIVITY_TYPES, node-type-definitions, and NODE_ENRICHMENT', () => {
    const readConv = registry.getNode('read-conversation');
    expect(readConv).toBeDefined();
    expect(readConv!.type).toBe('read-conversation');
    expect(readConv!.inputRequirements.fromTrigger).toContain('sessionId');
    expect(readConv!.sideEffectClass).toBe('read');
    expect(readConv!.contractVersion).toBe(1);
    // category comes from node-type-definitions.json:
    expect(readConv!.category).toBe('data');
    // label and description are preserved:
    expect(readConv!.label).toBeTruthy();
    expect(readConv!.description).toBeTruthy();
    // outputSchema comes from ACTIVITY_TYPES:
    expect(readConv!.outputSchema.properties).toBeDefined();
  });

  it('hydrates destinations from DESTINATION_REGISTRY', () => {
    const ch = registry.getDestination('clickhouse');
    expect(ch).toBeDefined();
    expect(ch!.previewable).toBe(true);

    const mongo = registry.getDestination('mongodb');
    expect(mongo!.previewable).toBe(false);
  });

  it('getDestination returns undefined for unknown IDs', () => {
    expect(registry.getDestination('postgres')).toBeUndefined();
    expect(registry.getDestination(undefined as unknown as string)).toBeUndefined();
  });

  it('listTriggers / listNodes / listDestinations return non-empty arrays', () => {
    expect(registry.listTriggers().length).toBeGreaterThan(0);
    expect(registry.listNodes().length).toBeGreaterThan(0);
    expect(registry.listDestinations().length).toBe(4);
  });

  it('every returned NodeContract passes isValidNodeContract', async () => {
    const { isValidNodeContract } = await import('../../pipeline/contracts/node-contract.js');
    for (const node of registry.listNodes()) {
      expect(isValidNodeContract(node), `${node.type} invalid`).toBe(true);
    }
  });
});

describe('contracts barrel', () => {
  it('re-exports the public types and registry', async () => {
    const mod = await import('../../pipeline/contracts/index.js');
    expect(mod.ContractRegistry).toBeDefined();
    expect(mod.DESTINATION_REGISTRY).toBeDefined();
    expect(mod.isDestinationId).toBeDefined();
    expect(mod.isValidTriggerContract).toBeDefined();
    expect(mod.isValidNodeContract).toBeDefined();
    expect(mod.NODE_ENRICHMENT).toBeDefined();
  });
});

describe('TriggerContract exampleOutput', () => {
  const registry = new ContractRegistry();

  it('session-ended has example payload with tenantId + sessionId', () => {
    const ex = registry.getTrigger('session-ended')!.exampleOutput;
    expect(ex.tenantId).toBeDefined();
    expect(ex.sessionId).toBeDefined();
  });

  it('user-message includes a nested payload with role, content, messageId', () => {
    const ex = registry.getTrigger('user-message')!.exampleOutput;
    expect(ex.payload).toMatchObject({
      role: 'user',
      content: expect.any(String),
      messageId: expect.any(String),
      messageIndex: expect.any(Number),
    });
  });

  it('agent-message includes a nested payload with role: assistant', () => {
    const ex = registry.getTrigger('agent-message')!.exampleOutput;
    expect((ex.payload as { role?: string }).role).toBe('assistant');
  });

  it('every trigger has a non-empty exampleOutput sourced from JSON (not synthesized)', async () => {
    const mod = await import('../../pipeline/seed-data/trigger-definitions.json', {
      with: { type: 'json' },
    });
    const defs = mod.default as Array<Record<string, unknown>>;
    for (const def of defs) {
      expect(def.exampleOutput, `${def.id} missing exampleOutput in JSON`).toBeDefined();
    }
  });
});
