/**
 * Integration tests for lookup table validation within the gather flow.
 *
 * Tests validateWithLookupTables() with representative scenarios that
 * mirror how it is called in flow-step-executor.ts:
 *   1. Invalid value cleared + re-prompted
 *   2. Fuzzy match triggers confirmation
 *   3. No lookup tables -> normal flow (skipped)
 *   4. Valid value proceeds without errors
 *   5. Case normalization applied automatically
 *   6. Multiple fields validated at once
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LookupTableIR } from '@abl/compiler/platform/ir/schema.js';
import {
  validateWithLookupTables,
  type LookupValidationResult,
} from '../../services/execution/flow-step-executor.js';
import type { LookupContext, LookupEntryModel } from '../../services/execution/lookup-resolver.js';
import { clearCaches } from '../../services/execution/lookup-resolver.js';

/**
 * Fake LookupEntry model injected via LookupContext.lookupEntryModel (DI).
 * Provides a chainable findOne().lean() / find().select().limit().lean() pattern.
 */
const mockLean = vi.fn().mockResolvedValue(null);
const mockFindOne = vi.fn().mockReturnValue({ lean: mockLean });
const fakeLookupEntryModel: LookupEntryModel = {
  findOne: mockFindOne,
  find: vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    }),
  }),
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<LookupContext> = {}): LookupContext {
  return {
    tenantId: 'test-tenant',
    projectId: 'test-project',
    lookupEntryModel: fakeLookupEntryModel,
    ...overrides,
  };
}

function makeInlineTable(
  name: string,
  values: string[],
  overrides: Partial<LookupTableIR> = {},
): LookupTableIR {
  return {
    name,
    source: 'inline',
    values,
    case_sensitive: false,
    fuzzy_match: false,
    fuzzy_threshold: 0.85,
    ...overrides,
  };
}

