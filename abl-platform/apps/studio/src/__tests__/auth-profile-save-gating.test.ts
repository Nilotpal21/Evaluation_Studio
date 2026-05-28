/**
 * Pure-function coverage for auth-profile save gating.
 *
 * The route handlers share evaluateSaveGating so credential-sensitive OAuth
 * transitions stay in one place and do not drift between project/workspace
 * update paths.
 */

import { describe, expect, it } from 'vitest';
import { evaluateSaveGating } from '@/app/api/auth-profiles/_save-gating';

describe('evaluateSaveGating', () => {
  it('forces oauth2_app reauthorization when the clientId changes', async () => {
    const result = await evaluateSaveGating({
      existingProfile: {
        authType: 'oauth2_app',
        config: {
          authorizationUrl: 'https://provider.example/oauth/authorize',
          tokenUrl: 'https://provider.example/oauth/token',
        },
      },
      existingSecrets: { clientId: 'old-client-id', clientSecret: 'same-secret' },
      mergedConfig: undefined,
      updates: { secrets: { clientId: 'new-client-id' } },
    });

    expect(result).toEqual({ kind: 'allow', forceReauth: true });
  });

  it('does not force oauth2_app reauthorization for metadata-only updates', async () => {
    const result = await evaluateSaveGating({
      existingProfile: {
        authType: 'oauth2_app',
        config: {
          authorizationUrl: 'https://provider.example/oauth/authorize',
          tokenUrl: 'https://provider.example/oauth/token',
        },
      },
      existingSecrets: { clientId: 'client-id', clientSecret: 'secret' },
      mergedConfig: undefined,
      updates: {},
    });

    expect(result).toEqual({ kind: 'allow', forceReauth: false });
  });
});
