/**
 * TRANSFORM Pipeline Tests
 *
 * Tests the TRANSFORM array pipeline in FlowStepExecutor which applies
 * FILTER -> MAP -> SORT_BY -> LIMIT stages on session data arrays.
 *
 * Uses the integration pattern: DSL -> compileToResolvedAgent -> RuntimeExecutor
 * to exercise the real transform code path inside executeFlowStep.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor';

describe('TRANSFORM pipeline', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // Helper: compile DSL, create session, seed source data, run, return session + output
  async function runTransform(
    dsl: string,
    agentName: string,
    sourceData: Record<string, unknown>,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ) {
    const session = executor.createSessionFromResolved(compileToResolvedAgent([dsl], agentName));
    Object.assign(session.data.values, sourceData);

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c), onTraceEvent);

    return { session, output: chunks.join('') };
  }

  // ===========================================================================
  // 1. FILTER only: keeps items matching condition
  // ===========================================================================

  test('FILTER only: keeps items matching condition', async () => {
    const dsl = `
AGENT: FilterOnly

GOAL: "Test FILTER only"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Starting"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: products AS item INTO filtered
      FILTER: item.price > 20
    THEN: done

  done:
    REASONING: false
    RESPOND: "Filtered count: {{filtered.length}}"
    THEN: COMPLETE
`;

    const { session, output } = await runTransform(dsl, 'FilterOnly', {
      products: [
        { name: 'Pen', price: 5 },
        { name: 'Book', price: 25 },
        { name: 'Bag', price: 50 },
        { name: 'Sticker', price: 2 },
        { name: 'Notebook', price: 30 },
      ],
    });

    const filtered = session.data.values.filtered as Array<Record<string, unknown>>;
    expect(filtered).toBeDefined();
    expect(filtered).toHaveLength(3);
    expect(filtered.map((f) => f.name)).toEqual(['Book', 'Bag', 'Notebook']);
    expect(output).toContain('Filtered count: 3');
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 2. MAP only: transforms item shape with expressions
  // ===========================================================================

  test('MAP only: transforms item shape with expressions', async () => {
    const dsl = `
AGENT: MapOnly

GOAL: "Test MAP only"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Starting"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: users AS u INTO mapped
      MAP:
        full_name: u.first_name
        age: u.age
    THEN: done

  done:
    REASONING: false
    RESPOND: "Mapped count: {{mapped.length}}"
    THEN: COMPLETE
`;

    const { session, output } = await runTransform(dsl, 'MapOnly', {
      users: [
        { first_name: 'Alice', age: 30, email: 'alice@test.com' },
        { first_name: 'Bob', age: 25, email: 'bob@test.com' },
      ],
    });

    const mapped = session.data.values.mapped as Array<Record<string, unknown>>;
    expect(mapped).toBeDefined();
    expect(mapped).toHaveLength(2);
    // MAP reshapes — only mapped keys exist
    expect(mapped[0]).toEqual({ full_name: 'Alice', age: 30 });
    expect(mapped[1]).toEqual({ full_name: 'Bob', age: 25 });
    // Original keys like email should not be present in mapped items
    expect(mapped[0]).not.toHaveProperty('email');
    expect(output).toContain('Mapped count: 2');
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 3. SORT_BY ascending orders by field
  // ===========================================================================

  test('SORT_BY ascending orders by field', async () => {
    const dsl = `
AGENT: SortAsc

GOAL: "Test SORT_BY ascending"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Starting"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: scores AS item INTO sorted
      SORT_BY: value ASC
    THEN: done

  done:
    REASONING: false
    RESPOND: "Sorted"
    THEN: COMPLETE
`;

    const { session } = await runTransform(dsl, 'SortAsc', {
      scores: [
        { name: 'C', value: 30 },
        { name: 'A', value: 10 },
        { name: 'D', value: 40 },
        { name: 'B', value: 20 },
      ],
    });

    const sorted = session.data.values.sorted as Array<Record<string, unknown>>;
    expect(sorted).toBeDefined();
    expect(sorted).toHaveLength(4);
    expect(sorted.map((s) => s.value)).toEqual([10, 20, 30, 40]);
    expect(sorted.map((s) => s.name)).toEqual(['A', 'B', 'C', 'D']);
  });

  // ===========================================================================
  // 4. SORT_BY descending reverses order
  // ===========================================================================

  test('SORT_BY descending reverses order', async () => {
    const dsl = `
AGENT: SortDesc

GOAL: "Test SORT_BY descending"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Starting"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: scores AS item INTO sorted
      SORT_BY: value DESC
    THEN: done

  done:
    REASONING: false
    RESPOND: "Sorted"
    THEN: COMPLETE
`;

    const { session } = await runTransform(dsl, 'SortDesc', {
      scores: [
        { name: 'C', value: 30 },
        { name: 'A', value: 10 },
        { name: 'D', value: 40 },
        { name: 'B', value: 20 },
      ],
    });

    const sorted = session.data.values.sorted as Array<Record<string, unknown>>;
    expect(sorted).toBeDefined();
    expect(sorted).toHaveLength(4);
    expect(sorted.map((s) => s.value)).toEqual([40, 30, 20, 10]);
    expect(sorted.map((s) => s.name)).toEqual(['D', 'C', 'B', 'A']);
  });

  // ===========================================================================
  // 5. SORT_BY handles null values (nulls sort first in ascending)
  // ===========================================================================

  test('SORT_BY handles null values (nulls sort first in ascending)', async () => {
    const dsl = `
AGENT: SortNulls

GOAL: "Test SORT_BY null handling"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Starting"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: items AS item INTO sorted
      SORT_BY: priority ASC
    THEN: done

  done:
    REASONING: false
    RESPOND: "Sorted"
    THEN: COMPLETE
`;

    const { session } = await runTransform(dsl, 'SortNulls', {
      items: [
        { name: 'B', priority: 2 },
        { name: 'X', priority: null },
        { name: 'A', priority: 1 },
        { name: 'Y' }, // missing field = undefined
        { name: 'C', priority: 3 },
      ],
    });

    const sorted = session.data.values.sorted as Array<Record<string, unknown>>;
    expect(sorted).toBeDefined();
    expect(sorted).toHaveLength(5);

    // Nulls/undefined sort first in ascending (null < value)
    // The first two should be the null/undefined items
    expect(sorted[0].priority).toBeNull();
    expect(sorted[1].priority).toBeUndefined();
    // Then ascending numeric values
    expect(sorted[2].priority).toBe(1);
    expect(sorted[3].priority).toBe(2);
    expect(sorted[4].priority).toBe(3);
  });

  // ===========================================================================
  // 6. LIMIT truncates to first N items
  // ===========================================================================

  test('LIMIT truncates to first N items', async () => {
    const dsl = `
AGENT: LimitOnly

GOAL: "Test LIMIT only"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Starting"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: items AS item INTO limited
      LIMIT: 3
    THEN: done

  done:
    REASONING: false
    RESPOND: "Limited count: {{limited.length}}"
    THEN: COMPLETE
`;

    const { session, output } = await runTransform(dsl, 'LimitOnly', {
      items: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }],
    });

    const limited = session.data.values.limited as Array<Record<string, unknown>>;
    expect(limited).toBeDefined();
    expect(limited).toHaveLength(3);
    expect(limited.map((l) => l.name)).toEqual(['A', 'B', 'C']);
    expect(output).toContain('Limited count: 3');
  });

  // ===========================================================================
  // 7. Full pipeline: FILTER -> MAP -> SORT_BY -> LIMIT
  // ===========================================================================

  test('full pipeline: FILTER -> MAP -> SORT_BY -> LIMIT', async () => {
    const dsl = `
AGENT: FullPipeline

GOAL: "Test full TRANSFORM pipeline"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Starting"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: products AS p INTO results
      FILTER: p.stock > 0
      MAP:
        label: p.name
        cost: p.price
      SORT_BY: cost ASC
      LIMIT: 3
    THEN: done

  done:
    REASONING: false
    RESPOND: "Results: {{results.length}}"
    THEN: COMPLETE
`;

    const { session, output } = await runTransform(dsl, 'FullPipeline', {
      products: [
        { name: 'Widget', price: 50, stock: 10 },
        { name: 'Gadget', price: 30, stock: 0 },
        { name: 'Doohickey', price: 20, stock: 5 },
        { name: 'Thingamajig', price: 10, stock: 3 },
        { name: 'Whatsit', price: 40, stock: 8 },
        { name: 'Gizmo', price: 15, stock: 0 },
      ],
    });

    const results = session.data.values.results as Array<Record<string, unknown>>;
    expect(results).toBeDefined();

    // Source: 6 items
    // FILTER (stock > 0): Widget(50), Doohickey(20), Thingamajig(10), Whatsit(40) = 4 items
    // MAP: label/cost shape
    // SORT_BY cost ASC: Thingamajig(10), Doohickey(20), Whatsit(40), Widget(50)
    // LIMIT 3: first 3
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ label: 'Thingamajig', cost: 10 });
    expect(results[1]).toEqual({ label: 'Doohickey', cost: 20 });
    expect(results[2]).toEqual({ label: 'Whatsit', cost: 40 });

    expect(output).toContain('Results: 3');
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 8. Empty source array produces empty result
  // ===========================================================================

  test('empty source array produces empty result', async () => {
    const dsl = `
AGENT: EmptySource

GOAL: "Test empty source array"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Starting"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: items AS item INTO output
      FILTER: item.active == true
      MAP:
        name: item.name
    THEN: done

  done:
    REASONING: false
    RESPOND: "Output count: {{output.length}}"
    THEN: COMPLETE
`;

    const { session, output } = await runTransform(dsl, 'EmptySource', {
      items: [],
    });

    const result = session.data.values.output as Array<Record<string, unknown>>;
    expect(result).toBeDefined();
    expect(result).toHaveLength(0);
    expect(output).toContain('Output count: 0');
  });

  // ===========================================================================
  // 9. Non-array source skips transform
  // ===========================================================================

  test('non-array source skips transform', async () => {
    const dsl = `
AGENT: NonArraySource

GOAL: "Test non-array source"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Starting"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: data AS item INTO output
      MAP:
        value: item.x
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

    const { session } = await runTransform(dsl, 'NonArraySource', {
      data: { x: 1, y: 2 }, // not an array — transform should be skipped
    });

    // Target should NOT be set because the source was not an array
    expect(session.data.values.output).toBeUndefined();
    // Source should remain unchanged
    expect(session.data.values.data).toEqual({ x: 1, y: 2 });
  });

  // ===========================================================================
  // 10. LIMIT 0 or negative keeps all items
  // ===========================================================================

  test('LIMIT 0 or negative keeps all items', async () => {
    // The code: if (limit != null && limit > 0) — so limit=0 does NOT truncate
    const dsl = `
AGENT: LimitZero

GOAL: "Test LIMIT zero"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Starting"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: items AS item INTO output
      LIMIT: 0
    THEN: done

  done:
    REASONING: false
    RESPOND: "Output count: {{output.length}}"
    THEN: COMPLETE
`;

    const { session, output } = await runTransform(dsl, 'LimitZero', {
      items: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    });

    const result = session.data.values.output as Array<Record<string, unknown>>;
    expect(result).toBeDefined();
    // LIMIT: 0 should keep all items (the condition is limit > 0)
    expect(result).toHaveLength(3);
    expect(output).toContain('Output count: 3');
  });

  // ===========================================================================
  // 11. dsl_transform trace emitted with input/output counts
  // ===========================================================================

  test('dsl_transform trace emitted with input/output counts', async () => {
    const dsl = `
AGENT: TraceTest

GOAL: "Test dsl_transform trace event"

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Starting"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: items AS item INTO filtered
      FILTER: item.active == true
      MAP:
        name: item.name
      SORT_BY: name ASC
      LIMIT: 5
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const onTraceEvent = vi.fn((e: { type: string; data: Record<string, unknown> }) => {
      traceEvents.push(e);
    });

    await runTransform(
      dsl,
      'TraceTest',
      {
        items: [
          { name: 'Alpha', active: true },
          { name: 'Bravo', active: false },
          { name: 'Charlie', active: true },
          { name: 'Delta', active: false },
          { name: 'Echo', active: true },
        ],
      },
      onTraceEvent,
    );

    // Find the dsl_transform event
    const transformEvent = traceEvents.find((e) => e.type === 'dsl_transform');
    expect(transformEvent).toBeDefined();
    expect(transformEvent!.data).toMatchObject({
      source: 'items',
      target: 'filtered',
      inputCount: 5,
      outputCount: 3, // 3 active items pass filter
      hasFilter: true,
      hasMap: true,
      hasSortBy: true,
      limit: 5,
    });
    expect(transformEvent!.data.stepName).toBe('process');
  });

  // ===========================================================================
  // 12. item_var provides current item in filter/map context
  // ===========================================================================

  test('item_var provides current item in filter/map context', async () => {
    // This test uses a custom item_var name ("entry" instead of default "item")
    // and also references a session-level variable in the filter condition
    const dsl = `
AGENT: ItemVarTest

GOAL: "Test item_var context binding"

ON_START:
  set: min_score = 70

FLOW:
  start -> process -> done

  start:
    REASONING: false
    RESPOND: "Starting"
    THEN: process

  process:
    REASONING: false
    TRANSFORM: records AS entry INTO results
      FILTER: entry.score >= min_score
      MAP:
        student: entry.name
        grade: entry.score
    THEN: done

  done:
    REASONING: false
    RESPOND: "Results: {{results.length}}"
    THEN: COMPLETE
`;

    const { session, output } = await runTransform(dsl, 'ItemVarTest', {
      records: [
        { name: 'Alice', score: 95 },
        { name: 'Bob', score: 60 },
        { name: 'Charlie', score: 80 },
        { name: 'Diana', score: 55 },
        { name: 'Eve', score: 70 },
      ],
    });

    const results = session.data.values.results as Array<Record<string, unknown>>;
    expect(results).toBeDefined();

    // Filter: entry.score >= min_score (70)
    // Passes: Alice(95), Charlie(80), Eve(70) = 3 items
    expect(results).toHaveLength(3);

    // MAP reshapes with entry as item_var
    expect(results[0]).toEqual({ student: 'Alice', grade: 95 });
    expect(results[1]).toEqual({ student: 'Charlie', grade: 80 });
    expect(results[2]).toEqual({ student: 'Eve', grade: 70 });

    expect(output).toContain('Results: 3');
    expect(session.isComplete).toBe(true);
  });
});
