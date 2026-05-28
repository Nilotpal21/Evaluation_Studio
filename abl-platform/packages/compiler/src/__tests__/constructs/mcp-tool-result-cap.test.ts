/**
 * Tests for MCP tool result size cap (M-8).
 *
 * Verifies that MCP tool results exceeding MAX_MCP_RESULT_CHARS
 * are truncated with a notice suffix.
 */

import { describe, it, expect } from 'vitest';
import {
  _normalizeMcpResultForTest as normalizeMcpResult,
  MAX_MCP_RESULT_CHARS,
} from '../../platform/constructs/executors/mcp-tool-executor.js';

describe('MCP tool result size cap (M-8)', () => {
  it('truncates result exceeding 100K chars', () => {
    const hugeResult = [{ type: 'text', text: 'x'.repeat(200_000) }];
    const normalized = normalizeMcpResult(hugeResult);
    expect(typeof normalized).toBe('string');
    expect((normalized as string).length).toBeLessThanOrEqual(
      MAX_MCP_RESULT_CHARS + 50, // account for truncation suffix
    );
  });

  it('appends truncation notice', () => {
    const hugeResult = [{ type: 'text', text: 'x'.repeat(200_000) }];
    const normalized = normalizeMcpResult(hugeResult) as string;
    expect(normalized).toContain('[truncated -- result exceeded size limit]');
  });

  it('does not truncate result under limit', () => {
    const smallResult = [{ type: 'text', text: 'hello world' }];
    const normalized = normalizeMcpResult(smallResult);
    expect(normalized).toBe('hello world');
  });

  it('handles mixed content with truncation', () => {
    const mixedResult = [
      { type: 'text', text: 'y'.repeat(200_000) },
      { type: 'image', mimeType: 'image/png' },
    ];
    const normalized = normalizeMcpResult(mixedResult) as {
      text: string;
      nonTextContent: string[];
    };
    expect(normalized.text.length).toBeLessThanOrEqual(MAX_MCP_RESULT_CHARS + 50);
    expect(normalized.text).toContain('[truncated');
    expect(normalized.nonTextContent).toContain('image(image/png)');
  });

  it('returns non-array results as-is', () => {
    expect(normalizeMcpResult('plain string')).toBe('plain string');
    expect(normalizeMcpResult(42)).toBe(42);
    expect(normalizeMcpResult(null)).toBe(null);
  });
});
