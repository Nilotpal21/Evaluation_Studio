/**
 * Phase 1 — Pure tests for `buildWorkflowKey`, `startsWithReservedPrefix`,
 * `RESERVED_KEY_PREFIXES`, and `MongoDBFactStore`'s `ReservedPrefixError`
 * envelope. Covers UT-3 (translation rule) + UT-5 (reserved-prefix validator).
 *
 * Pattern: pure function tests. The adapter↔MongoDB integration is verified
 * separately in `mongodb-fact-store-prefix-guard.integration.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  buildWorkflowKey,
  MAX_FACT_TTL_MS,
  MAX_KEY_LENGTH,
  MAX_VALUE_SIZE_BYTES,
  MAX_WRITES_PER_RUN,
  RESERVED_KEY_PREFIXES,
  startsWithReservedPrefix,
  WORKFLOW_KEY_PREFIX,
} from '../services/stores/workflow-memory-constants.js';

import { ReservedPrefixError } from '../services/stores/mongodb-fact-store.js';

describe('UT-3 — workflow-key translation', () => {
  it('prefixes the workflow key with `wf:<workflowId>:`', () => {
    expect(buildWorkflowKey('wf-123', 'lastCursor')).toBe('wf:wf-123:lastCursor');
  });

  it('preserves dotted keys verbatim (no nesting normalization)', () => {
    expect(buildWorkflowKey('wf-123', 'state.intent.next')).toBe('wf:wf-123:state.intent.next');
  });

  it('preserves keys that already contain colons in the author portion', () => {
    expect(buildWorkflowKey('wf-123', 'cache:order:42')).toBe('wf:wf-123:cache:order:42');
  });

  it('handles empty author key (translation does not validate non-emptiness — that is the route layer)', () => {
    expect(buildWorkflowKey('wf-123', '')).toBe('wf:wf-123:');
  });
});

describe('UT-5 — reserved-prefix validator', () => {
  it('lists `wf:`, `_meta:`, `_system:`, `_audit:` as reserved', () => {
    expect(RESERVED_KEY_PREFIXES).toEqual(['wf:', '_meta:', '_system:', '_audit:']);
    expect(WORKFLOW_KEY_PREFIX).toBe('wf:');
  });

  it.each([
    ['wf:wf-123:foo', true],
    ['_meta:run-id', true],
    ['_system:internal', true],
    ['_audit:access-log', true],
    ['memory.workflow.foo', false],
    ['lastCursor', false],
    ['nested.dotted.key', false],
    ['', false],
    ['workflow:foo', false], // close miss — author prefix doesn't match `wf:`
  ])('startsWithReservedPrefix(%s) === %s', (key, expected) => {
    expect(startsWithReservedPrefix(key)).toBe(expected);
  });
});

describe('UT-5 — ReservedPrefixError envelope', () => {
  it('exposes a stable error code', () => {
    const err = new ReservedPrefixError('wf:wf-123:foo');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('RESERVED_PREFIX');
    expect(err.name).toBe('ReservedPrefixError');
    expect(err.message).toContain('wf:wf-123:foo');
    expect(err.message).toContain('reserved prefix');
  });
});

describe('Phase 1 — quota constants are stable', () => {
  it('locks the v1 ceiling values per FR-20 / D-7', () => {
    expect(MAX_FACT_TTL_MS).toBe(365 * 24 * 60 * 60 * 1000);
    expect(MAX_VALUE_SIZE_BYTES).toBe(64 * 1024);
    expect(MAX_KEY_LENGTH).toBe(256);
    expect(MAX_WRITES_PER_RUN).toBe(100);
  });
});
