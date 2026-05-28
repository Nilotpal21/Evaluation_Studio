import { describe, expect, test } from 'vitest';
import {
  applyResponseMetadataToLatestAssistantMessage,
  type ResponseMessageMetadata,
} from '../../services/execution/types.js';
import type { ConversationMessage } from '../../services/session/types.js';

function makeResponseMetadata(
  overrides: Partial<ResponseMessageMetadata['responseProvenance']> = {},
): ResponseMessageMetadata {
  return {
    isLlmGenerated: true,
    responseProvenance: {
      schemaVersion: 1,
      kind: 'llm',
      disclaimerRequired: true,
      usedLlmInternally: true,
      ...overrides,
    },
  };
}

describe('applyResponseMetadataToLatestAssistantMessage', () => {
  test('merges provenance into the latest exact assistant response match', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: 'Hi' },
      {
        role: 'assistant',
        content: 'Hello from the model',
        metadata: { toolName: 'knowledge_search' },
      },
    ];
    const responseMetadata = makeResponseMetadata();

    const applied = applyResponseMetadataToLatestAssistantMessage(
      history,
      'Hello from the model',
      responseMetadata,
    );

    expect(applied).toBe(true);
    expect(history[1]).toEqual({
      role: 'assistant',
      content: 'Hello from the model',
      metadata: {
        toolName: 'knowledge_search',
        ...responseMetadata,
      },
    });
  });

  test('matches decorated parent-thread assistant responses', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: '[Weather_Agent]: Forecast ready for tomorrow' },
    ];
    const responseMetadata = makeResponseMetadata({
      kind: 'mixed',
    });

    const applied = applyResponseMetadataToLatestAssistantMessage(
      history,
      'Forecast ready for tomorrow',
      responseMetadata,
    );

    expect(applied).toBe(true);
    expect(history[1]).toEqual({
      role: 'assistant',
      content: '[Weather_Agent]: Forecast ready for tomorrow',
      metadata: responseMetadata,
    });
  });

  test('does not rewrite unrelated trailing assistant messages', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'First response' },
      { role: 'assistant', content: 'Second response' },
    ];
    const responseMetadata = makeResponseMetadata();

    const applied = applyResponseMetadataToLatestAssistantMessage(
      history,
      'Different response',
      responseMetadata,
    );

    expect(applied).toBe(false);
    expect(history).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'First response' },
      { role: 'assistant', content: 'Second response' },
    ]);
  });

  test('matches PII-protected assistant history against redacted delivery text', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: 'Previous turn' },
      { role: 'assistant', content: 'Previous answer' },
      { role: 'user', content: 'Show me my contract' },
      {
        role: 'assistant',
        content: 'Contract {{PII:ContractID:token-123}}',
        metadata: { source: 'vault' },
      },
    ];
    const responseMetadata = makeResponseMetadata();

    const applied = applyResponseMetadataToLatestAssistantMessage(
      history,
      'Contract [REDACTED_CONTRACT_ID]',
      responseMetadata,
    );

    expect(applied).toBe(true);
    expect(history[3]).toEqual({
      role: 'assistant',
      content: 'Contract {{PII:ContractID:token-123}}',
      metadata: {
        source: 'vault',
        ...responseMetadata,
      },
    });
  });

  test('falls back to the latest assistant message in the current turn when response text is empty', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: 'Previous turn' },
      { role: 'assistant', content: 'Previous answer' },
      { role: 'user', content: 'Show me my account options' },
      {
        role: 'assistant',
        content: 'Choose from the cards below',
      },
    ];
    const responseMetadata = makeResponseMetadata({
      kind: 'mixed',
    });

    const applied = applyResponseMetadataToLatestAssistantMessage(history, '', responseMetadata);

    expect(applied).toBe(true);
    expect(history[3]).toEqual({
      role: 'assistant',
      content: 'Choose from the cards below',
      metadata: responseMetadata,
    });
  });

  test('attaches a structured content envelope to the matched assistant message', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: 'Show me my options' },
      { role: 'assistant', content: 'Choose from the cards below' },
    ];
    const responseMetadata = makeResponseMetadata({
      kind: 'mixed',
    });
    const contentEnvelope = {
      version: 2 as const,
      format: 'message_envelope' as const,
      text: 'Choose from the cards below',
      richContent: {
        markdown: '**Choose from the cards below**',
      },
      actions: {
        elements: [{ id: 'choose-plan', type: 'button' as const, label: 'Choose plan' }],
      },
      voiceConfig: {
        plain_text: 'Choose from the cards below',
      },
    };

    const applied = applyResponseMetadataToLatestAssistantMessage(
      history,
      'Choose from the cards below',
      responseMetadata,
      contentEnvelope,
    );

    expect(applied).toBe(true);
    expect(history[1]).toEqual({
      role: 'assistant',
      content: 'Choose from the cards below',
      metadata: responseMetadata,
      contentEnvelope,
    });
  });
});
