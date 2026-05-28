/**
 * Unit tests for WorkflowToolExecutor — pure-function style.
 * UT-4: normalizer handles both envelope shapes + 409-on-cancel
 * UT-6: exp-backoff schedule, paramMapping pass-through + JSONPath resolution
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeEngineError,
  resolveJsonPath,
  applyParamMapping,
  POLL_BACKOFF_SCHEDULE,
} from '../workflow-tool-executor.js';

// ─── UT-4: normalizeEngineError ──────────────────────────────────────────

describe('normalizeEngineError', () => {
  describe('flat-string envelope', () => {
    it('wraps 404 flat-string as "workflow not found"', () => {
      const result = normalizeEngineError(404, { success: false, error: 'Workflow not found' });
      expect(result.message).toBe('workflow not found: Workflow not found');
    });

    it('wraps 400 flat-string as-is', () => {
      const result = normalizeEngineError(400, {
        success: false,
        error: 'Missing required parameters',
      });
      expect(result.message).toBe('Missing required parameters');
    });

    it('wraps 502 flat-string as "workflow engine unavailable"', () => {
      const result = normalizeEngineError(502, {
        success: false,
        error: 'Restate connection refused',
      });
      expect(result.message).toBe('workflow engine unavailable: Restate connection refused');
      expect(result.upstreamCode).toBe('RESTATE_START_FAILED');
    });
  });

  describe('structured envelope', () => {
    it('handles INVALID_EXECUTION_ID', () => {
      const result = normalizeEngineError(400, {
        success: false,
        error: { code: 'INVALID_EXECUTION_ID', message: 'executionId must be a valid UUID' },
      });
      expect(result.message).toBe('INVALID_EXECUTION_ID: executionId must be a valid UUID');
      expect(result.upstreamCode).toBe('INVALID_EXECUTION_ID');
    });

    it('handles INVALID_TRIGGER_TYPE', () => {
      const result = normalizeEngineError(400, {
        success: false,
        error: {
          code: 'INVALID_TRIGGER_TYPE',
          message: 'triggerType must be one of: manual, api, trigger, schedule',
        },
      });
      expect(result.message).toContain('INVALID_TRIGGER_TYPE');
    });

    it('handles DUPLICATE_NODE_NAMES', () => {
      const result = normalizeEngineError(400, {
        success: false,
        error: { code: 'DUPLICATE_NODE_NAMES', message: 'All node names must be unique' },
      });
      expect(result.message).toBe('DUPLICATE_NODE_NAMES: All node names must be unique');
      expect(result.upstreamCode).toBe('DUPLICATE_NODE_NAMES');
    });

    it('handles RESTATE_START_FAILED with special prefix', () => {
      const result = normalizeEngineError(502, {
        success: false,
        error: { code: 'RESTATE_START_FAILED', message: 'connection refused' },
      });
      expect(result.message).toBe('workflow engine unavailable: connection refused');
      expect(result.upstreamCode).toBe('RESTATE_START_FAILED');
    });

    it('handles structured error with no code', () => {
      const result = normalizeEngineError(400, {
        success: false,
        error: { message: 'something went wrong' },
      });
      expect(result.message).toBe('something went wrong');
    });
  });

  describe('edge cases', () => {
    it('handles null body', () => {
      const result = normalizeEngineError(500, null);
      expect(result.message).toBe('workflow engine error: HTTP 500');
    });

    it('handles undefined body', () => {
      const result = normalizeEngineError(500, undefined);
      expect(result.message).toBe('workflow engine error: HTTP 500');
    });

    it('handles body with no error field', () => {
      const result = normalizeEngineError(500, { success: false });
      expect(result.message).toBe('workflow engine error: HTTP 500');
    });

    it('handles body with array error field', () => {
      const result = normalizeEngineError(500, { error: ['not', 'expected'] });
      expect(result.message).toBe('workflow engine error: HTTP 500');
    });

    it('handles numeric body', () => {
      const result = normalizeEngineError(500, 42);
      expect(result.message).toBe('workflow engine error: HTTP 500');
    });
  });
});

// ─── UT-6: exp-backoff schedule ──────────────────────────────────────────

describe('POLL_BACKOFF_SCHEDULE', () => {
  it('matches D-7: [250, 500, 1000, 2000]', () => {
    expect([...POLL_BACKOFF_SCHEDULE]).toEqual([250, 500, 1000, 2000]);
  });

  it('is monotonically increasing', () => {
    for (let i = 1; i < POLL_BACKOFF_SCHEDULE.length; i++) {
      expect(POLL_BACKOFF_SCHEDULE[i]).toBeGreaterThan(POLL_BACKOFF_SCHEDULE[i - 1]);
    }
  });

  it('cap is 2000ms (last element)', () => {
    expect(POLL_BACKOFF_SCHEDULE[POLL_BACKOFF_SCHEDULE.length - 1]).toBe(2000);
  });
});

// ─── UT-6: resolveJsonPath ───────────────────────────────────────────────

describe('resolveJsonPath', () => {
  it('resolves top-level field', () => {
    expect(resolveJsonPath({ name: 'Alice' }, '$.name')).toBe('Alice');
  });

  it('resolves nested field', () => {
    expect(resolveJsonPath({ a: { b: { c: 42 } } }, '$.a.b.c')).toBe(42);
  });

  it('returns undefined for missing field', () => {
    expect(resolveJsonPath({ a: 1 }, '$.b')).toBeUndefined();
  });

  it('returns undefined for missing nested field', () => {
    expect(resolveJsonPath({ a: { x: 1 } }, '$.a.b.c')).toBeUndefined();
  });

  it('returns undefined for non-JSONPath string', () => {
    expect(resolveJsonPath({ a: 1 }, 'a')).toBeUndefined();
  });

  it('returns undefined when traversing through null', () => {
    expect(resolveJsonPath({ a: null } as Record<string, unknown>, '$.a.b')).toBeUndefined();
  });

  it('resolves to object value', () => {
    const obj = { a: { nested: { deep: true } } };
    expect(resolveJsonPath(obj, '$.a.nested')).toEqual({ deep: true });
  });
});

// ─── UT-6: applyParamMapping ─────────────────────────────────────────────

describe('applyParamMapping', () => {
  it('passes through when paramMapping is empty', () => {
    const params = { foo: 'bar', num: 42 };
    expect(applyParamMapping(params, {})).toBe(params); // same reference
  });

  it('maps fields via JSONPath', () => {
    const params = { user: { name: 'Alice', age: 30 } };
    const mapping = { userName: '$.user.name', userAge: '$.user.age' };
    expect(applyParamMapping(params, mapping)).toEqual({ userName: 'Alice', userAge: 30 });
  });

  it('produces undefined for unresolvable paths', () => {
    const params = { a: 1 };
    const mapping = { x: '$.nonexistent.field' };
    expect(applyParamMapping(params, mapping)).toEqual({ x: undefined });
  });

  it('handles mixed resolvable and unresolvable mappings', () => {
    const params = { name: 'Bob', address: { city: 'NYC' } };
    const mapping = { n: '$.name', zip: '$.address.zip', city: '$.address.city' };
    const result = applyParamMapping(params, mapping);
    expect(result).toEqual({ n: 'Bob', zip: undefined, city: 'NYC' });
  });
});
