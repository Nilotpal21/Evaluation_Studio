import { describe, test, expect } from 'vitest';
import {
  getDefaultFillerMessage,
  getFillerMessage,
  OPERATION_MESSAGES,
} from '../../services/filler/message-pools.js';

describe('filler message pools', () => {
  test('returns a message for each operation type', () => {
    const ops = [
      'tool_call',
      'reasoning',
      'handoff',
      'delegation',
      'extraction',
      'constraint_check',
      'general',
    ] as const;
    for (const op of ops) {
      const msg = getFillerMessage(op);
      expect(msg).toBeTruthy();
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  test('returns message from the correct pool', () => {
    const msg = getFillerMessage('handoff');
    const pool = OPERATION_MESSAGES.handoff;
    expect(pool).toContain(msg);
  });

  test('avoids repeating recent messages', () => {
    const history: string[] = [];
    const results = new Set<string>();
    // Call enough times to force variety
    for (let i = 0; i < 20; i++) {
      const msg = getFillerMessage('tool_call', history);
      results.add(msg);
      history.push(msg);
      if (history.length > 3) history.shift();
    }
    // Should have used more than one message
    expect(results.size).toBeGreaterThan(1);
  });

  test('toolName does not change the generic fallback pool', () => {
    const msg = getFillerMessage('tool_call', [], 'custom_lookup_tool');
    expect(OPERATION_MESSAGES.tool_call).toContain(msg);
  });

  test('voice fallback uses conversational generic text without tool inference', () => {
    const msg = getFillerMessage('tool_call', [], 'custom_lookup_tool', {
      isVoiceChannel: true,
    });

    expect([
      "I'm checking that for you.",
      'Let me check that.',
      "I'll take a quick look.",
    ]).toContain(msg);
  });

  test('locale selects a localized generic fallback pool', () => {
    const msg = getFillerMessage('tool_call', [], undefined, { locale: 'es-MX' });
    expect(['Un momento.', 'Revisando ahora.', 'Echando un vistazo.']).toContain(msg);
  });

  test('default fallback follows locale language prefix', () => {
    expect(getDefaultFillerMessage({ locale: 'pt-BR' })).toBe('Um momento.');
  });
});
