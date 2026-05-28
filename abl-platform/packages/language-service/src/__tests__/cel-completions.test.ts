import { describe, it, expect } from 'vitest';
import { CEL_FUNCTIONS } from '../cel-functions';

describe('CEL_FUNCTIONS registry', () => {
  it('exports a non-empty array of function definitions', () => {
    expect(Array.isArray(CEL_FUNCTIONS)).toBe(true);
    expect(CEL_FUNCTIONS.length).toBe(32);
  });

  it('each entry has required fields', () => {
    for (const fn of CEL_FUNCTIONS) {
      expect(fn).toHaveProperty('name');
      expect(fn).toHaveProperty('signature');
      expect(fn).toHaveProperty('description');
      expect(fn).toHaveProperty('category');
      expect(fn.name).toMatch(/^abl\./);
    }
  });

  it('includes known functions', () => {
    const names = CEL_FUNCTIONS.map((f) => f.name);
    expect(names).toContain('abl.upper');
    expect(names).toContain('abl.round');
    expect(names).toContain('abl.now');
    expect(names).toContain('abl.coalesce');
    expect(names).toContain('abl.array_find');
    expect(names).toContain('abl.format_currency');
  });

  it('categories are valid', () => {
    const validCategories = [
      'string',
      'numeric',
      'formatting',
      'type',
      'array',
      'object',
      'utility',
    ];
    for (const fn of CEL_FUNCTIONS) {
      expect(validCategories).toContain(fn.category);
    }
  });
});
