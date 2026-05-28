/**
 * Secrets API Route
 *
 * GET    /api/secrets?scope=shared — List secrets (masked values)
 * POST   /api/secrets — Create a new secret
 * PATCH  /api/secrets — Update an existing secret
 * DELETE /api/secrets — Delete a secret
 */

import { NextResponse } from 'next/server';
import { getVaultClient, maskSecret } from '../../../lib/vault-client';
import { logAdminAction } from '../../../lib/audit-logger';
import { withAdminRoute, type AdminRouteContext } from '../../../lib/with-admin-route';
import { hasMinimumRole } from '../../../lib/role-guard';

const SAFE_VAULT_SEGMENT = /^[a-zA-Z0-9_.\-]+$/;

function validateVaultSegments(...segments: (string | undefined | null)[]): NextResponse | null {
  for (const seg of segments) {
    if (seg && !SAFE_VAULT_SEGMENT.test(seg)) {
      return NextResponse.json(
        { error: 'Invalid characters in name, scope, or environment' },
        { status: 400 },
      );
    }
  }
  return null;
}

export const GET = withAdminRoute({ role: 'VIEWER' }, async (ctx: AdminRouteContext) => {
  const scope = ctx.request.nextUrl.searchParams.get('scope') ?? 'shared';
  const env = ctx.request.nextUrl.searchParams.get('env') ?? 'dev';

  const segErr = validateVaultSegments(scope, env);
  if (segErr) return segErr;

  await logAdminAction({
    actor: ctx.user.userId,
    actorRole: ctx.user.role,
    action: 'secret_list',
    target: `secrets/${scope}`,
    environment: env,
    ipAddress: ctx.user.ipAddress,
  });

  try {
    const vault = await getVaultClient();
    const prefix = `/agent-platform/${env}/${scope}/`;
    const allSecrets = await vault.getAll(prefix);

    // VIEWER sees names only, no values (even masked)
    const isViewer = !hasMinimumRole(ctx.user.role, 'OPERATOR');

    const secrets = allSecrets
      ? Object.entries(allSecrets).map(([name, value]) => ({
          name,
          value: isViewer ? '••••••••' : maskSecret(String(value)),
          scope,
          environment: env,
        }))
      : [];

    return NextResponse.json({ scope, environment: env, secrets });
  } catch {
    return NextResponse.json(
      { error: 'Failed to list secrets', details: 'Internal error' },
      { status: 500 },
    );
  }
});

export const POST = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  try {
    const body = await ctx.request.json();
    const { name, value, scope, environment } = body as {
      name?: string;
      value?: string;
      scope?: string;
      environment?: string;
    };

    if (!name || !value || !scope || !environment) {
      return NextResponse.json(
        { error: 'Missing required fields: name, value, scope, environment' },
        { status: 400 },
      );
    }

    const segErr = validateVaultSegments(name, scope, environment);
    if (segErr) return segErr;

    const vault = await getVaultClient();
    const key = `/agent-platform/${environment}/${scope}/${name}`;

    if (!vault.set) {
      return NextResponse.json(
        { error: 'Vault provider does not support write operations' },
        { status: 501 },
      );
    }

    await vault.set(key, value);

    await logAdminAction({
      actor: ctx.user.userId,
      actorRole: ctx.user.role,
      action: 'secret_create',
      target: `secrets/${scope}/${name}`,
      environment,
      ipAddress: ctx.user.ipAddress,
    });

    return NextResponse.json({ success: true, name, scope, environment }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: 'Failed to create secret', details: 'Internal error' },
      { status: 500 },
    );
  }
});

export const PATCH = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  try {
    const body = await ctx.request.json();
    const { name, value, scope, environment } = body as {
      name?: string;
      value?: string;
      scope?: string;
      environment?: string;
    };

    if (!name || !value || !scope || !environment) {
      return NextResponse.json(
        { error: 'Missing required fields: name, value, scope, environment' },
        { status: 400 },
      );
    }

    const segErr = validateVaultSegments(name, scope, environment);
    if (segErr) return segErr;

    const vault = await getVaultClient();
    const key = `/agent-platform/${environment}/${scope}/${name}`;

    // Verify the secret exists before updating
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

    await vault.set(key, value);

    await logAdminAction({
      actor: ctx.user.userId,
      actorRole: ctx.user.role,
      action: 'secret_update',
      target: `secrets/${scope}/${name}`,
      environment,
      ipAddress: ctx.user.ipAddress,
    });

    return NextResponse.json({ success: true, name, scope, environment });
  } catch {
    return NextResponse.json(
      { error: 'Failed to update secret', details: 'Internal error' },
      { status: 500 },
    );
  }
});

export const DELETE = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  try {
    const body = await ctx.request.json();
    const { name, scope, environment } = body as {
      name?: string;
      scope?: string;
      environment?: string;
    };

    if (!name || !scope || !environment) {
      return NextResponse.json(
        { error: 'Missing required fields: name, scope, environment' },
        { status: 400 },
      );
    }

    const segErr = validateVaultSegments(name, scope, environment);
    if (segErr) return segErr;

    const vault = await getVaultClient();
    const key = `/agent-platform/${environment}/${scope}/${name}`;

    // Verify the secret exists before deleting
    const existing = await vault.get(key);
    if (existing === undefined) {
      return NextResponse.json({ error: 'Secret not found' }, { status: 404 });
    }

    if (!vault.delete) {
      return NextResponse.json(
        { error: 'Vault provider does not support delete operations' },
        { status: 501 },
      );
    }

    await vault.delete(key);

    await logAdminAction({
      actor: ctx.user.userId,
      actorRole: ctx.user.role,
      action: 'secret_delete',
      target: `secrets/${scope}/${name}`,
      environment,
      ipAddress: ctx.user.ipAddress,
    });

    return NextResponse.json({ success: true, name, scope, environment });
  } catch {
    return NextResponse.json(
      { error: 'Failed to delete secret', details: 'Internal error' },
      { status: 500 },
    );
  }
});
