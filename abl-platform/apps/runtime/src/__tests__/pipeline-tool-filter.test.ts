/**
 * Tests for pipeline tool filter — pure function tests (no LLM mocking).
 */

import { describe, it, expect } from 'vitest';
import { parseToolFilterResponse } from '../services/pipeline/tool-filter.js';

const validTools = new Set(['check_balance', 'process_refund', 'get_details', 'update_account']);

describe('parseToolFilterResponse', () => {
  it('parses valid JSON with tool names', () => {
    const result = parseToolFilterResponse(
      '{"tools": ["check_balance", "get_details"]}',
      validTools,
    );
    expect(result).toEqual(['check_balance', 'get_details']);
  });

  it('filters out invalid tool names', () => {
    const result = parseToolFilterResponse(
      '{"tools": ["check_balance", "nonexistent_tool", "get_details"]}',
      validTools,
    );
    expect(result).toEqual(['check_balance', 'get_details']);
  });

  it('handles markdown code fences', () => {
    const result = parseToolFilterResponse(
      '```json\n{"tools": ["check_balance"]}\n```',
      validTools,
    );
    expect(result).toEqual(['check_balance']);
  });

  it('returns empty array for empty tools', () => {
    const result = parseToolFilterResponse('{"tools": []}', validTools);
    expect(result).toEqual([]);
  });

  it('returns empty array for invalid JSON', () => {
    const result = parseToolFilterResponse('not json at all', validTools);
    expect(result).toEqual([]);
  });

  it('returns empty array when tools is not an array', () => {
    const result = parseToolFilterResponse('{"tools": "check_balance"}', validTools);
    expect(result).toEqual([]);
  });

  it('filters out non-string entries in tools array', () => {
    const result = parseToolFilterResponse(
      '{"tools": ["check_balance", 123, null, "get_details"]}',
      validTools,
    );
    expect(result).toEqual(['check_balance', 'get_details']);
  });

  it('handles extra whitespace', () => {
    const result = parseToolFilterResponse('  \n {"tools": ["process_refund"]} \n  ', validTools);
    expect(result).toEqual(['process_refund']);
  });
});
