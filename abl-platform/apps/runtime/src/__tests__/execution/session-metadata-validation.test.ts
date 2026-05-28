import { describe, it, expect } from 'vitest';
import {
  coerceSessionMetadata,
  validateSessionMetadataSize,
  validatePostMergeSize,
  sessionMetadataSchema,
} from '../../services/session-metadata.js';

describe('sessionMetadata size validation', () => {
  it('accepts payload under 64KB', () => {
    const small = { key: 'x'.repeat(1000) };
    expect(() => validateSessionMetadataSize(small)).not.toThrow();
  });

  it('rejects payload over 64KB', () => {
    const large = { key: 'x'.repeat(70_000) };
    expect(() => validateSessionMetadataSize(large)).toThrow(/65536/);
  });

  it('rejects oversized JSON string payloads instead of silently dropping them', () => {
    const large = JSON.stringify({ key: 'x'.repeat(70_000) });
    expect(() => coerceSessionMetadata(large)).toThrow(/65536/);
  });

  it('accepts post-merge under 256KB', () => {
    const merged = { key: 'x'.repeat(200_000) };
    expect(() => validatePostMergeSize(merged)).not.toThrow();
  });

  it('rejects post-merge over 256KB', () => {
    const merged = { key: 'x'.repeat(300_000) };
    expect(() => validatePostMergeSize(merged)).toThrow(/262144/);
  });
});

describe('sessionMetadata Zod schema validation', () => {
  it('accepts valid object', () => {
    const result = sessionMetadataSchema.safeParse({ token: 'abc', profile: { name: 'Alice' } });
    expect(result.success).toBe(true);
  });

  it('rejects string value', () => {
    const result = sessionMetadataSchema.safeParse('not-an-object');
    expect(result.success).toBe(false);
  });

  it('rejects array value', () => {
    const result = sessionMetadataSchema.safeParse([1, 2, 3]);
    expect(result.success).toBe(false);
  });

  it('rejects number value', () => {
    const result = sessionMetadataSchema.safeParse(42);
    expect(result.success).toBe(false);
  });

  it('accepts empty object', () => {
    const result = sessionMetadataSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts null values for key deletion', () => {
    const result = sessionMetadataSchema.safeParse({ token: null });
    expect(result.success).toBe(true);
  });

  it('rejects payload exceeding 64KB via refine', () => {
    const result = sessionMetadataSchema.safeParse({ big: 'x'.repeat(70_000) });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/65536/);
  });
});
