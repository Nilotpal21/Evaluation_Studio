/**
 * GET /api/node-types - List pipeline node type definitions from MongoDB
 *
 * Returns node types for the caller's tenant plus SYSTEM-level definitions.
 * Supports optional `?category=` filter.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { handleApiError } from '@/lib/api-response';
import { NodeTypeDefinitionModel } from '@agent-platform/pipeline-engine/schemas';

export async function GET(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  try {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category');

    const filter: Record<string, unknown> = {
      tenantId: { $in: ['SYSTEM', user.tenantId] },
      isActive: true,
    };

    if (category) {
      filter.category = category;
    }

    const nodeTypes = await NodeTypeDefinitionModel.find(filter)
      .sort({ category: 1, label: 1 })
      .lean();

    return NextResponse.json({ data: nodeTypes });
  } catch (error) {
    return handleApiError(error, 'GET /api/node-types');
  }
}
