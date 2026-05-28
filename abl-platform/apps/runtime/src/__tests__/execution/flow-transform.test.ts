/**
 * TRANSFORM Array Pipeline Tests
 *
 * Tests for the TRANSFORM step feature in FlowStepExecutor, which applies
 * filter -> map -> sort_by -> limit operations on session data arrays.
 *
 * Source: apps/runtime/src/services/execution/flow-step-executor.ts (lines ~1464-1549)
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor';

describe('TRANSFORM array pipeline', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ===========================================================================
  // FILTER ONLY
  // ===========================================================================

  test('FILTER only: keeps items matching the condition', async () => {
    const dsl = `
AGENT: Transform_Filter_Test

GOAL: "Test TRANSFORM filter"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Start"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: items AS item INTO filtered
      FILTER: item.active == true
    THEN: done

  done:
    REASONING: false
    RESPOND: "Filtered count: {{filtered.length}}"
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Transform_Filter_Test'),
    );
    session.data.values.items = [
      { name: 'Alpha', active: true },
      { name: 'Bravo', active: false },
      { name: 'Charlie', active: true },
      { name: 'Delta', active: false },
      { name: 'Echo', active: true },
    ];

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const filtered = session.data.values.filtered as Array<Record<string, unknown>>;
    expect(filtered).toHaveLength(3);
    expect(filtered.every((item) => item.active === true)).toBe(true);
    expect(filtered.map((item) => item.name)).toEqual(['Alpha', 'Charlie', 'Echo']);
  });

  // ===========================================================================
  // MAP ONLY
  // ===========================================================================

  test('MAP only: transforms item shape with mapped fields', async () => {
    const dsl = `
AGENT: Transform_Map_Test

GOAL: "Test TRANSFORM map"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Start"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: items AS item INTO mapped
      MAP:
        label: item.title
        cost: item.price
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Transform_Map_Test'),
    );
    session.data.values.items = [
      { title: 'Widget', price: 25 },
      { title: 'Gadget', price: 50 },
      { title: 'Doohickey', price: 10 },
    ];

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const mapped = session.data.values.mapped as Array<Record<string, unknown>>;
    expect(mapped).toHaveLength(3);
    expect(mapped[0]).toEqual({ label: 'Widget', cost: 25 });
    expect(mapped[1]).toEqual({ label: 'Gadget', cost: 50 });
    expect(mapped[2]).toEqual({ label: 'Doohickey', cost: 10 });
  });

  // ===========================================================================
  // SORT_BY ASCENDING
  // ===========================================================================

  test('SORT_BY ascending: orders items by field ASC', async () => {
    const dsl = `
AGENT: Transform_SortAsc_Test

GOAL: "Test TRANSFORM sort asc"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Start"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: items AS item INTO sorted
      SORT_BY: price ASC
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Transform_SortAsc_Test'),
    );
    session.data.values.items = [
      { name: 'C', price: 300 },
      { name: 'A', price: 100 },
      { name: 'D', price: 400 },
      { name: 'B', price: 200 },
    ];

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const sorted = session.data.values.sorted as Array<Record<string, unknown>>;
    expect(sorted).toHaveLength(4);
    expect(sorted.map((i) => i.price)).toEqual([100, 200, 300, 400]);
    expect(sorted.map((i) => i.name)).toEqual(['A', 'B', 'C', 'D']);
  });

  // ===========================================================================
  // SORT_BY DESCENDING
  // ===========================================================================

  test('SORT_BY descending: orders items by field DESC', async () => {
    const dsl = `
AGENT: Transform_SortDesc_Test

GOAL: "Test TRANSFORM sort desc"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Start"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: items AS item INTO sorted
      SORT_BY: price DESC
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Transform_SortDesc_Test'),
    );
    session.data.values.items = [
      { name: 'A', price: 100 },
      { name: 'C', price: 300 },
      { name: 'B', price: 200 },
      { name: 'D', price: 400 },
    ];

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const sorted = session.data.values.sorted as Array<Record<string, unknown>>;
    expect(sorted).toHaveLength(4);
    expect(sorted.map((i) => i.price)).toEqual([400, 300, 200, 100]);
    expect(sorted.map((i) => i.name)).toEqual(['D', 'C', 'B', 'A']);
  });

  // ===========================================================================
  // LIMIT ONLY
  // ===========================================================================

  test('LIMIT only: truncates array to N items', async () => {
    const dsl = `
AGENT: Transform_Limit_Test

GOAL: "Test TRANSFORM limit"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Start"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: items AS item INTO limited
      LIMIT: 3
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Transform_Limit_Test'),
    );
    session.data.values.items = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      name: `Item_${i + 1}`,
    }));

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const limited = session.data.values.limited as Array<Record<string, unknown>>;
    expect(limited).toHaveLength(3);
    expect(limited.map((i) => i.id)).toEqual([1, 2, 3]);
  });

  // ===========================================================================
  // FULL PIPELINE: FILTER -> MAP -> SORT_BY -> LIMIT
  // ===========================================================================

  test('Full pipeline: FILTER -> MAP -> SORT_BY -> LIMIT applied in order', async () => {
    const dsl = `
AGENT: Transform_Full_Test

GOAL: "Test TRANSFORM full pipeline"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Start"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: items AS item INTO results
      FILTER: item.active == true
      MAP:
        label: item.name
        cost: item.price
      SORT_BY: cost ASC
      LIMIT: 3
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Transform_Full_Test'),
    );
    session.data.values.items = [
      { name: 'Expensive', price: 500, active: true },
      { name: 'Inactive', price: 10, active: false },
      { name: 'Cheap', price: 50, active: true },
      { name: 'Mid', price: 200, active: true },
      { name: 'AlsoInactive', price: 5, active: false },
      { name: 'Budget', price: 75, active: true },
      { name: 'Premium', price: 300, active: true },
    ];

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const results = session.data.values.results as Array<Record<string, unknown>>;
    // After FILTER: 5 active items (Expensive, Cheap, Mid, Budget, Premium)
    // After MAP: label/cost shape
    // After SORT_BY cost ASC: Cheap(50), Budget(75), Mid(200), Premium(300), Expensive(500)
    // After LIMIT 3: Cheap, Budget, Mid
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ label: 'Cheap', cost: 50 });
    expect(results[1]).toEqual({ label: 'Budget', cost: 75 });
    expect(results[2]).toEqual({ label: 'Mid', cost: 200 });
  });

  // ===========================================================================
  // NON-ARRAY SOURCE: GRACEFUL SKIP
  // ===========================================================================

  test('Non-array source: graceful skip, target not set', async () => {
    const dsl = `
AGENT: Transform_NonArray_Test

GOAL: "Test TRANSFORM non-array source"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Start"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: items AS item INTO results
      FILTER: item.active == true
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Transform_NonArray_Test'),
    );
    // Set source to a non-array value
    session.data.values.items = 'not an array';

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    // Target should not be set since source was not an array
    expect(session.data.values.results).toBeUndefined();
    // Flow should still continue to the done step
    expect(chunks.join('')).toContain('Done');
  });

  // ===========================================================================
  // EMPTY ARRAY SOURCE
  // ===========================================================================

  test('Empty array: target is empty array', async () => {
    const dsl = `
AGENT: Transform_Empty_Test

GOAL: "Test TRANSFORM empty array"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Start"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: items AS item INTO results
      FILTER: item.active == true
      MAP:
        name: item.name
      SORT_BY: name ASC
      LIMIT: 10
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Transform_Empty_Test'),
    );
    session.data.values.items = [];

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const results = session.data.values.results as Array<Record<string, unknown>>;
    expect(results).toEqual([]);
  });

  // ===========================================================================
  // SORT_BY WITH NULL VALUES
  // ===========================================================================

  test('SORT_BY with null values: nulls sort to beginning in ASC', async () => {
    const dsl = `
AGENT: Transform_SortNull_Test

GOAL: "Test TRANSFORM sort with nulls"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Start"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: items AS item INTO sorted
      SORT_BY: score ASC
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Transform_SortNull_Test'),
    );
    session.data.values.items = [
      { name: 'B', score: 80 },
      { name: 'NullFirst', score: null },
      { name: 'A', score: 50 },
      { name: 'NullSecond', score: null },
      { name: 'C', score: 100 },
    ];

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const sorted = session.data.values.sorted as Array<Record<string, unknown>>;
    expect(sorted).toHaveLength(5);
    // Null values sort to beginning in ASC (null -> -1 in comparator)
    expect(sorted[0].score).toBeNull();
    expect(sorted[1].score).toBeNull();
    // Non-null values sorted ascending
    expect(sorted[2]).toEqual({ name: 'A', score: 50 });
    expect(sorted[3]).toEqual({ name: 'B', score: 80 });
    expect(sorted[4]).toEqual({ name: 'C', score: 100 });
  });

  // ===========================================================================
  // TRACE EVENT: dsl_transform
  // ===========================================================================

  test('dsl_transform trace event includes correct metadata', async () => {
    const dsl = `
AGENT: Transform_Trace_Test

GOAL: "Test TRANSFORM trace"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Start"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: items AS item INTO results
      FILTER: item.active == true
      MAP:
        label: item.name
      SORT_BY: label ASC
      LIMIT: 5
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Transform_Trace_Test'),
    );
    session.data.values.items = [
      { name: 'Alpha', active: true },
      { name: 'Bravo', active: false },
      { name: 'Charlie', active: true },
      { name: 'Delta', active: true },
    ];

    const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
    await executor.initializeSession(session.id, undefined, (e) => traces.push(e));

    const transformTrace = traces.find((t) => t.type === 'dsl_transform');
    expect(transformTrace).toBeDefined();
    expect(transformTrace!.data.agentName).toBe('Transform_Trace_Test');
    expect(transformTrace!.data.source).toBe('items');
    expect(transformTrace!.data.target).toBe('results');
    expect(transformTrace!.data.inputCount).toBe(4);
    // After filter: 3 active items, then map, then sort, then limit 5 (no truncation)
    expect(transformTrace!.data.outputCount).toBe(3);
    expect(transformTrace!.data.hasFilter).toBe(true);
    expect(transformTrace!.data.hasMap).toBe(true);
    expect(transformTrace!.data.hasSortBy).toBe(true);
    expect(transformTrace!.data.limit).toBe(5);
  });

  // ===========================================================================
  // TRANSFORM THEN RESPOND: Flow continues after TRANSFORM
  // ===========================================================================

  test('TRANSFORM then RESPOND: flow continues and template references target', async () => {
    const dsl = `
AGENT: Transform_Continue_Test

GOAL: "Test TRANSFORM flow continuation"

FLOW:
  start -> process -> display

  start:
    REASONING: false
    RESPOND: "Start"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: items AS item INTO results
      FILTER: item.active == true
    THEN: display

  display:
    REASONING: false
    RESPOND: "Found {{results.length}} active items."
    THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Transform_Continue_Test'),
    );
    session.data.values.items = [
      { name: 'A', active: true },
      { name: 'B', active: false },
      { name: 'C', active: true },
      { name: 'D', active: true },
    ];

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');
    // The display step should reference the length of the filtered results
    expect(output).toContain('Found 3 active items.');
    expect(session.isComplete).toBe(true);
  });
});
