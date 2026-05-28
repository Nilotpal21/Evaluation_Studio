/**
 * Integration tests for generate-test-input.ts
 * Tool Lifecycle: test input generation from DSL
 */

import { describe, it, expect } from 'vitest';
import { generateTestInputFromDsl } from '../tools/generate-test-input.js';

describe('generateTestInputFromDsl', () => {
  describe('string parameter heuristics', () => {
    it('generates email for email-named param', () => {
      const dsl = `send_email(email: string) -> object
  type: http`;
      const result = generateTestInputFromDsl(dsl);
      expect(result.email).toBe('test@example.com');
    });

    it('generates phone for phone-named param', () => {
      const dsl = `call_customer(phone: string) -> object
  type: http`;
      const result = generateTestInputFromDsl(dsl);
      expect(result.phone).toBe('+1-555-000-1234');
    });

    it('generates date string for date-named param', () => {
      const dsl = `schedule(date: string) -> object
  type: http`;
      const result = generateTestInputFromDsl(dsl);
      expect(result.date).toBe('2026-01-15');
    });

    it('generates URL for url-named param', () => {
      const dsl = `fetch_page(url: string) -> object
  type: http`;
      const result = generateTestInputFromDsl(dsl);
      expect(result.url).toBe('https://example.com');
    });

    it('falls back to test-value for unknown string param', () => {
      const dsl = `do_something(foobar: string) -> object
  type: http`;
      const result = generateTestInputFromDsl(dsl);
      expect(result.foobar).toBe('test-value');
    });
  });

  describe('type-based defaults', () => {
    it('generates 0 for number params', () => {
      const dsl = `calculate(amount: number, count: integer) -> object
  type: sandbox`;
      const result = generateTestInputFromDsl(dsl);
      expect(result.amount).toBe(0);
      expect(result.count).toBe(0);
    });

    it('generates true for boolean params', () => {
      const dsl = `toggle(enabled: boolean) -> object
  type: sandbox`;
      const result = generateTestInputFromDsl(dsl);
      expect(result.enabled).toBe(true);
    });

    it('generates empty object for object params', () => {
      const dsl = `create(data: object) -> object
  type: http`;
      const result = generateTestInputFromDsl(dsl);
      expect(result.data).toEqual({});
    });

    it('generates empty array for array params', () => {
      const dsl = `batch(items: array) -> object
  type: http`;
      const result = generateTestInputFromDsl(dsl);
      expect(result.items).toEqual([]);
    });

    it('generates empty array for typed array params (string[])', () => {
      const dsl = `tag(labels: string[]) -> object
  type: http`;
      const result = generateTestInputFromDsl(dsl);
      expect(result.labels).toEqual([]);
    });
  });

  describe('enum and default values from params block', () => {
    it('selects first enum value when enum is specified', () => {
      const dsl = `get_weather(city: string, units: string) -> object
  type: http
  params:
    units:
      description: Temperature units
      enum: metric, imperial`;
      const result = generateTestInputFromDsl(dsl);
      expect(result.units).toBe('metric');
    });

    it('uses default value when specified', () => {
      const dsl = `get_weather(city: string, units: string) -> object
  type: http
  params:
    units:
      description: Temperature units
      default: imperial`;
      const result = generateTestInputFromDsl(dsl);
      expect(result.units).toBe('imperial');
    });

    it('uses numeric default for number params', () => {
      const dsl = `paginate(page: number) -> object
  type: http
  params:
    page:
      description: Page number
      default: 1`;
      const result = generateTestInputFromDsl(dsl);
      expect(result.page).toBe(1);
    });
  });

  describe('multi-parameter tools', () => {
    it('generates inputs for all parameters', () => {
      const dsl = `create_user(name: string, email: string, age: number, active: boolean) -> object
  type: http`;
      const result = generateTestInputFromDsl(dsl);
      expect(result).toEqual({
        name: 'Test User',
        email: 'test@example.com',
        age: 0,
        active: true,
      });
    });

    it('handles optional parameters (marked with ?)', () => {
      const dsl = `search(query: string, limit?: number) -> object
  type: http`;
      const result = generateTestInputFromDsl(dsl);
      expect(result).toHaveProperty('query');
      expect(result).toHaveProperty('limit');
      expect(result.query).toBe('test query');
      expect(result.limit).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('returns empty object for empty DSL', () => {
      expect(generateTestInputFromDsl('')).toEqual({});
    });

    it('returns empty object for whitespace-only DSL', () => {
      expect(generateTestInputFromDsl('   ')).toEqual({});
    });

    it('handles tool with no parameters', () => {
      const dsl = `get_status() -> object
  type: http`;
      const result = generateTestInputFromDsl(dsl);
      expect(result).toEqual({});
    });
  });
});
