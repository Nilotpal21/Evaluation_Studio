/**
 * Value Resolution — Comprehensive Unit Tests
 *
 * Tests all exported pure functions from the value-resolution module:
 *   - getNestedValue
 *   - interpolateTemplate
 *   - interpolateVoiceConfig
 *   - interpolateRichContent
 *   - resolveSetValue
 *   - resolveValuePath
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockWarn = vi.fn();
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: (...args: unknown[]) => mockWarn(...args),
    error: vi.fn(),
  }),
}));

import {
  getNestedValue,
  interpolateTemplate,
  interpolateVoiceConfig,
  interpolateRichContent,
  resolveSetValue,
  resolveValuePath,
} from '../../services/execution/value-resolution.js';

// ---------------------------------------------------------------------------
// getNestedValue
// ---------------------------------------------------------------------------
describe('getNestedValue', () => {
  it('returns a top-level property', () => {
    expect(getNestedValue({ name: 'Alice' }, 'name')).toBe('Alice');
  });

  it('returns a deeply nested property (4 levels)', () => {
    const data = { user: { profile: { tier: { level: 'gold' } } } };
    expect(getNestedValue(data, 'user.profile.tier.level')).toBe('gold');
  });

  it('returns undefined for a missing top-level key', () => {
    expect(getNestedValue({}, 'missing')).toBeUndefined();
  });

  it('returns undefined when an intermediate segment is missing', () => {
    expect(getNestedValue({ a: { b: 1 } }, 'a.c.d')).toBeUndefined();
  });

  it('returns undefined when traversing through a primitive (number)', () => {
    expect(getNestedValue({ a: 42 }, 'a.b')).toBeUndefined();
  });

  it('returns undefined when traversing through a primitive (string)', () => {
    expect(getNestedValue({ a: 'hello' }, 'a.b')).toBeUndefined();
  });

  it('returns undefined when traversing through a primitive (boolean)', () => {
    expect(getNestedValue({ a: true }, 'a.b')).toBeUndefined();
  });

  it('returns undefined when traversing through null', () => {
    expect(getNestedValue({ a: null } as Record<string, unknown>, 'a.b')).toBeUndefined();
  });

  it('returns the value when it is null', () => {
    expect(getNestedValue({ x: null }, 'x')).toBeNull();
  });

  it('returns the value when it is 0', () => {
    expect(getNestedValue({ count: 0 }, 'count')).toBe(0);
  });

  it('returns the value when it is an empty string', () => {
    expect(getNestedValue({ label: '' }, 'label')).toBe('');
  });

  it('returns the value when it is false', () => {
    expect(getNestedValue({ active: false }, 'active')).toBe(false);
  });

  it('returns an array value', () => {
    const data = { items: [1, 2, 3] };
    expect(getNestedValue(data, 'items')).toEqual([1, 2, 3]);
  });

  it('returns an object value (reference equality)', () => {
    const nested = { x: 10 };
    expect(getNestedValue({ obj: nested }, 'obj')).toBe(nested);
  });

  it('handles single-segment path', () => {
    expect(getNestedValue({ a: 'val' }, 'a')).toBe('val');
  });

  it('handles a two-segment path', () => {
    expect(getNestedValue({ a: { b: 99 } }, 'a.b')).toBe(99);
  });

  it('returns undefined for empty object at intermediate level', () => {
    expect(getNestedValue({ a: {} }, 'a.b')).toBeUndefined();
  });

  it('handles nested arrays as values', () => {
    const data = { config: { tags: ['a', 'b', 'c'] } };
    expect(getNestedValue(data, 'config.tags')).toEqual(['a', 'b', 'c']);
  });

  it('resolves bracket-indexed array paths', () => {
    const data = {
      lookup_phone_record: {
        result: [{ pin: '4321' }],
      },
    };

    expect(getNestedValue(data, 'lookup_phone_record.result[0].pin')).toBe('4321');
  });

  it('returns NaN stored as value', () => {
    const data = { val: NaN };
    expect(getNestedValue(data, 'val')).toBeNaN();
  });

  it('returns undefined stored as value', () => {
    const data = { val: undefined };
    expect(getNestedValue(data, 'val')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// interpolateTemplate -- simple variable replacement
// ---------------------------------------------------------------------------
describe('interpolateTemplate', () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  describe('simple {{variable}} replacement', () => {
    it('replaces a single variable', () => {
      expect(interpolateTemplate('Hello {{name}}', { name: 'Bob' })).toBe('Hello Bob');
    });

    it('replaces multiple variables', () => {
      expect(interpolateTemplate('{{greeting}}, {{name}}!', { greeting: 'Hi', name: 'Eve' })).toBe(
        'Hi, Eve!',
      );
    });

    it('leaves unresolved variables as-is and warns', () => {
      const result = interpolateTemplate('Hello {{unknown}}', {});
      expect(result).toBe('Hello {{unknown}}');
      expect(mockWarn).toHaveBeenCalled();
    });

    it('coerces numbers to strings', () => {
      expect(interpolateTemplate('Count: {{n}}', { n: 42 })).toBe('Count: 42');
    });

    it('coerces booleans to strings', () => {
      expect(interpolateTemplate('Flag: {{flag}}', { flag: true })).toBe('Flag: true');
    });

    it('handles empty template', () => {
      expect(interpolateTemplate('', { x: 1 })).toBe('');
    });

    it('handles template with no placeholders', () => {
      expect(interpolateTemplate('plain text', {})).toBe('plain text');
    });

    it('serializes arrays as pretty JSON', () => {
      const result = interpolateTemplate('Items: {{items}}', { items: [1, 2] });
      expect(result).toContain('[');
      expect(result).toContain('1');
      expect(result).toContain('2');
      // Verify pretty-printed format (JSON.stringify with indent 2)
      const expected = JSON.stringify([1, 2], null, 2);
      expect(result).toBe(`Items: ${expected}`);
    });

    it('handles nested dot-notation paths', () => {
      expect(interpolateTemplate('Tier: {{user.tier}}', { user: { tier: 'gold' } })).toBe(
        'Tier: gold',
      );
    });

    it('handles deeply nested paths', () => {
      const data = { a: { b: { c: { d: 'deep' } } } };
      expect(interpolateTemplate('{{a.b.c.d}}', data)).toBe('deep');
    });

    it('leaves unresolved nested paths as-is', () => {
      const result = interpolateTemplate('{{user.missing}}', { user: {} });
      expect(result).toBe('{{user.missing}}');
    });

    it('replaces same variable appearing multiple times', () => {
      expect(interpolateTemplate('{{x}} and {{x}} again', { x: 'val' })).toBe('val and val again');
    });

    it('renders supported filters like upper without leaking raw template syntax', () => {
      expect(interpolateTemplate('Hello {{user.name | upper}}', { user: { name: 'alice' } })).toBe(
        'Hello ALICE',
      );
    });

    it('fails closed for unsupported filters instead of leaking raw handlebars', () => {
      expect(
        interpolateTemplate('Hello {{user.name | unknown_filter}}', { user: { name: 'alice' } }),
      ).toBe('Hello ');
    });

    it('replaces adjacent variables with no separator', () => {
      expect(interpolateTemplate('{{a}}{{b}}', { a: 'foo', b: 'bar' })).toBe('foobar');
    });

    it('renders relative-time filters like ago without leaking raw handlebars', () => {
      const nowSpy = vi
        .spyOn(Date, 'now')
        .mockReturnValue(new Date('2026-04-19T12:00:00.000Z').valueOf());

      try {
        const rendered = interpolateTemplate('Seen {{user.last_seen | ago}}', {
          user: { last_seen: '2026-04-19T11:59:00.000Z' },
        });
        expect(rendered).toBe('Seen 1m ago');
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('coerces null to "null" string', () => {
      // null is not undefined, so it gets stringified
      expect(interpolateTemplate('Value: {{v}}', { v: null })).toBe('Value: null');
    });

    it('coerces zero to "0" string', () => {
      expect(interpolateTemplate('{{n}}', { n: 0 })).toBe('0');
    });

    it('handles variable names with underscores', () => {
      expect(interpolateTemplate('{{my_var}}', { my_var: 'ok' })).toBe('ok');
    });

    it('handles numeric string values', () => {
      expect(interpolateTemplate('Age: {{age}}', { age: '25' })).toBe('Age: 25');
    });

    it('handles object values (serialized with toString)', () => {
      // Objects get String() conversion: "[object Object]"
      expect(interpolateTemplate('Obj: {{o}}', { o: { key: 'val' } })).toBe('Obj: [object Object]');
    });
  });

  // -------------------------------------------------------------------------
  // {{#if variable}}...{{/if}}
  // -------------------------------------------------------------------------
  describe('{{#if}} blocks', () => {
    it('renders the block when the condition is truthy (boolean true)', () => {
      expect(interpolateTemplate('{{#if premium}}VIP{{/if}}', { premium: true })).toBe('VIP');
    });

    it('omits the block when the condition is falsy (boolean false)', () => {
      expect(interpolateTemplate('{{#if premium}}VIP{{/if}}', { premium: false })).toBe('');
    });

    it('omits the block when the variable is undefined', () => {
      expect(interpolateTemplate('{{#if premium}}VIP{{/if}}', {})).toBe('');
    });

    it('omits the block when the variable is 0', () => {
      expect(interpolateTemplate('{{#if count}}Has items{{/if}}', { count: 0 })).toBe('');
    });

    it('omits the block when the variable is empty string', () => {
      expect(interpolateTemplate('{{#if name}}Hello {{name}}{{/if}}', { name: '' })).toBe('');
    });

    it('omits the block when the variable is null', () => {
      expect(interpolateTemplate('{{#if val}}Present{{/if}}', { val: null })).toBe('');
    });

    it('renders the block when the variable is a non-empty string', () => {
      expect(interpolateTemplate('{{#if name}}Hello {{name}}{{/if}}', { name: 'Alice' })).toBe(
        'Hello Alice',
      );
    });

    it('renders the block when the variable is a positive number', () => {
      expect(interpolateTemplate('{{#if count}}Count: {{count}}{{/if}}', { count: 5 })).toBe(
        'Count: 5',
      );
    });

    it('renders the block when the variable is a non-empty array (truthy)', () => {
      expect(interpolateTemplate('{{#if items}}Has items{{/if}}', { items: [1] })).toBe(
        'Has items',
      );
    });

    it('renders the block when the variable is an empty array (truthy: arrays are truthy)', () => {
      // Empty arrays are truthy in JS
      expect(interpolateTemplate('{{#if items}}Has items{{/if}}', { items: [] })).toBe('Has items');
    });

    it('handles nested dot-path conditions (truthy)', () => {
      expect(
        interpolateTemplate('{{#if user.premium}}VIP{{/if}}', { user: { premium: true } }),
      ).toBe('VIP');
    });

    it('handles nested dot-path conditions (falsy)', () => {
      expect(
        interpolateTemplate('{{#if user.premium}}VIP{{/if}}', { user: { premium: false } }),
      ).toBe('');
    });

    it('handles nested dot-path where intermediate is missing', () => {
      expect(interpolateTemplate('{{#if user.premium}}VIP{{/if}}', { user: {} })).toBe('');
    });

    it('handles if block with surrounding text', () => {
      const template = 'Start {{#if show}}middle{{/if}} end';
      expect(interpolateTemplate(template, { show: true })).toBe('Start middle end');
      expect(interpolateTemplate(template, { show: false })).toBe('Start  end');
    });

    it('handles multiple if blocks', () => {
      const template = '{{#if a}}A{{/if}}{{#if b}}B{{/if}}';
      expect(interpolateTemplate(template, { a: true, b: true })).toBe('AB');
      expect(interpolateTemplate(template, { a: true, b: false })).toBe('A');
      expect(interpolateTemplate(template, { a: false, b: true })).toBe('B');
      expect(interpolateTemplate(template, { a: false, b: false })).toBe('');
    });

    it('recursively interpolates variables inside the if block', () => {
      expect(
        interpolateTemplate('{{#if active}}Welcome {{user}}!{{/if}}', {
          active: true,
          user: 'Carol',
        }),
      ).toBe('Welcome Carol!');
    });

    it('handles multiline content inside if block', () => {
      const template = '{{#if show}}Line 1\nLine 2{{/if}}';
      expect(interpolateTemplate(template, { show: true })).toBe('Line 1\nLine 2');
    });

    it('handles if block with only whitespace content', () => {
      expect(interpolateTemplate('{{#if show}}   {{/if}}', { show: true })).toBe('   ');
    });
  });

  // -------------------------------------------------------------------------
  // {{#each array}}...{{/each}}
  // -------------------------------------------------------------------------
  describe('{{#each}} blocks', () => {
    it('iterates over an array of objects', () => {
      const data = {
        items: [
          { name: 'Apple', price: 1 },
          { name: 'Banana', price: 2 },
        ],
      };
      const template = '{{#each items}}{{name}}: ${{price}}; {{/each}}';
      expect(interpolateTemplate(template, data)).toBe('Apple: $1; Banana: $2; ');
    });

    it('replaces {{@index}} with the current index', () => {
      const data = { items: [{ name: 'A' }, { name: 'B' }] };
      const template = '{{#each items}}{{@index}}-{{name}} {{/each}}';
      expect(interpolateTemplate(template, data)).toBe('0-A 1-B ');
    });

    it('supports {{add @index 1}} helper (1-based numbering)', () => {
      const data = { items: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] };
      const template = '{{#each items}}{{add @index 1}}.{{name}} {{/each}}';
      expect(interpolateTemplate(template, data)).toBe('1.A 2.B 3.C ');
    });

    it('supports {{add @index N}} with larger offsets', () => {
      const data = { items: [{ name: 'X' }] };
      const template = '{{#each items}}{{add @index 10}}{{/each}}';
      expect(interpolateTemplate(template, data)).toBe('10');
    });

    it('supports multiple {{@index}} in same iteration', () => {
      const data = { items: [{ name: 'A' }] };
      const template = '{{#each items}}[{{@index}}] {{name}} ({{@index}}){{/each}}';
      expect(interpolateTemplate(template, data)).toBe('[0] A (0)');
    });

    it('returns the original match when the variable is not an array', () => {
      const template = '{{#each items}}{{name}}{{/each}}';
      expect(interpolateTemplate(template, { items: 'not-an-array' })).toBe(template);
    });

    it('returns the original match when the variable is a number', () => {
      const template = '{{#each items}}{{name}}{{/each}}';
      expect(interpolateTemplate(template, { items: 42 })).toBe(template);
    });

    it('returns the original match when the variable is missing', () => {
      const template = '{{#each items}}{{name}}{{/each}}';
      expect(interpolateTemplate(template, {})).toBe(template);
    });

    it('produces empty string for an empty array', () => {
      expect(interpolateTemplate('{{#each items}}{{name}}{{/each}}', { items: [] })).toBe('');
    });

    it('handles missing properties in item objects gracefully (warns)', () => {
      const data = { items: [{ name: 'A' }] };
      const template = '{{#each items}}{{name}}-{{missing}}{{/each}}';
      const result = interpolateTemplate(template, data);
      expect(result).toBe('A-');
      expect(mockWarn).toHaveBeenCalled();
    });

    it('handles each block with surrounding text', () => {
      const data = { nums: [{ v: 1 }, { v: 2 }] };
      const result = interpolateTemplate('Before {{#each nums}}{{v}} {{/each}}After', data);
      expect(result).toBe('Before 1 2 After');
    });

    it('handles multiline content inside each block', () => {
      const data = { items: [{ name: 'X' }] };
      const template = '{{#each items}}\nLine: {{name}}\n{{/each}}';
      expect(interpolateTemplate(template, data)).toContain('Line: X');
    });

    it('handles single-item arrays', () => {
      const data = { items: [{ val: 'only' }] };
      expect(interpolateTemplate('{{#each items}}{{val}}{{/each}}', data)).toBe('only');
    });

    it('handles items with numeric property values', () => {
      const data = { items: [{ count: 42 }, { count: 0 }] };
      const template = '{{#each items}}{{count}},{{/each}}';
      expect(interpolateTemplate(template, data)).toBe('42,0,');
    });

    it('handles items with boolean property values', () => {
      const data = { items: [{ active: true }, { active: false }] };
      const template = '{{#each items}}{{active}} {{/each}}';
      expect(interpolateTemplate(template, data)).toBe('true false ');
    });

    it('iterates over an array reached via a dotted path', () => {
      const data = {
        flight_results: {
          results: [
            { airline: 'AA', flightNumber: '100' },
            { airline: 'BA', flightNumber: '200' },
          ],
        },
      };
      const template = '{{#each flight_results.results}}{{airline}} {{flightNumber}};{{/each}}';
      expect(interpolateTemplate(template, data)).toBe('AA 100;BA 200;');
    });

    it('supports @index and item props together on a dotted-path array', () => {
      const data = {
        flight_results: {
          results: [{ airline: 'AA' }, { airline: 'BA' }, { airline: 'CA' }],
        },
      };
      const template = '{{#each flight_results.results}}{{add @index 1}}.{{airline}} {{/each}}';
      expect(interpolateTemplate(template, data)).toBe('1.AA 2.BA 3.CA ');
    });

    it('returns the original match when the dotted path resolves to a non-array', () => {
      const template = '{{#each a.b}}x{{/each}}';
      expect(interpolateTemplate(template, { a: { b: 'not-an-array' } })).toBe(template);
    });
  });

  // -------------------------------------------------------------------------
  // combined blocks
  // -------------------------------------------------------------------------
  describe('combined template blocks', () => {
    it('handles if + simple variables together', () => {
      const template = 'Hello {{name}}. {{#if vip}}Welcome VIP!{{/if}}';
      expect(interpolateTemplate(template, { name: 'Dan', vip: true })).toBe(
        'Hello Dan. Welcome VIP!',
      );
    });

    it('handles each + simple variables together', () => {
      const template = 'User: {{user}}. Items: {{#each items}}{{name}} {{/each}}';
      const data = { user: 'Eve', items: [{ name: 'A' }, { name: 'B' }] };
      expect(interpolateTemplate(template, data)).toBe('User: Eve. Items: A B ');
    });

    it('handles multiple each blocks', () => {
      const data = {
        fruits: [{ n: 'apple' }],
        vegs: [{ n: 'carrot' }],
      };
      const template = 'Fruits: {{#each fruits}}{{n}}{{/each}} Vegs: {{#each vegs}}{{n}}{{/each}}';
      expect(interpolateTemplate(template, data)).toBe('Fruits: apple Vegs: carrot');
    });

    it('handles each block after if block', () => {
      const data = { show: true, items: [{ x: 1 }, { x: 2 }] };
      const template = '{{#if show}}List: {{/if}}{{#each items}}{{x}} {{/each}}';
      expect(interpolateTemplate(template, data)).toBe('List: 1 2 ');
    });
  });
});

// ---------------------------------------------------------------------------
// interpolateVoiceConfig
// ---------------------------------------------------------------------------
describe('interpolateVoiceConfig', () => {
  it('interpolates all voice config fields', () => {
    const vc = {
      ssml: '<speak>Hello {{name}}</speak>',
      instructions: 'Greet {{name}}',
      plain_text: 'Hi {{name}}',
    };
    const result = interpolateVoiceConfig(vc, { name: 'Alice' });
    expect(result.ssml).toBe('<speak>Hello Alice</speak>');
    expect(result.instructions).toBe('Greet Alice');
    expect(result.plain_text).toBe('Hi Alice');
  });

  it('returns undefined for missing fields', () => {
    const vc = { ssml: undefined, instructions: undefined, plain_text: undefined };
    const result = interpolateVoiceConfig(vc, { name: 'Bob' });
    expect(result.ssml).toBeUndefined();
    expect(result.instructions).toBeUndefined();
    expect(result.plain_text).toBeUndefined();
  });

  it('handles mixed present and absent fields', () => {
    const vc = { ssml: 'Hello {{name}}', instructions: undefined, plain_text: undefined };
    const result = interpolateVoiceConfig(vc, { name: 'Carol' });
    expect(result.ssml).toBe('Hello Carol');
    expect(result.instructions).toBeUndefined();
    expect(result.plain_text).toBeUndefined();
  });

  it('handles templates with no variables', () => {
    const vc = { ssml: '<speak>Hi</speak>', instructions: undefined, plain_text: undefined };
    const result = interpolateVoiceConfig(vc, {});
    expect(result.ssml).toBe('<speak>Hi</speak>');
  });

  it('preserves voice config structure (all three keys present)', () => {
    const vc = { ssml: 'a', instructions: 'b', plain_text: 'c' };
    const result = interpolateVoiceConfig(vc, {});
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining(['ssml', 'instructions', 'plain_text']),
    );
  });

  it('handles nested variable paths in voice fields', () => {
    const vc = {
      ssml: '<speak>Hi {{user.name}}</speak>',
      instructions: undefined,
      plain_text: '{{user.name}}',
    };
    const result = interpolateVoiceConfig(vc, { user: { name: 'Diana' } });
    expect(result.ssml).toBe('<speak>Hi Diana</speak>');
    expect(result.plain_text).toBe('Diana');
  });

  it('handles empty string fields (not undefined)', () => {
    const vc = { ssml: '', instructions: '', plain_text: '' };
    const result = interpolateVoiceConfig(vc, { x: 1 });
    expect(result.ssml).toBe('');
    expect(result.instructions).toBe('');
    expect(result.plain_text).toBe('');
  });
});

// ---------------------------------------------------------------------------
// interpolateRichContent
// ---------------------------------------------------------------------------
describe('interpolateRichContent', () => {
  it('interpolates all rich content fields', () => {
    const rc = {
      markdown: '# {{title}}',
      adaptive_card: '{"body": "{{body}}"}',
      html: '<h1>{{title}}</h1>',
      slack: '{"text": "{{msg}}"}',
      ag_ui: '{"type": "{{kind}}"}',
      whatsapp: '{{greeting}}',
    };
    const data = { title: 'Test', body: 'Content', msg: 'Hi', kind: 'card', greeting: 'Hello' };
    const result = interpolateRichContent(rc, data);

    expect(result.markdown).toBe('# Test');
    expect(result.adaptive_card).toBe('{"body": "Content"}');
    expect(result.html).toBe('<h1>Test</h1>');
    expect(result.slack).toBe('{"text": "Hi"}');
    expect(result.ag_ui).toBe('{"type": "card"}');
    expect(result.whatsapp).toBe('Hello');
  });

  it('returns undefined for all missing fields', () => {
    const rc = {
      markdown: undefined,
      adaptive_card: undefined,
      html: undefined,
      slack: undefined,
      ag_ui: undefined,
      whatsapp: undefined,
    };
    const result = interpolateRichContent(rc, { x: 1 });
    expect(result.markdown).toBeUndefined();
    expect(result.adaptive_card).toBeUndefined();
    expect(result.html).toBeUndefined();
    expect(result.slack).toBeUndefined();
    expect(result.ag_ui).toBeUndefined();
    expect(result.whatsapp).toBeUndefined();
  });

  it('handles mixed present and absent fields', () => {
    const rc = {
      markdown: '**{{text}}**',
      adaptive_card: undefined,
      html: undefined,
      slack: undefined,
      ag_ui: undefined,
      whatsapp: undefined,
    };
    const result = interpolateRichContent(rc, { text: 'bold' });
    expect(result.markdown).toBe('**bold**');
    expect(result.html).toBeUndefined();
  });

  it('handles templates with no variables in all fields', () => {
    const rc = {
      markdown: '# Title',
      adaptive_card: '{}',
      html: '<p>text</p>',
      slack: 'hello',
      ag_ui: 'ui',
      whatsapp: 'wa',
    };
    const result = interpolateRichContent(rc, {});
    expect(result.markdown).toBe('# Title');
    expect(result.adaptive_card).toBe('{}');
    expect(result.html).toBe('<p>text</p>');
    expect(result.slack).toBe('hello');
    expect(result.ag_ui).toBe('ui');
    expect(result.whatsapp).toBe('wa');
  });

  it('handles only one field present', () => {
    const rc = {
      markdown: undefined,
      adaptive_card: undefined,
      html: '<div>{{content}}</div>',
      slack: undefined,
      ag_ui: undefined,
      whatsapp: undefined,
    };
    const result = interpolateRichContent(rc, { content: 'hello' });
    expect(result.html).toBe('<div>hello</div>');
    expect(result.markdown).toBeUndefined();
    expect(result.slack).toBeUndefined();
  });

  it('handles nested paths in rich content fields', () => {
    const rc = {
      markdown: '{{data.title}}',
      adaptive_card: undefined,
      html: undefined,
      slack: undefined,
      ag_ui: undefined,
      whatsapp: undefined,
    };
    const result = interpolateRichContent(rc, { data: { title: 'Nested' } });
    expect(result.markdown).toBe('Nested');
  });

  it('handles empty string fields as falsy (returns undefined)', () => {
    const rc = {
      markdown: '',
      adaptive_card: '',
      html: '',
      slack: '',
      ag_ui: '',
      whatsapp: '',
    };
    const result = interpolateRichContent(rc, {});
    // Empty strings are falsy, so the ternary returns undefined
    expect(result.markdown).toBeUndefined();
    expect(result.adaptive_card).toBeUndefined();
    expect(result.html).toBeUndefined();
    expect(result.slack).toBeUndefined();
    expect(result.ag_ui).toBeUndefined();
    expect(result.whatsapp).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveSetValue
// ---------------------------------------------------------------------------
describe('resolveSetValue', () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  describe('quote stripping', () => {
    it('strips double quotes', () => {
      expect(resolveSetValue('"hello"', {})).toBe('hello');
    });

    it('strips single quotes', () => {
      expect(resolveSetValue("'hello'", {})).toBe('hello');
    });

    it('strips quotes with surrounding whitespace', () => {
      expect(resolveSetValue('  "trimmed"  ', {})).toBe('trimmed');
    });

    it('returns empty string for empty double quotes', () => {
      expect(resolveSetValue('""', {})).toBe('');
    });

    it('returns empty string for empty single quotes', () => {
      expect(resolveSetValue("''", {})).toBe('');
    });

    it('interpolates templates inside double-quoted strings', () => {
      expect(resolveSetValue('"status: {{state}}"', { state: 'active' })).toBe('status: active');
    });

    it('interpolates templates inside single-quoted strings', () => {
      expect(resolveSetValue("'status: {{state}}'", { state: 'done' })).toBe('status: done');
    });

    it('does not strip mismatched quotes (double then single)', () => {
      const result = resolveSetValue('"mismatched\'', {});
      expect(result).toBe('"mismatched\'');
    });

    it('does not strip mismatched quotes (single then double)', () => {
      const result = resolveSetValue('\'mismatched"', {});
      expect(result).toBe('\'mismatched"');
    });

    it('preserves inner quotes in double-quoted string', () => {
      expect(resolveSetValue('"it\'s a test"', {})).toBe("it's a test");
    });

    it('preserves inner double quotes in single-quoted string', () => {
      expect(resolveSetValue('\'she said "hi"\'', {})).toBe('she said "hi"');
    });

    it('handles quoted string containing only whitespace', () => {
      expect(resolveSetValue('"   "', {})).toBe('   ');
    });
  });

  describe('boolean parsing', () => {
    it('parses "true" as boolean true', () => {
      expect(resolveSetValue('true', {})).toBe(true);
    });

    it('parses "false" as boolean false', () => {
      expect(resolveSetValue('false', {})).toBe(false);
    });

    it('does not parse "True" as boolean (case sensitive)', () => {
      expect(resolveSetValue('True', {})).not.toBe(true);
    });

    it('does not parse "TRUE" as boolean (case sensitive)', () => {
      expect(resolveSetValue('TRUE', {})).not.toBe(true);
    });

    it('does not parse "False" as boolean (case sensitive)', () => {
      expect(resolveSetValue('False', {})).not.toBe(false);
    });

    it('handles "true" with whitespace', () => {
      expect(resolveSetValue('  true  ', {})).toBe(true);
    });

    it('handles "false" with whitespace', () => {
      expect(resolveSetValue('  false  ', {})).toBe(false);
    });

    it('does not parse "trueish" as boolean', () => {
      const result = resolveSetValue('trueish', {});
      expect(result).toBe('trueish');
    });
  });

  describe('number parsing', () => {
    it('parses a positive integer', () => {
      expect(resolveSetValue('42', {})).toBe(42);
    });

    it('parses zero', () => {
      expect(resolveSetValue('0', {})).toBe(0);
    });

    it('parses a negative integer', () => {
      expect(resolveSetValue('-7', {})).toBe(-7);
    });

    it('parses a float', () => {
      expect(resolveSetValue('3.14', {})).toBeCloseTo(3.14);
    });

    it('parses a negative float', () => {
      expect(resolveSetValue('-0.5', {})).toBeCloseTo(-0.5);
    });

    it('parses a number with whitespace', () => {
      expect(resolveSetValue('  100  ', {})).toBe(100);
    });

    it('parses a large number', () => {
      expect(resolveSetValue('999999', {})).toBe(999999);
    });

    it('does not parse a number with trailing text as a number', () => {
      const result = resolveSetValue('42abc', {});
      expect(typeof result).toBe('string');
    });

    it('does not parse a number with leading text', () => {
      const result = resolveSetValue('abc42', {});
      expect(typeof result).toBe('string');
    });

    it('does not parse a number with multiple dots', () => {
      const result = resolveSetValue('1.2.3', {});
      expect(typeof result).toBe('string');
    });

    it('parses "1" as number 1', () => {
      expect(resolveSetValue('1', {})).toBe(1);
    });
  });

  describe('template interpolation fallback', () => {
    it('interpolates a bare {{variable}} reference', () => {
      expect(resolveSetValue('{{status}}', { status: 'done' })).toBe('done');
    });

    it('returns the raw template when variable is missing', () => {
      expect(resolveSetValue('{{missing}}', {})).toBe('{{missing}}');
    });

    it('returns a plain string as-is when no pattern matches', () => {
      expect(resolveSetValue('plain_text', {})).toBe('plain_text');
    });

    it('interpolates template with surrounding text', () => {
      expect(resolveSetValue('prefix_{{key}}_suffix', { key: 'val' })).toBe('prefix_val_suffix');
    });

    it('handles template with multiple variables', () => {
      expect(resolveSetValue('{{a}}_{{b}}', { a: 'x', b: 'y' })).toBe('x_y');
    });
  });

  describe('CEL-backed computed expressions', () => {
    it('evaluates arithmetic expressions against the current context', () => {
      expect(resolveSetValue('price + tax', { price: 100, tax: 10 })).toBe(110);
    });

    it('recovers mixed numeric arithmetic when context numbers are doubles and literals are ints', () => {
      expect(resolveSetValue('counter + 1', { counter: 0 })).toBe(1);
      expect(resolveSetValue('counter + 1', { counter: 1.5 })).toBe(2.5);
    });

    it('evaluates CEL helper functions when the expression is computed', () => {
      expect(resolveSetValue('abl.upper(name)', { name: 'alice' })).toBe('ALICE');
    });

    it('still treats bare identifiers as legacy literals while dotted identifiers resolve via value paths', () => {
      expect(resolveSetValue('plain_text', { plain_text: 'ignored' })).toBe('plain_text');
      expect(resolveSetValue('config.value', { config: { value: 'x' } })).toBe('x');
    });

    it('resolves indexed value paths instead of storing the literal expression', () => {
      const context = {
        lookup_phone_record: {
          result: [{ pin: '4321' }],
        },
      };

      expect(resolveSetValue('lookup_phone_record.result[0].pin', context)).toBe('4321');
    });

    it('preserves hyphenated literals when CEL fails for reasons other than numeric type mismatch', () => {
      expect(resolveSetValue('release-2026-04-21', {})).toBe('release-2026-04-21');
    });
  });

  describe('precedence', () => {
    it('quoted "true" returns string, not boolean', () => {
      expect(resolveSetValue('"true"', {})).toBe('true');
    });

    it('quoted "false" returns string, not boolean', () => {
      expect(resolveSetValue('"false"', {})).toBe('false');
    });

    it('quoted "42" returns string, not number', () => {
      expect(resolveSetValue('"42"', {})).toBe('42');
    });

    it('quoted "0" returns string, not number', () => {
      expect(resolveSetValue('"0"', {})).toBe('0');
    });
  });
});

// ---------------------------------------------------------------------------
// resolveValuePath
// ---------------------------------------------------------------------------
describe('resolveValuePath', () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  describe('array.length shorthand', () => {
    it('returns the length of a populated array', () => {
      expect(resolveValuePath('items.length', { items: [1, 2, 3] })).toBe(3);
    });

    it('returns 0 for an empty array', () => {
      expect(resolveValuePath('items.length', { items: [] })).toBe(0);
    });

    it('returns length for a single-element array', () => {
      expect(resolveValuePath('items.length', { items: ['only'] })).toBe(1);
    });

    it('does not return length for a non-array and warns', () => {
      resolveValuePath('items.length', { items: 'hello' });
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('is not an array'),
        expect.any(Object),
      );
    });

    it('warns for a number value with .length', () => {
      resolveValuePath('count.length', { count: 42 });
      expect(mockWarn).toHaveBeenCalled();
    });

    it('warns for an object value with .length', () => {
      resolveValuePath('obj.length', { obj: { a: 1 } });
      expect(mockWarn).toHaveBeenCalled();
    });

    it('returns undefined when the variable does not exist at all', () => {
      const result = resolveValuePath('missing.length', {});
      expect(result).toBeUndefined();
    });

    it('does not warn when variable is undefined (no .length warning)', () => {
      resolveValuePath('missing.length', {});
      // When the value is undefined, the warn branch is skipped
      expect(mockWarn).not.toHaveBeenCalled();
    });
  });

  describe('nested property access', () => {
    it('resolves a top-level property', () => {
      expect(resolveValuePath('name', { name: 'Alice' })).toBe('Alice');
    });

    it('resolves a two-level path', () => {
      expect(resolveValuePath('user.name', { user: { name: 'Bob' } })).toBe('Bob');
    });

    it('resolves a three-level path', () => {
      const data = { a: { b: { c: 'deep' } } };
      expect(resolveValuePath('a.b.c', data)).toBe('deep');
    });

    it('resolves a four-level path', () => {
      const data = { a: { b: { c: { d: 'very deep' } } } };
      expect(resolveValuePath('a.b.c.d', data)).toBe('very deep');
    });

    it('resolves indexed array paths within nested objects', () => {
      const data = {
        lookup_phone_record: {
          result: [{ pin: '4321' }],
        },
      };

      expect(resolveValuePath('lookup_phone_record.result[0].pin', data)).toBe('4321');
    });

    it('returns undefined for a missing intermediate path', () => {
      expect(resolveValuePath('a.b.c', { a: {} })).toBeUndefined();
    });

    it('returns undefined when traversing through a primitive', () => {
      expect(resolveValuePath('a.b', { a: 42 })).toBeUndefined();
    });

    it('returns undefined when traversing through null', () => {
      expect(resolveValuePath('a.b', { a: null } as Record<string, unknown>)).toBeUndefined();
    });

    it('returns undefined for a completely missing path', () => {
      expect(resolveValuePath('x.y.z', {})).toBeUndefined();
    });

    it('returns an object value', () => {
      const nested = { x: 1 };
      expect(resolveValuePath('obj', { obj: nested })).toEqual({ x: 1 });
    });

    it('returns an array value', () => {
      expect(resolveValuePath('arr', { arr: [10, 20] })).toEqual([10, 20]);
    });

    it('returns falsy values correctly (0)', () => {
      expect(resolveValuePath('val', { val: 0 })).toBe(0);
    });

    it('returns falsy values correctly (false)', () => {
      expect(resolveValuePath('val', { val: false })).toBe(false);
    });

    it('returns falsy values correctly (empty string)', () => {
      expect(resolveValuePath('val', { val: '' })).toBe('');
    });

    it('returns falsy values correctly (null)', () => {
      expect(resolveValuePath('val', { val: null })).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('array.length shorthand takes precedence for arrays', () => {
      expect(resolveValuePath('items.length', { items: [1, 2] })).toBe(2);
    });

    it('handles a single-segment path', () => {
      expect(resolveValuePath('x', { x: 'hello' })).toBe('hello');
    });

    it('handles numeric values in nested paths', () => {
      const data = { config: { maxRetries: 3 } };
      expect(resolveValuePath('config.maxRetries', data)).toBe(3);
    });

    it('handles boolean values in nested paths', () => {
      const data = { config: { enabled: true } };
      expect(resolveValuePath('config.enabled', data)).toBe(true);
    });

    it('handles nested object with same key name as top-level', () => {
      const data = { data: { data: { val: 'inner' } } };
      expect(resolveValuePath('data.data.val', data)).toBe('inner');
    });
  });
});

// ---------------------------------------------------------------------------
// Integration-level scenarios: combined usage patterns
// ---------------------------------------------------------------------------
describe('integration scenarios', () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  it('resolveSetValue + interpolateTemplate: quoted template with context', () => {
    const context = { booking_id: 'BK-123', hotel: 'Grand' };
    const result = resolveSetValue('"Booking {{booking_id}} at {{hotel}}"', context);
    expect(result).toBe('Booking BK-123 at Grand');
  });

  it('resolveSetValue returns number for count used later in resolveValuePath', () => {
    const count = resolveSetValue('5', {});
    expect(count).toBe(5);
    expect(typeof count).toBe('number');
  });

  it('interpolateTemplate with #if and nested path from resolveValuePath-style data', () => {
    const data = { user: { isPremium: true }, discount: '20%' };
    const template = '{{#if user.isPremium}}Discount: {{discount}}{{/if}}';
    expect(interpolateTemplate(template, data)).toBe('Discount: 20%');
  });

  it('interpolateTemplate with #each and #if combined', () => {
    const data = {
      showItems: true,
      items: [{ name: 'A' }, { name: 'B' }],
    };
    const template = '{{#if showItems}}Items: {{#each items}}{{name}} {{/each}}{{/if}}';
    expect(interpolateTemplate(template, data)).toBe('Items: A B ');
  });

  it('interpolateRichContent with complex templates', () => {
    const rc = {
      markdown: '# {{title}}\n{{#if subtitle}}## {{subtitle}}{{/if}}',
      adaptive_card: undefined,
      html: undefined,
      slack: undefined,
      ag_ui: undefined,
      whatsapp: undefined,
    };
    const data = { title: 'Report', subtitle: 'Q4 2025' };
    const result = interpolateRichContent(rc, data);
    expect(result.markdown).toBe('# Report\n## Q4 2025');
  });

  it('interpolateVoiceConfig with nested variable paths', () => {
    const vc = {
      ssml: '<speak>Welcome {{user.name}}</speak>',
      instructions: 'Address user as {{user.name}}',
      plain_text: 'Hi {{user.name}}',
    };
    const data = { user: { name: 'Diana' } };
    const result = interpolateVoiceConfig(vc, data);
    expect(result.ssml).toBe('<speak>Welcome Diana</speak>');
    expect(result.instructions).toBe('Address user as Diana');
    expect(result.plain_text).toBe('Hi Diana');
  });

  it('resolveValuePath returns length, resolveSetValue returns the same number', () => {
    const length = resolveValuePath('items.length', { items: [1, 2, 3] });
    expect(length).toBe(3);
    const parsed = resolveSetValue('3', {});
    expect(parsed).toBe(3);
    expect(length).toBe(parsed);
  });

  it('getNestedValue used to build context for interpolateTemplate', () => {
    const fullContext = { booking: { ref: 'ABC-123', guest: 'John' } };
    const ref = getNestedValue(fullContext, 'booking.ref');
    const guest = getNestedValue(fullContext, 'booking.guest');
    const template = 'Booking {{ref}} for {{guest}}';
    const result = interpolateTemplate(template, { ref, guest } as Record<string, unknown>);
    expect(result).toBe('Booking ABC-123 for John');
  });

  it('interpolateTemplate with #each using @index and add for display numbering', () => {
    const data = {
      hotels: [
        { name: 'Grand', city: 'Paris' },
        { name: 'Royal', city: 'London' },
        { name: 'Ritz', city: 'Madrid' },
      ],
    };
    const template = '{{#each hotels}}{{add @index 1}}. {{name}} ({{city}})\n{{/each}}';
    const result = interpolateTemplate(template, data);
    expect(result).toContain('1. Grand (Paris)');
    expect(result).toContain('2. Royal (London)');
    expect(result).toContain('3. Ritz (Madrid)');
  });

  it('resolveSetValue with context-dependent template inside quotes', () => {
    const ctx = { flow: 'booking', step: 'confirm' };
    const result = resolveSetValue('"{{flow}}_{{step}}"', ctx);
    expect(result).toBe('booking_confirm');
  });

  it('full pipeline: resolve path, set value, template render', () => {
    const context = {
      results: [1, 2, 3],
      config: { label: 'Items' },
    };
    // 1) resolve the count
    const count = resolveValuePath('results.length', context);
    expect(count).toBe(3);
    // 2) resolve a label
    const label = resolveValuePath('config.label', context);
    expect(label).toBe('Items');
    // 3) render a template with them
    const template = '{{label}}: {{count}}';
    const rendered = interpolateTemplate(template, { label, count } as Record<string, unknown>);
    expect(rendered).toBe('Items: 3');
  });
});

// ---------------------------------------------------------------------------
// EXPANDED TESTS: edge cases, nested paths, empty/null inputs, whitespace
// ---------------------------------------------------------------------------

describe('getNestedValue — expanded edge cases', () => {
  it('returns undefined for empty path string', () => {
    // path.split('.') on '' gives [''], which won't match any key
    expect(getNestedValue({ '': 'empty-key' }, '')).toBe('empty-key');
  });

  it('handles keys with numeric names', () => {
    expect(getNestedValue({ '0': 'zero', '1': 'one' }, '0')).toBe('zero');
  });

  it('handles deeply nested object (5+ levels)', () => {
    const data = { a: { b: { c: { d: { e: { f: 'bottom' } } } } } };
    expect(getNestedValue(data, 'a.b.c.d.e.f')).toBe('bottom');
  });

  it('returns undefined when root object is empty and path is multi-segment', () => {
    expect(getNestedValue({}, 'a.b.c')).toBeUndefined();
  });

  it('returns the entire data object for a path segment that maps to an object', () => {
    const inner = { x: 1, y: 2 };
    expect(getNestedValue({ nested: inner }, 'nested')).toBe(inner);
  });

  it('handles Infinity as a stored value', () => {
    expect(getNestedValue({ val: Infinity }, 'val')).toBe(Infinity);
  });

  it('handles negative Infinity as a stored value', () => {
    expect(getNestedValue({ val: -Infinity }, 'val')).toBe(-Infinity);
  });

  it('handles Date object as a stored value', () => {
    const d = new Date('2025-01-01');
    expect(getNestedValue({ created: d }, 'created')).toBe(d);
  });

  it('returns undefined when traversing through an array (not an object)', () => {
    // Arrays are objects, so 'b' is looked up as a property on the array
    expect(getNestedValue({ a: [1, 2, 3] }, 'a.b')).toBeUndefined();
  });

  it('can access array length via dot notation since arrays are objects', () => {
    expect(getNestedValue({ a: [1, 2, 3] }, 'a.length')).toBe(3);
  });
});

describe('interpolateTemplate — expanded edge cases', () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  it('handles whitespace inside placeholder braces', () => {
    // {{  name  }} — regex \w+ doesn't match leading space, so no match
    const result = interpolateTemplate('Hello {{  name  }}', { name: 'Bob' });
    expect(result).toBe('Hello {{  name  }}');
  });

  it('handles placeholder with only special characters (no match)', () => {
    const result = interpolateTemplate('Test {{!@#}}', {});
    expect(result).toBe('Test {{!@#}}');
  });

  it('handles template that is only a single placeholder', () => {
    expect(interpolateTemplate('{{x}}', { x: 'entire' })).toBe('entire');
  });

  it('handles template with newlines between placeholders', () => {
    const result = interpolateTemplate('Line1: {{a}}\nLine2: {{b}}', { a: 'X', b: 'Y' });
    expect(result).toBe('Line1: X\nLine2: Y');
  });

  it('handles nested dot path where value is an object (toString)', () => {
    const data = { config: { settings: { debug: true } } };
    expect(interpolateTemplate('{{config.settings}}', data)).toBe('[object Object]');
  });

  it('handles #each with items that have nested objects', () => {
    const data = {
      users: [{ profile: { name: 'A' } }, { profile: { name: 'B' } }],
    };
    // #each only expands top-level item properties, not nested
    const template = '{{#each users}}{{profile}} {{/each}}';
    const result = interpolateTemplate(template, data);
    expect(result).toBe('[object Object] [object Object] ');
  });

  it('handles #if with nested path that resolves to 0 (falsy)', () => {
    const data = { metrics: { errors: 0 } };
    expect(interpolateTemplate('{{#if metrics.errors}}Has errors{{/if}}', data)).toBe('');
  });

  it('handles #if with nested path that resolves to non-zero number (truthy)', () => {
    const data = { metrics: { errors: 3 } };
    expect(interpolateTemplate('{{#if metrics.errors}}Has errors{{/if}}', data)).toBe('Has errors');
  });

  it('handles #if with nested path inside #each (independent variable)', () => {
    const data = {
      show: true,
      items: [{ val: 'a' }],
    };
    // #each runs first, then #if
    const template = '{{#each items}}{{val}}{{/each}}{{#if show}}!{{/if}}';
    expect(interpolateTemplate(template, data)).toBe('a!');
  });

  it('handles very long template with many placeholders', () => {
    const vars: Record<string, string> = {};
    let template = '';
    for (let i = 0; i < 50; i++) {
      vars[`v${i}`] = `val${i}`;
      template += `{{v${i}}} `;
    }
    const result = interpolateTemplate(template, vars);
    expect(result).toContain('val0');
    expect(result).toContain('val49');
  });

  it('serializes null variable to "null" string in template', () => {
    expect(interpolateTemplate('Val: {{x}}', { x: null })).toBe('Val: null');
  });

  it('serializes undefined variable leaves placeholder as-is', () => {
    const result = interpolateTemplate('Val: {{x}}', { x: undefined });
    expect(result).toBe('Val: {{x}}');
  });

  it('handles #each with empty body template', () => {
    const data = { items: [{ a: 1 }, { a: 2 }] };
    expect(interpolateTemplate('{{#each items}}{{/each}}', data)).toBe('');
  });

  it('handles consecutive #if blocks (true then false)', () => {
    const data = { a: true, b: false };
    const template = '{{#if a}}YES{{/if}}{{#if b}}NO{{/if}}';
    expect(interpolateTemplate(template, data)).toBe('YES');
  });
});

describe('resolveSetValue — expanded edge cases', () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  it('handles only whitespace (not a valid number, boolean, or template)', () => {
    const result = resolveSetValue('   ', {});
    // trimmed is '', which doesn't match quotes, boolean, number, or template
    expect(result).toBe('');
  });

  it('handles scientific notation (not matched by number regex)', () => {
    const result = resolveSetValue('1e5', {});
    // regex /^-?\d+(\.\d+)?$/ doesn't match 1e5
    expect(typeof result).toBe('string');
  });

  it('handles leading zeros in number strings', () => {
    const result = resolveSetValue('007', {});
    // matches number regex, parseFloat('007') = 7
    expect(result).toBe(7);
  });

  it('handles negative zero', () => {
    const result = resolveSetValue('-0', {});
    expect(result).toBe(-0);
    expect(Object.is(result, -0)).toBe(true);
  });

  it('preserves raw value with embedded double-braces but no matching var', () => {
    const result = resolveSetValue('no_{{braces}}_here', {});
    expect(result).toBe('no_{{braces}}_here');
  });

  it('handles quoted string with internal template variables', () => {
    const result = resolveSetValue('"Hello {{who}}, age {{age}}"', { who: 'World', age: 30 });
    expect(result).toBe('Hello World, age 30');
  });

  it('returns raw path as string when context variable missing (no interpolation)', () => {
    const result = resolveSetValue('status_code', {});
    expect(result).toBe('status_code');
  });

  it('handles dot-separated identifier as template fallthrough', () => {
    const result = resolveSetValue('config.value', { config: { value: 'x' } });
    expect(result).toBe('x');
  });

  it('returns undefined for unresolved bare dotted paths instead of storing the literal string', () => {
    const result = resolveSetValue('result.user_id', {});
    expect(result).toBeUndefined();
  });
});

describe('resolveValuePath — expanded edge cases', () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  it('returns undefined for nested .length when parent is missing', () => {
    expect(resolveValuePath('data.items.length', {})).toBeUndefined();
  });

  it('handles .length on nested array (only matches top-level pattern)', () => {
    // The regex ^(\w+)\.length$ only matches 'items.length', not 'data.items.length'
    // So 'data.items.length' falls through to nested property access
    const data = { data: { items: [1, 2, 3] } };
    const result = resolveValuePath('data.items.length', data);
    // Nested access: data -> items -> length (array .length property)
    expect(result).toBe(3);
  });

  it('returns undefined when .length is called on null context value', () => {
    expect(resolveValuePath('val.length', { val: null })).toBeUndefined();
  });

  it('handles property named "length" on an object (not array)', () => {
    // 'config.length' matches the regex, but config is not an array
    const data = { config: { length: 42 } };
    // The regex matches top-level 'config.length', config is not an array, warns
    // Then falls through to nested access which returns 42
    resolveValuePath('config.length', data);
    expect(mockWarn).toHaveBeenCalled();
  });

  it('resolves undefined values correctly', () => {
    expect(resolveValuePath('x', { x: undefined })).toBeUndefined();
  });

  it('resolves nested path with intermediate empty object', () => {
    expect(resolveValuePath('a.b.c', { a: { b: {} } })).toBeUndefined();
  });

  it('handles single char path names', () => {
    expect(resolveValuePath('x', { x: 'hello' })).toBe('hello');
  });

  it('handles path with many segments (4+)', () => {
    const data = { a: { b: { c: { d: { e: 'deep' } } } } };
    expect(resolveValuePath('a.b.c.d.e', data)).toBe('deep');
  });

  it('returns the whole context for a key that maps to another object', () => {
    const nested = { foo: 'bar' };
    expect(resolveValuePath('obj', { obj: nested })).toBe(nested);
  });

  it('handles .length on boolean (not array, warns)', () => {
    resolveValuePath('flag.length', { flag: true });
    expect(mockWarn).toHaveBeenCalled();
  });

  it('handles .length on null (does not warn, returns undefined)', () => {
    const result = resolveValuePath('val.length', { val: null });
    // null is not undefined, so arr = null, !Array.isArray(null) is true,
    // null !== undefined is true, so it warns
    expect(mockWarn).toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});

describe('interpolateTemplate + resolveSetValue integration', () => {
  it('resolveSetValue as number then template renders it', () => {
    const count = resolveSetValue('3', {});
    expect(count).toBe(3);
    const rendered = interpolateTemplate('Items: {{count}}', {
      count,
    } as Record<string, unknown>);
    expect(rendered).toBe('Items: 3');
  });

  it('resolveSetValue with boolean then #if checks it', () => {
    const flag = resolveSetValue('true', {});
    expect(flag).toBe(true);
    const rendered = interpolateTemplate('{{#if flag}}On{{/if}}', {
      flag,
    } as Record<string, unknown>);
    expect(rendered).toBe('On');
  });

  it('resolveSetValue with false boolean in #if', () => {
    const flag = resolveSetValue('false', {});
    expect(flag).toBe(false);
    const rendered = interpolateTemplate('{{#if flag}}On{{/if}}', {
      flag,
    } as Record<string, unknown>);
    expect(rendered).toBe('');
  });

  it('resolveSetValue with quoted empty string in #if (falsy)', () => {
    const val = resolveSetValue('""', {});
    expect(val).toBe('');
    const rendered = interpolateTemplate('{{#if val}}Present{{/if}}', {
      val,
    } as Record<string, unknown>);
    expect(rendered).toBe('');
  });

  it('resolveValuePath as array then #each iterates', () => {
    const context = { items: [{ name: 'A' }, { name: 'B' }] };
    const items = resolveValuePath('items', context);
    expect(Array.isArray(items)).toBe(true);
    const rendered = interpolateTemplate('{{#each items}}{{name}} {{/each}}', context);
    expect(rendered).toBe('A B ');
  });

  it('getNestedValue + resolveSetValue pipeline with deeply nested context', () => {
    const context = { order: { items: [{ sku: 'ABC' }], total: 99.99 } };
    const sku = getNestedValue(context, 'order.items');
    expect(Array.isArray(sku)).toBe(true);
    const total = getNestedValue(context, 'order.total');
    expect(total).toBe(99.99);
    const parsed = resolveSetValue('99.99', {});
    expect(parsed).toBeCloseTo(99.99);
  });
});
