/**
 * Template Store Config — Validation Tests
 *
 * Bug 6: JWT secret mismatch between Studio and template-store.
 * Template-store previously used 'dev-secret-change-in-production', while
 * Studio and the rest of the platform use 'development-secret-change-in-production'.
 * Verify the fix is in place: the default JWT secret must match the platform standard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('Template store config', () => {
  // Save and restore env state around tests to avoid leaking into other suites
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      JWT_SECRET: process.env.JWT_SECRET,
      NODE_ENV: process.env.NODE_ENV,
    };
    // Clear JWT_SECRET so loadConfig() uses its default
    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    // Restore env
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('default JWT secret matches platform standard (development-secret-change-in-production)', async () => {
    // Re-import loadConfig (not getConfig singleton) to get a fresh config
    const { loadConfig } = await import('../../config.js');
    const config = loadConfig();

    // This is the platform standard used by Studio, Runtime, Admin
    expect(config.jwtSecret).toBe('development-secret-change-in-production');
  });

  it('JWT secret can be overridden via JWT_SECRET env var', async () => {
    process.env.JWT_SECRET = 'custom-secret-for-test';
    const { loadConfig } = await import('../../config.js');
    const config = loadConfig();

    expect(config.jwtSecret).toBe('custom-secret-for-test');
  });
});
