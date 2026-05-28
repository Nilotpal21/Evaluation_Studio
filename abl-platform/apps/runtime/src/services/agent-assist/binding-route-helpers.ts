/**
 * Shared route helpers for Agent Assist binding CRUD endpoints.
 *
 * platform-admin-agent-assist.ts and project-agent-assist-bindings.ts
 * each ran their own copies of these. Centralising keeps the immutable-
 * field policy and pagination bounds in one place.
 */

import type { AgentAssistBindingResolver } from '../../repos/agent-assist-binding-repo.js';

// ─── Pagination ────────────────────────────────────────────────────────

const PAGINATION_DEFAULT_LIMIT = 25;
const PAGINATION_MAX_LIMIT = 100;

export interface ParsedPagination {
  page: number;
  limit: number;
  skip: number;
}

/**
 * Parse `?page=` and `?limit=` from a query record. Defaults to page=1,
 * limit=PAGINATION_DEFAULT_LIMIT; clamps limit to PAGINATION_MAX_LIMIT.
 */
export function parsePagination(query: Record<string, unknown>): ParsedPagination {
  const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
  const limit = Math.min(
    PAGINATION_MAX_LIMIT,
    Math.max(
      1,
      parseInt(String(query.limit ?? String(PAGINATION_DEFAULT_LIMIT)), 10) ||
        PAGINATION_DEFAULT_LIMIT,
    ),
  );
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

// ─── Immutable field guard ─────────────────────────────────────────────

/** Fields that may not be changed via PATCH on a project-scoped binding. */
export const PROJECT_BINDING_IMMUTABLE_FIELDS = [
  'tenantId',
  'projectId',
  'appId',
  'environment',
] as const;

/** Fields that may not be changed via PATCH on the platform-admin binding route. */
export const ADMIN_BINDING_IMMUTABLE_FIELDS = ['tenantId', 'appId', 'environment'] as const;

/** Returns the subset of `immutable` keys present on `body` (case-sensitive). */
export function attemptedImmutableFields(body: unknown, immutable: readonly string[]): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const payload = body as Record<string, unknown>;
  return immutable.filter((field) => field in payload);
}

// ─── Tenant-scoped lookup ──────────────────────────────────────────────

/**
 * Look up a binding by `_id` + `tenantId` via the repo. The repo method is
 * named `findByIdForTenant` to keep callsites type-safe while avoiding the
 * Mongoose `findById` lint guard (see CLAUDE.md Core Invariants).
 */
export function lookupBindingByPk(
  repo: AgentAssistBindingResolver,
  ctx: { tenantId: string },
  id: string,
): ReturnType<AgentAssistBindingResolver['findByIdForTenant']> {
  return repo.findByIdForTenant(ctx, id);
}
