/**
 * Session Scanner Tests (INT-12)
 *
 * Covers:
 *   - Preconfigured profiles: inline refresh, valid (no refresh needed)
 *   - JIT profiles: deferred until first use
 *   - Preflight profiles: requires upfront consent
 *   - user_token profiles: deferred like JIT
 *   - Refresh-failure path: pushes to issues[]
 *   - Empty IR: no profiles referenced
 *   - Behavior profile tool additions scanned
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@agent-platform/shared-observability', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@agent-platform/shared/services/auth-profile', () => ({
  emitAuthProfileTraceEvent: vi.fn(),
  refreshOAuth2Token: vi.fn(),
  needsProactiveRefresh: vi.fn(),
}));

vi.mock('@agent-platform/shared/validation', () => ({
  resolveAuthProfileUsageMode: vi.fn(
    (authType: string, usageMode?: string) => usageMode ?? 'preconfigured',
  ),
}));

import {
  AuthProfileSessionScanner,
  collectAuthProfileRefs,
  type SessionScannerDeps,
  type ScannableProfile,
} from '../../services/auth-profile/session-scanner.js';
import {
  refreshOAuth2Token,
  needsProactiveRefresh,
} from '@agent-platform/shared/services/auth-profile';
import type { AgentIR } from '@abl/compiler';

const mockRefreshOAuth2Token = vi.mocked(refreshOAuth2Token);
const mockNeedsProactiveRefresh = vi.mocked(needsProactiveRefresh);

function makeIR(tools: Array<{ name: string; auth_profile_ref?: string }>): AgentIR {
  return {
    ir_version: '1.0',
    metadata: { name: 'test-agent', version: '1.0', type: 'conversational' },
    execution: { model: 'gpt-4o', temperature: 0.7, max_tokens: 4096, mode: 'autonomous' },
    identity: { role: 'test agent', goal: 'test' },
    tools: tools.map((t) => ({
      name: t.name,
      description: 'test tool',
      parameters: [],
      returns: { type: 'string', description: '' },
      hints: {},
      auth_profile_ref: t.auth_profile_ref,
    })),
    gather: { fields: [], strategy: 'conversational' },
    memory: { mode: 'full' },
    constraints: { rules: [] },
    coordination: { mode: 'single' },
    completion: { conditions: [] },
    error_handling: { strategy: 'retry', max_retries: 3 },
  } as unknown as AgentIR;
}

function makeIRWithBehaviorProfiles(
  baseTools: Array<{ name: string; auth_profile_ref?: string }>,
  profileToolsAdd: Array<{ name: string; auth_profile_ref?: string }>,
): AgentIR {
  const ir = makeIR(baseTools);
  (ir as any).behavior_profiles = [
    {
      name: 'bp1',
      priority: 1,
      when: 'true',
      tools_add: profileToolsAdd.map((t) => ({
        name: t.name,
        description: 'test tool',
        parameters: [],
        returns: { type: 'string', description: '' },
        hints: {},
        auth_profile_ref: t.auth_profile_ref,
      })),
    },
  ];
  return ir;
}

function makeDeps(profiles: Record<string, ScannableProfile | null>): SessionScannerDeps {
  return {
    findProfile: vi.fn(async (ref: string) => profiles[ref] ?? null),
    getRedis: vi.fn(() => null),
  };
}

function makeProfile(
  id: string,
  authType: string,
  usageMode: 'preconfigured' | 'user_token' | 'jit' | 'preflight',
  expiresAt?: Date,
): ScannableProfile {
  return {
    _id: id,
    authType,
    usageMode,
    encryptedSecrets: '{}',
    config: {},
    expiresAt: expiresAt ?? null,
  };
}

const CTX = { tenantId: 'tenant-1', projectId: 'proj-1', userId: 'user-1' };

describe('collectAuthProfileRefs', () => {
  it('collects unique auth_profile_ref from tools', () => {
    const ir = makeIR([
      { name: 'tool1', auth_profile_ref: 'profile-a' },
      { name: 'tool2', auth_profile_ref: 'profile-b' },
      { name: 'tool3', auth_profile_ref: 'profile-a' }, // duplicate
      { name: 'tool4' }, // no ref
    ]);
    expect(collectAuthProfileRefs(ir)).toEqual(['profile-a', 'profile-b']);
  });

  it('skips template refs ({{config.VAR}})', () => {
    const ir = makeIR([{ name: 'tool1', auth_profile_ref: '{{config.MY_PROFILE}}' }]);
    expect(collectAuthProfileRefs(ir)).toEqual([]);
  });

  it('returns empty array for IR with no tools', () => {
    const ir = makeIR([]);
    expect(collectAuthProfileRefs(ir)).toEqual([]);
  });

  it('collects from behavior profile tools_add', () => {
    const ir = makeIRWithBehaviorProfiles(
      [{ name: 'tool1', auth_profile_ref: 'profile-a' }],
      [{ name: 'bp-tool', auth_profile_ref: 'profile-b' }],
    );
    expect(collectAuthProfileRefs(ir)).toEqual(['profile-a', 'profile-b']);
  });
});

describe('AuthProfileSessionScanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty result for IR with no auth profile refs', async () => {
    const deps = makeDeps({});
    const scanner = new AuthProfileSessionScanner(deps);
    const ir = makeIR([{ name: 'tool1' }]);

    const result = await scanner.scan(ir, CTX);

    expect(result.preconfigured).toHaveLength(0);
    expect(result.jit).toHaveLength(0);
    expect(result.preflight).toHaveLength(0);
    expect(result.issues).toHaveLength(0);
  });

  it('classifies preconfigured profile as valid when no refresh needed', async () => {
    const profile = makeProfile('p1', 'api_key', 'preconfigured');
    const deps = makeDeps({ 'my-profile': profile });
    const scanner = new AuthProfileSessionScanner(deps);
    const ir = makeIR([{ name: 'tool1', auth_profile_ref: 'my-profile' }]);

    const result = await scanner.scan(ir, CTX);

    expect(result.preconfigured).toEqual([{ profileId: 'p1', status: 'valid' }]);
    expect(result.issues).toHaveLength(0);
  });

  it('classifies preconfigured OAuth profile as refreshed when refresh succeeds', async () => {
    const expiresAt = new Date(Date.now() + 60_000); // expires soon
    const profile = makeProfile('p2', 'oauth2_app', 'preconfigured', expiresAt);
    const deps = makeDeps({ 'oauth-profile': profile });
    const scanner = new AuthProfileSessionScanner(deps);
    const ir = makeIR([{ name: 'tool1', auth_profile_ref: 'oauth-profile' }]);

    mockNeedsProactiveRefresh.mockReturnValue(true);
    mockRefreshOAuth2Token.mockResolvedValue({
      accessToken: 'new-token',
      refreshed: true,
    });

    const result = await scanner.scan(ir, CTX);

    expect(result.preconfigured).toEqual([{ profileId: 'p2', status: 'refreshed' }]);
    expect(result.issues).toHaveLength(0);
    expect(mockRefreshOAuth2Token).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'p2',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        userId: 'user-1',
      }),
    );
  });

  it('records refresh failure in issues with REFRESH_FAILED code', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const profile = makeProfile('p3', 'oauth2_app', 'preconfigured', expiresAt);
    const deps = makeDeps({ 'failing-profile': profile });
    const scanner = new AuthProfileSessionScanner(deps);
    const ir = makeIR([{ name: 'tool1', auth_profile_ref: 'failing-profile' }]);

    mockNeedsProactiveRefresh.mockReturnValue(true);
    mockRefreshOAuth2Token.mockRejectedValue(new Error('Token exchange failed'));

    const result = await scanner.scan(ir, CTX);

    expect(result.preconfigured).toEqual([
      { profileId: 'p3', status: 'failed', error: 'Token exchange failed' },
    ]);
    expect(result.issues).toEqual([
      {
        profileId: 'p3',
        code: 'REFRESH_FAILED',
        message: 'Auth profile token refresh failed',
      },
    ]);
  });

  it('classifies JIT profile as deferred', async () => {
    const profile = makeProfile('p4', 'oauth2_app', 'jit');
    const deps = makeDeps({ 'jit-profile': profile });
    const scanner = new AuthProfileSessionScanner(deps);
    const ir = makeIR([{ name: 'tool1', auth_profile_ref: 'jit-profile' }]);

    const result = await scanner.scan(ir, CTX);

    expect(result.jit).toEqual([{ profileId: 'p4', deferredUntilFirstUse: true }]);
    expect(result.preconfigured).toHaveLength(0);
  });

  it('classifies user_token profile as deferred (like JIT)', async () => {
    const profile = makeProfile('p5', 'oauth2_token', 'user_token');
    const deps = makeDeps({ 'user-token-profile': profile });
    const scanner = new AuthProfileSessionScanner(deps);
    const ir = makeIR([{ name: 'tool1', auth_profile_ref: 'user-token-profile' }]);

    const result = await scanner.scan(ir, CTX);

    expect(result.jit).toEqual([{ profileId: 'p5', deferredUntilFirstUse: true }]);
  });

  it('classifies preflight profile as requiring upfront consent and degrades to JIT', async () => {
    const profile = makeProfile('p6', 'oauth2_app', 'preflight');
    const deps = makeDeps({ 'preflight-profile': profile });
    const scanner = new AuthProfileSessionScanner(deps);
    const ir = makeIR([{ name: 'tool1', auth_profile_ref: 'preflight-profile' }]);

    const result = await scanner.scan(ir, CTX);

    // Preflight is recorded for observability
    expect(result.preflight).toEqual([{ profileId: 'p6', requiresUpfrontConsent: true }]);
    // But also degraded to JIT so session does NOT abort
    expect(result.jit).toEqual([{ profileId: 'p6', deferredUntilFirstUse: true }]);
    expect(result.degradedFromPreflight).toEqual(['p6']);
    // Session should NOT have blocking issues from preflight
    expect(result.issues).toHaveLength(0);
  });

  it('reports PROFILE_NOT_FOUND when profile does not exist', async () => {
    const deps = makeDeps({});
    const scanner = new AuthProfileSessionScanner(deps);
    const ir = makeIR([{ name: 'tool1', auth_profile_ref: 'nonexistent' }]);

    const result = await scanner.scan(ir, CTX);

    expect(result.issues).toEqual([
      {
        profileId: 'nonexistent',
        code: 'PROFILE_NOT_FOUND',
        message: 'Auth profile not found or inactive',
      },
    ]);
  });

  it('handles multiple profiles in a single scan', async () => {
    const preconfigured = makeProfile('p1', 'api_key', 'preconfigured');
    const jit = makeProfile('p2', 'oauth2_app', 'jit');
    const preflight = makeProfile('p3', 'oauth2_app', 'preflight');

    const deps = makeDeps({
      preconfig: preconfigured,
      'jit-auth': jit,
      'preflight-auth': preflight,
    });
    const scanner = new AuthProfileSessionScanner(deps);
    const ir = makeIR([
      { name: 'tool1', auth_profile_ref: 'preconfig' },
      { name: 'tool2', auth_profile_ref: 'jit-auth' },
      { name: 'tool3', auth_profile_ref: 'preflight-auth' },
    ]);

    const result = await scanner.scan(ir, CTX);

    expect(result.preconfigured).toHaveLength(1);
    // jit has 1 original JIT + 1 degraded from preflight = 2
    expect(result.jit).toHaveLength(2);
    expect(result.preflight).toHaveLength(1);
    expect(result.degradedFromPreflight).toHaveLength(1);
    expect(result.issues).toHaveLength(0);
  });
});
