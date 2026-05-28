/**
 * Tests for runtime config hygiene — coldPersistDebounceMs floor and default.
 */

import { describe, it, expect } from 'vitest';
import { RuntimeConfigSchema } from '../config/index.js';
import { DEFAULT_SESSION_CONFIG } from '../services/session/types.js';

/** Minimal valid base config to satisfy required fields (jwt.secret). */
const BASE = {
  jwt: { secret: 'a]3Fg!kP9$mN2vR8wX5yB7cD0hJ4qT6u' },
};

describe('Config hygiene', () => {
  it('coldPersistDebounceMs rejects values below 500', () => {
    expect(() =>
      RuntimeConfigSchema.parse({
        ...BASE,
        session: { coldPersistDebounceMs: 100 },
      }),
    ).toThrow();
  });

  it('coldPersistDebounceMs accepts 500', () => {
    const config = RuntimeConfigSchema.parse({
      ...BASE,
      session: { coldPersistDebounceMs: 500 },
    });
    expect(config.session.coldPersistDebounceMs).toBe(500);
  });

  it('coldPersistDebounceMs defaults to 2000', () => {
    const config = RuntimeConfigSchema.parse(BASE);
    expect(config.session.coldPersistDebounceMs).toBe(2000);
  });

  it('runtime schema default matches the session service default', () => {
    const config = RuntimeConfigSchema.parse(BASE);
    expect(config.session.coldPersistDebounceMs).toBe(DEFAULT_SESSION_CONFIG.coldPersistDebounceMs);
  });
});
