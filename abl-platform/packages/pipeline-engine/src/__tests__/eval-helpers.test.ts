import { describe, expect, it } from 'vitest';
import { toCHDateTime } from '../pipeline/services/eval/eval-types.js';

describe('toCHDateTime', () => {
  it('formats a Date as YYYY-MM-DD HH:MM:SS.mmm — no T separator, no Z', () => {
    const out = toCHDateTime(new Date('2026-04-29T12:34:56.789Z'));
    expect(out).toBe('2026-04-29 12:34:56.789');
    expect(out).not.toContain('T');
    expect(out).not.toContain('Z');
  });

  it('uses now() when called without args', () => {
    const out = toCHDateTime();
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it('output is parseable by ClickHouse-style splitter', () => {
    const out = toCHDateTime(new Date('2026-01-01T00:00:00.000Z'));
    const [datePart, timePart] = out.split(' ');
    expect(datePart).toBe('2026-01-01');
    expect(timePart).toBe('00:00:00.000');
  });
});
