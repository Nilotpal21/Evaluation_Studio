import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import {
  createTokenPair,
  resolveUserContextOrAutoAcceptInvite,
  resolveUserTenantContext,
} from '@/services/auth-service';
import { findUserByEmail, createUser, updateUser } from '@/repos/auth-repo';
import { createTenant, createTenantMember, findTenantBySlug } from '@/repos/workspace-repo';
import { checkRateLimit } from '@/lib/rate-limit';
import { isPlatformAdminUser } from '@/lib/platform-auth-policy';

const DEFAULT_DEV_TENANT_SLUG = 'dev-workspace';
const DEFAULT_E2E_TENANT_SLUG = 'e2e-workspace';
const E2E_SMOKE_EMAIL_DOMAIN = '@e2e-smoke.test';
const ISOLATED_TEST_LOGIN_EMAILS = new Set(['studio-theme-docs@kore.ai']);

function isE2ETestEmailAddress(email: string): boolean {
  const normalizedEmail = email.toLowerCase();
  return (
    normalizedEmail.endsWith(E2E_SMOKE_EMAIL_DOMAIN) ||
    ISOLATED_TEST_LOGIN_EMAILS.has(normalizedEmail)
  );
}

async function findPreferredDevTenant() {
  const seededTenant = await findTenantBySlug(DEFAULT_DEV_TENANT_SLUG);
  if (seededTenant) {
    return seededTenant;
  }

  const { Tenant } = await import('@agent-platform/database/models');
  const doc = await Tenant.findOne().sort({ createdAt: 1 }).lean();
  return doc ? { ...doc, id: doc._id } : null;
}

async function ensureTenantOperationalDefaults(tenantId: string, createdBy: string) {
  try {
    const [{ seedTenantBootstrapDefaults }, { seedTenantPipelineConfigs }] = await Promise.all([
      import('@agent-platform/database'),
      import('@agent-platform/pipeline-engine'),
    ]);

    await seedTenantBootstrapDefaults({ tenantId, createdBy });
    await seedTenantPipelineConfigs({ tenantId, createdBy });
  } catch (err) {
    // Non-fatal: seeding operational defaults is best-effort during dev login.
    // The login should still succeed even if pipeline-engine fails to load
    // (e.g. Next.js webpack bundling issues with server-only packages).
    console.warn(
      '[Auth] Failed to seed tenant operational defaults (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function attachUserToTenant(
  userId: string,
  tenant: { id: string; organizationId?: string | null },
) {
  try {
    await createTenantMember({
      tenantId: tenant.id,
      userId,
      role: 'OWNER',
    });
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
  }

  await ensureTenantOperationalDefaults(tenant.id, userId);

  return {
    tenantId: tenant.id,
    role: 'OWNER' as const,
    orgId: tenant.organizationId ?? undefined,
  };
}

async function ensureE2ETestTenant(user: { id: string }) {
  const existingTenant = await findTenantBySlug(DEFAULT_E2E_TENANT_SLUG);
  if (existingTenant) {
    return attachUserToTenant(user.id, existingTenant);
  }

  try {
    const tenant = await createTenant({
      name: 'E2E Workspace',
      slug: DEFAULT_E2E_TENANT_SLUG,
      ownerId: user.id,
    });
    return attachUserToTenant(user.id, tenant);
  } catch (err: any) {
    if (err?.code !== 11000) {
      throw err;
    }

    const createdByAnotherRequest = await findTenantBySlug(DEFAULT_E2E_TENANT_SLUG);
    if (!createdByAnotherRequest) {
      throw err;
    }

    return attachUserToTenant(user.id, createdByAnotherRequest);
  }
}

const devLoginRequestSchema = z.object({
  email: z.string().email('Invalid email format'),
  name: z.string().optional(),
});

const devLoginResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  }),
  accessToken: z.string(),
  expiresIn: z.number(),
  refreshToken: z.string().optional(),
});

