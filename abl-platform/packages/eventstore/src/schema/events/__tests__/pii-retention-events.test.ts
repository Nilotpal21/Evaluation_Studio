import { describe, expect, it } from 'vitest';
import { eventRegistry } from '../../event-registry.js';
import '../index.js';

describe('PII retention event metadata', () => {
  it('marks runtime content-bearing platform events as PII', () => {
    const piiTypes = eventRegistry.getPIIEventTypes();

    for (const eventType of [
      'agent.handoff',
      'agent.escalated',
      'agent.escalation.triggered',
      'agent.escalation.resolved',
      'agent.delegated',
      'agent.delegate.completed',
      'agent.error.handled',
      'agent.decision',
      'agent.handoff.resume_intent',
      'agent.thread.returned',
      'attachment.uploaded',
      'attachment.scanned',
      'attachment.processed',
      'attachment.indexed',
      'attachment.deleted',
      'attachment.preprocessed',
      'channel.message.received',
      'channel.message.sent',
      'channel.response.sent',
      'evaluation.completed',
      'evaluation.failed',
      'evaluation.quality.scored',
      'gather.field.validated',
      'llm.call.completed',
      'llm.call.failed',
      'message.user.received',
      'message.agent.sent',
      'system.error',
      'tool.call.completed',
      'tool.call.failed',
      'tool.call.retried',
      'tool.error.handled',
    ]) {
      expect(piiTypes).toContain(eventType);
    }
  });
});