type GatherField = { name: string; semantics?: { lookup?: string } };

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearCaches();
  mockFindOne.mockClear();
  mockLean.mockClear();
  mockLean.mockResolvedValue(null);
  mockFindOne.mockReturnValue({ lean: mockLean });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Gather Lookup Integration - validateWithLookupTables', () => {
  describe('Invalid value cleared + re-prompted', () => {
    it('returns error for a value not in the lookup table', async () => {
      const lookupTables: Record<string, LookupTableIR> = {
        airports: makeInlineTable('airports', ['LAX', 'JFK', 'CDG', 'LHR']),
      };
      const fields: GatherField[] = [{ name: 'origin', semantics: { lookup: 'airports' } }];
      const values: Record<string, unknown> = { origin: 'ZZZ' };
      const context = makeContext();

      const result: LookupValidationResult = await validateWithLookupTables(
        values,
        fields,
        lookupTables,
        context,
      );

      expect(result.errors).toHaveProperty('origin');
      expect(result.errors.origin).toContain('ZZZ');
      expect(result.errors.origin).toContain('origin');
      expect(Object.keys(result.fuzzyMatches)).toHaveLength(0);
    });

    it('reports errors for multiple invalid fields', async () => {
      const lookupTables: Record<string, LookupTableIR> = {
        airports: makeInlineTable('airports', ['LAX', 'JFK', 'CDG']),
        cabin_classes: makeInlineTable('cabin_classes', ['Economy', 'Business', 'First']),
      };
      const fields: GatherField[] = [
        { name: 'origin', semantics: { lookup: 'airports' } },
        { name: 'cabin', semantics: { lookup: 'cabin_classes' } },
      ];
      const values: Record<string, unknown> = { origin: 'XYZ', cabin: 'Super Premium' };
      const context = makeContext();

      const result = await validateWithLookupTables(values, fields, lookupTables, context);

      expect(Object.keys(result.errors)).toHaveLength(2);
      expect(result.errors).toHaveProperty('origin');
      expect(result.errors).toHaveProperty('cabin');
    });
  });

  describe('Fuzzy match triggers confirmation', () => {
    it('returns fuzzy match when value is close but not exact', async () => {
      const lookupTables: Record<string, LookupTableIR> = {
        airports: makeInlineTable('airports', ['LAX', 'JFK', 'CDG', 'LHR'], {
          fuzzy_match: true,
          fuzzy_threshold: 0.5,
        }),
      };
      const fields: GatherField[] = [{ name: 'origin', semantics: { lookup: 'airports' } }];
      // "LHX" is close to "LHR" (1 character difference)
      const values: Record<string, unknown> = { origin: 'LHX' };
      const context = makeContext();

      const result = await validateWithLookupTables(values, fields, lookupTables, context);

      expect(Object.keys(result.errors)).toHaveLength(0);
      expect(result.fuzzyMatches).toHaveProperty('origin');
      expect(result.fuzzyMatches.origin.suggested).toBeDefined();
      expect(result.fuzzyMatches.origin.similarity).toBeGreaterThan(0);
      expect(result.fuzzyMatches.origin.similarity).toBeLessThan(1.0);
    });

    it('does not return fuzzy match when fuzzy_match is disabled', async () => {
      const lookupTables: Record<string, LookupTableIR> = {
        airports: makeInlineTable('airports', ['LAX', 'JFK', 'CDG', 'LHR'], {
          fuzzy_match: false,
        }),
      };
      const fields: GatherField[] = [{ name: 'origin', semantics: { lookup: 'airports' } }];
      const values: Record<string, unknown> = { origin: 'LHX' };
      const context = makeContext();

      const result = await validateWithLookupTables(values, fields, lookupTables, context);

      // Without fuzzy match, it should be an error (not found)
      expect(result.errors).toHaveProperty('origin');
      expect(Object.keys(result.fuzzyMatches)).toHaveLength(0);
    });
  });

  describe('No lookup tables -> normal flow', () => {
    it('returns empty errors and fuzzyMatches when lookup_tables is undefined', async () => {
      const fields: GatherField[] = [{ name: 'origin', semantics: { lookup: 'airports' } }];
      const values: Record<string, unknown> = { origin: 'XYZ' };
      const context = makeContext();

      const result = await validateWithLookupTables(values, fields, undefined, context);

      expect(Object.keys(result.errors)).toHaveLength(0);
      expect(Object.keys(result.fuzzyMatches)).toHaveLength(0);
    });

    it('skips fields without a lookup semantic', async () => {
      const lookupTables: Record<string, LookupTableIR> = {
        airports: makeInlineTable('airports', ['LAX', 'JFK']),
      };
      const fields: GatherField[] = [
        { name: 'guest_name' }, // no semantics at all
        { name: 'phone', semantics: {} }, // semantics but no lookup
      ];
      const values: Record<string, unknown> = { guest_name: 'Alice', phone: '555-1234' };
      const context = makeContext();

      const result = await validateWithLookupTables(values, fields, lookupTables, context);

      expect(Object.keys(result.errors)).toHaveLength(0);
      expect(Object.keys(result.fuzzyMatches)).toHaveLength(0);
    });

    it('skips fields whose lookup table does not exist in the lookup_tables map', async () => {
      const lookupTables: Record<string, LookupTableIR> = {
        airports: makeInlineTable('airports', ['LAX', 'JFK']),
      };
      const fields: GatherField[] = [
        { name: 'cuisine', semantics: { lookup: 'cuisines' } }, // 'cuisines' not in map
      ];
      const values: Record<string, unknown> = { cuisine: 'Italian' };
      const context = makeContext();

      const result = await validateWithLookupTables(values, fields, lookupTables, context);

      expect(Object.keys(result.errors)).toHaveLength(0);
      expect(Object.keys(result.fuzzyMatches)).toHaveLength(0);
    });

    it('skips fields whose value is null or undefined', async () => {
      const lookupTables: Record<string, LookupTableIR> = {
        airports: makeInlineTable('airports', ['LAX', 'JFK']),
      };
      const fields: GatherField[] = [
        { name: 'origin', semantics: { lookup: 'airports' } },
        { name: 'destination', semantics: { lookup: 'airports' } },
      ];
      const values: Record<string, unknown> = { origin: null, destination: undefined };
      const context = makeContext();

      const result = await validateWithLookupTables(values, fields, lookupTables, context);

      expect(Object.keys(result.errors)).toHaveLength(0);
      expect(Object.keys(result.fuzzyMatches)).toHaveLength(0);
    });
  });

  describe('Valid value proceeds', () => {
    it('returns no errors when all values match the lookup table', async () => {
      const lookupTables: Record<string, LookupTableIR> = {
        airports: makeInlineTable('airports', ['LAX', 'JFK', 'CDG', 'LHR']),
      };
      const fields: GatherField[] = [
        { name: 'origin', semantics: { lookup: 'airports' } },
        { name: 'destination', semantics: { lookup: 'airports' } },
      ];
      const values: Record<string, unknown> = { origin: 'LAX', destination: 'JFK' };
      const context = makeContext();

      const result = await validateWithLookupTables(values, fields, lookupTables, context);

      expect(Object.keys(result.errors)).toHaveLength(0);
      expect(Object.keys(result.fuzzyMatches)).toHaveLength(0);
    });

    it('auto-normalizes case when matched (case-insensitive)', async () => {
      const lookupTables: Record<string, LookupTableIR> = {
        airports: makeInlineTable('airports', ['LAX', 'JFK', 'CDG']),
      };
      const fields: GatherField[] = [{ name: 'origin', semantics: { lookup: 'airports' } }];
      const values: Record<string, unknown> = { origin: 'lax' };
      const context = makeContext();

      const result = await validateWithLookupTables(values, fields, lookupTables, context);

      // Should match and auto-normalize to original case
      expect(Object.keys(result.errors)).toHaveLength(0);
      expect(Object.keys(result.fuzzyMatches)).toHaveLength(0);
      // The value should have been normalized in-place
      expect(values.origin).toBe('LAX');
    });
  });

  describe('Mixed valid and invalid fields', () => {
    it('only reports errors for invalid fields, valid fields pass through', async () => {
      const lookupTables: Record<string, LookupTableIR> = {
        airports: makeInlineTable('airports', ['LAX', 'JFK', 'CDG']),
        cabin_classes: makeInlineTable('cabin_classes', ['Economy', 'Business', 'First']),
      };
      const fields: GatherField[] = [
        { name: 'origin', semantics: { lookup: 'airports' } },
        { name: 'cabin', semantics: { lookup: 'cabin_classes' } },
        { name: 'guest_name' }, // no lookup
      ];
      const values: Record<string, unknown> = {
        origin: 'LAX',
        cabin: 'SuperFirst',
        guest_name: 'Alice',
      };
      const context = makeContext();

      const result = await validateWithLookupTables(values, fields, lookupTables, context);

      // Only cabin should fail
      expect(Object.keys(result.errors)).toHaveLength(1);
      expect(result.errors).toHaveProperty('cabin');
      expect(result.errors).not.toHaveProperty('origin');
      expect(result.errors).not.toHaveProperty('guest_name');
    });
  });

  describe('Collection source lookup', () => {
    it('validates against collection source via LookupEntry model', async () => {
      // Mock LookupEntry.findOne to return a match
      mockLean.mockResolvedValueOnce({ value: 'Premium Economy' });

      const lookupTables: Record<string, LookupTableIR> = {
        cabin_classes: {
          name: 'cabin_classes',
          source: 'collection',
          table_name: 'cabin_classes',
          case_sensitive: false,
          fuzzy_match: false,
          fuzzy_threshold: 0.85,
        },
      };
      const fields: GatherField[] = [{ name: 'cabin', semantics: { lookup: 'cabin_classes' } }];
      const values: Record<string, unknown> = { cabin: 'premium economy' };
      const context = makeContext();

      const result = await validateWithLookupTables(values, fields, lookupTables, context);

      expect(Object.keys(result.errors)).toHaveLength(0);
      expect(mockFindOne).toHaveBeenCalled();
    });

    it('reports error when collection lookup finds no match', async () => {
      // mockLean already defaults to null (no match)
      const lookupTables: Record<string, LookupTableIR> = {
        cabin_classes: {
          name: 'cabin_classes',
          source: 'collection',
          table_name: 'cabin_classes',
          case_sensitive: false,
          fuzzy_match: false,
          fuzzy_threshold: 0.85,
        },
      };
      const fields: GatherField[] = [{ name: 'cabin', semantics: { lookup: 'cabin_classes' } }];
      const values: Record<string, unknown> = { cabin: 'Ultra Luxury' };
      const context = makeContext();

      const result = await validateWithLookupTables(values, fields, lookupTables, context);

      expect(result.errors).toHaveProperty('cabin');
      expect(result.errors.cabin).toContain('Ultra Luxury');
    });
  });

  describe('Case-sensitive lookup', () => {
    it('rejects mismatched case when case_sensitive is true', async () => {
      const lookupTables: Record<string, LookupTableIR> = {
        airports: makeInlineTable('airports', ['LAX', 'JFK'], {
          case_sensitive: true,
        }),
      };
      const fields: GatherField[] = [{ name: 'origin', semantics: { lookup: 'airports' } }];
      const values: Record<string, unknown> = { origin: 'lax' };
      const context = makeContext();

      const result = await validateWithLookupTables(values, fields, lookupTables, context);

      expect(result.errors).toHaveProperty('origin');
    });

    it('accepts exact case match when case_sensitive is true', async () => {
      const lookupTables: Record<string, LookupTableIR> = {
        airports: makeInlineTable('airports', ['LAX', 'JFK'], {
          case_sensitive: true,
        }),
      };
      const fields: GatherField[] = [{ name: 'origin', semantics: { lookup: 'airports' } }];
      const values: Record<string, unknown> = { origin: 'LAX' };
      const context = makeContext();

      const result = await validateWithLookupTables(values, fields, lookupTables, context);

      expect(Object.keys(result.errors)).toHaveLength(0);
    });
  });

  describe('Non-string values', () => {
    it('converts numeric value to string for lookup', async () => {
      const lookupTables: Record<string, LookupTableIR> = {
        room_numbers: makeInlineTable('room_numbers', ['101', '102', '103', '201']),
      };
      const fields: GatherField[] = [{ name: 'room', semantics: { lookup: 'room_numbers' } }];
      const values: Record<string, unknown> = { room: 101 };
      const context = makeContext();

      const result = await validateWithLookupTables(values, fields, lookupTables, context);

      expect(Object.keys(result.errors)).toHaveLength(0);
    });
  });
});