async function handler(request: NextRequest) {
  // Only allow when explicitly enabled via server-side env var.
  // This is the single gate — NODE_ENV is 'production' even in dev deployments
  // (for Next.js optimisation), so we rely solely on ENABLE_DEV_LOGIN.
  if (process.env.ENABLE_DEV_LOGIN !== 'true') {
    return NextResponse.json({ error: 'Not available' }, { status: 404 });
  }

  // Rate limit by IP — 10 attempts per 15-minute window
  // Exempt E2E test infrastructure emails (sandbox creates multiple logins per run)
  const bodyPeek = await request
    .clone()
    .json()
    .catch(() => ({}));
  const isE2ETestEmail =
    typeof bodyPeek.email === 'string' && isE2ETestEmailAddress(bodyPeek.email);

  if (!isE2ETestEmail) {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const rl = await checkRateLimit(`dev-login:${ip}`, 10, 15 * 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many login attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfter ?? 0) } },
      );
    }
  }

  try {
    const body = await request.json();
    const { email, name } = body;

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'Email required' }, { status: 400 });
    }
    const normalizedEmail = email.toLowerCase().trim();
    const isE2ETestUser = isE2ETestEmailAddress(normalizedEmail);

    // Find existing user by email, or create new dev user
    let user = await findUserByEmail(normalizedEmail);
    if (!user) {
      user = await createUser({
        email: normalizedEmail,
        name: name || normalizedEmail.split('@')[0],
        googleId: `dev-${email}`,
        emailVerified: true,
        authProvider: 'email',
      });
    } else {
      // Update last login
      user = await updateUser(user.id, { lastLoginAt: new Date() });
    }

    // Super admins get tokens WITHOUT tenant context.
    // They use the Admin app for platform operations and must be
    // explicitly invited to a workspace to use Studio.
    const isSuperAdmin = await isPlatformAdminUser(user);

    if (isSuperAdmin) {
      // Check if super admin already has a tenant membership (via explicit invite)
      const existingContext = await resolveUserTenantContext(user.id);
      const tokenPair = await createTokenPair(user, existingContext);

      const isProgrammatic = !request.headers.get('origin');
      const response = NextResponse.json({
        user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl },
        accessToken: tokenPair.accessToken,
        expiresIn: tokenPair.expiresIn,
        ...(isProgrammatic ? { refreshToken: tokenPair.refreshToken } : {}),
      });

      response.cookies.set('refresh_token', tokenPair.refreshToken, {
        httpOnly: true,
        secure: (process.env.NODE_ENV as string) === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60,
        path: '/',
      });
      response.headers.append(
        'Set-Cookie',
        'refresh_token=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/api/auth',
      );
      return response;
    }

    // Ensure the dev user belongs to a tenant. Mirror the invitation-aware
    // production login flow before falling back to dev-only auto-bootstrap.
    const tenantResolution = await resolveUserContextOrAutoAcceptInvite(user.id, user.email);
    if (tenantResolution.pendingInvitationChoice) {
      return NextResponse.json(
        {
          error:
            'Multiple pending workspace invitations found. Use an interactive sign-in flow to choose a workspace.',
        },
        { status: 409 },
      );
    }

    let tenantContext = tenantResolution.tenantContext;
    if (!tenantContext) {
      if (isE2ETestUser) {
        tenantContext = await ensureE2ETestTenant(user);
      } else {
        // Prefer the seeded dev workspace when available so local logins land in the
        // example-project tenant instead of whichever workspace happened to be created first.
        const firstTenant = await findPreferredDevTenant();

        if (firstTenant) {
          tenantContext = await attachUserToTenant(user.id, firstTenant);
        } else {
          // Auto-create a default workspace for dev
          const slug = `dev-workspace-${Date.now()}`;
          const tenant = await createTenant({
            name: 'Dev Workspace',
            slug,
            ownerId: user.id,
          });
          tenantContext = await attachUserToTenant(user.id, tenant);
        }
      }
    }

    const tokenPair = await createTokenPair(user, tenantContext);

    // Non-browser callers (no Origin header) need the refresh token in the body
    const isProgrammatic = !request.headers.get('origin');

    const response = NextResponse.json({
      user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl },
      accessToken: tokenPair.accessToken,
      expiresIn: tokenPair.expiresIn,
      ...(isProgrammatic ? { refreshToken: tokenPair.refreshToken } : {}),
    });

    // Set new cookie at root path so middleware can see it
    response.cookies.set('refresh_token', tokenPair.refreshToken, {
      httpOnly: true,
      secure: (process.env.NODE_ENV as string) === 'production', // Dev-only route, never reached in production
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60,
      path: '/',
    });

    // Clear any stale cookie from the old /api/auth path (append AFTER cookies.set)
    response.headers.append(
      'Set-Cookie',
      'refresh_token=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/api/auth',
    );

    return response;
  } catch (error) {
    console.error('[Auth] Dev login error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Development login',
    description: 'Login or create a dev user (dev mode only). Auto-creates workspace if needed.',
    body: devLoginRequestSchema,
    response: devLoginResponseSchema,
    successStatus: 200,
    auth: false,
  },
  handler as any,
);
