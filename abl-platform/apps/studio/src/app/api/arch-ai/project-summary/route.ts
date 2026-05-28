/**
 * GET /api/arch-ai/project-summary
 *
 * Lightweight endpoint for Smart Welcome stats card.
 * Called by the frontend on overlay mount (not via LLM tool call).
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { getProjectSummary } from '@/services/arch-project-service';

const querySchema = z.object({
  projectId: z.string().min(1),
});

export async function GET(req: NextRequest) {
  try {
    const user = await requireTenantAuth(req);
    if (isAuthError(user)) return user;

    const params = Object.fromEntries(req.nextUrl.searchParams.entries());
    const parsed = querySchema.safeParse(params);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const { projectId } = parsed.data;
    const access = await requireProjectAccess(projectId, user);
    if (isAccessError(access)) return access;

    const summary = await getProjectSummary(projectId, user.tenantId);

    return new Response(JSON.stringify({ success: true, summary }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Log real error server-side but return generic message to client
    const { createLogger } = await import('@abl/compiler/platform/logger.js');
    createLogger('arch-ai:project-summary').error('Project summary failed', { error: message });
    return new Response(
      JSON.stringify({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
