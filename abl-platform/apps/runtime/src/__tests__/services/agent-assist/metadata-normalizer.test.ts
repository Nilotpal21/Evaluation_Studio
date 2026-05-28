import { describe, expect, it } from 'vitest';
import { normalizeV1Metadata } from '../../../services/agent-assist/metadata-normalizer.js';
import { AGENT_ASSIST_MAX_AA_HISTORY_MSGS } from '../../../services/agent-assist/constants.js';

describe('normalizeV1Metadata', () => {
  it('returns empty history and forward for non-object input', () => {
    expect(normalizeV1Metadata(null)).toEqual({ history: [], forward: {} });
    expect(normalizeV1Metadata('string')).toEqual({ history: [], forward: {} });
    expect(normalizeV1Metadata(42)).toEqual({ history: [], forward: {} });
    expect(normalizeV1Metadata([])).toEqual({ history: [], forward: {} });
  });

  it('strips the full reserved-key set before forwarding', () => {
    const input = {
      conversationId: 'conv-1',
      botId: 'bot-1',
      language: 'en',
      // Reserved → must be dropped:
      history: [{ fake: true }],
      token: 'leaked',
      credentials: { secret: 'x' },
      apiKey: 'kg-fake',
      apiKeyId: 'spoofed-key-id',
      authorization: 'Bearer abuse',
      sessionId: 'spoofed',
      runId: 'spoofed',
      bindingId: 'spoofed',
      tenantId: 'spoofed',
      projectId: 'spoofed',
      orgId: 'spoofed',
      userId: 'spoofed',
      _agentAssist: { source: 'spoofed' },
    };
    const result = normalizeV1Metadata(input);
    expect(result.forward).toEqual({
      conversationId: 'conv-1',
      botId: 'bot-1',
      language: 'en',
    });
  });

  it('parses aa_uamsgs JSON-string entries into objects', () => {
    const result = normalizeV1Metadata({
      aa_uamsgs: [
        JSON.stringify({ role: 'agent', text: 'hello' }),
        JSON.stringify({ role: 'customer', text: 'hi' }),
        'plain non-json',
      ],
    });
    expect(result.history).toHaveLength(3);
    expect(result.history[0]).toEqual({ role: 'agent', text: 'hello' });
    expect(result.history[1]).toEqual({ role: 'customer', text: 'hi' });
    expect(result.history[2]).toEqual({ content: 'plain non-json' });
    expect(result.forward).toEqual({});
  });

  it('bounds aa_uamsgs at the configured max message count', () => {
    const oversized = Array.from({ length: AGENT_ASSIST_MAX_AA_HISTORY_MSGS + 25 }, (_, i) => ({
      role: 'agent',
      text: `m-${i}`,
    }));
    const result = normalizeV1Metadata({ aa_uamsgs: oversized });
    expect(result.history).toHaveLength(AGENT_ASSIST_MAX_AA_HISTORY_MSGS);
    expect(result.history[0]).toEqual({ role: 'agent', text: 'm-0' });
  });

  it('preserves both history and non-reserved keys when both are present', () => {
    const result = normalizeV1Metadata({
      conversationId: 'c-1',
      aa_uamsgs: [{ role: 'agent', text: 'hi' }],
    });
    expect(result.forward).toEqual({ conversationId: 'c-1' });
    expect(result.history).toEqual([{ role: 'agent', text: 'hi' }]);
  });
});
