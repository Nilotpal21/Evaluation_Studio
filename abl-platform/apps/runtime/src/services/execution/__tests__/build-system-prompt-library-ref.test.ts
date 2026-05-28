/**
 * INT-9: buildSystemPrompt() defensive guard for empty template + libraryRef
 *
 * Verifies that when an agent IR has a prompt library reference but an empty
 * template (misconfigured / pre-hook version), buildSystemPrompt() throws a
 * sanitized error — promptId and versionId must NOT appear in the user-facing
 * message.
 */

import { describe, test, expect } from 'vitest';
import { buildSystemPrompt } from '../prompt-builder.js';

function makeSessionWithLibraryRef(template: string) {
  return {
    agentName: 'test-agent',
    channelType: 'web',
    _fillerEnabled: false,
    data: { values: {} },
    conversationHistory: [],
    agentIR: {
      metadata: { name: 'test-agent' },
      identity: {
        goal: 'Help the user',
        persona: '',
        limitations: [],
        system_prompt: {
          template,
          custom: true,
          sections: { context: false, tools: false, constraints: false, history: false },
          libraryRef: {
            promptId: 'pl_secret_prompt_id',
            versionId: 'plv_secret_version_id',
            resolvedHash: 'abc123def456',
          },
        },
      },
      tools: [],
      gather: { fields: [], strategy: 'hybrid' },
      memory: { namespaces: [] },
      constraints: { guardrails: [], constraints: [] },
      coordination: { handoffs: [], delegates: [] },
      execution: { reasoning: { enabled: false }, model: {} },
    },
  } as any;
}

describe('INT-9: buildSystemPrompt() defensive guard for libraryRef + empty template', () => {
  test('throws sanitized error when libraryRef is set but template is empty', () => {
    const session = makeSessionWithLibraryRef('');

    expect(() => buildSystemPrompt(session)).toThrow(/system prompt configuration is incomplete/i);
  });

  test('error message does not leak promptId or versionId', () => {
    const session = makeSessionWithLibraryRef('');

    let thrown: unknown;
    try {
      buildSystemPrompt(session);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).not.toContain('pl_secret_prompt_id');
    expect(message).not.toContain('plv_secret_version_id');
  });

  test('guard does not trigger when template is non-empty (error comes from deeper in builder)', () => {
    const session = makeSessionWithLibraryRef('You are a helpful assistant.');

    // Guard does NOT fire (template non-empty), but builder may throw for other reasons
    // in a minimal test session. Assert specifically: NOT PROMPT_LIBRARY_TEMPLATE_MISSING.
    let thrown: unknown;
    try {
      buildSystemPrompt(session);
    } catch (err) {
      thrown = err;
    }

    if (thrown) {
      const code = (thrown as Record<string, unknown>).code;
      expect(code).not.toBe('PROMPT_LIBRARY_TEMPLATE_MISSING');
    }
  });

  test('guard does not trigger when libraryRef is absent', () => {
    const session = {
      agentName: 'no-ref-agent',
      channelType: 'web',
      _fillerEnabled: false,
      data: { values: {} },
      conversationHistory: [],
      agentIR: {
        metadata: { name: 'no-ref-agent' },
        identity: {
          goal: 'Help',
          persona: '',
          limitations: [],
          system_prompt: {
            template: '',
            custom: false,
            sections: { context: true, tools: false, constraints: false, history: true },
          },
        },
        tools: [],
        gather: { fields: [], strategy: 'hybrid' },
        memory: { namespaces: [] },
        constraints: { guardrails: [], constraints: [] },
        coordination: { handoffs: [], delegates: [] },
        execution: { reasoning: { enabled: false }, model: {} },
      },
    } as any;

    let thrown: unknown;
    try {
      buildSystemPrompt(session);
    } catch (err) {
      thrown = err;
    }

    if (thrown) {
      const code = (thrown as Record<string, unknown>).code;
      expect(code).not.toBe('PROMPT_LIBRARY_TEMPLATE_MISSING');
    }
  });
});
