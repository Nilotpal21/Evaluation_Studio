import { describe, it, expect } from 'vitest';
import { sanitizeDocument } from '@/lib/sanitize';

describe('sanitizeDocument', () => {
  // ─── _id handling ─────────────────────────────────────────────────────

  it('promotes _id to id and deletes _id', () => {
    const result = sanitizeDocument<Record<string, unknown>>(
      { _id: 'abc-123', name: 'test' },
      { stripFields: [] },
    );
    expect(result.id).toBe('abc-123');
    expect(result._id).toBeUndefined();
    expect(result.name).toBe('test');
  });

  it('deletes _id even when id already exists', () => {
    const result = sanitizeDocument<Record<string, unknown>>(
      { _id: 'old-id', id: 'new-id', name: 'test' },
      { stripFields: [] },
    );
    expect(result.id).toBe('new-id');
    expect(result._id).toBeUndefined();
  });

  // ─── Field stripping ─────────────────────────────────────────────────

  it('strips listed internal fields', () => {
    const result = sanitizeDocument<Record<string, unknown>>(
      { id: '1', tenantId: 't1', projectId: 'p1', name: 'test' },
      { stripFields: ['tenantId', 'projectId'] },
    );
    expect(result.tenantId).toBeUndefined();
    expect(result.projectId).toBeUndefined();
    expect(result.id).toBe('1');
    expect(result.name).toBe('test');
  });

  // ─── JSON array fields ───────────────────────────────────────────────

  it('parses JSON array field from string', () => {
    const result = sanitizeDocument<Record<string, unknown>>(
      { id: '1', tags: '["weather","api"]' },
      { stripFields: [], jsonArrayFields: ['tags'] },
    );
    expect(result.tags).toEqual(['weather', 'api']);
  });

  it('converts null JSON array field to empty array', () => {
    const result = sanitizeDocument<Record<string, unknown>>(
      { id: '1', tags: null },
      { stripFields: [], jsonArrayFields: ['tags'] },
    );
    expect(result.tags).toEqual([]);
  });

  it('converts undefined JSON array field to empty array', () => {
    const result = sanitizeDocument<Record<string, unknown>>(
      { id: '1' },
      { stripFields: [], jsonArrayFields: ['tags'] },
    );
    expect(result.tags).toEqual([]);
  });

  it('converts malformed JSON array field to empty array', () => {
    const result = sanitizeDocument<Record<string, unknown>>(
      { id: '1', tags: 'not-valid-json' },
      { stripFields: [], jsonArrayFields: ['tags'] },
    );
    expect(result.tags).toEqual([]);
  });

  // ─── JSON nullable fields ────────────────────────────────────────────

  it('parses JSON nullable field from string', () => {
    const result = sanitizeDocument<Record<string, unknown>>(
      { id: '1', args: '["--verbose","--port=3000"]' },
      { stripFields: [], jsonNullableFields: ['args'] },
    );
    expect(result.args).toEqual(['--verbose', '--port=3000']);
  });

  it('keeps null JSON nullable field as null', () => {
    const result = sanitizeDocument<Record<string, unknown>>(
      { id: '1', args: null },
      { stripFields: [], jsonNullableFields: ['args'] },
    );
    expect(result.args).toBeNull();
  });

  it('converts malformed JSON nullable field to null', () => {
    const result = sanitizeDocument<Record<string, unknown>>(
      { id: '1', args: 'not-json' },
      { stripFields: [], jsonNullableFields: ['args'] },
    );
    expect(result.args).toBeNull();
  });

  // ─── Combined ────────────────────────────────────────────────────────

  it('handles all options together', () => {
    const result = sanitizeDocument<Record<string, unknown>>(
      {
        _id: 'abc',
        id: 'abc',
        tenantId: 't1',
        name: 'test',
        tags: '["a"]',
        args: null,
      },
      {
        stripFields: ['tenantId'],
        jsonArrayFields: ['tags'],
        jsonNullableFields: ['args'],
      },
    );
    expect(result._id).toBeUndefined();
    expect(result.tenantId).toBeUndefined();
    expect(result.id).toBe('abc');
    expect(result.name).toBe('test');
    expect(result.tags).toEqual(['a']);
    expect(result.args).toBeNull();
  });
});
