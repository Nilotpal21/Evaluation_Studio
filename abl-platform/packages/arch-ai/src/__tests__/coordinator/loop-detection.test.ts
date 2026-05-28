import { describe, expect, it, beforeEach } from 'vitest';
import { LoopDetector } from '../../coordinator/loop-detection.js';

describe('LoopDetector', () => {
  let detector: LoopDetector;

  beforeEach(() => {
    detector = new LoopDetector();
  });

  describe('exact match detection', () => {
    it('does not detect loop on first call', () => {
      const result = detector.check('agent1', 'tool1', { query: 'test' });
      expect(result).toBe(false);
    });

    it('does not detect loop on second call with same input', () => {
      detector.check('agent1', 'tool1', { query: 'test' });
      const result = detector.check('agent1', 'tool1', { query: 'test' });
      expect(result).toBe(false);
    });

    it('does not detect loop on third call with same input', () => {
      detector.check('agent1', 'tool1', { query: 'test' });
      detector.check('agent1', 'tool1', { query: 'test' });
      const result = detector.check('agent1', 'tool1', { query: 'test' });
      expect(result).toBe(false);
    });

    it('does not detect loop on fourth call with same input', () => {
      detector.check('agent1', 'tool1', { query: 'test' });
      detector.check('agent1', 'tool1', { query: 'test' });
      detector.check('agent1', 'tool1', { query: 'test' });
      const result = detector.check('agent1', 'tool1', { query: 'test' });
      expect(result).toBe(false);
    });

    it('detects loop on fifth call with same input', () => {
      detector.check('agent1', 'tool1', { query: 'test' });
      detector.check('agent1', 'tool1', { query: 'test' });
      detector.check('agent1', 'tool1', { query: 'test' });
      detector.check('agent1', 'tool1', { query: 'test' });
      const result = detector.check('agent1', 'tool1', { query: 'test' });
      expect(result).toBe(true);
    });

    it('does not detect loop when inputs differ', () => {
      for (let i = 0; i < 10; i++) {
        const result = detector.check('agent1', 'tool1', { query: `test${i}` });
        expect(result).toBe(false);
      }
    });

    it('does not detect loop when tool names differ', () => {
      for (let i = 0; i < 10; i++) {
        const result = detector.check('agent1', `tool${i}`, { query: 'test' });
        expect(result).toBe(false);
      }
    });

    it('does not detect loop when specialists differ', () => {
      for (let i = 0; i < 10; i++) {
        const result = detector.check(`agent${i}`, 'tool1', { query: 'test' });
        expect(result).toBe(false);
      }
    });

    it('handles complex nested objects', () => {
      const input = {
        user: { id: '123', name: 'John' },
        filters: { age: 25, city: 'NYC' },
        options: { sort: 'asc', limit: 10 },
      };

      for (let i = 0; i < 4; i++) {
        const result = detector.check('agent1', 'tool1', input);
        expect(result).toBe(false);
      }

      const result = detector.check('agent1', 'tool1', input);
      expect(result).toBe(true);
    });

    it('handles arrays in input', () => {
      const input = { items: ['a', 'b', 'c'], count: 3 };

      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'tool1', input);
      }

      const result = detector.check('agent1', 'tool1', input);
      expect(result).toBe(true);
    });

    it('treats different property orders as identical', () => {
      const input1 = { a: 1, b: 2 };
      const input2 = { b: 2, a: 1 };

      for (let i = 0; i < 2; i++) {
        detector.check('agent1', 'tool1', input1);
      }
      for (let i = 0; i < 2; i++) {
        detector.check('agent1', 'tool1', input2);
      }

      const result = detector.check('agent1', 'tool1', input1);
      expect(result).toBe(true);
    });
  });

  describe('semantic match detection', () => {
    it('detects semantic loop with paraphrased questions', () => {
      // Semantic matching is aggressive - these all normalize to "channel support"
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'ask_user', { question: 'Which channels do you support?' });
      }
      // Fifth identical semantic match should trigger
      const result = detector.check('agent1', 'ask_user', { question: 'channels support' });
      expect(result).toBe(true);
    });

    it('normalizes filler words and question words', () => {
      // All normalize to "status"
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'ask_user', { question: 'what is the status' });
      }
      const result = detector.check('agent1', 'ask_user', { question: 'status' });
      expect(result).toBe(true);
    });

    it('normalizes word order', () => {
      const questions = [
        { question: 'support channels which' },
        { question: 'channels which support' },
        { question: 'which channels support' },
        { question: 'channels support which' },
        { question: 'support which channels' },
      ];

      for (const input of questions) {
        const result = detector.check('agent1', 'ask_user', input);
        if (input === questions[questions.length - 1]) {
          expect(result).toBe(true);
        }
      }
    });

    it('normalizes inflections via stemming', () => {
      const questions = [
        { question: 'support channels' },
        { question: 'supports channels' },
        { question: 'supported channels' },
        { question: 'supporting channels' },
        { question: 'channel support' },
      ];

      for (const input of questions) {
        const result = detector.check('agent1', 'ask_user', input);
        if (input === questions[questions.length - 1]) {
          expect(result).toBe(true);
        }
      }
    });

    it('works with prompt field', () => {
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'generate', { prompt: 'Write a story about dragons' });
      }
      const result = detector.check('agent1', 'generate', { prompt: 'Write a story dragons' });
      expect(result).toBe(true);
    });

    it('works with description field', () => {
      // Both normalize to "management system user"
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'create', { description: 'User management system' });
      }
      const result = detector.check('agent1', 'create', { description: 'user system management' });
      expect(result).toBe(true);
    });

    it('works with content field', () => {
      // Both normalize to "check code error" (stemmed)
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'analyze', { content: 'Check code errors' });
      }
      const result = detector.check('agent1', 'analyze', { content: 'code check error' });
      expect(result).toBe(true);
    });

    it('works with rationale field', () => {
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'decide', { rationale: 'User requested feature toggle' });
      }
      const result = detector.check('agent1', 'decide', {
        rationale: 'requested feature toggle user',
      });
      expect(result).toBe(true);
    });

    it('works with instructions field', () => {
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'execute', { instructions: 'Deploy to production' });
      }
      const result = detector.check('agent1', 'execute', { instructions: 'deploy production' });
      expect(result).toBe(true);
    });

    it('concatenates multiple text fields', () => {
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'process', {
          question: 'What is the status?',
          description: 'Check deployment',
        });
      }
      const result = detector.check('agent1', 'process', {
        question: 'status?',
        description: 'deployment check',
      });
      expect(result).toBe(true);
    });

    it('does not trigger semantic loop on non-text fields but does trigger exact loop', () => {
      for (let i = 0; i < 4; i++) {
        const result = detector.check('agent1', 'tool1', { count: 42, enabled: true });
        expect(result).toBe(false);
      }
      // 5th call triggers exact match loop
      const result = detector.check('agent1', 'tool1', { count: 42, enabled: true });
      expect(result).toBe(true);
    });

    it('ignores punctuation', () => {
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'ask_user', { question: 'What is the status?' });
      }
      const result = detector.check('agent1', 'ask_user', { question: 'what is the status!!!' });
      expect(result).toBe(true);
    });

    it('collapses whitespace', () => {
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'ask_user', { question: 'what    is   the   status' });
      }
      const result = detector.check('agent1', 'ask_user', { question: 'what is the status' });
      expect(result).toBe(true);
    });

    it('distinguishes semantically different questions', () => {
      detector.check('agent1', 'ask_user', { question: 'What channels do you support?' });
      detector.check('agent1', 'ask_user', { question: 'What channels do you support?' });
      detector.check('agent1', 'ask_user', { question: 'What channels do you support?' });
      detector.check('agent1', 'ask_user', { question: 'What channels do you support?' });

      const result = detector.check('agent1', 'ask_user', { question: 'What is the pricing?' });
      expect(result).toBe(false);
    });
  });

  describe('mixed detection', () => {
    it('tracks exact and semantic separately', () => {
      // 2 exact matches
      detector.check('agent1', 'tool1', { question: 'What is the status?' });
      detector.check('agent1', 'tool1', { question: 'What is the status?' });

      // 3 semantic but not exact
      detector.check('agent1', 'tool1', { question: 'What status?' });
      detector.check('agent1', 'tool1', { question: 'status?' });
      detector.check('agent1', 'tool1', { question: 'what status' });

      // Should trip on 5th semantic match
      const result = detector.check('agent1', 'tool1', { question: 'the status what' });
      expect(result).toBe(true);
    });

    it('trips on exact before semantic threshold', () => {
      detector.check('agent1', 'tool1', { question: 'status' });
      detector.check('agent1', 'tool1', { question: 'status' });
      detector.check('agent1', 'tool1', { question: 'status' });
      detector.check('agent1', 'tool1', { question: 'status' });

      const result = detector.check('agent1', 'tool1', { question: 'status' });
      expect(result).toBe(true);
    });
  });

  describe('reset', () => {
    it('clears history', () => {
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'tool1', { query: 'test' });
      }

      detector.reset();

      const result = detector.check('agent1', 'tool1', { query: 'test' });
      expect(result).toBe(false);
    });

    it('allows new loop detection after reset', () => {
      for (let i = 0; i < 5; i++) {
        detector.check('agent1', 'tool1', { query: 'test' });
      }

      detector.reset();

      for (let i = 0; i < 4; i++) {
        const result = detector.check('agent1', 'tool1', { query: 'test' });
        expect(result).toBe(false);
      }

      const result = detector.check('agent1', 'tool1', { query: 'test' });
      expect(result).toBe(true);
    });
  });

  describe('max history bounds', () => {
    it('maintains bounded history with FIFO eviction', () => {
      // Fill history beyond MAX_HISTORY (200)
      for (let i = 0; i < 250; i++) {
        const result = detector.check('agent1', `tool${i}`, { query: `test${i}` });
        expect(result).toBe(false);
      }

      // Old entries should have been evicted, new unique entries should not loop
      const result = detector.check('agent1', 'tool251', { query: 'test251' });
      expect(result).toBe(false);
    });

    it('evicts oldest entry when at capacity', () => {
      // Fill to capacity with unique entries
      for (let i = 0; i < 200; i++) {
        detector.check('agent1', `tool${i}`, { query: `test${i}` });
      }

      // Add 5 more identical calls - should NOT loop because oldest were evicted
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'tool_new', { query: 'new' });
      }

      const result = detector.check('agent1', 'tool_new', { query: 'new' });
      // Should detect loop (5 identical within window)
      expect(result).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles empty input object', () => {
      for (let i = 0; i < 5; i++) {
        detector.check('agent1', 'tool1', {});
      }
      const result = detector.check('agent1', 'tool1', {});
      expect(result).toBe(true);
    });

    it('handles input with null values', () => {
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'tool1', { value: null });
      }
      const result = detector.check('agent1', 'tool1', { value: null });
      expect(result).toBe(true);
    });

    it('handles input with undefined values', () => {
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'tool1', { value: undefined });
      }
      const result = detector.check('agent1', 'tool1', { value: undefined });
      expect(result).toBe(true);
    });

    it('handles very long text fields', () => {
      const longText = 'word '.repeat(1000);
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'tool1', { question: longText });
      }
      const result = detector.check('agent1', 'tool1', { question: longText });
      expect(result).toBe(true);
    });

    it('handles text with only filler words', () => {
      for (let i = 0; i < 10; i++) {
        const result = detector.check('agent1', 'tool1', { question: 'the a an is are was were' });
        // All filler words normalize to empty string, so semantic hash is null
        // Should not trigger semantic loop, only exact loop
        if (i === 4) {
          expect(result).toBe(true);
        }
      }
    });

    it('handles special characters', () => {
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'tool1', { question: '@#$%^&*()' });
      }
      const result = detector.check('agent1', 'tool1', { question: '@#$%^&*()' });
      // Punctuation stripped, becomes empty after normalization
      expect(result).toBe(true);
    });

    it('handles mixed case', () => {
      detector.check('agent1', 'tool1', { question: 'CHANNELS SUPPORT' });
      detector.check('agent1', 'tool1', { question: 'Channels Support' });
      detector.check('agent1', 'tool1', { question: 'channels support' });
      detector.check('agent1', 'tool1', { question: 'ChAnNeLs SuPpOrT' });
      const result = detector.check('agent1', 'tool1', { question: 'CHANNELS SUPPORT' });
      expect(result).toBe(true);
    });

    it('handles numbers in text', () => {
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'tool1', { question: 'What are the top 5 items?' });
      }
      const result = detector.check('agent1', 'tool1', { question: 'top 5 items' });
      expect(result).toBe(true);
    });

    it('handles empty string in text fields', () => {
      for (let i = 0; i < 10; i++) {
        const result = detector.check('agent1', 'tool1', { question: '', other: 'data' });
        // Empty text fields are ignored, so semantic hash is null
        if (i === 4) {
          expect(result).toBe(true);
        }
      }
    });

    it('handles whitespace-only text fields', () => {
      for (let i = 0; i < 10; i++) {
        const result = detector.check('agent1', 'tool1', { question: '   ', other: 'data' });
        if (i === 4) {
          expect(result).toBe(true);
        }
      }
    });
  });

  describe('specialist and tool scoping', () => {
    it('tracks counts per (specialist, tool) pair', () => {
      // agent1 + tool1: 4 calls
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'tool1', { query: 'test' });
      }

      // agent2 + tool1: 1 call (different specialist)
      detector.check('agent2', 'tool1', { query: 'test' });

      // agent1 + tool2: 1 call (different tool)
      detector.check('agent1', 'tool2', { query: 'test' });

      // agent1 + tool1: 5th call should loop
      const result = detector.check('agent1', 'tool1', { query: 'test' });
      expect(result).toBe(true);
    });

    it('does not cross-contaminate between specialist-tool pairs', () => {
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'tool1', { query: 'test' });
      }

      // Different specialist, same tool and input - tracked separately
      for (let i = 0; i < 4; i++) {
        const result = detector.check('agent2', 'tool1', { query: 'test' });
        expect(result).toBe(false);
      }
      // 5th call for agent2 should loop
      const result = detector.check('agent2', 'tool1', { query: 'test' });
      expect(result).toBe(true);
    });
  });

  describe('stemming edge cases', () => {
    it('does not stem words <= 3 chars', () => {
      detector.check('agent1', 'tool1', { question: 'is was are' });
      detector.check('agent1', 'tool1', { question: 'is was are' });
      detector.check('agent1', 'tool1', { question: 'is was are' });
      detector.check('agent1', 'tool1', { question: 'is was are' });
      const result = detector.check('agent1', 'tool1', { question: 'is was are' });
      expect(result).toBe(true);
    });

    it('handles "ing" suffix', () => {
      // Both normalize to "jump run swim" (alphabetical sort)
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'tool1', { question: 'running jumping swimming' });
      }
      const result = detector.check('agent1', 'tool1', { question: 'running swimming jumping' });
      expect(result).toBe(true);
    });

    it('handles "ed" suffix', () => {
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'tool1', { question: 'tested passed failed' });
      }
      const result = detector.check('agent1', 'tool1', { question: 'test pass fail' });
      expect(result).toBe(true);
    });

    it('handles "ies" -> "y" transformation', () => {
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'tool1', { question: 'cities entries queries' });
      }
      const result = detector.check('agent1', 'tool1', { question: 'city entry query' });
      expect(result).toBe(true);
    });

    it('handles "es" suffix', () => {
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'tool1', { question: 'boxes watches dishes' });
      }
      const result = detector.check('agent1', 'tool1', { question: 'box watch dish' });
      expect(result).toBe(true);
    });

    it('handles "s" suffix but not "ss"', () => {
      for (let i = 0; i < 4; i++) {
        detector.check('agent1', 'tool1', { question: 'cats dogs birds' });
      }
      const result = detector.check('agent1', 'tool1', { question: 'cat dog bird' });
      expect(result).toBe(true);
    });

    it('does not stem "ss" words', () => {
      detector.check('agent1', 'tool1', { question: 'class pass' });
      detector.check('agent1', 'tool1', { question: 'class pass' });
      detector.check('agent1', 'tool1', { question: 'class pass' });
      detector.check('agent1', 'tool1', { question: 'class pass' });
      // "class" and "pass" should NOT stem to "clas" and "pas"
      const result = detector.check('agent1', 'tool1', { question: 'class pass' });
      expect(result).toBe(true);
    });
  });
});
