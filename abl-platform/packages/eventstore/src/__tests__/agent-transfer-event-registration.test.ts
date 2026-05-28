import { describe, expect, it } from 'vitest';
import { eventRegistry } from '../schema/index.js';
import {
  AgentTransferInitiatedDataSchema,
  AgentTransferAcwCompletedDataSchema,
  AgentTransferFailedDataSchema,
} from '../schema/events/agent-events.js';

describe('agent.transfer event registration', () => {
  it('registers all 7 agent.transfer lifecycle events', () => {
    const expected = [
      'agent.transfer.initiated',
      'agent.transfer.agent_connected',
      'agent.transfer.completed',
      'agent.transfer.failed',
      'agent.transfer.agent_disconnected',
      'agent.transfer.csat_completed',
      'agent.transfer.acw_completed',
    ];
    for (const type of expected) {
      expect(eventRegistry.has(type), `missing: ${type}`).toBe(true);
    }
  });

  it('validates agent.transfer.initiated data', () => {
    const result = AgentTransferInitiatedDataSchema.safeParse({
      provider: 'smartassist',
      channel: 'chat',
      runtimeSessionId: 'sess-1',
    });
    expect(result.success).toBe(true);
  });

  it('validates agent.transfer.acw_completed data with dispositionCode and reason', () => {
    const result = AgentTransferAcwCompletedDataSchema.safeParse({
      acwCloseReason: 'agent_closed',
      acwTimedOut: false,
      dispositionCode: 'resolved',
      reason: 'Customer issue was resolved.',
      provider: 'smartassist',
      channel: 'chat',
      transferSessionId: 'agent_transfer:t-1:s-1:chat',
      runtimeSessionId: 'sess-1',
    });
    expect(result.success).toBe(true);
  });

  it('validates agent.transfer.failed data', () => {
    const result = AgentTransferFailedDataSchema.safeParse({
      errorCode: 'NO_AGENTS_AVAILABLE',
      errorMessage: 'No agents available',
      provider: 'smartassist',
      runtimeSessionId: 'sess-1',
    });
    expect(result.success).toBe(true);
  });

  it('marks all agent.transfer events as PII-bearing for lifecycle cleanup', () => {
    const transferEvents = [
      'agent.transfer.initiated',
      'agent.transfer.agent_connected',
      'agent.transfer.completed',
      'agent.transfer.failed',
      'agent.transfer.agent_disconnected',
      'agent.transfer.csat_completed',
      'agent.transfer.acw_completed',
    ];
    for (const type of transferEvents) {
      const meta = eventRegistry.getMetadata(type);
      expect(meta, `${type} should be registered`).toBeDefined();
      expect(meta!.containsPII, `${type} should contain PII`).toBe(true);
    }
  });
});
