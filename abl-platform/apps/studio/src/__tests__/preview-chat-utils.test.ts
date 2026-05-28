import { describe, expect, it } from 'vitest';
import {
  buildPreviewAssistantMessage,
  buildPreviewAuthChallengeMessage,
  buildPreviewThoughtMessage,
} from '@/components/preview/preview-chat-utils';
import { ASSISTANT_OUTPUT_GOLDEN_FIXTURE } from '@agent-platform/shared-kernel/propagation-fixtures';

describe('preview-chat-utils', () => {
  it('uses fullText when response_end includes text', () => {
    const message = buildPreviewAssistantMessage({
      messageId: 'msg-1',
      fullText: 'Hello from runtime',
      metadata: {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'llm',
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      },
      richContent: { markdown: '**hello**' },
      actions: {
        elements: [{ id: 'confirm', type: 'button', label: 'Confirm', value: 'yes' }],
      },
    });

    expect(message).toMatchObject({
      id: 'msg-1',
      role: 'assistant',
      content: 'Hello from runtime',
      metadata: {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'llm',
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      },
    });
    expect(message.richContent?.markdown).toBe('**hello**');
    expect(message.actions?.elements[0]?.id).toBe('confirm');
  });

  it('falls back to voiceConfig.plain_text when fullText is empty', () => {
    const message = buildPreviewAssistantMessage({
      messageId: 'msg-2',
      fullText: '',
      voiceConfig: { plain_text: 'Spoken fallback text' },
    });

    expect(message.content).toBe('Spoken fallback text');
  });

  it('normalizes SDK-visible golden content envelopes for hosted preview rendering', () => {
    const golden = ASSISTANT_OUTPUT_GOLDEN_FIXTURE.textPlusStructured;
    const message = buildPreviewAssistantMessage({
      messageId: 'msg-golden',
      fullText: '',
      contentEnvelope: golden.contentEnvelope,
      richContent: golden.richContent,
      actions: golden.actions,
      voiceConfig: golden.voiceConfig,
      metadata: { responseMode: 'preview' },
    });

    expect(message.content).toBe('Your claim CLM-123 is ready for review.');
    expect(message.richContent?.markdown).toContain('Claim review');
    expect(message.actions?.elements.map((element) => element.label)).toEqual([
      'Open claim {{session.claimId}}',
      'Request callback',
    ]);
    expect(message.metadata).toEqual({
      responseMode: 'preview',
      localization: {
        locale: 'en-US',
        messageKey: 'claims.review.ready',
        variables: ['session.claimId', 'contact.displayName'],
      },
    });
  });

  it('builds a thought message from tool_thought trace data', () => {
    const message = buildPreviewThoughtMessage({
      id: 'trace-1',
      data: {
        thought: 'Need to search available hotels',
        toolName: 'hotel_search',
        agentName: 'TravelDesk_Supervisor',
      },
    });

    expect(message).toMatchObject({
      id: 'trace-1',
      role: 'thought',
      content: 'Need to search available hotels',
      metadata: {
        toolName: 'hotel_search',
        agentName: 'TravelDesk_Supervisor',
        traceIds: ['trace-1'],
      },
    });
  });

  it('returns null when a tool_thought trace has no visible thought content', () => {
    expect(
      buildPreviewThoughtMessage({
        id: 'trace-2',
        data: {
          toolName: 'hotel_search',
        },
      }),
    ).toBeNull();
  });

  it('builds an auth challenge message with the challenge payload attached', () => {
    const message = buildPreviewAuthChallengeMessage({
      type: 'auth_challenge',
      code: 'AUTH_JIT_REQUIRED',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      authType: 'oauth2',
      authUrl: 'https://accounts.google.com/o/oauth2/auth',
      profileId: 'google-creds',
      profileName: 'Google',
      prompt: 'Authorize Google to continue',
      timeoutMs: 600000,
    });

    expect(message).toMatchObject({
      id: 'auth-challenge-tool-1',
      role: 'system',
      content: 'Authorize Google to continue',
      authChallenge: {
        type: 'auth_challenge',
        toolCallId: 'tool-1',
        profileName: 'Google',
      },
      metadata: {
        errorCode: 'AUTH_JIT_REQUIRED',
        severity: 'warning',
      },
    });
  });
});
