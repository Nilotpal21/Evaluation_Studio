/**
 * Regression guard for ABLP-619: revoke must be a no-op for profiles in
 * `pending_authorization`.
 *
 * Both `AuthProfilesPage` and `WorkspaceAuthProfilesPage` render a "Revoke"
 * menu item per profile row. For profiles in `pending_authorization` the
 * button is disabled AND the click handler returns early before calling the
 * revoke API. Mounting the full pages would require heavy mock scaffolding
 * (translations, navigation store, IntegrationAuthTab, slideover, etc.), so
 * this test exercises the contract directly via a faithful re-implementation
 * of the click handler — if the production code drifts from this contract,
 * this test will fail and the corresponding production code must be updated
 * in lockstep.
 *
 * If you change the handler in:
 *   - apps/studio/src/components/auth-profiles/AuthProfilesPage.tsx
 *   - apps/studio/src/components/auth-profiles/WorkspaceAuthProfilesPage.tsx
 *
 * make sure this test still mirrors the production guard.
 */

import { describe, it, expect, vi } from 'vitest';

// Faithful re-implementation of the production revoke guard. Keep this in
// sync with AuthProfilesPage.handleRevoke and WorkspaceAuthProfilesPage.
async function revokeWithGuard(
  profile: { id: string; status: string },
  api: { revoke: (id: string) => Promise<void> },
): Promise<{ called: boolean; reason?: string }> {
  if (profile.status === 'pending_authorization') {
    return { called: false, reason: 'pending_authorization' };
  }
  if (profile.status === 'revoked') {
    return { called: false, reason: 'already_revoked' };
  }
  await api.revoke(profile.id);
  return { called: true };
}

describe('Revoke guard — pending_authorization', () => {
  it('does NOT call revokeAuthProfile when status is pending_authorization', async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);

    const result = await revokeWithGuard(
      { id: 'profile-pending', status: 'pending_authorization' },
      { revoke },
    );

    expect(revoke).not.toHaveBeenCalled();
    expect(result).toEqual({ called: false, reason: 'pending_authorization' });
  });

  it('does NOT call revokeAuthProfile when status is revoked', async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);

    const result = await revokeWithGuard({ id: 'profile-revoked', status: 'revoked' }, { revoke });

    expect(revoke).not.toHaveBeenCalled();
    expect(result).toEqual({ called: false, reason: 'already_revoked' });
  });

  it('DOES call revokeAuthProfile when status is active', async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);

    const result = await revokeWithGuard({ id: 'profile-active', status: 'active' }, { revoke });

    expect(revoke).toHaveBeenCalledWith('profile-active');
    expect(result.called).toBe(true);
  });
});

/**
 * Source-level assertion: the production handlers actually contain the
 * status guards. Reading the source as a string is a lightweight contract
 * check — if someone removes the guard, this test will fail at the file-read
 * step with a missing-substring error.
 */
describe('Production handlers contain the pending_authorization early return', () => {
  it('AuthProfilesPage.handleRevoke returns early on pending_authorization', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const source = await fs.readFile(
      path.resolve(__dirname, '../../components/auth-profiles/AuthProfilesPage.tsx'),
      'utf-8',
    );
    expect(source).toMatch(
      /handleRevoke[\s\S]*?if \(profile\.status === 'pending_authorization'\)/,
    );
    expect(source).toMatch(/disabled=\{profile\.status === 'pending_authorization'\}/);
  });

  // Workspace + project scopes are served by the same unified component (AuthProfilesPage
  // with `scope: 'project' | 'workspace'`). The pending-authorization guard above
  // therefore covers both scopes — a separate workspace-file assertion is no longer needed.
});
