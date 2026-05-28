/**
 * Tests for formatApiDetails — the toast description formatter that turns
 * server validation errors into a human-readable line. Covers the
 * `[object Object]` regression and the node-label lookup.
 *
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest';
import { formatApiDetails } from '../PipelineEditorPage';

describe('formatApiDetails', () => {
  it('returns null for non-array / empty input', () => {
    expect(formatApiDetails(undefined)).toBeNull();
    expect(formatApiDetails(null)).toBeNull();
    expect(formatApiDetails('not an array')).toBeNull();
    expect(formatApiDetails([])).toBeNull();
  });

  it('joins plain string details with "; "', () => {
    expect(formatApiDetails(['first error', 'second error'])).toBe('first error; second error');
  });

  it('renders { stepId, field, message } objects as "step · field · message"', () => {
    const details = [{ stepId: 'node-123', field: 'config', message: 'required field missing' }];
    expect(formatApiDetails(details)).toBe('node-123 · config · required field missing');
  });

  it('uses the lookupLabel for stepId so the user-facing label appears, not the raw id', () => {
    const details = [
      { stepId: 'node-1776324747603-2', field: 'inputRequirements', message: 'sessionId missing' },
    ];
    const lookup = (id: string) => (id === 'node-1776324747603-2' ? 'Read Conversation' : id);

    expect(formatApiDetails(details, lookup)).toBe(
      'Read Conversation · inputRequirements · sessionId missing',
    );
  });

  it('falls back to the raw stepId when the lookup returns it unchanged', () => {
    const details = [{ stepId: 'unknown-node', message: 'oops' }];
    const lookup = (id: string) => id;
    expect(formatApiDetails(details, lookup)).toBe('unknown-node · oops');
  });

  it('regression: never produces "[object Object]" for object details', () => {
    const details = [
      { stepId: 'a', field: 'x', message: 'one' },
      { stepId: 'b', field: 'y', message: 'two' },
    ];
    const result = formatApiDetails(details);
    expect(result).not.toContain('[object Object]');
    expect(result).toContain('one');
    expect(result).toContain('two');
  });

  it('caps to the first 3 details (toast width)', () => {
    const details = Array.from({ length: 10 }, (_, i) => ({
      stepId: `n-${i}`,
      message: `m-${i}`,
    }));
    const result = formatApiDetails(details)!;
    expect(result.split(';').length).toBe(3);
    expect(result).toContain('m-0');
    expect(result).toContain('m-2');
    expect(result).not.toContain('m-3');
  });

  it('handles mixed strings and objects in the same list', () => {
    const details = ['plain string', { stepId: 's', message: 'object message' }];
    expect(formatApiDetails(details)).toBe('plain string; s · object message');
  });

  it('falls back to JSON.stringify when the object has no message', () => {
    const result = formatApiDetails([{ stepId: 's', field: 'f' }]);
    // No `message` field → JSON-stringify path; must not be "[object Object]".
    expect(result).not.toContain('[object Object]');
    expect(result).toContain('"stepId"');
  });
});
