import { describe, expect, it } from 'vitest';
import { isSdkDistributedStateRequired, type RuntimeConfig } from '../../config/index.js';

function buildRuntimeConfig(
  env: RuntimeConfig['env'],
  requireDistributedState?: boolean,
): Pick<RuntimeConfig, 'env' | 'auth'> {
  return {
    env,
    auth: {
      sdk: typeof requireDistributedState === 'boolean' ? { requireDistributedState } : {},
    },
  } as Pick<RuntimeConfig, 'env' | 'auth'>;
}

describe('SDK distributed state requirement', () => {
  it('defaults to required in production when unset', () => {
    expect(isSdkDistributedStateRequired(buildRuntimeConfig('production'))).toBe(true);
  });

  it('defaults to disabled outside production when unset', () => {
    expect(isSdkDistributedStateRequired(buildRuntimeConfig('development'))).toBe(false);
    expect(isSdkDistributedStateRequired(buildRuntimeConfig('test'))).toBe(false);
  });

  it('honors explicit overrides', () => {
    expect(isSdkDistributedStateRequired(buildRuntimeConfig('production', false))).toBe(false);
    expect(isSdkDistributedStateRequired(buildRuntimeConfig('development', true))).toBe(true);
  });
});
