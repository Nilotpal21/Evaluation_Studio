/**
 * Template Engine Tests
 *
 * Tests renderTemplate including {{add @index N}}, getNestedValue edge cases,
 * and all template features.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderTemplate } from '../prompts/template-engine.js';

describe('renderTemplate', () => {
  // ===========================================================================
  // Simple variable substitution
  // ===========================================================================

  describe('variable substitution', () => {
    it('should replace simple variables', () => {
      const result = renderTemplate('Hello, {{name}}!', { name: 'World' });
      expect(result).toBe('Hello, World!');
    });

    it('should preserve undefined variables', () => {
      const result = renderTemplate('Hello, {{name}}!', {});
      expect(result).toBe('Hello, {{name}}!');
    });

    it('should replace empty string values', () => {
      const result = renderTemplate('Hello, {{name}}!', { name: '' });
      expect(result).toBe('Hello, !');
    });

    it('should handle nested paths', () => {
      const result = renderTemplate('{{user.name}}', { user: { name: 'Alice' } });
      expect(result).toBe('Alice');
    });

    it('should preserve nested path when value is undefined', () => {
      const result = renderTemplate('{{user.name}}', { user: {} });
      expect(result).toBe('{{user.name}}');
    });

    it('should render arrays as JSON', () => {
      const result = renderTemplate('Items: {{items}}', { items: [1, 2, 3] });
      expect(result).toBe('Items: [\n  1,\n  2,\n  3\n]');
    });

    it('should handle null value', () => {
      const result = renderTemplate('{{val}}', { val: null });
      expect(result).toBe('null');
    });

    it('should handle false value', () => {
      const result = renderTemplate('{{val}}', { val: false });
      expect(result).toBe('false');
    });

    it('should handle numeric value', () => {
      const result = renderTemplate('{{count}}', { count: 42 });
      expect(result).toBe('42');
    });

    it('should render supported filters without leaking raw template syntax', () => {
      const result = renderTemplate('Hello, {{user.name | upper}}!', {
        user: { name: 'Alice' },
      });
      expect(result).toBe('Hello, ALICE!');
    });

    it('should fail closed for unsupported filters', () => {
      const result = renderTemplate('Hello, {{user.name | unknown_filter}}!', {
        user: { name: 'Alice' },
      });
      expect(result).toBe('Hello, !');
    });

    it('should render relative-time filters like ago', () => {
      const nowSpy = vi
        .spyOn(Date, 'now')
        .mockReturnValue(new Date('2026-04-19T12:00:00.000Z').valueOf());

      try {
        const result = renderTemplate('Seen {{user.last_seen | ago}}', {
          user: { last_seen: '2026-04-19T11:59:00.000Z' },
        });
        expect(result).toBe('Seen 1m ago');
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  // ===========================================================================
  // Nested path resolution — getNestedValue edge cases
  // ===========================================================================

  describe('getNestedValue edge cases', () => {
    it('should return undefined when traversing through non-object', () => {
      const result = renderTemplate('{{a.b.c}}', { a: 'string-not-object' });
      expect(result).toBe('{{a.b.c}}');
    });

    it('should return undefined when traversing through null', () => {
      const result = renderTemplate('{{a.b}}', { a: null });
      expect(result).toBe('{{a.b}}');
    });

    it('should return undefined when traversing through number', () => {
      const result = renderTemplate('{{a.b}}', { a: 42 });
      expect(result).toBe('{{a.b}}');
    });

    it('should return undefined when traversing through boolean', () => {
      const result = renderTemplate('{{a.b}}', { a: true });
      expect(result).toBe('{{a.b}}');
    });

    it('should handle deeply nested path', () => {
      const result = renderTemplate('{{a.b.c.d}}', {
        a: { b: { c: { d: 'deep' } } },
      });
      expect(result).toBe('deep');
    });
  });

  // ===========================================================================
  // Conditional blocks
  // ===========================================================================

  describe('{{#if}} blocks', () => {
    it('should render block when value is truthy', () => {
      const result = renderTemplate('{{#if show}}Visible{{/if}}', { show: true });
      expect(result).toBe('Visible');
    });

    it('should not render block when value is falsy', () => {
      const result = renderTemplate('{{#if show}}Visible{{/if}}', { show: false });
      expect(result).toBe('');
    });

    it('should not render block when value is undefined', () => {
      const result = renderTemplate('{{#if show}}Visible{{/if}}', {});
      expect(result).toBe('');
    });

    it('should support nested paths in condition', () => {
      const result = renderTemplate('{{#if user.active}}Active{{/if}}', {
        user: { active: true },
      });
      expect(result).toBe('Active');
    });

    it('should render variables within conditional block', () => {
      const result = renderTemplate('{{#if show}}Hello, {{name}}!{{/if}}', {
        show: true,
        name: 'World',
      });
      expect(result).toBe('Hello, World!');
    });
  });

  // ===========================================================================
  // Each blocks
  // ===========================================================================

  describe('{{#each}} blocks', () => {
    it('should iterate over array', () => {
      const result = renderTemplate('{{#each items}}{{name}},{{/each}}', {
        items: [{ name: 'a' }, { name: 'b' }],
      });
      expect(result).toBe('a,b,');
    });

    it('should provide @index', () => {
      const result = renderTemplate('{{#each items}}{{@index}}{{/each}}', {
        items: ['a', 'b', 'c'],
      });
      expect(result).toBe('012');
    });

    it('should support {{add @index N}} helper', () => {
      const result = renderTemplate('{{#each items}}{{add @index 1}},{{/each}}', {
        items: ['a', 'b', 'c'],
      });
      expect(result).toBe('1,2,3,');
    });

    it('should return empty string for non-array value', () => {
      const result = renderTemplate('{{#each items}}item{{/each}}', { items: 'not-array' });
      expect(result).toBe('');
    });

    it('should return empty string for undefined value', () => {
      const result = renderTemplate('{{#each items}}item{{/each}}', {});
      expect(result).toBe('');
    });

    it('should handle empty array', () => {
      const result = renderTemplate('{{#each items}}item{{/each}}', { items: [] });
      expect(result).toBe('');
    });

    it('should handle non-object items in array', () => {
      const result = renderTemplate('{{#each items}}[{{@index}}]{{/each}}', {
        items: ['a', 'b'],
      });
      expect(result).toBe('[0][1]');
    });

    it('should replace item properties with empty string when not found', () => {
      const result = renderTemplate('{{#each items}}{{name}}|{{missing}}|{{/each}}', {
        items: [{ name: 'a' }],
      });
      expect(result).toBe('a||');
    });

    it('should iterate over an array reached via a dotted path', () => {
      const result = renderTemplate(
        '{{#each flight_results.results}}{{airline}} {{flightNumber}};{{/each}}',
        {
          flight_results: {
            results: [
              { airline: 'AA', flightNumber: '100' },
              { airline: 'BA', flightNumber: '200' },
            ],
          },
        },
      );
      expect(result).toBe('AA 100;BA 200;');
    });

    it('should support @index and add helper inside dotted-path each', () => {
      const result = renderTemplate(
        '{{#each flight_results.results}}{{add @index 1}}.{{airline}} {{/each}}',
        {
          flight_results: {
            results: [{ airline: 'AA' }, { airline: 'BA' }, { airline: 'CA' }],
          },
        },
      );
      expect(result).toBe('1.AA 2.BA 3.CA ');
    });

    it('should return empty string when dotted path resolves to a non-array', () => {
      const result = renderTemplate('{{#each a.b}}x{{/each}}', { a: { b: 'not-array' } });
      expect(result).toBe('');
    });
  });

  // ===========================================================================
  // Combined features
  // ===========================================================================

  describe('combined features', () => {
    it('should handle template with all features', () => {
      const template = `Name: {{name}}
{{#if goal}}Goal: {{goal}}{{/if}}
Items:{{#each items}} {{add @index 1}}.{{label}}{{/each}}`;

      const result = renderTemplate(template, {
        name: 'Bot',
        goal: 'Help users',
        items: [{ label: 'First' }, { label: 'Second' }],
      });

      expect(result).toContain('Name: Bot');
      expect(result).toContain('Goal: Help users');
      expect(result).toContain('1.First');
      expect(result).toContain('2.Second');
    });
  });
});
