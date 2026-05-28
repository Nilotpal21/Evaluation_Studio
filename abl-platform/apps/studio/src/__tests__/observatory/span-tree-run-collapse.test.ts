/**
 * Tests for SpanTree's `groupConsecutiveSimilarChildren` helper, which
 * collapses runs of 3+ consecutive identical sibling spans into a single
 * collapsed row in the tree.
 *
 * Audit reference: Theme 23 (ABLP-569).
 */

import { describe, expect, it } from 'vitest';
import {
  groupConsecutiveSimilarChildren,
  RUN_COLLAPSE_THRESHOLD,
} from '../../components/observatory/SpanTree';
import type { Span, SpanTreeNode } from '../../types';

function makeNode(
  spanId: string,
  name: string,
  status: Span['status'] = 'completed',
): SpanTreeNode {
  return {
    span: {
      spanId,
      traceId: 'trace-1',
      name,
      startTime: new Date(0),
      endTime: new Date(10),
      durationMs: 10,
      status,
      agentName: 'demo_agent',
      sessionId: 'sess-1',
      events: [],
      attributes: {},
    },
    children: [],
    depth: 1,
  };
}

describe('SpanTree groupConsecutiveSimilarChildren', () => {
  it('returns an empty array when there are no children', () => {
    expect(groupConsecutiveSimilarChildren([])).toEqual([]);
  });

  it('renders single children as singles', () => {
    const a = makeNode('a', 'flow_step');
    const b = makeNode('b', 'llm_call');
    const c = makeNode('c', 'tool_call');
    const result = groupConsecutiveSimilarChildren([a, b, c]);
    expect(result).toHaveLength(3);
    expect(result.every((entry) => entry.kind === 'single')).toBe(true);
  });

  it('keeps runs of 2 as individual singles (below the 3+ threshold)', () => {
    const a = makeNode('a', 'constraint_check');
    const b = makeNode('b', 'constraint_check');
    const result = groupConsecutiveSimilarChildren([a, b]);
    expect(result).toHaveLength(2);
    expect(result.every((entry) => entry.kind === 'single')).toBe(true);
  });

  it('collapses a run of 3 consecutive identical name+status children', () => {
    const nodes = [
      makeNode('a', 'constraint_check'),
      makeNode('b', 'constraint_check'),
      makeNode('c', 'constraint_check'),
    ];
    const result = groupConsecutiveSimilarChildren(nodes);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: 'run',
      key: 'run-a',
      nodes,
    });
  });

  it('reproduces the audit pattern: collapses 7 consecutive constraint_check spans into one run', () => {
    const seven = Array.from({ length: 7 }, (_, i) => makeNode(`c${i}`, 'constraint_check'));
    const result = groupConsecutiveSimilarChildren(seven);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('run');
    if (result[0].kind === 'run') {
      expect(result[0].nodes).toHaveLength(7);
    }
  });

  it('preserves order — non-matching children break the run', () => {
    const r1 = makeNode('r1', 'constraint_check');
    const r2 = makeNode('r2', 'constraint_check');
    const r3 = makeNode('r3', 'constraint_check');
    const tool = makeNode('t', 'tool_call');
    const r4 = makeNode('r4', 'constraint_check');
    const result = groupConsecutiveSimilarChildren([r1, r2, r3, tool, r4]);
    expect(result).toHaveLength(3);
    // First entry: run of 3
    expect(result[0]).toMatchObject({ kind: 'run' });
    // Middle entry: tool_call as single
    expect(result[1]).toMatchObject({ kind: 'single' });
    // Trailing entry: lone constraint_check stays single (run is broken)
    expect(result[2]).toMatchObject({ kind: 'single' });
    if (result[0].kind === 'run') expect(result[0].nodes).toHaveLength(3);
  });

  it('does not collapse when status differs even if names match', () => {
    const ok = makeNode('a', 'constraint_check', 'completed');
    const err = makeNode('b', 'constraint_check', 'error');
    const ok2 = makeNode('c', 'constraint_check', 'completed');
    const result = groupConsecutiveSimilarChildren([ok, err, ok2]);
    expect(result).toHaveLength(3);
    expect(result.every((entry) => entry.kind === 'single')).toBe(true);
  });

  it('exposes RUN_COLLAPSE_THRESHOLD as 3 (audit-aligned)', () => {
    expect(RUN_COLLAPSE_THRESHOLD).toBe(3);
  });
});
