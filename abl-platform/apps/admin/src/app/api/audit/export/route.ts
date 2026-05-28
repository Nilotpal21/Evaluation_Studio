/**
 * Audit Log Export API
 *
 * GET /api/audit/export — Export filtered admin audit log entries as CSV.
 */

import { NextResponse } from 'next/server';
import { queryAuditLog, type AdminAction } from '../../../../lib/audit-logger';
import { formatAuditEntriesAsCsv } from '../../../../lib/audit-page-export';
import { withAdminRoute, type AdminRouteContext } from '../../../../lib/with-admin-route';

export const GET = withAdminRoute({ role: 'VIEWER' }, async (ctx: AdminRouteContext) => {
  const actor = ctx.request.nextUrl.searchParams.get('actor');
  const action = ctx.request.nextUrl.searchParams.get('action');
  const from = ctx.request.nextUrl.searchParams.get('from');
  const to = ctx.request.nextUrl.searchParams.get('to');
  const tenantId = ctx.request.nextUrl.searchParams.get('tenantId') ?? undefined;
  const scope = ctx.request.nextUrl.searchParams.get('scope') === 'tenant' ? 'tenant' : 'platform';
  const limit = parseInt(ctx.request.nextUrl.searchParams.get('limit') ?? '50', 10);

  if (scope === 'tenant' && !tenantId) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'BAD_REQUEST', message: 'tenantId is required for tenant-scoped reads' },
      },
      { status: 400 },
    );
  }

  const entries = await queryAuditLog({
    actor: actor ?? undefined,
    action: (action as AdminAction) ?? undefined,
    from: from ? new Date(from) : undefined,
    to: to ? new Date(to) : undefined,
    limit,
    tenantId,
    scope,
  });

  const csv = formatAuditEntriesAsCsv(entries);
  const filenameDate = new Date().toISOString().slice(0, 10);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="audit-log-${filenameDate}.csv"`,
    },
  });
});
