import { describe, expect, test } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';

const SIMPLE_AGENT = `
AGENT: Simple_Agent

GOAL: "Handle simple requests"

PERSONA: "Simple handler"
`;

describe('RuntimeExecutor getSessionDetail metadata', () => {
  test('preserves assistant metadata from in-memory conversation history', () => {
    const executor = new RuntimeExecutor();
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SIMPLE_AGENT], 'Simple_Agent'),
    );
    const responseMetadata = {
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1 as const,
        kind: 'llm' as const,
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    };

    session.conversationHistory.push({ role: 'user', content: 'Hello there' });
    session.conversationHistory.push({
      role: 'assistant',
      content: 'AI answer',
      metadata: responseMetadata,
    } as (typeof session.conversationHistory)[number]);

    const detail = executor.getSessionDetail(session.id);

    expect(detail).not.toBeNull();
    expect(detail!.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'Hello there',
      }),
      expect.objectContaining({
        role: 'assistant',
        content: 'AI answer',
        metadata: responseMetadata,
      }),
    ]);
  });

  test('preserves assistant metadata added through RuntimeExecutor.addMessage', () => {
    const executor = new RuntimeExecutor();
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SIMPLE_AGENT], 'Simple_Agent'),
    );
    const responseMetadata = {
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1 as const,
        kind: 'llm' as const,
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    };

    executor.addMessage(session.id, 'user', 'Hello there');
    executor.addMessage(session.id, 'assistant', 'AI answer', responseMetadata);

    const detail = executor.getSessionDetail(session.id);

    expect(detail).not.toBeNull();
    expect(detail!.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'Hello there',
      }),
      expect.objectContaining({
        role: 'assistant',
        content: 'AI answer',
        metadata: responseMetadata,
      }),
    ]);
  });

  test('preserves envelope-only assistant turns from in-memory conversation history', () => {
    const executor = new RuntimeExecutor();
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SIMPLE_AGENT], 'Simple_Agent'),
    );
    const responseMetadata = {
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1 as const,
        kind: 'llm' as const,
        disclaimerRequired: true,
        usedLlmInternally: false,
      },
    };
    const contentEnvelope = {
      version: 2 as const,
      format: 'message_envelope' as const,
      text: '',
      richContent: {
        markdown: '**Pick an option**',
      },
      actions: {
        elements: [{ id: 'pick-option', type: 'button' as const, label: 'Pick option' }],
      },
      voiceConfig: {
        plain_text: 'Pick an option',
      },
    };

    session.conversationHistory.push({ role: 'user', content: 'Show me options' });
    session.conversationHistory.push({
      role: 'assistant',
      content: '',
      metadata: responseMetadata,
      contentEnvelope,
    } as (typeof session.conversationHistory)[number]);

    const detail = executor.getSessionDetail(session.id);

    expect(detail).not.toBeNull();
    expect(detail!.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'Show me options',
      }),
      expect.objectContaining({
        role: 'assistant',
        content: '',
        metadata: responseMetadata,
        contentEnvelope,
      }),
    ]);
  });
});
