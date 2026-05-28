import { describe, expect, it } from 'vitest';

import { AuthProfileError } from '../errors.js';
import { RESERVED_PRINCIPALS, assertNotReservedPrincipal } from '../reserved-principals.js';

describe('assertNotReservedPrincipal (RP-1)', () => {
  it('passes for a real UUID-shaped userId', () => {
    expect(() => assertNotReservedPrincipal('01h3sxv2gqz9k7m6c4t5p8n0w1')).not.toThrow();
    expect(() => assertNotReservedPrincipal('user-abc-123')).not.toThrow();
  });

  it('rejects __tenant__ — the canonical reserved system principal', () => {
    let caught: unknown;
    try {
      assertNotReservedPrincipal('__tenant__');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuthProfileError);
    expect(caught).toMatchObject({ code: 'AUTH_RESERVED_PRINCIPAL', statusCode: 400 });
  });

  it('rejects unknown __-prefixed userIds even if they are not in the approved list', () => {
    let caught: unknown;
    try {
      assertNotReservedPrincipal('__future_principal');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuthProfileError);
    expect((caught as AuthProfileError).code).toBe('AUTH_RESERVED_PRINCIPAL');
  });

  it('rejects empty input', () => {
    expect(() => assertNotReservedPrincipal('')).toThrow(AuthProfileError);
  });

  it('exposes the approved-list constant for external consumers', () => {
    expect(RESERVED_PRINCIPALS).toEqual(['__tenant__']);
  });
});
