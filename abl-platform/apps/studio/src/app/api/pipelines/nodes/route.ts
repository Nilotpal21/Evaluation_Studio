/**
 * GET /api/pipelines/nodes - List available pipeline node types from the registry
 *
 * Supports optional `?category=` filter (analytics, builtin, integration, etc.)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getNodeRegistry } from '../_shared/registry';
import type { NodeCategory } from '@agent-platform/pipeline-engine/registry';

export async function GET(req: NextRequest) {
  const user = await requireTenantAuth(req);
  if (isAuthError(user)) return user;

  const registry = await getNodeRegistry();
  const { searchParams } = new URL(req.url);
  const category = searchParams.get('category') as NodeCategory | null;

  const filters: { category?: NodeCategory } = {};
  if (category) filters.category = category;

  const nodes = registry.list(filters);

  return NextResponse.json({
    success: true,
    data: nodes,
  });
}
