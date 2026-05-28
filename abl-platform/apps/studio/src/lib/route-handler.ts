/**
 * Route Handler Factory
 *
 * Composable wrapper that eliminates repetitive auth → access → validate → try/catch
 * boilerplate from every Next.js API route handler.
 *
 * Middleware chain (order matters):
 *   1. Auth (JWT verify + user lookup + permission resolution)
 *   2. Rate limit check (if configured) → 429
 *   3. Tenant resolution
 *   4. Feature gate check (if requireFeature) → 403 (fail-closed)
 *   5. Project access check (if requireProject / requireProjectMemberOrAdmin) → 404
 *      (before permissions to prevent existence leakage)
 *   6. Permission check (if configured) → 403
 *   7. Body validation (if bodySchema) → 400
 *   8. Handler execution
 *   9. Response sanitization (if sanitizeResponse) → strip sensitive data
 *
 * Usage:
 *   export const POST = withRouteHandler(
 *     {
 *       requireProject: true,
 *       permissions: StudioPermission.TOOL_EXECUTE,
 *       rateLimit: { limit: 10, windowMs: 60_000, scope: 'user' },
 *       sanitizeResponse: { redactHeaders: true, maxBodySize: 100_000 },
 *       bodySchema: TestToolRequestSchema,
 *     },
 *     handler,
 *   );
 */

import { NextRequest, NextResponse } from 'next/server';
import type { z } from 'zod';
import { withAuditActor } from '@agent-platform/database/mongo';
import { requireAuth, isAuthError, type AuthenticatedUser } from './auth';
import { requireProjectAccess, isAccessError, type ProjectAccessResult } from './project-access';
import { requireProjectMemberOrAdmin } from './require-project-member-or-admin';
import { parseInput } from '@agent-platform/shared/validation';
import { errorJson, ErrorCode, handleApiError } from './api-response';
import { hasPermission } from './permission-resolver';
import { hasSensitivePermission, isSensitiveExactPermission } from '@agent-platform/shared/rbac';
import { rateLimiter, buildRateLimitKey, type RateLimitConfig } from './rate-limiter';
import { sanitizeResponseData, type ResponseSanitizeConfig } from './response-sanitizer';
import { isFeatureEnabled } from './feature-resolver';
import { getClientIp } from './get-client-ip';
import { ensureStudioAuditTrailHandlerRegistered } from './studio-audit-trail-handler';
import type { StudioPermission } from './permissions';
import {
  canProjectPermissionContextPerform,
  resolveProjectPermissionContext,
  resolveStudioProjectPermissionAliases,
} from './project-permission';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Supported auth mechanisms. Extensible — add new types here as needed. */
export const AuthType = {
  USER: 'user',
  API_KEY: 'api_key',
  SERVICE: 'service',
} as const;

export type AuthType = (typeof AuthType)[keyof typeof AuthType];

/** Standard rate-limit response headers. */
const RATE_LIMIT_HEADERS = {
  RETRY_AFTER: 'Retry-After',
  REMAINING: 'X-RateLimit-Remaining',
  RESET: 'X-RateLimit-Reset',
} as const;

// ─── Types ─────────────────────────────────────────────────────────────────

/** Context passed to route handler after all middleware checks pass. */
export interface RouteContext<TBody = unknown> {
  request: NextRequest;
  user: AuthenticatedUser;
  params: Record<string, string>;
  tenantId: string;
  /** Present when requireProject or requireProjectMemberOrAdmin is true */
  project?: ProjectAccessResult['project'];
  /** Present when bodySchema is provided — fully typed and validated */
  body: TBody;
}

