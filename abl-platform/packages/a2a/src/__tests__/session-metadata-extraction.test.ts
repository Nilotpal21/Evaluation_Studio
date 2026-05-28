import { describe, it, expect } from 'vitest';
import {
  extractInteractionContext,
  extractSessionMetadata,
} from '../infrastructure/agent-executor-adapter.js';

describe('A2A extractSessionMetadata', () => {
  it('extracts sessionMetadata from message.metadata', () => {
    const message = {
      role: 'user' as const,
      parts: [{ kind: 'text' as const, text: 'hello' }],
      metadata: {
        sessionMetadata: { token: 'abc', profile: { name: 'Alice' } },
        messageMetadata: { correlationId: 'corr-1' },
      },
    };
    expect(extractSessionMetadata(message)).toEqual({
      token: 'abc',
      profile: { name: 'Alice' },
    });
  });

  it('returns undefined when no metadata on message', () => {
    const message = {
      role: 'user' as const,
      parts: [{ kind: 'text' as const, text: 'hello' }],
    };
    expect(extractSessionMetadata(message)).toBeUndefined();
  });

  it('returns undefined when sessionMetadata is not an object', () => {
    const message = {
      role: 'user' as const,
      parts: [{ kind: 'text' as const, text: 'hello' }],
      metadata: {
        sessionMetadata: 'not-an-object',
      },
    };
    expect(extractSessionMetadata(message)).toBeUndefined();
  });

  it('returns undefined when sessionMetadata is absent', () => {
    const message = {
      role: 'user' as const,
      parts: [{ kind: 'text' as const, text: 'hello' }],
      metadata: {
        messageMetadata: { locale: 'en' },
      },
    };
    expect(extractSessionMetadata(message)).toBeUndefined();
  });
});

describe('A2A extractInteractionContext', () => {
  it('extracts top-level interactionContext from message metadata', () => {
    const message = {
      role: 'user' as const,
      parts: [{ kind: 'text' as const, text: 'hello' }],
      metadata: {
        interactionContext: {
          language: 'es',
          locale: 'es-MX',
          timezone: 'America/Mexico_City',
        },
        messageMetadata: { correlationId: 'corr-1' },
      },
    };

    expect(extractInteractionContext(message)).toEqual({
      language: 'es',
      locale: 'es-MX',
      timezone: 'America/Mexico_City',
    });
  });

  it('returns undefined when interactionContext is missing or invalid', () => {
    const message = {
      role: 'user' as const,
      parts: [{ kind: 'text' as const, text: 'hello' }],
      metadata: {
        interactionContext: 'invalid',
      },
    };

    expect(extractInteractionContext(message)).toBeUndefined();
  });
});
