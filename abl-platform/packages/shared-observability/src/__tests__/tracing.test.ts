import { describe, it, expect } from 'vitest';
import {
  generateTraceId,
  generateSpanId,
  parseTraceparent,
  formatTraceparent,
  injectTrace,
  extractTrace,
} from '../tracing/index.js';

describe('generateTraceId', () => {
  it('returns a 32-character hex string', () => {
    const id = generateTraceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
    expect(ids.size).toBe(100);
  });
});

describe('generateSpanId', () => {
  it('returns a 16-character hex string', () => {
    const id = generateSpanId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSpanId()));
    expect(ids.size).toBe(100);
  });
});

describe('parseTraceparent', () => {
  it('parses a valid traceparent header', () => {
    const result = parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    expect(result).toEqual({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: '01',
    });
  });

  it('returns null for undefined input', () => {
    expect(parseTraceparent(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseTraceparent('')).toBeNull();
  });

  it('rejects non-00 version', () => {
    expect(parseTraceparent('01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')).toBeNull();
  });

  it('rejects all-zero trace ID', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-b7ad6b7169203331-01`)).toBeNull();
  });

  it('rejects all-zero span ID', () => {
    expect(parseTraceparent(`00-0af7651916cd43dd8448eb211c80319c-${'0'.repeat(16)}-01`)).toBeNull();
  });

  it('rejects invalid hex characters', () => {
    expect(parseTraceparent('00-ZZZZ651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')).toBeNull();
  });

  it('rejects wrong length fields', () => {
    expect(parseTraceparent('00-0af765-b7ad6b-01')).toBeNull();
  });
});

describe('formatTraceparent', () => {
  it('formats a valid traceparent string', () => {
    const result = formatTraceparent('0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331');
    expect(result).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
  });

  it('uses custom trace flags', () => {
    const result = formatTraceparent('0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331', '00');
    expect(result).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00');
  });

  it('roundtrips with parseTraceparent', () => {
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    const header = formatTraceparent(traceId, spanId);
    const parsed = parseTraceparent(header);
    expect(parsed).toEqual({ traceId, spanId, traceFlags: '01' });
  });
});

describe('injectTrace / extractTrace', () => {
  it('roundtrips span context through a carrier', () => {
    const carrier: Record<string, unknown> = {};
    const context = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      parentSpanId: 'a1b2c3d4e5f60718',
    };

    injectTrace(carrier, context);
    const extracted = extractTrace(carrier);

    expect(extracted).toEqual(context);
  });

  it('handles missing parentSpanId', () => {
    const carrier: Record<string, unknown> = {};
    const context = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
    };

    injectTrace(carrier, context);
    const extracted = extractTrace(carrier);

    expect(extracted).toEqual(context);
    expect(extracted?.parentSpanId).toBeUndefined();
  });

  it('returns null for empty carrier', () => {
    expect(extractTrace({})).toBeNull();
  });

  it('returns null for non-string values', () => {
    expect(extractTrace({ __traceId: 123, __spanId: 456 })).toBeNull();
  });

  it('preserves existing carrier properties', () => {
    const carrier: Record<string, unknown> = { jobType: 'ingest', priority: 1 };
    injectTrace(carrier, {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
    });

    expect(carrier.jobType).toBe('ingest');
    expect(carrier.priority).toBe(1);
  });
});
