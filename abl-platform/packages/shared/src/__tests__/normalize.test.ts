import { describe, it, expect } from 'vitest';
import { normalizeDocument } from '../utils/normalize.js';

// =============================================================================
// normalizeDocument()
// =============================================================================

describe('normalizeDocument', () => {
  it('returns null for null input', () => {
    expect(normalizeDocument(null)).toBeNull();
  });

  it('adds id from _id', () => {
    const doc = { _id: 'abc123', name: 'Test' };
    const result = normalizeDocument(doc);
    expect(result!.id).toBe('abc123');
    expect(result!._id).toBe('abc123');
    expect(result!.name).toBe('Test');
  });

  it('converts Date createdAt to ISO string', () => {
    const date = new Date('2026-01-15T10:30:00.000Z');
    const doc = { _id: 'x', createdAt: date } as any;
    const result = normalizeDocument(doc);
    expect(result!.createdAt).toBe('2026-01-15T10:30:00.000Z');
  });

  it('converts Date updatedAt to ISO string', () => {
    const date = new Date('2026-02-01T08:00:00.000Z');
    const doc = { _id: 'x', updatedAt: date } as any;
    const result = normalizeDocument(doc);
    expect(result!.updatedAt).toBe('2026-02-01T08:00:00.000Z');
  });

  it('leaves non-Date timestamps unchanged', () => {
    const doc = { _id: 'x', createdAt: '2026-01-01', updatedAt: 1234567890 } as any;
    const result = normalizeDocument(doc);
    expect(result!.createdAt).toBe('2026-01-01');
    expect(result!.updatedAt).toBe(1234567890);
  });

  it('handles documents without timestamps', () => {
    const doc = { _id: 'abc', score: 42 };
    const result = normalizeDocument(doc);
    expect(result!.id).toBe('abc');
    expect(result!.score).toBe(42);
    expect(result).not.toHaveProperty('createdAt');
  });

  it('does not mutate the original document', () => {
    const doc = { _id: 'original', name: 'test' };
    normalizeDocument(doc);
    expect(doc).not.toHaveProperty('id');
  });
});
