import { describe, expect, it, vi } from 'vitest';

import {
  InputClassifier,
  buildClassifierSystemPrompt,
  createLlmInputClassifier,
} from '../interactive/input-classifier.js';
import type { ClassifiedInput } from '../interactive/types.js';
import type { ModelSpec } from '../types.js';

describe('InputClassifier', () => {
  const classifier = new InputClassifier();

  describe('exact command matching', () => {
    it.each([
      ['help', 'help'],
      ['?', 'help'],
      ['commands', 'help'],
      ['pause', 'pause'],
      ['wait', 'pause'],
      ['hold', 'pause'],
      ['resume', 'resume'],
      ['continue', 'resume'],
      ['go', 'resume'],
      ['proceed', 'resume'],
      ['abort', 'abort'],
      ['stop', 'abort'],
      ['quit', 'abort'],
      ['cancel', 'abort'],
      ['kill', 'abort'],
    ])('classifies "%s" as %s with high confidence', async (input, expectedIntent) => {
      const result = await classifier.classify(input);
      expect(result.intent).toBe(expectedIntent);
      expect(result.confidence).toBeGreaterThanOrEqual(0.95);
    });
  });

  describe('status queries', () => {
    it.each([
      'status',
      "what's happening",
      'what is the status',
      "what's going on",
      'progress',
      'where are we',
    ])('classifies "%s" as status', async (input) => {
      const result = await classifier.classify(input);
      expect(result.intent).toBe('status');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe('skip stage commands', () => {
    it('extracts stage name from "skip regression"', async () => {
      const result = await classifier.classify('skip regression');
      expect(result.intent).toBe('skip-stage');
      expect(result.params['stageName']).toBe('regression');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('extracts stage name from "skip stage Oracle Analysis"', async () => {
      const result = await classifier.classify('skip stage Oracle Analysis');
      expect(result.intent).toBe('skip-stage');
      expect(result.params['stageName']).toBe('Oracle Analysis');
    });
  });

  describe('prioritize commands', () => {
    it('extracts finding ID from "prioritize F-3"', async () => {
      const result = await classifier.classify('prioritize F-3');
      expect(result.intent).toBe('prioritize');
      expect(result.params['findingId']).toBe('F-3');
    });

    it('handles "bump finding abc123"', async () => {
      const result = await classifier.classify('bump finding abc123');
      expect(result.intent).toBe('prioritize');
      expect(result.params['findingId']).toBe('abc123');
    });

    it('handles "escalate F-12"', async () => {
      const result = await classifier.classify('escalate F-12');
      expect(result.intent).toBe('prioritize');
      expect(result.params['findingId']).toBe('F-12');
    });
  });

  describe('context injection', () => {
    it('handles "focus on auth middleware"', async () => {
      const result = await classifier.classify('focus on auth middleware');
      expect(result.intent).toBe('inject-context');
      expect(result.params['content']).toBe('auth middleware');
    });

    it('handles "context: check token refresh flow"', async () => {
      const result = await classifier.classify('context: check token refresh flow');
      expect(result.intent).toBe('inject-context');
      expect(result.params['content']).toBe('check token refresh flow');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('handles "note that the API changed"', async () => {
      const result = await classifier.classify('note that the API changed');
      expect(result.intent).toBe('inject-context');
      expect(result.params['content']).toBe('the API changed');
    });

    it('handles "remember to update the docs"', async () => {
      const result = await classifier.classify('remember to update the docs');
      expect(result.intent).toBe('inject-context');
      expect(result.params['content']).toBe('to update the docs');
    });

    it('handles "add context: the migration script is broken"', async () => {
      const result = await classifier.classify('add context: the migration script is broken');
      expect(result.intent).toBe('inject-context');
      expect(result.params['content']).toBe('the migration script is broken');
    });
  });

  describe('ambiguous input', () => {
    it('classifies multi-word input as inject-context with low confidence', async () => {
      const result = await classifier.classify('maybe we should look at the database layer too');
      expect(result.intent).toBe('inject-context');
      expect(result.confidence).toBeLessThan(0.5);
    });

    it('classifies single unknown word as unknown', async () => {
      const result = await classifier.classify('xyz');
      expect(result.intent).toBe('unknown');
      expect(result.confidence).toBe(0);
    });

    it('classifies empty input as unknown', async () => {
      const result = await classifier.classify('');
      expect(result.intent).toBe('unknown');
      expect(result.confidence).toBe(0);
    });

    it('classifies whitespace-only input as unknown', async () => {
      const result = await classifier.classify('   ');
      expect(result.intent).toBe('unknown');
      expect(result.confidence).toBe(0);
    });
  });

  describe('LLM classifier integration', () => {
    it('uses LLM classifier when pattern confidence is low', async () => {
      const llmClassify = async (input: string): Promise<ClassifiedInput> => ({
        intent: 'inject-context',
        confidence: 0.9,
        rawInput: input,
        params: { content: input },
      });

      const classifierWithLlm = new InputClassifier({ llmClassify });
      const result = await classifierWithLlm.classify('ab');
      // Single word < 3 words → unknown by pattern (confidence 0), but LLM returns inject-context at 0.9
      expect(result.intent).toBe('inject-context');
      expect(result.confidence).toBe(0.9);
    });

    it('prefers pattern result when pattern confidence is high', async () => {
      let llmCalled = false;
      const llmClassify = async (input: string): Promise<ClassifiedInput> => {
        llmCalled = true;
        return { intent: 'unknown', confidence: 1.0, rawInput: input, params: {} };
      };

      const classifierWithLlm = new InputClassifier({ llmClassify });
      const result = await classifierWithLlm.classify('help');
      expect(result.intent).toBe('help');
      expect(llmCalled).toBe(false);
    });

    it('falls back to pattern result when LLM throws', async () => {
      const llmClassify = async (): Promise<ClassifiedInput> => {
        throw new Error('API unavailable');
      };

      const classifierWithLlm = new InputClassifier({ llmClassify });
      // "xy" is 1 word, pattern returns unknown at 0
      const result = await classifierWithLlm.classify('xy');
      expect(result.intent).toBe('unknown');
    });

    it('creates a router-backed LLM classifier and parses fenced JSON output', async () => {
      const execute = vi.fn().mockResolvedValue({
        output:
          '```json\n{"intent":"prioritize","confidence":0.82,"params":{"findingId":"F-9"}}\n```',
        model: 'gpt-5.5',
        engine: 'codex-cli',
        turnsUsed: 1,
        durationMs: 25,
      });

      const classifier = createLlmInputClassifier(
        { execute } as unknown as {
          execute: typeof execute;
        },
        {
          engine: 'codex-cli',
          model: 'gpt-5.5',
          effort: 'medium',
        } satisfies ModelSpec,
      );

      const result = await classifier('please bump F-9');

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[0]).toContain('Classify the following HELIX REPL input');
      expect(execute.mock.calls[0]?.[1]).toEqual({
        primary: expect.objectContaining({
          engine: 'codex-cli',
          model: 'gpt-5.5',
          effort: 'low',
          maxTurns: 1,
        }),
      });
      expect(result).toEqual({
        intent: 'prioritize',
        confidence: 0.82,
        rawInput: 'please bump F-9',
        params: { findingId: 'F-9' },
      });
    });

    it('throws when the router-backed LLM classifier receives an execution error', async () => {
      const classifier = createLlmInputClassifier(
        {
          execute: vi.fn().mockResolvedValue({
            output: '',
            model: 'gpt-5.5',
            engine: 'codex-cli',
            turnsUsed: 0,
            durationMs: 10,
            error: 'model unavailable',
          }),
        } as unknown as {
          execute: (
            prompt: string,
            assignment: unknown,
            tools?: string[],
            onStream?: unknown,
            outputSchema?: unknown,
            timeoutMs?: number,
          ) => Promise<{
            output: string;
            model: string;
            engine: string;
            turnsUsed: number;
            durationMs: number;
            error?: string;
          }>;
        },
        { engine: 'codex-cli', model: 'gpt-5.5' } satisfies ModelSpec,
      );

      await expect(classifier('resume')).rejects.toThrow('model unavailable');
    });
  });

  describe('buildClassifierSystemPrompt', () => {
    it('returns a non-empty system prompt with all intents', () => {
      const prompt = buildClassifierSystemPrompt();
      expect(prompt).toContain('inject-context');
      expect(prompt).toContain('skip-stage');
      expect(prompt).toContain('pause');
      expect(prompt).toContain('resume');
      expect(prompt).toContain('abort');
      expect(prompt).toContain('status');
      expect(prompt).toContain('prioritize');
      expect(prompt).toContain('help');
      expect(prompt).toContain('unknown');
      expect(prompt).toContain('JSON');
    });
  });

  describe('case insensitivity', () => {
    it.each([
      ['HELP', 'help'],
      ['Status', 'status'],
      ['PAUSE', 'pause'],
      ['Skip regression', 'skip-stage'],
      ['ABORT', 'abort'],
    ])('classifies "%s" correctly regardless of case', async (input, expectedIntent) => {
      const result = await classifier.classify(input);
      expect(result.intent).toBe(expectedIntent);
    });
  });
});
