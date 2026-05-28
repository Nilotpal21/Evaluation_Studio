/**
 * Regression: TurnEngine must poll cancelRequested between tool iterations and
 * emit turn_canceled when detected.
 *
 * This is source + unit-level verification. Full end-to-end cancel coverage is
 * in apps/studio/e2e/arch-v4-session.spec.ts (Task 8).
 */
import { describe, it, expect } from 'vitest';

describe('TurnEngine cancel wiring', () => {
  it('engine deps declare cancelRequestedRead and cancelRequestedClear', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(__dirname, '..', '..', 'engine', 'turn-engine.ts'),
      'utf8',
    );
    expect(src).toMatch(/cancelRequestedRead\?:\s*\(sessionId: string\)\s*=>\s*Promise<boolean>/);
    expect(src).toMatch(/cancelRequestedClear\?:\s*\(sessionId: string\)\s*=>\s*Promise<void>/);
  });

  it('engine calls cancelRequestedRead and durably commits canceled turns', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(__dirname, '..', '..', 'engine', 'turn-engine.ts'),
      'utf8',
    );
    // Must actually invoke the flag reader.
    expect(src).toMatch(/await\s+engineDeps\.cancelRequestedRead\(/);
    // Cancel must clear the durable session flag inside the committed patch.
    expect(src).toMatch(/cancelRequested:\s*false/);
    // Canceled turns must still go through the normal commit+flush path.
    expect(src).toMatch(/commitAndFlushOrFail/);
    // Must emit turn_ended with reason 'canceled'.
    expect(src).toMatch(/reason:\s*'canceled'/);
  });
});
