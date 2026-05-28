import { describe, test, expect } from 'vitest';
import { substituteTemplates } from '../pipeline/template-engine.js';

describe('substituteTemplates', () => {
  test('substitutes simple variables', () => {
    expect(substituteTemplates('Hello {{name}}', { name: 'World' })).toBe('Hello World');
  });

  test('substitutes nested paths', () => {
    expect(substituteTemplates('Score: {{output.score}}', { output: { score: 0.9 } })).toBe(
      'Score: 0.9',
    );
  });

  test('replaces missing variables with empty string', () => {
    expect(substituteTemplates('Hello {{missing}}', {})).toBe('Hello ');
  });

  test('handles multiple substitutions', () => {
    expect(substituteTemplates('{{a}} and {{b}}', { a: 'X', b: 'Y' })).toBe('X and Y');
  });

  test('handles no template patterns', () => {
    expect(substituteTemplates('plain text', {})).toBe('plain text');
  });

  test('stringifies non-string values', () => {
    expect(substituteTemplates('count: {{n}}', { n: 42 })).toBe('count: 42');
    expect(substituteTemplates('flag: {{b}}', { b: true })).toBe('flag: true');
  });

  test('handles objects by JSON stringifying', () => {
    expect(substituteTemplates('data: {{obj}}', { obj: { a: 1 } })).toBe('data: {"a":1}');
  });
});
