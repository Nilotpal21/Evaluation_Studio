import { describe, expect, it } from 'vitest';
import type { Message, Task } from '@agent-platform/a2a';
import {
  buildStructuredHandoffAssistantMessage,
  extractA2AResponseOutput,
} from '../../services/execution/routing-executor.js';
import type { RuntimeSession } from '../../services/execution/types.js';

function createSession(): RuntimeSession {
  return {
    id: 'session-structured-a2a',
    tenantId: 'tenant-1',
    projectId: 'project-1',
  } as RuntimeSession;
}

describe('A2A structured handoff return extraction', () => {
  it('preserves multipart text plus data-part rich content, actions, and metadata', () => {
    const result = {
      kind: 'message',
      messageId: 'msg-1',
      role: 'agent',
      parts: [
        { kind: 'text', text: 'First paragraph.' },
        { kind: 'text', text: 'Second paragraph.' },
        {
          kind: 'data',
          data: {
            richContent: { markdown: '**Structured card**' },
            actions: {
              elements: [{ id: 'approve', type: 'button', label: 'Approve' }],
              submit_id: 'submit_claim',
            },
            responseMetadata: {
              isLlmGenerated: false,
              responseProvenance: {
                schemaVersion: 1,
                kind: 'scripted',
                disclaimerRequired: false,
                usedLlmInternally: false,
              },
            },
          },
        },
      ],
    } as Message;

    const output = extractA2AResponseOutput(result);

    expect(output.text).toBe('First paragraph.\nSecond paragraph.');
    expect(output.richContent).toEqual({ markdown: '**Structured card**' });
    expect(output.actions?.elements).toEqual([{ id: 'approve', type: 'button', label: 'Approve' }]);
    expect(output.responseMetadata?.isLlmGenerated).toBe(false);

    const { message, result: executionResult } = buildStructuredHandoffAssistantMessage(
      createSession(),
      output,
      { prefix: '[Remote_Agent]: ' },
    );

    expect(message.content).toBe('[Remote_Agent]: First paragraph.\nSecond paragraph.');
    expect(message.contentEnvelope?.richContent).toEqual({ markdown: '**Structured card**' });
    expect(message.contentEnvelope?.actions?.submit_id).toBe('submit_claim');
    expect(message.metadata?.isLlmGenerated).toBe(false);
    expect(executionResult.richContent).toEqual({ markdown: '**Structured card**' });
    expect(executionResult.actions?.elements[0]?.id).toBe('approve');
    expect(executionResult.responseMetadata?.isLlmGenerated).toBe(false);
  });

  it('falls back to artifacts and keeps structured-only task output in the envelope', () => {
    const result = {
      kind: 'task',
      id: 'task-1',
      contextId: 'context-1',
      status: {
        state: 'completed',
        timestamp: new Date().toISOString(),
        message: {
          kind: 'message',
          messageId: 'status-msg',
          role: 'agent',
          parts: [
            {
              kind: 'data',
              data: {
                actions: {
                  elements: [{ id: 'pick', type: 'button', label: 'Pick one' }],
                },
              },
            },
          ],
        },
      },
      artifacts: [
        {
          artifactId: 'artifact-1',
          parts: [
            { kind: 'text', text: 'Artifact paragraph one.' },
            { kind: 'text', text: 'Artifact paragraph two.' },
          ],
        },
      ],
    } as Task;

    const output = extractA2AResponseOutput(result);

    expect(output.text).toBe('Artifact paragraph one.\nArtifact paragraph two.');
    expect(output.actions?.elements[0]?.id).toBe('pick');

    const { message } = buildStructuredHandoffAssistantMessage(createSession(), {
      text: '',
      actions: output.actions,
    });

    expect(message.content).toBe('');
    expect(message.contentEnvelope?.actions?.elements[0]?.label).toBe('Pick one');
  });
});
