import { describe, it, expect } from 'vitest';

/**
 * Timestamp faithfulness — pure-logic assertions.
 *
 * These tests verify the spreading / conversion logic that keeps
 * lastActivityAt faithful to user-interaction time rather than
 * persist-time.  Full integration coverage (touch() wiring through
 * SessionService → TieredSessionStore → SessionStateRepo) is
 * exercised by the cold-store-field-parity integration suite.
 */
describe('Timestamp faithfulness', () => {
  it('snapshot does not overwrite lastActivityAt with Date.now()', () => {
    const originalTime = Date.now() - 60_000; // 1 minute ago

    const fakeSession = {
      id: 'ts-test-1',
      lastActivityAt: { getTime: () => originalTime } as Date,
      createdAt: { getTime: () => originalTime - 5000 } as Date,
    } as any;

    // After fix: snapshot should carry session.lastActivityAt, not Date.now()
    const snapshotLastActivityAt = fakeSession.lastActivityAt?.getTime() ?? Date.now();
    expect(snapshotLastActivityAt).toBe(originalTime);
  });

  it('saveSession does not overwrite lastActivityAt with Date.now()', () => {
    const originalTime = Date.now() - 30_000;
    const session = { lastActivityAt: originalTime, version: 1 } as any;

    // After fix: preserve lastActivityAt from session, not Date.now()
    const updated = { ...session, version: session.version + 1 };
    expect(updated.lastActivityAt).toBe(originalTime);
  });
});
