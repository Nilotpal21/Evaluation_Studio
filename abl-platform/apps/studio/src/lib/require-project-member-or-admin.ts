import { NextResponse } from 'next/server';
import type { AuthenticatedUser } from './auth';
import { requireProjectAccess, type ProjectAccessResult } from './project-access';

/**
 * Compatibility wrapper for routes that were explicitly hardened before
 * `requireProjectAccess()` enforced explicit project membership by default.
 *
 * Both helpers now share the same contract:
 * project owner, tenant admin, or explicit project member.
 */
export async function requireProjectMemberOrAdmin(
  projectId: string,
  user: AuthenticatedUser,
): Promise<ProjectAccessResult | NextResponse> {
  return requireProjectAccess(projectId, user);
}
