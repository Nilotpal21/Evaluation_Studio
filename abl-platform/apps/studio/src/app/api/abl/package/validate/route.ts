import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { buildPackageDiagnostics } from '@/lib/abl-package-analysis';
import { packageFilesSchema, type PackageFilesBody } from '../_shared';

export const POST = withRouteHandler<PackageFilesBody>(
  {
    bodySchema: packageFilesSchema,
    rateLimit: { limit: 30, windowMs: 60_000, scope: 'user' },
  },
  async (ctx) => {
    const diagnostics = buildPackageDiagnostics(ctx.body.files);
    return NextResponse.json({
      success: diagnostics.valid,
      diagnostics,
    });
  },
);
