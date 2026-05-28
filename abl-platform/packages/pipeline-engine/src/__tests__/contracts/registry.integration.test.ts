import { describe, it, expect } from 'vitest';
import { ContractRegistry } from '../../pipeline/contracts/registry.js';
import { isValidTriggerContract } from '../../pipeline/contracts/trigger-contract.js';
import { isValidNodeContract } from '../../pipeline/contracts/node-contract.js';
import { ACTIVITY_TYPES } from '../../pipeline/activity-metadata.js';

describe('ContractRegistry — end-to-end coverage', () => {
  const registry = new ContractRegistry();

  it('produces a valid TriggerContract for every entry in trigger-definitions.json', () => {
    const triggers = registry.listTriggers();
    expect(triggers.length).toBeGreaterThan(0);
    for (const t of triggers) {
      expect(isValidTriggerContract(t), `${t.id} is not a valid TriggerContract`).toBe(true);
    }
  });

  it('produces a valid NodeContract for every entry in ACTIVITY_TYPES', () => {
    const nodes = registry.listNodes();
    const metaKeys = Object.keys(ACTIVITY_TYPES).sort();
    const nodeTypes = nodes.map((n) => n.type).sort();
    expect(nodeTypes, 'NodeContract coverage must equal ACTIVITY_TYPES keys').toEqual(metaKeys);
    for (const n of nodes) {
      expect(isValidNodeContract(n), `${n.type} is not a valid NodeContract`).toBe(true);
    }
  });

  it('exposes exactly four destinations', () => {
    const ids = registry
      .listDestinations()
      .map((d) => d.id)
      .sort();
    expect(ids).toEqual(['callback', 'clickhouse', 'mongodb', 'none']);
  });

  it('every node that writes has sideEffectClass=write', () => {
    const write = ['store-results', 'store-insight'];
    for (const type of write) {
      const node = registry.getNode(type);
      expect(node, `${type} missing`).toBeDefined();
      expect(node!.sideEffectClass, type).toBe('write');
    }
  });

  it('every node that calls an external service has sideEffectClass=external', () => {
    const external = [
      'llm-evaluate',
      'conversation-analyzer',
      'http-request',
      'send-notification',
      'send-email',
      'send-slack',
      'publish-kafka',
      'run-legacy-workflow',
      'sub-pipeline',
      'simulate-persona',
      'execute-agent-turn',
      'run-eval-conversation',
      'judge-conversation',
    ];
    for (const type of external) {
      const node = registry.getNode(type);
      expect(node, `${type} missing`).toBeDefined();
      expect(node!.sideEffectClass, type).toBe('external');
    }
  });

  it('read-message-window is gated to message-level triggers only', () => {
    const rmw = registry.getNode('read-message-window')!;
    expect(rmw.compatibleTriggers).toEqual(['user-message', 'agent-message']);
    expect(rmw.inputRequirements.fromTrigger).toContain('payload');
  });

  it('ClickHouse destination table regex matches abl_platform.<table> patterns', () => {
    const ch = registry.getDestination('clickhouse')!;
    expect(ch.table.regex!.test('abl_platform.conversation_sentiment')).toBe(true);
    expect(ch.table.regex!.test('foo_db.bar_table')).toBe(true);
    expect(ch.table.regex!.test('test_custom_politeness')).toBe(false);
  });
});
