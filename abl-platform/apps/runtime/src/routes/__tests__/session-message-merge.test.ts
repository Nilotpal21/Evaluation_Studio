import { describe, expect, test } from 'vitest';
import { mergeActiveSessionMessages } from '../sessions.js';

describe('mergeActiveSessionMessages', () => {
  test('prefers richer active assistant content when persisted history has matching text only', () => {
    const merged = mergeActiveSessionMessages({
      persistedMessages: [
        {
          id: 'msg-db-1',
          role: 'assistant',
          content: 'Account summary',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
      ],
      runtimeMessages: [
        {
          id: 'msg-runtime-1',
          role: 'assistant',
          content: 'Account summary',
          contentEnvelope: {
            version: 2,
            format: 'message_envelope',
            text: 'Account summary',
            richContent: { markdown: '| Name | Value |' },
            actions: {
              elements: [{ id: 'details', type: 'button', label: 'View details' }],
              submit_id: 'details-submit',
            },
          },
          timestamp: '2025-01-01T00:00:00.000Z',
        },
      ],
    });

    expect(merged).toEqual([
      {
        id: 'msg-runtime-1',
        role: 'assistant',
        content: 'Account summary',
        contentEnvelope: {
          version: 2,
          format: 'message_envelope',
          text: 'Account summary',
          richContent: { markdown: '| Name | Value |' },
          actions: {
            elements: [{ id: 'details', type: 'button', label: 'View details' }],
            submit_id: 'details-submit',
          },
        },
        timestamp: '2025-01-01T00:00:00.000Z',
      },
    ]);
  });

  test('prefers active assistant content when envelopes differ with equal richness', () => {
    const persistedEnvelope = {
      version: 2 as const,
      format: 'message_envelope' as const,
      text: 'Choose a card',
      actions: {
        elements: [{ id: 'old-card', type: 'button' as const, label: 'Old card' }],
      },
    };
    const runtimeEnvelope = {
      version: 2 as const,
      format: 'message_envelope' as const,
      text: 'Choose a card',
      actions: {
        elements: [{ id: 'new-card', type: 'button' as const, label: 'New card' }],
      },
    };

    const merged = mergeActiveSessionMessages({
      persistedMessages: [
        {
          id: 'msg-db-1',
          role: 'assistant',
          content: 'Choose a card',
          contentEnvelope: persistedEnvelope,
          timestamp: '2025-01-01T00:00:00.000Z',
        },
      ],
      runtimeMessages: [
        {
          id: 'msg-runtime-1',
          role: 'assistant',
          content: 'Choose a card',
          contentEnvelope: runtimeEnvelope,
          timestamp: '2025-01-01T00:00:00.000Z',
        },
      ],
    });

    expect(merged[0]).toMatchObject({
      id: 'msg-runtime-1',
      contentEnvelope: runtimeEnvelope,
    });
  });

  test('keeps persisted identity for equivalent plain messages with equal richness', () => {
    const merged = mergeActiveSessionMessages({
      persistedMessages: [
        {
          id: 'msg-db-1',
          role: 'user',
          content: 'Show me my account',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
      ],
      runtimeMessages: [
        {
          id: 'msg-runtime-1',
          role: 'user',
          content: 'Show me my account',
          timestamp: '2025-01-01T00:00:00Z',
        },
      ],
    });

    expect(merged).toEqual([
      {
        id: 'msg-db-1',
        role: 'user',
        content: 'Show me my account',
        timestamp: '2025-01-01T00:00:00.000Z',
      },
    ]);
  });
});
