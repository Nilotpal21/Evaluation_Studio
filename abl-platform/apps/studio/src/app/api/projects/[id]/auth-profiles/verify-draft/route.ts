/**
 * POST /api/projects/:id/auth-profiles/verify-draft
 *
 * Project-scoped twin of /api/auth-profiles/verify-draft. Same body shape and
 * response shape; permission-gated by project access.
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import {
  VerifyDraftRequestSchema,
  runVerifyDraft,
} from '@/app/api/auth-profiles/_verify-draft-helper';

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.AUTH_PROFILE_WRITE },
  async ({ request }) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorJson('Invalid JSON body', 400, ErrorCode.VALIDATION_ERROR);
    }

    const parsed = VerifyDraftRequestSchema.safeParse(body);
    if (!parsed.success) {
      return errorJson(
        `Invalid verify-draft payload: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const result = await runVerifyDraft(parsed.data);
    return NextResponse.json({ success: true, data: result });
  },
);
