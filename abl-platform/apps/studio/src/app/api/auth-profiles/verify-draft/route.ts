/**
 * POST /api/auth-profiles/verify-draft
 *
 * Verify a transient (unsaved) auth-profile payload — used by the slide-over
 * to let users sanity-check a profile before saving it for the first time.
 * Runs structural validation and (where feasible) a live credential check
 * without touching the database.
 *
 * Body: { authType, config, secrets }
 * Returns: { valid, latencyMs, message?, validationType?, health }
 *
 * Workspace-scoped variant. The project-scoped twin lives at
 * /api/projects/[id]/auth-profiles/verify-draft.
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
  { permissions: StudioPermission.AUTH_PROFILE_WRITE },
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
