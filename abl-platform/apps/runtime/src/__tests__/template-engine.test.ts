import { describe, test, expect } from 'vitest';
import { renderTemplate } from '../services/execution/template-engine';

describe('renderTemplate', () => {
  test('simple variable substitution', () => {
    expect(renderTemplate('Hello {{name}}', { name: 'Alice' })).toBe('Hello Alice');
  });

  test('nested property access', () => {
    expect(renderTemplate('{{user.name}}', { user: { name: 'Bob' } })).toBe('Bob');
  });

  test('undefined variable preserves placeholder', () => {
    expect(renderTemplate('Hello {{unknown}}', {})).toBe('Hello {{unknown}}');
  });

  test('{{#if}} block renders when truthy', () => {
    expect(renderTemplate('{{#if goal}}Goal: {{goal}}{{/if}}', { goal: 'Help users' })).toBe(
      'Goal: Help users',
    );
  });

  test('{{#if}} block omitted when falsy', () => {
    expect(renderTemplate('Start{{#if goal}} Goal: {{goal}}{{/if}} End', {})).toBe('Start End');
  });

  test('{{#if}} block omitted when empty string', () => {
    expect(renderTemplate('{{#if goal}}Goal: {{goal}}{{/if}}', { goal: '' })).toBe('');
  });

  test('{{#each}} block iterates arrays', () => {
    const template = '{{#each items}}- {{name}}\n{{/each}}';
    const result = renderTemplate(template, { items: [{ name: 'A' }, { name: 'B' }] });
    expect(result).toBe('- A\n- B\n');
  });

  test('{{#each}} with @index', () => {
    const template = '{{#each items}}{{@index}}: {{name}}; {{/each}}';
    const result = renderTemplate(template, { items: [{ name: 'A' }, { name: 'B' }] });
    expect(result).toBe('0: A; 1: B; ');
  });

  test('{{#each}} with non-array value is no-op', () => {
    expect(renderTemplate('{{#each items}}x{{/each}}', { items: 'not-array' })).toBe('');
  });

  test('array variable renders as JSON', () => {
    expect(renderTemplate('{{arr}}', { arr: [1, 2] })).toContain('[');
  });

  test('boolean and number coercion', () => {
    expect(renderTemplate('{{count}} {{flag}}', { count: 42, flag: true })).toBe('42 true');
  });
});
