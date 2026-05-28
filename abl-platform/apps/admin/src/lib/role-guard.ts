/**
 * Role Guard
 *
 * Role-based access control for admin API routes.
 * Enforces a 4-tier hierarchy: VIEWER < OPERATOR < ADMIN < OWNER
 */

import { NextResponse } from 'next/server';
import type { AdminAuthContext } from './auth-context';

export const ROLE_HIERARCHY: Record<string, number> = {
  VIEWER: 0,
  OPERATOR: 1,
  ADMIN: 2,
  OWNER: 3,
  SUPER_ADMIN: 4,
};

/**
 * Check if userRole meets or exceeds the required minimum role.
 */
export function hasMinimumRole(userRole: string, requiredRole: string): boolean {
  const userLevel = ROLE_HIERARCHY[userRole] ?? -1;
  const requiredLevel = ROLE_HIERARCHY[requiredRole] ?? Infinity;
  return userLevel >= requiredLevel;
}

/**
 * Enforce minimum role on a route. Returns a 403 response if the user
 * doesn't meet the requirement, or null if access is granted.
 */
export function requireRole(auth: AdminAuthContext, minimumRole: string): NextResponse | null {
  if (!hasMinimumRole(auth.role, minimumRole)) {
    return NextResponse.json(
      { error: `Insufficient permissions. ${minimumRole} role or higher required.` },
      { status: 403 },
    );
  }
  return null;
}
