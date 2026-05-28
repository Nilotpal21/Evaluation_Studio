/**
 * PII Pattern Repository
 *
 * Tenant + project-scoped MongoDB operations for PII detection patterns.
 * Used by: services/pii/pattern-service.ts, routes/pii-patterns.ts
 */

// ─── Find ─────────────────────────────────────────────────────────────────

export async function findAll(tenantId: string, projectId: string): Promise<any[]> {
  const { PIIPattern } = await import('@agent-platform/database/models');
  return PIIPattern.find({ tenantId, projectId }).sort({ name: 1 }).lean();
}

export async function findEnabled(tenantId: string, projectId: string): Promise<any[]> {
  const { PIIPattern } = await import('@agent-platform/database/models');
  return PIIPattern.find({ tenantId, projectId, enabled: true }).sort({ name: 1 }).lean();
}

export async function findScopedByPatternId(
  tenantId: string,
  projectId: string,
  patternId: string,
): Promise<any | null> {
  const { PIIPattern } = await import('@agent-platform/database/models');
  return PIIPattern.findOne({ _id: patternId, tenantId, projectId }).lean();
}

export async function findByName(
  tenantId: string,
  projectId: string,
  name: string,
): Promise<any | null> {
  const { PIIPattern } = await import('@agent-platform/database/models');
  return PIIPattern.findOne({ tenantId, projectId, name }).lean();
}

/**
 * Find the (at most one) built-in override for a given PII type in a project.
 * Built-in overrides are uniquely identified by `(tenantId, projectId, piiType)`
 * with `builtinOverride: true`, NOT by name.
 */
export async function findBuiltinOverride(
  tenantId: string,
  projectId: string,
  piiType: string,
): Promise<any | null> {
  const { PIIPattern } = await import('@agent-platform/database/models');
  return PIIPattern.findOne({ tenantId, projectId, piiType, builtinOverride: true }).lean();
}

// ─── Create / Update / Delete ─────────────────────────────────────────────

export async function create(data: Record<string, unknown>): Promise<any> {
  const { PIIPattern } = await import('@agent-platform/database/models');
  const doc = await PIIPattern.create(data);
  return doc.toObject();
}

/**
 * Upsert a built-in override by `(tenantId, projectId, piiType)`. If an override
 * already exists for the type, it is updated atomically; otherwise a new one is
 * inserted. Returns the resulting document plus a `created` flag indicating
 * which branch ran. Atomic at the MongoDB level — safe under concurrent POSTs.
 */
export async function upsertBuiltinOverride(
  tenantId: string,
  projectId: string,
  piiType: string,
  data: Record<string, unknown>,
): Promise<{ pattern: any; created: boolean }> {
  const { PIIPattern } = await import('@agent-platform/database/models');
  const filter = { tenantId, projectId, piiType, builtinOverride: true };
  // Use raw update so we can split fields between $set and $setOnInsert without
  // re-overwriting creation metadata on subsequent saves.
  const { createdBy, ...mutable } = data;
  const update = {
    $set: { ...mutable, tenantId, projectId, piiType, builtinOverride: true },
    $setOnInsert: createdBy !== undefined ? { createdBy } : {},
  };
  const doc = await PIIPattern.findOneAndUpdate(filter, update, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
    includeResultMetadata: true,
  });
  // `lastErrorObject.updatedExisting` tells us which branch ran. When false,
  // the document was just created.
  const created = !doc.lastErrorObject?.updatedExisting;
  return { pattern: doc.value?.toObject?.() ?? doc.value, created };
}

export async function update(
  tenantId: string,
  projectId: string,
  patternId: string,
  data: Record<string, unknown>,
): Promise<any | null> {
  const { PIIPattern } = await import('@agent-platform/database/models');
  return PIIPattern.findOneAndUpdate(
    { _id: patternId, tenantId, projectId },
    { $set: data },
    { new: true },
  ).lean();
}

export async function remove(
  tenantId: string,
  projectId: string,
  patternId: string,
): Promise<any | null> {
  const { PIIPattern } = await import('@agent-platform/database/models');
  return PIIPattern.findOneAndDelete({ _id: patternId, tenantId, projectId }).lean();
}
