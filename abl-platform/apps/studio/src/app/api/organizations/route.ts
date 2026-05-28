/**
 * POST /api/organizations
 * Create a new organization
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { createOrganization } from '@/services/organization-service';
import { logAuditEvent, AuditActions } from '@/services/audit-service';

const SLUG_REGEX = /^[a-z0-9-]+$/;

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (isAuthError(authResult)) return authResult;

  const rl = await checkRateLimit(`org-create:${authResult.id}`, 5, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }

  try {
    const body = await request.json();
    const { name, slug, billingEmail, linkWorkspaceId } = body;

    if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) {
      return NextResponse.json(
        { error: 'Organization name must be between 2 and 100 characters' },
        { status: 400 },
      );
    }

    if (slug !== undefined) {
      if (typeof slug !== 'string' || slug.length > 50 || !SLUG_REGEX.test(slug)) {
        return NextResponse.json(
          { error: 'Slug must be lowercase alphanumeric with hyphens, max 50 characters' },
          { status: 400 },
        );
      }
    }

    if (!billingEmail || typeof billingEmail !== 'string') {
      return NextResponse.json({ error: 'Billing email is required' }, { status: 400 });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(billingEmail.trim())) {
      return NextResponse.json({ error: 'Invalid billing email format' }, { status: 400 });
    }

    const org = await createOrganization({
      name: name.trim(),
      slug,
      ownerId: authResult.id,
      billingEmail,
      initialTenantId: linkWorkspaceId,
    });

    await logAuditEvent({
      userId: authResult.id,
      action: AuditActions.ORGANIZATION_CREATED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: { orgName: org.name, slug: org.slug, linkedWorkspaceId: linkWorkspaceId },
    });

    return NextResponse.json({ organization: org }, { status: 201 });
  } catch (error) {
    console.error('[Org] Create error:', error);
    return NextResponse.json({ error: 'Operation failed. Please try again.' }, { status: 400 });
  }
}
