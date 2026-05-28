import { describe, it, expect } from 'vitest';
import { generateId, prefixedId, ids, otelTraceId, otelSpanId } from '../id.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// =============================================================================
// generateId()
// =============================================================================

describe('generateId', () => {
  it('returns a valid UUID v4', () => {
    expect(generateId()).toMatch(UUID_REGEX);
  });

  it('returns unique values on each call', () => {
    const a = generateId();
    const b = generateId();
    expect(a).not.toBe(b);
  });
});

// =============================================================================
// prefixedId()
// =============================================================================

describe('prefixedId', () => {
  it('returns prefix_uuid format', () => {
    const id = prefixedId('test');
    expect(id).toMatch(
      /^test_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('uses the given prefix', () => {
    expect(prefixedId('foo')).toMatch(/^foo_/);
    expect(prefixedId('bar')).toMatch(/^bar_/);
  });

  it('returns unique values on each call', () => {
    const a = prefixedId('x');
    const b = prefixedId('x');
    expect(a).not.toBe(b);
  });
});

// =============================================================================
// ids convenience generators
// =============================================================================

describe('ids', () => {
  it('session() returns sess_ prefix', () => {
    expect(ids.session()).toMatch(/^sess_/);
  });

  it('trace() returns tr_ prefix', () => {
    expect(ids.trace()).toMatch(/^tr_/);
  });

  it('span() returns sp_ prefix', () => {
    expect(ids.span()).toMatch(/^sp_/);
  });

  it('job() returns job_ prefix', () => {
    expect(ids.job()).toMatch(/^job_/);
  });

  it('pod() returns pod_ prefix', () => {
    expect(ids.pod()).toMatch(/^pod_/);
  });

  it('all return valid UUID v4 after prefix', () => {
    for (const key of ['session', 'trace', 'span', 'job', 'pod'] as const) {
      const id = ids[key]();
      const uuid = id.split('_').slice(1).join('_');
      expect(uuid).toMatch(UUID_REGEX);
    }
  });
});

// =============================================================================
// otelTraceId()
// =============================================================================

describe('otelTraceId', () => {
  it('returns a 32-character hex string', () => {
    const id = otelTraceId();
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('returns unique values on each call', () => {
    const a = otelTraceId();
    const b = otelTraceId();
    expect(a).not.toBe(b);
  });
});

// =============================================================================
// otelSpanId()
// =============================================================================

describe('otelSpanId', () => {
  it('returns a 16-character hex string', () => {
    const id = otelSpanId();
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns unique values on each call', () => {
    const a = otelSpanId();
    const b = otelSpanId();
    expect(a).not.toBe(b);
  });
});
