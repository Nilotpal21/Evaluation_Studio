/**
 * Asserts that a pipeline name is unique within a (tenantId, projectId) scope,
 * across BOTH custom pipelines (stored in MongoDB) AND built-in platform pipelines.
 *
 * Called from POST /api/pipelines (create), PATCH /api/pipelines/:id (rename),
 * and the two clone routes. Throws { code: 'PIPELINE_NAME_TAKEN', collidesWith }
 * which the route handlers translate to a 409 response.
 *
 * Comparison is case-insensitive and trimmed.
 */

import { BUILTIN_DEFINITIONS } from '@agent-platform/pipeline-engine';
import { PipelineDefinitionModel } from '@agent-platform/pipeline-engine/schemas';

export class PipelineNameTakenError extends Error {
  readonly code = 'PIPELINE_NAME_TAKEN';
  readonly collidesWith: 'builtin' | 'custom';
  constructor(name: string, collidesWith: 'builtin' | 'custom') {
    super(`Pipeline name "${name}" is already in use by a ${collidesWith} pipeline.`);
    this.collidesWith = collidesWith;
  }
}

/**
 * Trims leading/trailing whitespace and collapses any internal whitespace
 * run (spaces, tabs, newlines) to a single space. Used to clean user-typed
 * pipeline names before persisting and before comparing for uniqueness.
 *
 * Example: "  My   Quality  Pipeline\n" → "My Quality Pipeline"
 */
export function normalizePipelineName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function normalize(name: string): string {
  return normalizePipelineName(name).toLowerCase();
}

/**
 * @param name           The proposed pipeline name
 * @param tenantId       Scope of the uniqueness check
 * @param projectId      Scope of the uniqueness check (custom pipelines are project-scoped)
 * @param excludeId      Pipeline _id to exclude from the custom-collision check (used on rename)
 * @throws PipelineNameTakenError if the name collides
 */
export async function assertUniquePipelineName(
  name: string,
  tenantId: string,
  projectId: string,
  excludeId?: string,
): Promise<void> {
  const normalized = normalize(name);
  if (!normalized) return; // empty name is rejected by other validators

  // Check against built-in pipeline names (platform-wide, not tenant-scoped)
  const builtinCollision = BUILTIN_DEFINITIONS.find(
    (b) => normalize(b.definition.name) === normalized,
  );
  if (builtinCollision) {
    throw new PipelineNameTakenError(name, 'builtin');
  }

  // Check against existing custom pipelines in the same (tenantId, projectId).
  // Case-insensitive equality via regex on the name field.
  // Exclude archived pipelines so a previously-archived name can be reused.
  // Exclude the pipeline being renamed (excludeId) so a no-op rename succeeds.
  const filter: Record<string, unknown> = {
    tenantId,
    projectId,
    name: { $regex: `^${escapeRegex(normalized)}$`, $options: 'i' },
    status: { $ne: 'archived' },
  };
  if (excludeId) {
    filter._id = { $ne: excludeId };
  }
  const customCollision = await PipelineDefinitionModel.findOne(filter).select({ _id: 1 }).lean();
  if (customCollision) {
    throw new PipelineNameTakenError(name, 'custom');
  }
}

/**
 * Generates a unique name by appending `(2)`, `(3)`, etc. until no collision exists.
 * Used by clone endpoints so users don't have to retry naming on each clone.
 */
export async function generateUniquePipelineName(
  baseName: string,
  tenantId: string,
  projectId: string,
): Promise<string> {
  let candidate = baseName;
  let suffix = 2;
  // Cap retries — should never loop more than a handful of times in practice.
  while (suffix < 1000) {
    try {
      await assertUniquePipelineName(candidate, tenantId, projectId);
      return candidate;
    } catch (err) {
      if (err instanceof PipelineNameTakenError) {
        candidate = `${baseName} (${suffix})`;
        suffix++;
        continue;
      }
      throw err;
    }
  }
  // Extremely unlikely escape hatch
  return `${baseName} (${Date.now()})`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detects MongoDB duplicate-key errors (E11000) from a failed `save()`. Used by
 * route handlers to translate the DB-level uniqueness violation (caught by the
 * partial unique index on `{ tenantId, projectId, name }`) into a 409 response,
 * covering the race between `assertUniquePipelineName` and the actual insert.
 */
export function isPipelineNameDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number; name?: string; message?: string };
  if (e.code !== 11000) return false;
  const msg = String(e.message ?? '');
  // The collision is on the new partial index; the index name contains "name"
  // so we can disambiguate from other potential 11000s on this collection.
  return /name/.test(msg);
}
