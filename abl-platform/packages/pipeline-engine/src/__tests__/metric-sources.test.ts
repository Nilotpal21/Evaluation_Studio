/**
 * Tests for the curated metric source allowlist that powers the
 * Anomaly Detection / Drift Detection dropdowns in Studio.
 *
 * What we are guarding against:
 *   1. The allowlist staying internally consistent (every entry's
 *      defaultColumn must actually exist on the table).
 *   2. Validation helpers correctly accepting allowlist values and
 *      rejecting anything else.
 *   3. `resolveMetricDynamicOptions` inlining options on the schema
 *      response so Studio can render without a second fetch.
 */

import { describe, expect, test } from 'vitest';
import type { ConfigField } from '../pipeline/types.js';
import {
  METRIC_SOURCES,
  METRIC_TABLE_NAMES,
  getMetricColumns,
  getMetricTable,
  isValidMetricColumn,
  isValidMetricTable,
  resolveMetricDynamicOptions,
  resolveMetricDynamicOptionsAll,
} from '../pipeline/metric-sources.js';

describe('METRIC_SOURCES — internal consistency', () => {
  test('every entry declares a defaultColumn that exists on the table', () => {
    for (const entry of METRIC_SOURCES) {
      const columnNames = entry.columns.map((c) => c.name);
      expect(columnNames).toContain(entry.defaultColumn);
    }
  });

  test('every column has a non-empty user-facing description (subscript copy)', () => {
    for (const entry of METRIC_SOURCES) {
      for (const col of entry.columns) {
        expect(col.description.length).toBeGreaterThan(0);
        expect(col.label.length).toBeGreaterThan(0);
      }
    }
  });

  test('table names are unique', () => {
    const seen = new Set<string>();
    for (const entry of METRIC_SOURCES) {
      expect(seen.has(entry.table)).toBe(false);
      seen.add(entry.table);
    }
  });

  test('column names within a single table are unique', () => {
    for (const entry of METRIC_SOURCES) {
      const names = entry.columns.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe('Allowlist validation helpers', () => {
  test('isValidMetricTable accepts every allowlist entry', () => {
    for (const name of METRIC_TABLE_NAMES) {
      expect(isValidMetricTable(name)).toBe(true);
    }
  });

  test('isValidMetricTable rejects non-allowlisted tables', () => {
    expect(isValidMetricTable('abl_platform.does_not_exist')).toBe(false);
    expect(isValidMetricTable('')).toBe(false);
    expect(isValidMetricTable(null)).toBe(false);
    expect(isValidMetricTable(undefined)).toBe(false);
    expect(isValidMetricTable(42)).toBe(false);
  });

  test('isValidMetricColumn accepts each column under its own table', () => {
    for (const entry of METRIC_SOURCES) {
      for (const col of entry.columns) {
        expect(isValidMetricColumn(entry.table, col.name)).toBe(true);
      }
    }
  });

  test('isValidMetricColumn rejects a column that exists on a different table', () => {
    // friction_score lives only on friction_detections (not included in v1),
    // but avg_sentiment lives only on conversation_sentiment — verify it
    // does not validate against quality_evaluations.
    expect(isValidMetricColumn('abl_platform.quality_evaluations', 'avg_sentiment')).toBe(false);
  });

  test('isValidMetricColumn rejects unknown columns', () => {
    expect(isValidMetricColumn('abl_platform.conversation_sentiment', 'does_not_exist')).toBe(
      false,
    );
  });

  test('isValidMetricColumn rejects when the table itself is unknown', () => {
    expect(isValidMetricColumn('abl_platform.foo', 'avg_sentiment')).toBe(false);
  });

  test('getMetricColumns returns an empty array for an unknown table', () => {
    expect(getMetricColumns('abl_platform.foo')).toEqual([]);
  });

  test('getMetricTable returns the entry for a known table', () => {
    expect(getMetricTable('abl_platform.conversation_sentiment')?.label).toBe(
      'Conversation Sentiment',
    );
  });
});

describe('resolveMetricDynamicOptions — schema endpoint inlining', () => {
  test('expands `metric-tables` into inline options carrying label + description', () => {
    const field: ConfigField = {
      name: 'metricTable',
      type: 'enum',
      required: false,
      description: 'placeholder',
      dynamicOptions: 'metric-tables',
    };
    const resolved = resolveMetricDynamicOptions(field);
    expect(resolved.options).toBeDefined();
    expect(resolved.options!.length).toBe(METRIC_SOURCES.length);
    expect(resolved.options![0]).toMatchObject({
      value: expect.any(String),
      label: expect.any(String),
      description: expect.any(String),
    });
    // No `optionsByDependency` for metric-tables — it's a top-level enum.
    expect(resolved.optionsByDependency).toBeUndefined();
  });

  test('expands `metric-columns` into optionsByDependency keyed by metricTable', () => {
    const field: ConfigField = {
      name: 'metricColumn',
      type: 'enum',
      required: false,
      description: 'placeholder',
      dynamicOptions: 'metric-columns',
    };
    const resolved = resolveMetricDynamicOptions(field);
    expect(resolved.optionsByDependency).toBeDefined();
    expect(resolved.optionsByDependency!.field).toBe('metricTable');

    for (const entry of METRIC_SOURCES) {
      const opts = resolved.optionsByDependency!.options[entry.table];
      expect(opts).toBeDefined();
      expect(opts.length).toBe(entry.columns.length);
      // Labels carry the unit suffix when present, useful so users can tell
      // an "0 to 1" rate column apart from a "1 to 5" score column.
      const sample = opts[0];
      expect(sample.label.length).toBeGreaterThan(0);
      expect(sample.description!.length).toBeGreaterThan(0);
    }
  });

  test('passes through fields without metric-* dynamicOptions untouched', () => {
    const field: ConfigField = {
      name: 'lookbackDays',
      type: 'number',
      required: false,
      description: 'lookback',
      default: 30,
    };
    expect(resolveMetricDynamicOptions(field)).toBe(field);
  });

  test('resolveMetricDynamicOptionsAll resolves every metric-* field in a list', () => {
    const fields: ConfigField[] = [
      {
        name: 'metricTable',
        type: 'enum',
        required: false,
        description: 'x',
        dynamicOptions: 'metric-tables',
      },
      {
        name: 'metricColumn',
        type: 'enum',
        required: false,
        description: 'x',
        dynamicOptions: 'metric-columns',
      },
      {
        name: 'lookbackDays',
        type: 'number',
        required: false,
        description: 'x',
        default: 30,
      },
    ];
    const resolved = resolveMetricDynamicOptionsAll(fields);
    expect(resolved[0].options).toBeDefined();
    expect(resolved[1].optionsByDependency).toBeDefined();
    expect(resolved[2]).toBe(fields[2]);
  });
});
