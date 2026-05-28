import { describe, it, expect } from 'vitest';
import { extractExpressionRefs } from '../lib/pipeline-expression-utils';

describe('extractExpressionRefs', () => {
  it('returns empty array for plain text', () => {
    expect(extractExpressionRefs('Hello world')).toEqual([]);
    expect(extractExpressionRefs('')).toEqual([]);
  });

  it('extracts a single reference', () => {
    const refs = extractExpressionRefs('Conversation:\n{{steps.node-read.output.transcript}}');
    expect(refs).toHaveLength(1);
    expect(refs[0].nodeId).toBe('node-read');
    expect(refs[0].field).toBe('transcript');
    expect(refs[0].path).toBe('{{steps.node-read.output.transcript}}');
  });

  it('extracts multiple references from a template', () => {
    const text =
      'Agent score: {{steps.eval.output.agent_score}}\nUser score: {{steps.eval.output.user_score}}';
    const refs = extractExpressionRefs(text);
    expect(refs).toHaveLength(2);
    expect(refs[0].field).toBe('agent_score');
    expect(refs[1].field).toBe('user_score');
    expect(refs[0].nodeId).toBe('eval');
    expect(refs[1].nodeId).toBe('eval');
  });

  it('extracts references with complex node IDs (dashes and underscores)', () => {
    const refs = extractExpressionRefs('{{steps.node-1776422690665-1.output.windowMessages}}');
    expect(refs).toHaveLength(1);
    expect(refs[0].nodeId).toBe('node-1776422690665-1');
    expect(refs[0].field).toBe('windowMessages');
  });

  it('extracts raw expression paths used by config fields', () => {
    const refs = extractExpressionRefs('steps.warm_up.output.delayed');
    expect(refs).toHaveLength(1);
    expect(refs[0].nodeId).toBe('warm_up');
    expect(refs[0].field).toBe('delayed');
    expect(refs[0].path).toBe('steps.warm_up.output.delayed');
  });

  it('ignores partial or malformed expressions', () => {
    expect(extractExpressionRefs('{{steps.x}}')).toHaveLength(0);
    expect(extractExpressionRefs('{{steps.x.output}}')).toHaveLength(0);
    expect(extractExpressionRefs('{{ steps.x.output.field }}')).toHaveLength(0);
  });

  it('records startIndex and endIndex', () => {
    const text = 'Prefix {{steps.n.output.f}} suffix';
    const refs = extractExpressionRefs(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].startIndex).toBe(text.indexOf('{{'));
    expect(refs[0].endIndex).toBe(text.indexOf('}}') + 2);
    expect(text.substring(refs[0].startIndex, refs[0].endIndex)).toBe(refs[0].path);
  });

  it('returns nothing when expressions are inside plain braces', () => {
    expect(extractExpressionRefs('{not an expression}')).toHaveLength(0);
    expect(extractExpressionRefs('{steps.x.output.y}')).toHaveLength(0);
  });
});
