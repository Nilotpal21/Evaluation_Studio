import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { PLATFORM_KEY_SCOPE_KEYS, PLATFORM_KEY_SCOPES } from '@agent-platform/shared-auth';
import { requireAuth, isAuthError } from '@/lib/auth';

const ScopeCategorySchema = z.enum([
  'execution',
  'management',
  'knowledge_base',
  'analytics',
  'admin',
]);

const ScopeResponseItemSchema = z.object({
  scope: z.string(),
  label: z.string(),
  description: z.string(),
  category: ScopeCategorySchema,
});

const ScopesResponseSchema = z.object({
  scopes: z.array(ScopeResponseItemSchema),
});

async function getHandler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  return NextResponse.json({
    scopes: PLATFORM_KEY_SCOPE_KEYS.map((scope) => ({
      scope,
      label: PLATFORM_KEY_SCOPES[scope].label,
      description: PLATFORM_KEY_SCOPES[scope].description,
      category: PLATFORM_KEY_SCOPES[scope].category,
    })),
  });
}

export const GET = withOpenAPI(
  {
    summary: 'List platform key scopes',
    description:
      'Return the platform key scope registry without internal RBAC permission mappings.',
    response: ScopesResponseSchema,
    successStatus: 200,
    auth: true,
  },
  getHandler as any,
);
