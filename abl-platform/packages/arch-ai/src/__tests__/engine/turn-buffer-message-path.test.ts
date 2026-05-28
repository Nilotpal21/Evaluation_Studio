/**
 * Regression: turn-buffer must $push into metadata.messages, not top-level messages.
 * The V4 schema has no top-level `messages` field; a wrong-path $push silently
 * creates a stray array that no read path queries, causing the Interview loop.
 */
import { describe, it, expect } from 'vitest';

describe('turn-buffer message persistence path', () => {
  it('$push target must be "metadata.messages" with $slice -200', async () => {
    // Load source as text to verify the exact $push key — this is a
    // source-level regression guard, not a behavioural mock test.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(__dirname, '..', '..', 'engine', 'turn-buffer.ts'),
      'utf8',
    );

    // Must reference the correct nested path.
    expect(src).toContain(`'metadata.messages'`);
    // Must use the 200-entry cap to mirror V03's sliding window.
    expect(src).toContain(`$slice: -200`);
    // Must accept sessions created before fencingToken existed and backfill the field.
    expect(src).toContain(`{ fencingToken: { $exists: false } }`);
    expect(src).toContain(`{ fencingToken: { $lte: fencingToken } }`);
    expect(src).toContain(`const setFields = { fencingToken, ...this.sessionPatch };`);
    // Must NOT write to top-level `messages`.
    // The stray path is easy to reintroduce — block exact regression.
    expect(src).not.toMatch(/\$push\s*=\s*\{\s*messages:\s*\{/);
  });
});
