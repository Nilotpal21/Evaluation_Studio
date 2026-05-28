/**
 * ContextExplorer — buildStepOutputChildren regression tests.
 *
 * Pinned to ABLP-1086: before the fix, the NODES section's per-step entries
 * read only `step.outputSchema` and rendered a single opaque `output` leaf for
 * any node without a registered schema (e.g. Function nodes). After the fix,
 * the builder prefers live execution data when `executionContext.steps[stepId]
 * .output` is a plain object, surfacing real field names like `product_name`
 * for downstream binding from a Tool / Condition / Loop parameter editor.
 *
 * The helper is pure (no React, no DOM, no stores), so this test exercises
 * the whole fallback chain — live → static schema → single leaf — without any
 * mocks of platform components.
 */

import { describe, expect, it } from 'vitest';
import { buildStepOutputChildren } from '../ContextExplorer';

const OUTPUT_PATH = 'context.steps.fetch_product_details.output';

const STEP_NO_SCHEMA = {
  id: 'fetch_product_details',
  name: 'fetch_product_details',
};

const STEP_WITH_SCHEMA = {
  id: 'check_eligibility',
  name: 'check_eligibility',
  outputSchema: { conditionMet: 'boolean', branchTaken: 'string' },
};

describe('buildStepOutputChildren', () => {
  it('prefers live executionContext output over static schema (ABLP-1086 fix)', () => {
    const executionContext = {
      steps: {
        fetch_product_details: {
          output: {
            product_name: 'Widget',
            eligible: true,
            is_high_value: false,
          },
        },
      },
    };

    const children = buildStepOutputChildren(STEP_NO_SCHEMA, OUTPUT_PATH, executionContext);

    const labels = children.map((c) => c.label);
    expect(labels).toEqual(['product_name', 'eligible', 'is_high_value']);
    expect(children.every((c) => c.isLeaf)).toBe(true);
    expect(children.find((c) => c.label === 'product_name')?.expression).toBe(
      '{{context.steps.fetch_product_details.output.product_name}}',
    );
  });

  it('uses live data even when a static outputSchema is also present', () => {
    // Live data wins. A node with a registered schema (Condition) that has
    // been run should expand to actual values from the run, not the declared
    // schema fields.
    const stepWithBothLiveAndSchema = STEP_WITH_SCHEMA;
    const executionContext = {
      steps: {
        check_eligibility: { output: { conditionMet: true, branchTaken: 'then' } },
      },
    };

    const children = buildStepOutputChildren(
      stepWithBothLiveAndSchema,
      'context.steps.check_eligibility.output',
      executionContext,
    );

    expect(children.map((c) => c.label).sort()).toEqual(['branchTaken', 'conditionMet']);
  });

  it('hides engine-internal output fields (traceEvents, responseMetadata, respondedAt)', () => {
    const executionContext = {
      steps: {
        fetch_product_details: {
          output: {
            product_name: 'Widget',
            traceEvents: [{ ts: 1 }],
            responseMetadata: { latencyMs: 12 },
            respondedAt: '2026-05-15T00:00:00Z',
          },
        },
      },
    };

    const children = buildStepOutputChildren(STEP_NO_SCHEMA, OUTPUT_PATH, executionContext);

    const labels = children.map((c) => c.label);
    expect(labels).toContain('product_name');
    expect(labels).not.toContain('traceEvents');
    expect(labels).not.toContain('responseMetadata');
    expect(labels).not.toContain('respondedAt');
  });

  it('falls back to outputSchema when executionContext is absent', () => {
    const children = buildStepOutputChildren(STEP_WITH_SCHEMA, OUTPUT_PATH, null);
    expect(children.map((c) => c.label).sort()).toEqual(['branchTaken', 'conditionMet']);
  });

  it('falls back to outputSchema when executionContext has no entry for this step', () => {
    const executionContext = { steps: { other_step: { output: { ignored: true } } } };
    const children = buildStepOutputChildren(STEP_WITH_SCHEMA, OUTPUT_PATH, executionContext);
    expect(children.map((c) => c.label).sort()).toEqual(['branchTaken', 'conditionMet']);
  });

  it('falls through to the single opaque output leaf when no schema and no live data', () => {
    const children = buildStepOutputChildren(STEP_NO_SCHEMA, OUTPUT_PATH, null);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      label: 'output',
      expression: `{{${OUTPUT_PATH}}}`,
      isLeaf: true,
      type: 'any',
    });
  });

  it('ignores executionContext when steps.<id>.output is an array (only objects merge)', () => {
    // The runtime can write any JSON-serializable value to step output; if it's
    // an array we keep the single-leaf static fallback rather than trying to
    // explode array indices into the tree.
    const executionContext = {
      steps: { fetch_product_details: { output: ['a', 'b', 'c'] } },
    };
    const children = buildStepOutputChildren(STEP_NO_SCHEMA, OUTPUT_PATH, executionContext);
    expect(children).toHaveLength(1);
    expect(children[0].label).toBe('output');
  });

  it('ignores executionContext when steps.<id>.output is null', () => {
    const executionContext = {
      steps: { fetch_product_details: { output: null } },
    };
    const children = buildStepOutputChildren(STEP_NO_SCHEMA, OUTPUT_PATH, executionContext);
    expect(children).toHaveLength(1);
    expect(children[0].label).toBe('output');
  });

  it('tolerates malformed executionContext shapes without throwing', () => {
    expect(() => buildStepOutputChildren(STEP_NO_SCHEMA, OUTPUT_PATH, undefined)).not.toThrow();
    expect(() =>
      buildStepOutputChildren(STEP_NO_SCHEMA, OUTPUT_PATH, {
        steps: 'not-an-object' as unknown as Record<string, unknown>,
      }),
    ).not.toThrow();
    expect(() =>
      buildStepOutputChildren(STEP_NO_SCHEMA, OUTPUT_PATH, {
        steps: { fetch_product_details: 'not-an-object' as unknown as Record<string, unknown> },
      }),
    ).not.toThrow();
  });
});
