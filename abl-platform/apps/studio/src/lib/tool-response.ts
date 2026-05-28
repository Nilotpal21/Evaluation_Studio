/**
 * Tool Response Helpers
 *
 * Sanitizers and response builders for project tool entities.
 */

import type { NextResponse } from 'next/server';
import { computeToolRuntimeMetadataHash } from '@agent-platform/shared/tools';
import { sanitizeDocument } from '@/lib/sanitize';
import { successJson, listJson } from '@/lib/api-response';

const STRIP_FIELDS = ['tenantId', '_v', '__v'];

/** Sanitize a ProjectTool document for API response. */
export function sanitizeProjectTool(doc: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeDocument<Record<string, unknown>>(doc, { stripFields: STRIP_FIELDS });
  return {
    ...sanitized,
    runtimeMetadataHash: computeToolRuntimeMetadataHash({
      variableNamespaceIds: Array.isArray(sanitized.variableNamespaceIds)
        ? sanitized.variableNamespaceIds.map(String)
        : [],
    }),
  };
}

/** Single project tool response: { success: true, tool: {...} } */
export function projectToolResponse(tool: Record<string, unknown>, status = 200): NextResponse {
  return successJson('tool', sanitizeProjectTool(tool), status);
}

/** Paginated project tool list response. */
export function projectToolListResponse(result: {
  tools: Record<string, unknown>[];
  total: number;
  page?: number;
  limit?: number;
}): NextResponse {
  const page = result.page ?? 1;
  const limit = result.limit ?? 50;
  return listJson(result.tools.map(sanitizeProjectTool), {
    page,
    limit,
    total: result.total,
    hasMore: page * limit < result.total,
  });
}
