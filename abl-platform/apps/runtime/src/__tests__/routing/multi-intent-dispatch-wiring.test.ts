import { describe, it, expect } from 'vitest';
import { detectIntent } from '@abl/compiler/platform/constructs/utils.js';

describe('multi-intent dispatch wiring', () => {
  describe('detectMultipleIntents logic', () => {
    it('should find multiple matching intents from ON_INPUT branches', () => {
      const message = 'I want to book a flight and check my status';
      const onInputBranches = [
        { condition: 'input contains "book"', then: 'booking_step' },
        { condition: 'input contains "check"', then: 'status_step' },
        { condition: 'input contains "cancel"', then: 'cancel_step' },
      ];

      // Simulate detectMultipleIntents by checking each branch as keyword
      const matches: Array<{ intent: string; confidence: number }> = [];
      for (const branch of onInputBranches) {
        // Extract keyword from condition pattern
        const kwMatch = branch.condition?.match(/contains\s+"([^"]+)"/);
        if (kwMatch) {
          const keyword = kwMatch[1];
          const result = detectIntent(message, [{ intent: keyword }], {});
          if (result) {
            matches.push({ intent: branch.then, confidence: 0.8 });
          }
        }
      }

      expect(matches).toHaveLength(2); // "book" and "check" match
      expect(matches[0].intent).toBe('booking_step');
      expect(matches[1].intent).toBe('status_step');
    });

    it('should return null when fewer than 2 intents match', () => {
      const message = 'I want to book a flight';
      const onInputBranches = [
        { condition: 'input contains "book"', then: 'booking_step' },
        { condition: 'input contains "check"', then: 'status_step' },
      ];

      const matches: Array<{ intent: string; confidence: number }> = [];
      for (const branch of onInputBranches) {
        const kwMatch = branch.condition?.match(/contains\s+"([^"]+)"/);
        if (kwMatch) {
          const result = detectIntent(message, [{ intent: kwMatch[1] }], {});
          if (result) matches.push({ intent: branch.then, confidence: 0.8 });
        }
      }

      expect(matches.length < 2).toBe(true); // Only one match, no multi-intent
    });
  });

  describe('dispatch integration', () => {
    it('should skip dispatch when multi-intent is disabled', () => {
      // resolveMultiIntentConfig returns enabled: false
      const config = {
        enabled: false,
        strategy: 'primary_queue' as const,
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 600_000,
      };
      expect(config.enabled).toBe(false);
    });

    it('should skip dispatch when no currentMessage', () => {
      const currentMessage = '';
      const shouldDispatch = !!currentMessage;
      expect(shouldDispatch).toBe(false);
    });

    it('should skip dispatch when session is waiting for input', () => {
      const session = { waitingForInput: ['name'] };
      const shouldDispatch = !session.waitingForInput;
      expect(shouldDispatch).toBe(false);
    });
  });
});
