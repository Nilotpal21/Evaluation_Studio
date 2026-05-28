// SnippetGenerator.test.ts
import { describe, test, expect } from 'vitest';
import {
  generateToolSnippet,
  generateGuardrailSnippet,
  generateGatherFieldSnippet,
  generateFlowStepSnippet,
  generateMemoryVarSnippet,
  generateHandoffSnippet,
  generateConstraintSnippet,
  generateTemplateSnippet,
  applyIndent,
} from './SnippetGenerator';

describe('SnippetGenerator', () => {
  describe('applyIndent', () => {
    test('applies 2-space indent to all lines', () => {
      const snippet = 'line1\nline2\nline3';
      const result = applyIndent(snippet, 2);
      expect(result).toBe('  line1\n  line2\n  line3');
    });

    test('applies 4-space indent', () => {
      const result = applyIndent('foo\nbar', 4);
      expect(result).toBe('    foo\n    bar');
    });

    test('handles empty string', () => {
      expect(applyIndent('', 2)).toBe('');
    });
  });

  describe('generateToolSnippet', () => {
    test('generates minimal tool', () => {
      const snippet = generateToolSnippet({
        name: 'fetch_data',
        description: 'Fetch data from API',
        parameters: [],
        returns: 'object',
      });
      expect(snippet).toContain('fetch_data');
      expect(snippet).toContain('description:');
      expect(snippet).toContain('Fetch data from API');
    });

    test('generates tool with parameters', () => {
      const snippet = generateToolSnippet({
        name: 'search',
        description: 'Search items',
        parameters: [
          { name: 'query', type: 'string', required: true },
          { name: 'limit', type: 'number', required: false },
        ],
        returns: 'object',
      });
      expect(snippet).toContain('query: string');
      expect(snippet).toContain('limit: number');
    });

    test('generates HTTP tool with binding', () => {
      const snippet = generateToolSnippet({
        name: 'get_user',
        description: 'Get user by ID',
        parameters: [{ name: 'userId', type: 'string', required: true }],
        returns: 'object',
        toolType: 'http',
        httpBinding: {
          method: 'GET',
          endpoint: 'https://api.example.com/users/{userId}',
          auth: 'bearer',
        },
      });
      expect(snippet).toContain('type: http');
      expect(snippet).toContain('method: GET');
      expect(snippet).toContain('endpoint:');
      expect(snippet).toContain('auth: bearer');
    });
  });

  describe('generateTemplateSnippet', () => {
    test('generates canonical named template DSL with direct format keys', () => {
      const snippet = generateTemplateSnippet({
        name: 'booking_confirmation',
        content: 'Your booking is confirmed.',
        formats: {
          markdown: '**Your booking is confirmed.**',
          html: '<p><strong>Your booking is confirmed.</strong></p>',
        },
        voiceInstructions: 'Speak clearly and emphasize confirmed.',
      });

      expect(snippet).toContain('booking_confirmation:');
      expect(snippet).toContain('  DEFAULT: |');
      expect(snippet).toContain('    Your booking is confirmed.');
      expect(snippet).toContain('  MARKDOWN: |');
      expect(snippet).toContain('    **Your booking is confirmed.**');
      expect(snippet).toContain('  HTML: |');
      expect(snippet).toContain('    <p><strong>Your booking is confirmed.</strong></p>');
      expect(snippet).toContain('  VOICE INSTRUCTIONS: |');
      expect(snippet).toContain('    Speak clearly and emphasize confirmed.');
      expect(snippet).not.toContain('  content:');
      expect(snippet).not.toContain('  formats:');
    });

    test('preserves multiline format content as block scalars', () => {
      const snippet = generateTemplateSnippet({
        name: 'handoff_notice',
        content: 'I will connect you to a specialist.',
        formats: {
          slack: '*Connecting you now.*\nPlease stay in this thread.',
        },
      });

      expect(snippet).toContain('  SLACK: |');
      expect(snippet).toContain('    *Connecting you now.*\n    Please stay in this thread.');
    });
  });

  describe('generateGuardrailSnippet', () => {
    test('generates input guardrail with CEL check', () => {
      const snippet = generateGuardrailSnippet({
        name: 'pii_guard',
        kind: 'input',
        check: 'not_matches_pattern(input, "\\\\b\\\\d{3}-\\\\d{2}-\\\\d{4}\\\\b")',
        action: 'redact',
        message: 'SSN redacted',
      });
      expect(snippet).toContain('pii_guard:');
      expect(snippet).toContain('kind: input');
      expect(snippet).toContain('action: redact');
    });
  });

  describe('generateGatherFieldSnippet', () => {
    test('generates string field', () => {
      const snippet = generateGatherFieldSnippet({
        name: 'customer_name',
        type: 'string',
        prompt: 'Your name?',
        required: true,
      });
      expect(snippet).toContain('customer_name:');
      expect(snippet).toContain('type: string');
      expect(snippet).toContain('required: true');
    });
  });

  describe('generateFlowStepSnippet', () => {
    test('generates reasoning step', () => {
      const snippet = generateFlowStepSnippet({
        name: 'search',
        reasoning: true,
        goal: 'Find best options',
        exitWhen: 'selected == true',
        maxTurns: 5,
        then: 'confirm',
      });
      expect(snippet).toContain('REASONING: true');
      expect(snippet).toContain('GOAL:');
      expect(snippet).toContain('EXIT_WHEN:');
      expect(snippet).toContain('THEN: confirm');
    });

    test('generates scripted step', () => {
      const snippet = generateFlowStepSnippet({
        name: 'welcome',
        reasoning: false,
        respond: 'Hello!',
        then: 'collect',
      });
      expect(snippet).toContain('REASONING: false');
      expect(snippet).toContain('RESPOND:');
      expect(snippet).toContain('THEN: collect');
    });
  });

  describe('generateHandoffSnippet', () => {
    test('emits raw WHEN expressions without wrapping them in quotes', () => {
      const snippet = generateHandoffSnippet({
        to: 'LookupAgent',
        when: 'input contains "lookup"',
        priority: 1,
      });

      expect(snippet).toContain('TO: LookupAgent');
      expect(snippet).toContain('WHEN: input contains "lookup"');
      expect(snippet).not.toContain('WHEN: "input contains \\"lookup\\""');
    });
  });
});
