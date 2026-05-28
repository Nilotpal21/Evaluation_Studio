import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BREAKER_CHECK_STATE,
  BREAKER_FORCE_RESET,
  BREAKER_RECORD_FAILURE,
  BREAKER_RECORD_SUCCESS,
} from '../scripts.js';

const luaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../lua');

describe('Lua script constants', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('embed the Lua sources so runtime imports do not depend on filesystem assets', async () => {
    await expect(fs.readFile(resolve(luaDir, 'check-state.lua'), 'utf8')).resolves.toBe(
      BREAKER_CHECK_STATE.body,
    );
    await expect(fs.readFile(resolve(luaDir, 'force-reset.lua'), 'utf8')).resolves.toBe(
      BREAKER_FORCE_RESET.body,
    );
    await expect(fs.readFile(resolve(luaDir, 'record-failure.lua'), 'utf8')).resolves.toBe(
      BREAKER_RECORD_FAILURE.body,
    );
    await expect(fs.readFile(resolve(luaDir, 'record-success.lua'), 'utf8')).resolves.toBe(
      BREAKER_RECORD_SUCCESS.body,
    );
  });

  it('imports when filesystem reads are unavailable at runtime', async () => {
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      promises: {
        readFile: vi.fn(async () => {
          throw new Error('runtime filesystem read blocked');
        }),
      },
    }));

    const scripts = await import('../scripts.js');

    expect(scripts.BREAKER_CHECK_STATE.body).toContain('check-state.lua');
    expect(scripts.BREAKER_FORCE_RESET.body).toContain('force-reset.lua');
    expect(scripts.BREAKER_RECORD_FAILURE.body).toContain('record-failure.lua');
    expect(scripts.BREAKER_RECORD_SUCCESS.body).toContain('record-success.lua');
  });
});
