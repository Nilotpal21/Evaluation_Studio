import { describe, it, expect } from 'vitest';
import { nestDotParams } from '../adapters/activepieces/context-translator.js';

describe('nestDotParams', () => {
  it('passes flat keys through unchanged', () => {
    const result = nestDotParams({ subject: 'Hello', priority: 'high' });
    expect(result).toEqual({ subject: 'Hello', priority: 'high' });
  });

  it('nests a single dot-notation key into a child object', () => {
    const result = nestDotParams({ 'issueFields.summary': 'Fix bug' });
    expect(result).toEqual({ issueFields: { summary: 'Fix bug' } });
  });

  it('groups multiple dot-notation keys under the same parent', () => {
    const result = nestDotParams({
      'issueFields.summary': 'Fix bug',
      'issueFields.description': 'Detailed description',
      'issueFields.priority': '2',
    });
    expect(result).toEqual({
      issueFields: {
        summary: 'Fix bug',
        description: 'Detailed description',
        priority: '2',
      },
    });
  });

  it('handles a mix of flat and dot-notation keys', () => {
    const result = nestDotParams({
      projectId: 'proj-1',
      issueTypeId: '10001',
      'issueFields.summary': 'My issue',
      'issueFields.assignee': 'user-42',
    });
    expect(result).toEqual({
      projectId: 'proj-1',
      issueTypeId: '10001',
      issueFields: { summary: 'My issue', assignee: 'user-42' },
    });
  });

  it('handles multiple different parent prefixes', () => {
    const result = nestDotParams({
      'a.x': '1',
      'b.y': '2',
      flat: '3',
    });
    expect(result).toEqual({ a: { x: '1' }, b: { y: '2' }, flat: '3' });
  });

  it('preserves non-string values under dot-notation keys', () => {
    const result = nestDotParams({ 'fields.count': 42, 'fields.active': true });
    expect(result).toEqual({ fields: { count: 42, active: true } });
  });

  it('returns empty object for empty input', () => {
    expect(nestDotParams({})).toEqual({});
  });

  it('dot-notation children override a flat empty-string parent (real-world Jira params shape)', () => {
    // params[prop.name] defaults to "" for the DynamicProperties parent prop itself;
    // the sub-fields arrive as issueFields.summary etc. Children must win.
    const result = nestDotParams({
      projectId: '10001',
      issueTypeId: '10007',
      issueFields: '',
      'issueFields.summary': 'Hello',
      'issueFields.reporter': 'user-1',
      'issueFields.assignee': 'user-2',
    });
    expect(result).toEqual({
      projectId: '10001',
      issueTypeId: '10007',
      issueFields: { summary: 'Hello', reporter: 'user-1', assignee: 'user-2' },
    });
  });

  it('dot-notation children override a flat parent regardless of iteration order', () => {
    // children processed first, then flat key arrives — flat key must not overwrite
    const result = nestDotParams({
      'a.x': '1',
      a: 'should-be-dropped',
    });
    expect(result).toEqual({ a: { x: '1' } });
  });
});