/** Configuration for the route handler wrapper. */
export interface RouteOptions<TBody = unknown> {
  /** Which auth types are accepted. Default: ['user'] */
  authTypes?: AuthType[];
  /** If true, resolves projectId from params.id and checks access. Default: false */
  requireProject?: boolean;
  /**
   * If true, resolves projectId and requires the caller to be a project owner,
   * tenant admin, or explicit project member. Default: false.
   */
  requireProjectMemberOrAdmin?: boolean;
  /** Zod schema for request body (POST/PUT/PATCH). Parsed result available as ctx.body */
  bodySchema?: z.ZodType<TBody>;
  /** Permission(s) required. Use StudioPermission constants. Checked against user.permissions from RBAC. */
  permissions?: StudioPermission | StudioPermission[];
  /** Rate limit config. Applied per scope (tenant/user/ip). */
  rateLimit?: RateLimitConfig;
  /** Sanitize response data (redact headers, truncate bodies, scrub patterns). */
  sanitizeResponse?: ResponseSanitizeConfig;
  /** Feature flag required for this route. Checked against tenant plan/deals. Fails closed (403). */
  requireFeature?: string;
}

type RouteHandler<TBody = unknown> = (ctx: RouteContext<TBody>) => Promise<NextResponse>;

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Wraps a route handler with composable middleware:
 * Auth → Rate Limit → Project Access → Permissions → Body Validation → Handler → Sanitize
 */
