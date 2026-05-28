/**
 * Runtime adapter — validate hook attachment.
 *
 * mapAuth is structural; runtime hooks like the piece's `auth.validate` are
 * attached by `wrapActivepiecesPiece` via `wrapPieceValidate`. This file
 * covers that attachment seam plus the envelope guarantees:
 *
 *  - Hook is reachable on `connector.auth.validateAuth` after wrapping.
 *  - Thrown errors from the underlying piece are coerced to
 *    `{ valid: false, error }` so route handlers never see raw exceptions.
 *  - Pieces that don't declare a validate hook get `validateAuth: undefined`.
 *  - Dual-auth pieces (array of auth methods) prefer OAUTH2's validate, the
 *    same way mapAuth prefers OAUTH2's structural shape.
 */

import { describe, it, expect } from 'vitest';
import { wrapPieceValidate } from '../adapters/activepieces/type-mapper.js';
import { wrapActivepiecesPiece } from '../adapters/activepieces/runtime-adapter.js';

describe('wrapPieceValidate', () => {
  it('returns undefined when the piece declares no validate hook', () => {
    expect(wrapPieceValidate({ type: 'SECRET_TEXT' })).toBeUndefined();
  });

  it('returns undefined for empty / nullish auth', () => {
    expect(wrapPieceValidate(undefined)).toBeUndefined();
    expect(wrapPieceValidate([])).toBeUndefined();
  });

  it('forwards a successful validate result through unchanged', async () => {
    const validate = async () => ({ valid: true as const });
    const wrapped = wrapPieceValidate({ type: 'SECRET_TEXT', validate });
    expect(wrapped).toBeDefined();
    const result = await wrapped!({
      auth: 'token-string',
      server: { apiUrl: 'http://x', publicUrl: 'http://x' },
    });
    expect(result).toEqual({ valid: true });
  });

  it('forwards a {valid:false,error} result unchanged', async () => {
    const validate = async () => ({ valid: false as const, error: 'invalid_token' });
    const wrapped = wrapPieceValidate({ type: 'OAUTH2', validate });
    const result = await wrapped!({
      auth: { access_token: 't' },
      server: { apiUrl: 'http://x', publicUrl: 'http://x' },
    });
    expect(result).toEqual({ valid: false, error: 'invalid_token' });
  });

  it('coerces thrown Errors to {valid:false,error} so route handlers stay clean', async () => {
    const validate = async () => {
      throw new Error('rate limited');
    };
    const wrapped = wrapPieceValidate({ type: 'BASIC_AUTH', validate });
    const result = await wrapped!({
      auth: { username: 'u', password: 'p' },
      server: { apiUrl: 'http://x', publicUrl: 'http://x' },
    });
    expect(result).toEqual({ valid: false, error: 'rate limited' });
  });

  it('coerces non-Error throws to a string error', async () => {
    const validate = async () => {
      // Pieces sometimes throw raw strings or HTTP error envelopes.
      throw 'banned';
    };
    const wrapped = wrapPieceValidate({ type: 'CUSTOM_AUTH', validate });
    const result = await wrapped!({
      auth: { foo: 'bar' },
      server: { apiUrl: 'http://x', publicUrl: 'http://x' },
    });
    expect(result).toEqual({ valid: false, error: 'banned' });
  });

  it('prefers OAUTH2 validate when the piece exports an auth array', async () => {
    const oauthValidate = async () => ({ valid: true as const });
    const customValidate = async () => ({ valid: false as const, error: 'wrong-branch' });
    const wrapped = wrapPieceValidate([
      { type: 'CUSTOM_AUTH', validate: customValidate },
      { type: 'OAUTH2', validate: oauthValidate },
    ]);
    const result = await wrapped!({
      auth: {},
      server: { apiUrl: 'http://x', publicUrl: 'http://x' },
    });
    expect(result).toEqual({ valid: true });
  });
});

describe('wrapActivepiecesPiece — validateAuth wiring', () => {
  // wrapActivepiecesPiece expects a module-shaped export. The extractor
  // looks for an object with `displayName: string` + `actions` key as a
  // named export, so we wrap the piece definition under a named key.
  function makeModule(extra: { validate?: unknown } = {}) {
    return {
      testPiece: {
        name: '@activepieces/piece-test',
        displayName: 'Test',
        description: 'desc',
        version: '0.0.0',
        auth: {
          type: 'SECRET_TEXT' as const,
          ...(extra.validate ? { validate: extra.validate } : {}),
        },
        actions: {},
        triggers: {},
      },
    };
  }

  it('attaches validateAuth when the underlying piece declares one', async () => {
    const validate = async () => ({ valid: true as const });
    const connector = wrapActivepiecesPiece('test', makeModule({ validate }));
    expect(connector.auth.validateAuth).toBeDefined();
    const result = await connector.auth.validateAuth!({
      auth: 'tok',
      server: { apiUrl: 'http://x', publicUrl: 'http://x' },
    });
    expect(result).toEqual({ valid: true });
  });

  it('omits validateAuth when the underlying piece has no validate hook', () => {
    const connector = wrapActivepiecesPiece('test', makeModule());
    expect(connector.auth.validateAuth).toBeUndefined();
  });
});
