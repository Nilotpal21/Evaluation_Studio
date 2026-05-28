import { describe, expect, test } from 'vitest';
import type { SessionDetail } from '../domain/ports.js';

describe('A2A domain ports', () => {
  test('SessionDetail messages can carry response provenance metadata', () => {
    const detail: SessionDetail = {
      messages: [
        {
          role: 'assistant',
          content: 'Hello from A2A',
          metadata: {
            isLlmGenerated: true,
            responseProvenance: {
              schemaVersion: 1,
              kind: 'mixed',
              disclaimerRequired: true,
              usedLlmInternally: true,
            },
            responseChannelHint: 'a2a-session-detail',
          },
        },
      ],
    };

    expect(detail.messages[0]?.metadata).toEqual({
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1,
        kind: 'mixed',
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
      responseChannelHint: 'a2a-session-detail',
    });
  });
});
