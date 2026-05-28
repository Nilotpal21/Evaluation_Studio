/**
 * POST /api/auth/create-workspace
 * Create a new workspace (tenant) for the authenticated user
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireAuth, isAuthError } from '@/lib/auth';
import { canUserCreateWorkspace } from '@/lib/platform-auth-policy';
import { createTokenPair } from '@/services/auth-service';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { checkRateLimit } from '@/lib/rate-limit';
import { getConfig, isConfigLoaded } from '@/config';
import { AUTH_CONFIG_DEFAULTS } from '@/lib/auth-constants';
import { slugify } from '@agent-platform/shared';
import { findTenantBySlug } from '@/repos/workspace-repo';
import { createWorkspaceWithOwner } from '@/repos/workspace-repo';
import { authError, getAuthRouteClientIp } from '../route-utils';

const log = createLogger('auth:create-workspace');

const WORKSPACE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9\s\-_.]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

const createWorkspaceRequestSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Workspace name must be at least 2 characters')
    .max(100, 'Workspace name must be 100 characters or less')
    .regex(
      WORKSPACE_NAME_PATTERN,
      'Workspace name must start and end with a letter or number, and can only contain letters, numbers, spaces, hyphens, underscores, and periods',
    ),
});

const createWorkspaceResponseSchema = z.object({
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
  }),
  accessToken: z.string(),
  expiresIn: z.number(),
});

async function handler(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (isAuthError(authResult)) return authResult;
  const user = authResult;
  const clientIp = getAuthRouteClientIp(request);

  if (user.canCreateWorkspace === false) {
    return authError(
      'Workspace creation is not available for your account. Contact your administrator.',
      403,
    );
  }

  // Defense-in-depth: the JWT claim is minted at login time and can lag behind
  // a live allowlist revocation by up to one access-token lifetime. Re-check
  // against the current allowlist so a revoked email cannot still create a
  // workspace within the access-token window.
  if (!(await canUserCreateWorkspace(user.email))) {
    return authError(
      'Workspace creation is not available for your account. Contact your administrator.',
      403,
    );
  }

  let step = 'init';
  try {
    step = 'config';
    const authConfig = isConfigLoaded() ? getConfig().auth : null;
    const rlConfig =
      authConfig?.rateLimits.createWorkspace ?? AUTH_CONFIG_DEFAULTS.rateLimits.createWorkspace;

    step = 'rate-limit';
    const rl = await checkRateLimit(
      `create-workspace:${user.id}`,
      rlConfig.maxAttempts,
      rlConfig.windowMs,
    );
    if (!rl.allowed) {
      return authError('Too many attempts. Please try again later.', 429);
    }

    step = 'parse-body';
    const body = await request.json();
    const parseResult = createWorkspaceRequestSchema.safeParse(body);

    if (!parseResult.success) {
      return authError(parseResult.error.issues.map((i) => i.message).join(', '), 400);
    }

    const { name } = parseResult.data;

    // H10 - Workspace creation limit
    step = 'check-limit';
    const { TenantMember } = await import('@agent-platform/database/models');
    const existingMemberships = await TenantMember.countDocuments({ userId: user.id });

    const maxWorkspaces = authConfig?.workspace?.maxPerUser ?? 10;
    if (existingMemberships >= maxWorkspaces) {
      return authError('Maximum workspace limit reached', 403);
    }

    // Generate unique slug (name is already trimmed by Zod)
    step = 'slug';
    let slug = slugify(name);
    if (!slug) slug = `workspace-${Date.now().toString(36)}`;
    const existing = await findTenantBySlug(slug);
    if (existing) {
      slug = `${slug}-${Date.now().toString(36)}`;
    }

    // Create tenant and membership in a transaction using workspace-repo
    step = 'create-workspace';
    const result = await createWorkspaceWithOwner(
      {
        name,
        slug,
        ownerId: user.id,
      },
      {
        role: 'OWNER',
      },
    );

    // Issue new token pair with the new workspace context
    step = 'resolve-context';
    const tenantContext = {
      tenantId: result.tenant.id,
      role: 'OWNER',
      orgId: result.tenant.organizationId ?? undefined,
    };

    step = 'create-tokens';
    const tokenPair = await createTokenPair({ id: user.id, email: user.email }, tenantContext);

    // Audit is fire-and-forget — never block the response
    logAuditEvent({
      userId: user.id,
      tenantId: result.tenant.id,
      action: AuditActions.WORKSPACE_CREATED,
      ip: clientIp,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: { workspaceName: result.tenant.name, slug: result.tenant.slug },
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Audit log failed for workspace creation', { error: message });
    });

    const response = NextResponse.json({
      workspace: { id: result.tenant.id, name: result.tenant.name, slug: result.tenant.slug },
      accessToken: tokenPair.accessToken,
      expiresIn: tokenPair.expiresIn,
    });

    const refreshCookieMaxAge = authConfig?.tokens?.refreshCookieMaxAgeSeconds ?? 7 * 24 * 60 * 60;
    response.cookies.set('refresh_token', tokenPair.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: refreshCookieMaxAge,
      path: '/',
    });

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    log.error('Create workspace failed', { step, userId: user.id, error: message, stack });
    return authError('Workspace creation failed. Please try again.', 500);
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Create workspace',
    description:
      'Create a new workspace (tenant) for the authenticated user. Issues new tokens scoped to the workspace.',
    body: createWorkspaceRequestSchema,
    response: createWorkspaceResponseSchema,
    successStatus: 200,
    auth: true,
  },
  handler as any,
);