export function withRouteHandler<TBody = unknown>(
  options: RouteOptions<TBody>,
  handler: RouteHandler<TBody>,
) {
  return async (
    request: NextRequest,
    routeCtx: { params: Promise<Record<string, string>> },
  ): Promise<NextResponse> => {
    try {
      ensureStudioAuditTrailHandlerRegistered();

      // 1. Auth — JWT verify + user lookup + permission resolution
      const user = await requireAuth(request);
      if (isAuthError(user)) return user;

      // Next.js may pass `params` as undefined for static routes (e.g. /api/auth-profiles).
      // Accessing `params.id` without a default causes: Cannot read properties of undefined (reading 'id').
      const params = (await routeCtx?.params) ?? {};

      // 2. Tenant resolution (early — needed for rate limit key)
      const projectId = params.id || params.projectId;
      // Tentative tenantId from user — may be refined by project access
      let tenantId = user.tenantId;

      // 3. Rate limit check (if configured)
      if (options.rateLimit) {
        const scope = options.rateLimit.scope ?? 'user';
        const ip = getClientIp(request);
        const routePath = request.nextUrl.pathname;
        const key = buildRateLimitKey(scope, tenantId ?? 'unknown', user.id, ip, routePath);
        const result = rateLimiter.check(key, options.rateLimit);

        if (!result.allowed) {
          const retryAfterSec = Math.ceil(result.resetMs / 1000);
          return NextResponse.json(
            {
              success: false,
              errors: [{ msg: 'Too many requests', code: ErrorCode.RATE_LIMITED }],
            },
            {
              status: 429,
              headers: {
                [RATE_LIMIT_HEADERS.RETRY_AFTER]: String(retryAfterSec),
                [RATE_LIMIT_HEADERS.REMAINING]: '0',
                [RATE_LIMIT_HEADERS.RESET]: String(retryAfterSec),
              },
            },
          );
        }
      }

      // 4. Feature gate (if required) — checked before project access to fail fast.
      //    Fails closed: if tenantId is missing or resolution errors, returns 403.
      if (options.requireFeature) {
        if (!tenantId) {
          return errorJson('Missing tenant', 401, ErrorCode.UNAUTHORIZED);
        }
        const enabled = await isFeatureEnabled(tenantId, options.requireFeature);
        if (!enabled) {
          return errorJson(
            'This feature is not available on your current plan',
            403,
            ErrorCode.FEATURE_DISABLED,
          );
        }
      }

      // 5. Project access (if required) — checked BEFORE permissions so that
      //    cross-tenant requests get 404 (not 403), avoiding existence leakage.
      let project: ProjectAccessResult['project'] | undefined;
      let projectAccess: ProjectAccessResult | undefined;
      if (options.requireProject || options.requireProjectMemberOrAdmin) {
        if (!projectId) {
          return errorJson('Project ID is required', 400, ErrorCode.VALIDATION_ERROR);
        }
        const access = options.requireProjectMemberOrAdmin
          ? await requireProjectMemberOrAdmin(projectId, user)
          : await requireProjectAccess(projectId, user);
        if (isAccessError(access)) return access;
        projectAccess = access;
        project = access.project;
      }

      // 6. Permission check (if configured)
      if (options.permissions) {
        const required = Array.isArray(options.permissions)
          ? options.permissions
          : [options.permissions];
        const granted = user.permissions;
        let projectPermissionContext: Awaited<
          ReturnType<typeof resolveProjectPermissionContext>
        > | null = null;
        let permitted = false;

        for (const permission of required) {
          const projectPermissionAliases =
            projectId && project ? resolveStudioProjectPermissionAliases(permission) : null;
          const requiresExactProjectGrant =
            projectPermissionAliases?.some((alias) => isSensitiveExactPermission(alias)) ?? false;

          if (
            project &&
            projectPermissionAliases &&
            !requiresExactProjectGrant &&
            (project.ownerId === user.id || hasPermission(granted, 'project:*'))
          ) {
            permitted = true;
            break;
          }

          if (projectPermissionAliases && projectAccess?.accessPath === 'membership') {
            if (!projectPermissionContext) {
              projectPermissionContext = await resolveProjectPermissionContext(projectId, user, {
                project,
              });
            }

            if (projectPermissionContext instanceof NextResponse) {
              return projectPermissionContext;
            }

            if (
              canProjectPermissionContextPerform(projectPermissionContext, projectPermissionAliases)
            ) {
              permitted = true;
              break;
            }
            continue;
          }

          if (hasSensitivePermission(granted, permission)) {
            permitted = true;
            break;
          }
        }

        if (!permitted) {
          return errorJson(
            `Forbidden: missing required permission (${required.join(' | ')})`,
            403,
            ErrorCode.FORBIDDEN,
          );
        }
      }

      // Finalize tenantId (project may provide it if user doesn't have one)
      tenantId = tenantId || project?.tenantId || undefined;
      if (!tenantId) return errorJson('Missing tenant', 401, ErrorCode.UNAUTHORIZED);

      // 7. Body validation (optional)
      let body = undefined as TBody;
      if (options.bodySchema) {
        let rawBody: unknown;
        try {
          rawBody = await request.json();
        } catch {
          return errorJson('Invalid JSON body', 400, ErrorCode.VALIDATION_ERROR);
        }
        const parsed = parseInput(options.bodySchema, rawBody);
        if (!parsed.success) {
          const messages = parsed.issues.map((i) => {
            const prefix = i.path.length ? `${i.path.join('.')}: ` : '';
            return `${prefix}${i.message}`;
          });
          return errorJson(messages, 400, ErrorCode.VALIDATION_ERROR);
        }
        body = parsed.data;
      }

      const ipAddress = getClientIp(request);
      const userAgent = request.headers.get('user-agent') ?? undefined;

      // 8. Execute handler
      const response = await withAuditActor(
        {
          userId: user.id,
          email: user.email,
          ip: ipAddress,
          userAgent,
        },
        () => handler({ request, user, params, tenantId, project, body }),
      );

      // 9. Response sanitization (if configured)
      if (options.sanitizeResponse && response.headers.get('content-type')?.includes('json')) {
        try {
          const json = await response.json();
          const sanitized = sanitizeResponseData(json, options.sanitizeResponse);
          return NextResponse.json(sanitized, {
            status: response.status,
            headers: response.headers,
          });
        } catch {
          // If response body can't be parsed as JSON, return as-is
          return response;
        }
      }

      return response;
    } catch (error: unknown) {
      return handleApiError(error, `Route ${request.method} ${request.nextUrl.pathname}`);
    }
  };
}
