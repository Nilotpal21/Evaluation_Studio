/**
 * Secret Rotation API
 *
 * GET  /api/secrets/rotation — Rotation history from audit log
 * POST /api/secrets/rotation — Trigger manual rotation for a secret
 */

import { NextResponse } from 'next/server';
import { queryAuditLog, logAdminAction } from '../../../../lib/audit-logger';
import { withAdminRoute, type AdminRouteContext } from '../../../../lib/with-admin-route';
import { getVaultClient } from '../../../../lib/vault-client';
import { createLogger } from '../../../../lib/logger';

const log = createLogger('admin-secret-rotation-route');

export const GET = withAdminRoute({ role: 'VIEWER' }, async (_ctx: AdminRouteContext) => {
  const rotations = await queryAuditLog({
    action: 'secret_rotate',
    limit: 50,
  });

  return NextResponse.json({
    rotations: rotations.map((r) => ({
      secret: r.target,
      actor: r.actor,
      timestamp: r.timestamp,
      environment: r.environment,
      ipAddress: r.ipAddress,
    })),
  });
});

export const POST = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  try {
    const body = await ctx.request.json();
    const { secretName, scope, environment } = body as {
      secretName?: string;
      scope?: string;
      environment?: string;
    };

    if (!secretName || !scope || !environment) {
      return NextResponse.json(
        { error: 'Missing required fields: secretName, scope, environment' },
        { status: 400 },
      );
    }

    const vault = await getVaultClient();
    const key = `/agent-platform/${environment}/${scope}/${secretName}`;

    // Verify the secret exists
    const existing = await vault.get(key);
    if (existing === undefined) {
      return NextResponse.json({ error: 'Secret not found' }, { status: 404 });
    }

    if (!vault.set) {
      return NextResponse.json(
        { error: 'Vault provider does not support write operations' },
        { status: 501 },
      );
    }

    // Generate a new random value for the rotated secret
    const crypto = await import('crypto');
    const newValue = crypto.randomBytes(32).toString('base64url');

    await vault.set(key, newValue);

    await logAdminAction({
      actor: ctx.user.userId,
      actorRole: ctx.user.role,
      action: 'secret_rotate',
      target: `secrets/${scope}/${secretName}`,
      environment,
      ipAddress: ctx.user.ipAddress,
    });

    return NextResponse.json({
      success: true,
      secretName,
      scope,
      environment,
      rotatedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    log.error('Secret rotation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        success: false,
        error: { code: 'ROTATION_FAILED', message: 'Secret rotation failed' },
      },
      { status: 500 },
    );
  }
});
