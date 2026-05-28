/**
 * Admin Route Handler Wrapper
 *
 * Wraps Next.js API route handlers with JWT authentication and role-based
 * authorization. Replaces the broken Edge middleware → header propagation
 * pattern with direct JWT verification in each route handler.
 *
 * Usage:
 *   export const GET = withAdminRoute({ role: 'VIEWER' }, async (ctx) => {
 *     // ctx.user, ctx.request, ctx.params, ctx.token
 *     return NextResponse.json({ data: ... });
 *   });
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { withAuditActor } from '@agent-platform/database/mongo';
import { ensureAdminAuditTrailHandlerRegistered } from './admin-audit-trail-handler';
import { isPlatformAdminUser } from './platform-access-policy';
import { ROLE_HIERARCHY } from './role-guard';
import { createLogger } from './logger';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_SESSION_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const PLATFORM_SUPER_ADMIN_REQUIRED_MESSAGE = 'Platform super-admin access required.';
const log = createLogger('admin-route');

function isBootstrapSuperAdmin(userId: string): boolean {
  return (process.env.SUPER_ADMIN_USER_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(userId);
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AdminRouteUser {
  userId: string;
  email: string;
  role: string;
  ipAddress: string;
  isSuperAdmin: boolean;
}

export interface AdminRouteContext<
  P extends Record<string, string | string[]> = Record<string, string>,
> {
  request: NextRequest;
  user: AdminRouteUser;
  params: P;
  /** Raw JWT token for proxy forwarding */
  token: string;
}

export interface AdminRouteOptions {
  /** Minimum role required. Default: 'VIEWER' */
  role?: string;
}

type AdminRouteHandler<P extends Record<string, string | string[]> = Record<string, string>> = (
  ctx: AdminRouteContext<P>,
) => Promise<NextResponse>;

// ─── Helpers ────────────────────────────────────────────────────────────────

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not configured');
  return new TextEncoder().encode(secret);
}

function hasMinimumRole(userRole: string, requiredRole: string): boolean {
  const userLevel = ROLE_HIERARCHY[userRole] ?? -1;
  const requiredLevel = ROLE_HIERARCHY[requiredRole] ?? Infinity;
  return userLevel >= requiredLevel;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Wraps a Next.js API route handler with admin JWT auth and role checks.
 *
 * The wrapper:
 *  1. Extracts JWT from Authorization header or admin-session cookie
 *  2. Verifies JWT signature and claims (type=access, valid role)
 *  3. Checks session age (8h max) and idle timeout (30min)
 *  4. Checks minimum role requirement
 *  5. Strips client-supplied x-admin-user-* headers (anti-spoofing)
 *  6. Updates admin-last-activity cookie on success
 *  7. Catches errors and returns structured JSON responses
 */
export function withAdminRoute<
  P extends Record<string, string | string[]> = Record<string, string>,
>(options: AdminRouteOptions, handler: AdminRouteHandler<P>) {
  const minimumRole = options.role ?? 'VIEWER';

  return async (
    request: NextRequest,
    routeCtx: { params: Promise<Record<string, string | string[]>> },
  ): Promise<NextResponse> => {
    try {
      ensureAdminAuditTrailHandlerRegistered();

      // ── Extract token ───────────────────────────────────────────────
      const authHeader = request.headers.get('authorization');
      const sessionCookie = request.cookies.get('admin-session');
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : sessionCookie?.value;

      if (!token) {
        return NextResponse.json(
          { success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
          { status: 401 },
        );
      }

      // ── Verify JWT ──────────────────────────────────────────────────
      let payload: {
        sub?: string;
        email?: string;
        type?: string;
        role?: string;
        isSuperAdmin?: boolean;
        iat?: number;
      };
      try {
        const { payload: verified } = await jwtVerify(token, getJwtSecret());
        payload = verified as typeof payload;
      } catch {
        return NextResponse.json(
          {
            success: false,
            error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
          },
          { status: 401 },
        );
      }

      // ── Verify token type ──────────────────────────────────────────
      if (payload.type !== 'access') {
        return NextResponse.json(
          { success: false, error: { code: 'FORBIDDEN', message: 'Invalid token type' } },
          { status: 403 },
        );
      }

      // ── Check session age ──────────────────────────────────────────
      if (payload.iat) {
        const tokenAge = Date.now() - payload.iat * 1000;
        if (tokenAge > MAX_SESSION_AGE_MS) {
          return NextResponse.json(
            {
              success: false,
              error: { code: 'SESSION_EXPIRED', message: 'Session expired (max age exceeded)' },
            },
            { status: 401 },
          );
        }
      }

      // ── Check idle timeout ─────────────────────────────────────────
      const lastActivity = request.cookies.get('admin-last-activity');
      if (lastActivity?.value) {
        const idleTime = Date.now() - parseInt(lastActivity.value, 10);
        if (idleTime > IDLE_TIMEOUT_MS) {
          const response = NextResponse.json(
            {
              success: false,
              error: { code: 'SESSION_EXPIRED', message: 'Session expired (idle timeout)' },
            },
            { status: 401 },
          );
          response.cookies.delete('admin-session');
          response.cookies.delete('admin-last-activity');
          return response;
        }
      }

      // ── Verify admin role ──────────────────────────────────────────
      const isSuperAdmin =
        payload.isSuperAdmin === true &&
        !!payload.sub &&
        (await isPlatformAdminUser(
          { id: payload.sub, email: payload.email },
          { isBootstrapSuperAdmin },
        ));
      if (!isSuperAdmin) {
        return NextResponse.json(
          {
            success: false,
            error: { code: 'FORBIDDEN', message: PLATFORM_SUPER_ADMIN_REQUIRED_MESSAGE },
          },
          { status: 403 },
        );
      }

      // ── Check minimum role requirement ─────────────────────────────
      const effectiveRole = 'SUPER_ADMIN';
      if (!hasMinimumRole(effectiveRole, minimumRole)) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'FORBIDDEN',
              message: `Insufficient permissions. ${minimumRole} role or higher required.`,
            },
          },
          { status: 403 },
        );
      }

      // ── Build user context ─────────────────────────────────────────
      const ipAddress =
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        request.headers.get('x-real-ip') ??
        'unknown';

      const user: AdminRouteUser = {
        userId: payload.sub ?? '',
        email: payload.email ?? '',
        role: effectiveRole,
        ipAddress,
        isSuperAdmin,
      };

      // ── Await route params ─────────────────────────────────────────
      const params = (await routeCtx.params) as P;

      // ── Execute handler ────────────────────────────────────────────
      const response = await withAuditActor(
        {
          userId: user.userId,
          email: user.email,
          ip: user.ipAddress,
          userAgent: request.headers.get('user-agent') ?? undefined,
        },
        () => handler({ request, user, params, token }),
      );

      // ── Update idle timeout cookie ─────────────────────────────────
      response.cookies.set('admin-last-activity', String(Date.now()), {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: IDLE_TIMEOUT_MS / 1000,
      });

      return response;
    } catch (err: unknown) {
      log.error('Unhandled admin route error', {
        error: err instanceof Error ? err.message : String(err),
        pathname: request.nextUrl.pathname,
      });
      return NextResponse.json(
        {
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        },
        { status: 500 },
      );
    }
  };
}
