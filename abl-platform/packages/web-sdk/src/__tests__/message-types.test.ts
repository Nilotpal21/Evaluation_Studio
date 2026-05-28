/**
 * Message Types Tests (UT-3, UT-4)
 *
 * Tests MessageRole includes 'thought'.
 * Tests MessageMetadata index signature preserves Record<string, unknown> assignability.
 */

import { describe, test, expect } from 'vitest';
import type { MessageRole, MessageMetadata, Message, ResponseProvenance } from '../core/types.js';

describe('MessageRole type', () => {
  test('includes user, assistant, system, and thought', () => {
    const roles: MessageRole[] = ['user', 'assistant', 'system', 'thought'];
    expect(roles).toHaveLength(4);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    expect(roles).toContain('system');
    expect(roles).toContain('thought');
  });

  test('Message with role=thought is valid', () => {
    const msg: Message = {
      id: 'msg-1',
      role: 'thought',
      content: 'I think we should search for this',
      timestamp: new Date(),
      metadata: {
        toolName: 'search',
        agentName: 'assistant',
      },
    };
    expect(msg.role).toBe('thought');
    expect(msg.metadata?.toolName).toBe('search');
  });

  test('existing roles still work', () => {
    const userMsg: Message = {
      id: 'msg-1',
      role: 'user',
      content: 'Hello',
      timestamp: new Date(),
    };
    const assistantMsg: Message = {
      id: 'msg-2',
      role: 'assistant',
      content: 'Hi there',
      timestamp: new Date(),
    };
    const systemMsg: Message = {
      id: 'msg-3',
      role: 'system',
      content: 'Welcome',
      timestamp: new Date(),
    };

    expect(userMsg.role).toBe('user');
    expect(assistantMsg.role).toBe('assistant');
    expect(systemMsg.role).toBe('system');
  });
});

describe('MessageMetadata type', () => {
  test('typed optional fields are accessible', () => {
    const metadata: MessageMetadata = {
      toolName: 'search',
      agentName: 'main-assistant',
      traceIds: ['trace-1', 'trace-2'],
      llmCallId: 'llm-1',
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1,
        kind: 'llm',
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
      handoffFrom: 'triage',
      handoffTo: 'billing',
      errorCode: 'TIMEOUT',
      severity: 'error',
    };

    expect(metadata.toolName).toBe('search');
    expect(metadata.agentName).toBe('main-assistant');
    expect(metadata.traceIds).toEqual(['trace-1', 'trace-2']);
    expect(metadata.llmCallId).toBe('llm-1');
    expect(metadata.isLlmGenerated).toBe(true);
    expect(metadata.responseProvenance?.kind).toBe('llm');
    expect(metadata.handoffFrom).toBe('triage');
    expect(metadata.handoffTo).toBe('billing');
    expect(metadata.errorCode).toBe('TIMEOUT');
    expect(metadata.severity).toBe('error');
  });

  test('response provenance uses the exact public contract', () => {
    const provenance: ResponseProvenance = {
      schemaVersion: 1,
      kind: 'mixed',
      disclaimerRequired: true,
      usedLlmInternally: true,
    };

    const metadata: MessageMetadata = {
      isLlmGenerated: true,
      responseProvenance: provenance,
    };

    expect(metadata.responseProvenance).toEqual(provenance);
    expect(metadata.responseProvenance?.usedLlmInternally).toBe(true);
  });

  test('index signature allows arbitrary keys (backwards compatible)', () => {
    const metadata: MessageMetadata = {
      toolName: 'search',
      customField: 'custom-value',
      numericField: 42,
      nested: { deep: true },
    };

    expect(metadata.customField).toBe('custom-value');
    expect(metadata.numericField).toBe(42);
    expect(metadata.nested).toEqual({ deep: true });
  });

  test('is assignable from Record<string, unknown>', () => {
    // This verifies backwards compatibility: existing code that passes
    // Record<string, unknown> should still be assignable to MessageMetadata
    const record: Record<string, unknown> = {
      toolName: 'test',
      someOtherField: 'value',
    };

    // MessageMetadata with index signature accepts the same shape
    const metadata: MessageMetadata = record;
    expect(metadata.toolName).toBe('test');
    expect(metadata.someOtherField).toBe('value');
  });

  test('Message.metadata accepts MessageMetadata', () => {
    const msg: Message = {
      id: 'msg-1',
      role: 'thought',
      content: 'Thinking...',
      timestamp: new Date(),
      metadata: {
        toolName: 'analyze',
        agentName: 'assistant',
        customData: { score: 0.95 },
      },
    };

    expect(msg.metadata?.toolName).toBe('analyze');
    expect(msg.metadata?.agentName).toBe('assistant');
  });

  test('empty metadata is valid', () => {
    const metadata: MessageMetadata = {};
    expect(metadata.toolName).toBeUndefined();
    expect(metadata.severity).toBeUndefined();
  });
});
