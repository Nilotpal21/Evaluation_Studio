import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getVersionVector, resetVersionVector } from '../../sti/version-vector.js';

describe('VersionVector', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetVersionVector();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetVersionVector();
  });

  it('returns default values when env vars are not set', () => {
    delete process.env.GIT_SHA;
    delete process.env.DEPLOY_ID;
    delete process.env.npm_package_version;

    const vec = getVersionVector();
    expect(vec.codeVersion).toBe('unknown');
    expect(vec.irSchemaVersion).toBe(1);
    expect(vec.deployId).toBe('local');
  });

  it('reads GIT_SHA for codeVersion', () => {
    process.env.GIT_SHA = 'abc123';
    const vec = getVersionVector();
    expect(vec.codeVersion).toBe('abc123');
  });

  it('falls back to npm_package_version when GIT_SHA is absent', () => {
    delete process.env.GIT_SHA;
    process.env.npm_package_version = '2.3.4';
    const vec = getVersionVector();
    expect(vec.codeVersion).toBe('2.3.4');
  });

  it('reads DEPLOY_ID for deployId', () => {
    process.env.DEPLOY_ID = 'deploy-42';
    const vec = getVersionVector();
    expect(vec.deployId).toBe('deploy-42');
  });

  it('caches the result across calls', () => {
    process.env.GIT_SHA = 'first';
    const first = getVersionVector();

    process.env.GIT_SHA = 'second';
    const second = getVersionVector();

    expect(first).toBe(second);
    expect(second.codeVersion).toBe('first');
  });

  it('resetVersionVector clears the cache', () => {
    process.env.GIT_SHA = 'first';
    getVersionVector();

    resetVersionVector();
    process.env.GIT_SHA = 'second';
    const vec = getVersionVector();
    expect(vec.codeVersion).toBe('second');
  });
});
