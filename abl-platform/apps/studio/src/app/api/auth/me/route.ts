import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireAuth, isAuthError } from '@/lib/auth';
import { isPlatformAdminUser } from '@/lib/platform-auth-policy';

// Response schema
const meResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  isSuperAdmin: z.boolean().optional(),
  canCreateWorkspace: z.boolean().optional(),
  role: z.string().nullable().optional(),
  permissions: z.array(z.string()).optional(),
});

async function handler(request: NextRequest) {
  const result = await requireAuth(request);
  if (isAuthError(result)) return result;

  return NextResponse.json({
    id: result.id,
    email: result.email,
    name: result.name,
    isSuperAdmin: await isPlatformAdminUser(result),
    canCreateWorkspace: result.canCreateWorkspace ?? true,
    role: result.role ?? null,
    permissions: result.permissions ?? [],
  });
}

export const GET = withOpenAPI(
  {
    summary: 'Get current user',
    description: 'Retrieve authenticated user information from access token.',
    response: meResponseSchema,
    successStatus: 200,
    auth: true,
  },
  handler as any,
);
