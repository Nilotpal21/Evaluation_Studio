/**
 * Workflow Version Service
 *
 * Handles workflow version lifecycle: create from draft, list, get,
 * activate, deactivate, resolve default, soft-delete cascade, and diff.
 *
 * All methods require tenantId for cross-tenant isolation.
 * All project-scoped methods require projectId.
 */

import { createHash } from 'crypto';
import { AppError, ErrorCodes, compareSemverDesc } from '@agent-platform/shared-kernel';
import { generateWebhookSecret } from '@agent-platform/shared-kernel/security';
import { withTransaction } from '@agent-platform/shared/repos';
import { encryptForTenantAuto } from '@agent-platform/shared/encryption';
import { createLogger } from '@abl/compiler/platform';

import type { IWorkflowVersion } from '@agent-platform/database/models';

/** Mirrors RegistrationTriggerType from trigger-registration.model (not barrel-exported). */
type RegistrationTriggerType = 'webhook' | 'cron' | 'event';

const log = createLogger('workflow-version-service');

// =============================================================================
// SEMVER COMPARATOR
// =============================================================================

/**
 * Re-exported so existing imports (`import { compareSemverDesc } from
 * '../services/workflow-version-service.js'`) keep working. The canonical
 * implementation lives in `@agent-platform/shared-kernel` and is shared with
 * workflow-engine.
 */
export { compareSemverDesc };

// =============================================================================
// TYPES
// =============================================================================

export interface CreateWorkflowVersionParams {
  workflowId: string;
  projectId: string;
  tenantId: string;
  createdBy: string;
  changelog?: string;
}

export interface CreateWorkflowVersionResult {
  versionId: string;
  version: string;
  sourceHash: string;
  deduplicated?: boolean;
}

export interface ListWorkflowVersionsParams {
  workflowId: string;
  tenantId: string;
  projectId: string;
  limit?: number;
  offset?: number;
}

export interface ActivateVersionParams {
  tenantId: string;
  projectId: string;
  workflowId: string;
  version: string;
  activatedBy: string;
}

export interface DeactivateVersionParams {
  tenantId: string;
  projectId: string;
  workflowId: string;
  version: string;
}

export interface SoftDeleteVersionParams {
  tenantId: string;
  projectId: string;
  workflowId: string;
  version: string;
  userId: string;
}

export interface ResolveDefaultVersionResult {
  version: IWorkflowVersion;
  resolution: 'published' | 'draft-fallback';
}

// =============================================================================
// DEPRECATED — remove when workflow-versions route is migrated to activate/deactivate
// =============================================================================

/** @deprecated Use ActivateVersionParams / DeactivateVersionParams instead. Remove in Phase 3. */
export interface PromoteWorkflowVersionParams {
  workflowId: string;
  version: string;
  targetStatus: string;
  promotedBy: string;
  tenantId: string;
  projectId: string;
}

/** @deprecated Legacy status list. Remove in Phase 3. */
const LEGACY_VALID_STATUSES = ['draft', 'testing', 'staged', 'active', 'deprecated'] as const;

/** @deprecated Legacy status transitions. Remove in Phase 3. */
const LEGACY_VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ['testing', 'staged'],
  testing: ['staged', 'draft'],
  staged: ['active', 'draft'],
  active: ['deprecated'],
  deprecated: [],
};

// =============================================================================

const MAX_CHANGELOG_SIZE = 10_000;
const MAX_DEFINITION_SIZE = 512 * 1024;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const MAX_DUPLICATE_KEY_RETRIES = 3;

/** Frozen definition fields that cannot be changed on published versions. */
const FROZEN_DEFINITION_FIELDS = [
  'definition.nodes',
  'definition.edges',
  'definition.envVars',
  'definition.inputSchema',
  'definition.outputSchema',
] as const;

// =============================================================================
// HELPERS
// =============================================================================

/** Recursively sort object keys for canonical JSON serialization. */
function deepSortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(deepSortKeys);
  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = deepSortKeys((obj as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return obj;
}

/** Compute a stable sourceHash from a workflow definition. */
function computeSourceHash(definition: Record<string, unknown>): string {
  const canonical = JSON.stringify(deepSortKeys(definition));
  return createHash('sha256').update(canonical).digest('hex').substring(0, 16);
}

// =============================================================================
// WORKFLOW VERSION SERVICE
// =============================================================================

/**
 * Injectable dependencies for {@link WorkflowVersionService}. Production code
 * constructs the service with no arguments; tests that exercise `activate()`
 * with webhook triggers inject a deterministic `encryptSecret` stub so they
 * do not need to bootstrap the DEK facade.
 */
export interface WorkflowVersionServiceDeps {
  /**
   * Encrypt a secret for tenant-scoped persistence. Defaults to
   * {@link encryptForTenantAuto} with tenant-level DEK scope — the same scope
   * used by workflow-engine's `encryptSecret` helper so the connector webhook
   * handler can round-trip with `decryptForTenantAuto`.
   */
  encryptSecret?: (plaintext: string, tenantId: string) => Promise<string>;
}

const defaultEncryptSecret = (plaintext: string, tenantId: string): Promise<string> =>
  encryptForTenantAuto(plaintext, tenantId, '_tenant', '_tenant');

export class WorkflowVersionService {
  private readonly encryptSecret: (plaintext: string, tenantId: string) => Promise<string>;

  constructor(deps: WorkflowVersionServiceDeps = {}) {
    this.encryptSecret = deps.encryptSecret ?? defaultEncryptSecret;
  }

  // ---------------------------------------------------------------------------
  // INPUT VALIDATION
  // ---------------------------------------------------------------------------

  static validateChangelog(changelog: unknown): string | null {
    if (changelog === undefined || changelog === null) return null;
    if (typeof changelog !== 'string') return 'changelog must be a string';
    if (changelog.length > MAX_CHANGELOG_SIZE)
      return `changelog exceeds maximum size of ${MAX_CHANGELOG_SIZE} characters`;
    return null;
  }

  /** @deprecated Remove in Phase 3 when workflow-versions route is migrated. */
  static isValidStatus(status: unknown): boolean {
    return (
      typeof status === 'string' && (LEGACY_VALID_STATUSES as readonly string[]).includes(status)
    );
  }

  /**
   * Validate which fields may be mutated on a version.
   *
   * Drafts allow all fields. Published versions (active or inactive)
   * freeze definition structure and webhook trigger config but allow
   * operational fields (cron expression, app-event config, metadata).
   */
  static validateMutableFields(
    version: { version: string; state?: string },
    updatePayload: Record<string, unknown>,
  ): { allowed: boolean; frozenFields?: string[] } {
    // Draft versions allow all mutations
    if (version.version === 'draft') {
      return { allowed: true };
    }

    // Published inactive versions: all mutations blocked (per HLD FR-7 mutability matrix)
    if (version.state === 'inactive') {
      return { allowed: false, frozenFields: Object.keys(updatePayload) };
    }

    // Published active versions: check for frozen fields
    const frozenFields: string[] = [];
    const payloadKeys = Object.keys(updatePayload);

    for (const key of payloadKeys) {
      // Check frozen definition fields (dot-notation and top-level 'definition' key)
      if ((FROZEN_DEFINITION_FIELDS as readonly string[]).includes(key)) {
        frozenFields.push(key);
        continue;
      }

      // Check for nested definition writes via the top-level 'definition' key
      if (key === 'definition' && typeof updatePayload[key] === 'object' && updatePayload[key]) {
        const defPayload = updatePayload[key] as Record<string, unknown>;
        for (const defKey of Object.keys(defPayload)) {
          if (['nodes', 'edges', 'envVars', 'inputSchema', 'outputSchema'].includes(defKey)) {
            frozenFields.push(`definition.${defKey}`);
          }
        }
        continue;
      }

      // Check for webhook trigger config changes
      if (key.match(/^triggers\[\d+\]\.config$/) || key === 'triggers') {
        // triggers[N].config.cronExpression is allowed for cron triggers
        // triggers[N].config for app-event triggers is allowed
        // webhook trigger config is frozen
        if (
          key === 'triggers' &&
          typeof updatePayload[key] === 'object' &&
          Array.isArray(updatePayload[key])
        ) {
          const triggers = updatePayload[key] as Array<Record<string, unknown>>;
          for (const trigger of triggers) {
            if (trigger.type === 'webhook' && trigger.config !== undefined) {
              frozenFields.push('triggers[].config (webhook)');
            }
          }
        }
      }
    }

    if (frozenFields.length > 0) {
      return { allowed: false, frozenFields };
    }

    return { allowed: true };
  }

  // ---------------------------------------------------------------------------
  // GET OR CREATE DRAFT
  // ---------------------------------------------------------------------------

  /**
   * Find or lazily create the "draft" version for a workflow.
   * Acts as a migration safety net: if no draft exists, creates one
   * from the Workflow document's current fields.
   */
  async getOrCreateDraft(
    workflowId: string,
    tenantId: string,
    projectId: string,
    createdBy: string,
  ) {
    const { Workflow, WorkflowVersion } = await import('@agent-platform/database/models');

    // Look for existing draft
    const existing = await WorkflowVersion.findOne({
      workflowId,
      tenantId,
      projectId,
      version: 'draft',
      deleted: false,
    }).lean();

    if (existing) {
      return existing;
    }

    // No draft exists — create from Workflow document (migration safety net)
    const workflow = await Workflow.findOne({ _id: workflowId, tenantId, projectId }).lean();
    if (!workflow) {
      throw new AppError('Workflow not found', { ...ErrorCodes.NOT_FOUND });
    }

    const workflowDoc = workflow as Record<string, unknown>;

    const definition: Record<string, unknown> = {
      nodes: (workflowDoc.nodes as unknown[]) ?? [],
      edges: (workflowDoc.edges as unknown[]) ?? [],
      envVars: (workflowDoc.envVars as Record<string, string>) ?? {},
      inputSchema: (workflowDoc.inputSchema as Record<string, unknown>) ?? null,
      outputSchema: (workflowDoc.outputSchema as Record<string, unknown>) ?? null,
    };

    // Build triggers from Workflow's triggers array
    const rawTriggers = (workflowDoc.triggers as Array<Record<string, unknown>>) ?? [];
    const triggers = rawTriggers.map((t) => ({
      id: String(t.id ?? ''),
      type: String(t.type ?? ''),
      config: (t.config as Record<string, unknown>) ?? {},
    }));

    const sourceHash = computeSourceHash(definition);

    const draft = await WorkflowVersion.create({
      workflowId,
      tenantId,
      projectId,
      version: 'draft',
      definition,
      triggers,
      sourceHash,
      createdBy,
      deleted: false,
      // state is undefined for drafts (per LD-13)
    });

    log.info('Draft version created from workflow', {
      workflowId,
      tenantId,
      projectId,
    });

    return draft.toObject();
  }

  // ---------------------------------------------------------------------------
  // CREATE VERSION (publish from draft)
  // ---------------------------------------------------------------------------

  async createVersion(params: CreateWorkflowVersionParams): Promise<CreateWorkflowVersionResult> {
    const { workflowId, projectId, tenantId, createdBy, changelog } = params;

    // Validate changelog
    const changelogError = WorkflowVersionService.validateChangelog(changelog);
    if (changelogError) throw new AppError(changelogError, { ...ErrorCodes.BAD_REQUEST });

    // Load draft via getOrCreateDraft
    const draft = await this.getOrCreateDraft(workflowId, tenantId, projectId, createdBy);
    const draftDoc = draft as Record<string, unknown>;

    const definition = draftDoc.definition as Record<string, unknown>;
    const triggers = (draftDoc.triggers as Array<Record<string, unknown>>) ?? [];

    const definitionJson = JSON.stringify(definition);
    if (definitionJson.length > MAX_DEFINITION_SIZE) {
      throw new AppError(
        `Workflow definition exceeds maximum size of ${MAX_DEFINITION_SIZE} bytes`,
        { ...ErrorCodes.BAD_REQUEST },
      );
    }

    const sourceHash = computeSourceHash(definition);

    // Dedup: check if latest published version has same sourceHash
    const { WorkflowVersion } = await import('@agent-platform/database/models');
    const latestVersion = await WorkflowVersion.findOne({
      workflowId,
      tenantId,
      projectId,
      version: { $ne: 'draft' },
      deleted: false,
    })
      .sort({ createdAt: -1 })
      .lean();

    if (latestVersion && (latestVersion as Record<string, unknown>).sourceHash === sourceHash) {
      log.info('Workflow version dedup — same sourceHash as latest', {
        workflowId,
        sourceHash,
      });
      return {
        versionId: (latestVersion as Record<string, unknown>)._id as string,
        version: (latestVersion as Record<string, unknown>).version as string,
        sourceHash,
        deduplicated: true,
      };
    }

    // Compute next version
    const version = await this.nextVersion(workflowId, tenantId, projectId);

    // Create version record with retry on unique constraint collision
    let currentVersion = version;
    for (let attempt = 0; attempt < MAX_DUPLICATE_KEY_RETRIES; attempt++) {
      try {
        const record = await WorkflowVersion.create({
          workflowId,
          version: currentVersion,
          tenantId,
          projectId,
          definition,
          triggers,
          sourceHash,
          state: 'inactive',
          environment: null,
          deploymentId: null,
          changelog: changelog ?? null,
          createdBy,
          publishedAt: new Date(),
          publishedBy: createdBy,
          deleted: false,
        });

        log.info('Workflow version created', {
          workflowId,
          version: currentVersion,
          versionId: record._id,
          sourceHash,
        });

        return {
          versionId: record._id,
          version: currentVersion,
          sourceHash,
        };
      } catch (err: unknown) {
        const isDuplicateKey =
          err instanceof Error &&
          (err as { code?: number }).code === 11000 &&
          attempt < MAX_DUPLICATE_KEY_RETRIES - 1;
        if (isDuplicateKey) {
          log.warn('Workflow version create collision, retrying', {
            workflowId,
            version: currentVersion,
            attempt,
          });
          currentVersion = await this.nextVersion(workflowId, tenantId, projectId);
          continue;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error('Version creation failed', { workflowId, error: errMsg });
        throw new AppError('Version creation failed', { ...ErrorCodes.INTERNAL_ERROR, cause: err });
      }
    }
    throw new AppError(
      'Version name collision: could not allocate a unique version number after retries',
      { ...ErrorCodes.CONFLICT },
    );
  }

  // ---------------------------------------------------------------------------
  // LIST VERSIONS
  // ---------------------------------------------------------------------------

  async listVersions(params: ListWorkflowVersionsParams) {
    const { workflowId, tenantId, projectId } = params;
    const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const offset = Math.max(params.offset ?? 0, 0);

    const { WorkflowVersion } = await import('@agent-platform/database/models');

    const filter = { workflowId, tenantId, projectId, deleted: false };
    const [docs, total] = await Promise.all([
      WorkflowVersion.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
      WorkflowVersion.countDocuments(filter),
    ]);

    // Map Mongo `_id` → `versionId` for the public API contract.
    const versions = docs.map((doc: any) => ({
      versionId: doc._id,
      id: doc._id,
      workflowId: doc.workflowId,
      tenantId: doc.tenantId,
      projectId: doc.projectId,
      version: doc.version,
      state: doc.state,
      status: doc.status,
      deploymentId: doc.deploymentId ?? null,
      environment: doc.environment ?? null,
      sourceHash: doc.sourceHash,
      changelog: doc.changelog,
      definition: doc.definition,
      createdBy: doc.createdBy,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      publishedAt: doc.publishedAt,
      publishedBy: doc.publishedBy,
      promotedAt: doc.promotedAt,
      promotedBy: doc.promotedBy,
    }));

    return { versions, total };
  }

  // ---------------------------------------------------------------------------
  // GET VERSION
  // ---------------------------------------------------------------------------

  async getVersion(workflowId: string, version: string, tenantId: string, projectId: string) {
    const { WorkflowVersion } = await import('@agent-platform/database/models');
    const filter = { workflowId, version, tenantId, projectId, deleted: false };
    return WorkflowVersion.findOne(filter).lean();
  }

  // ---------------------------------------------------------------------------
  // NEXT VERSION
  // ---------------------------------------------------------------------------

  async nextVersion(workflowId: string, tenantId: string, projectId: string): Promise<string> {
    const { WorkflowVersion } = await import('@agent-platform/database/models');
    const latest = await WorkflowVersion.findOne({
      workflowId,
      tenantId,
      projectId,
      version: { $ne: 'draft' },
      deleted: false,
    })
      .sort({ createdAt: -1 })
      .select('version')
      .lean();

    if (!latest) return 'v0.1.0';

    const rawVersion = (latest as Record<string, unknown>).version as string;
    // Strip leading 'v' if present for parsing
    const versionStr = rawVersion.startsWith('v') ? rawVersion.slice(1) : rawVersion;
    const parts = versionStr.split('.').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return 'v0.1.0';
    return `v${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }

  // ---------------------------------------------------------------------------
  // ACTIVATE VERSION
  // ---------------------------------------------------------------------------

  async activate(params: ActivateVersionParams) {
    const { tenantId, projectId, workflowId, version, activatedBy } = params;

    // Guard: draft versions cannot be activated/deactivated
    if (version === 'draft') {
      throw new AppError('Draft versions are always active and cannot be explicitly activated', {
        code: 'DRAFT_ALWAYS_ACTIVE',
        statusCode: 400,
      });
    }

    const { WorkflowVersion, TriggerRegistration } =
      await import('@agent-platform/database/models');

    // Load version with tenant + project isolation
    const versionDoc = await WorkflowVersion.findOne({
      workflowId,
      version,
      tenantId,
      projectId,
      deleted: false,
    }).lean();

    if (!versionDoc) {
      throw new AppError('Version not found', { ...ErrorCodes.NOT_FOUND });
    }

    const doc = versionDoc as IWorkflowVersion;

    // Idempotent: already active
    if (doc.state === 'active') {
      return doc;
    }

    // Wrap state update + trigger management in a transaction for atomicity (GAP-009)
    const triggers = doc.triggers ?? [];
    let updated: IWorkflowVersion | null = null;

    await withTransaction(async (session) => {
      const opts = session ? { session } : {};

      // Optimistic lock via _v (include tenantId for isolation)
      updated = (await WorkflowVersion.findOneAndUpdate(
        { _id: doc._id, _v: doc._v, tenantId },
        { $set: { state: 'active' }, $inc: { _v: 1 } },
        { new: true, ...opts },
      ).lean()) as IWorkflowVersion | null;

      if (!updated) {
        throw new AppError('Concurrent modification: version changed since read', {
          ...ErrorCodes.CONFLICT,
        });
      }

      // Remove any existing trigger registrations for this version before creating new ones
      // This prevents unbounded document growth from repeated activate/deactivate cycles
      await TriggerRegistration.deleteMany(
        {
          workflowVersionId: doc._id,
          tenantId,
          projectId,
        },
        opts,
      );

      // Create TriggerRegistrations for each trigger
      for (const trigger of triggers) {
        const triggerConfig = (trigger.config ?? {}) as Record<string, unknown>;
        const registration: Record<string, unknown> = {
          triggerName: (triggerConfig.name as string) || trigger.id,
          triggerType: trigger.type as RegistrationTriggerType,
          workflowVersionId: doc._id,
          workflowVersion: doc.version,
          tenantId,
          projectId,
          workflowId,
          config: triggerConfig,
          status: 'active',
          environment: doc.environment,
        };

        // Add type-specific fields
        if (trigger.type === 'cron' && triggerConfig.cronExpression) {
          registration.cronExpression = triggerConfig.cronExpression;
        }

        if (trigger.type === 'webhook') {
          // HMAC signing secret — persisted ciphertext only. The connectors
          // webhook handler decrypts via `decryptForTenantAuto` before HMAC
          // verification, so the on-disk row carries no bearer material.
          registration.webhookSecret = await this.encryptSecret(generateWebhookSecret(), tenantId);
        }

        await TriggerRegistration.create([registration], opts);
      }
    });

    log.info('Workflow version activated', {
      workflowId,
      version,
      activatedBy,
      triggerCount: triggers.length,
    });

    return updated!;
  }

  // ---------------------------------------------------------------------------
  // DEACTIVATE VERSION
  // ---------------------------------------------------------------------------

  async deactivate(params: DeactivateVersionParams) {
    const { tenantId, projectId, workflowId, version } = params;

    // Guard: draft versions cannot be deactivated
    if (version === 'draft') {
      throw new AppError('Draft versions are always active and cannot be explicitly deactivated', {
        code: 'DRAFT_ALWAYS_ACTIVE',
        statusCode: 400,
      });
    }

    const { WorkflowVersion, TriggerRegistration } =
      await import('@agent-platform/database/models');

    // Load version with tenant + project isolation
    const versionDoc = await WorkflowVersion.findOne({
      workflowId,
      version,
      tenantId,
      projectId,
      deleted: false,
    }).lean();

    if (!versionDoc) {
      throw new AppError('Version not found', { ...ErrorCodes.NOT_FOUND });
    }

    const doc = versionDoc as IWorkflowVersion;

    // Idempotent: already inactive
    if (doc.state === 'inactive') {
      return doc;
    }

    // Optimistic lock via _v (include tenantId for isolation)
    const updated = await WorkflowVersion.findOneAndUpdate(
      { _id: doc._id, _v: doc._v, tenantId },
      { $set: { state: 'inactive' }, $inc: { _v: 1 } },
      { new: true },
    ).lean();

    if (!updated) {
      throw new AppError('Concurrent modification: version changed since read', {
        ...ErrorCodes.CONFLICT,
      });
    }

    // Deactivate all TriggerRegistrations for this version
    await TriggerRegistration.updateMany(
      { workflowVersionId: doc._id, tenantId },
      { $set: { status: 'inactive' } },
    );

    log.info('Workflow version deactivated', {
      workflowId,
      version,
    });

    return updated;
  }

  // ---------------------------------------------------------------------------
  // RESOLVE DEFAULT VERSION
  // ---------------------------------------------------------------------------

  /**
   * Resolve the "default" version for execution: prefer the highest-semver
   * active version, fall back to the draft.
   *
   * Uses client-side semver-desc sort instead of `publishedAt` to guarantee
   * deterministic resolution regardless of publish order. This is the
   * behavior-change shipped in Phase 5 (workflow-webhook-versioning).
   */
  async resolveDefaultVersion(
    tenantId: string,
    projectId: string,
    workflowId: string,
  ): Promise<ResolveDefaultVersionResult> {
    const { WorkflowVersion } = await import('@agent-platform/database/models');

    // Fetch all active non-draft versions and sort by semver descending
    const candidates = await WorkflowVersion.find({
      workflowId,
      tenantId,
      projectId,
      state: 'active',
      deleted: false,
      version: { $ne: 'draft' },
    }).lean();
    candidates.sort((a: { version: string }, b: { version: string }) =>
      compareSemverDesc(a.version, b.version),
    );
    const activeVersion = candidates[0] ?? null;

    if (activeVersion) {
      return {
        version: activeVersion as IWorkflowVersion,
        resolution: 'published',
      };
    }

    // Fallback to draft — emit resolution miss metric
    log.warn('workflow.version.resolution.miss', {
      workflowId,
      tenantId,
      projectId,
      resolution: 'draft-fallback',
    });
    const draft = await this.getOrCreateDraft(workflowId, tenantId, projectId, 'system');
    return {
      version: draft as IWorkflowVersion,
      resolution: 'draft-fallback',
    };
  }

  // ---------------------------------------------------------------------------
  // SOFT DELETE SINGLE VERSION
  // ---------------------------------------------------------------------------

  /**
   * Soft-delete a single workflow version.
   *
   * Guards:
   *  - Draft versions cannot be deleted.
   *  - Deployed versions (deploymentId !== null) cannot be deleted.
   *
   * If the version is active, it is deactivated first (state set to inactive,
   * trigger registrations deactivated), then soft-deleted.
   */
  async softDeleteVersion(params: SoftDeleteVersionParams): Promise<void> {
    const { tenantId, projectId, workflowId, version, userId } = params;

    if (version === 'draft') {
      throw new AppError('Cannot delete the draft version', {
        code: 'DRAFT_CANNOT_DELETE',
        statusCode: 409,
      });
    }

    const { WorkflowVersion, TriggerRegistration } =
      await import('@agent-platform/database/models');

    const versionDoc = await WorkflowVersion.findOne({
      workflowId,
      version,
      tenantId,
      projectId,
      deleted: false,
    }).lean();

    if (!versionDoc) {
      throw new AppError('Version not found', { ...ErrorCodes.NOT_FOUND });
    }

    const doc = versionDoc as IWorkflowVersion;

    if (doc.deploymentId !== null && doc.deploymentId !== undefined) {
      throw new AppError('Cannot delete a deployed version', {
        code: 'VERSION_DEPLOYED',
        statusCode: 409,
      });
    }

    // If active, deactivate first: set state to inactive and deactivate triggers
    if (doc.state === 'active') {
      await WorkflowVersion.findOneAndUpdate(
        { _id: doc._id, _v: doc._v, tenantId },
        { $set: { state: 'inactive' }, $inc: { _v: 1 } },
        { new: true },
      );

      await TriggerRegistration.updateMany(
        { workflowVersionId: doc._id, tenantId },
        { $set: { status: 'inactive' } },
      );

      log.info('Workflow version deactivated before deletion', {
        workflowId,
        version,
      });
    }

    // Soft-delete the version — re-read _v since deactivation may have incremented it
    const currentDoc =
      doc.state === 'active'
        ? await WorkflowVersion.findOne({ _id: doc._id, tenantId, deleted: false }).lean()
        : doc;

    if (!currentDoc) {
      throw new AppError('Version not found after deactivation', { ...ErrorCodes.NOT_FOUND });
    }

    const updated = await WorkflowVersion.findOneAndUpdate(
      { _id: doc._id, _v: (currentDoc as IWorkflowVersion)._v, tenantId },
      {
        $set: { deleted: true, deletedAt: new Date() },
        $inc: { _v: 1 },
      },
      { new: true },
    );

    if (!updated) {
      throw new AppError('Concurrent modification: version changed since read', {
        ...ErrorCodes.CONFLICT,
      });
    }

    log.info('Workflow version soft-deleted', {
      workflowId,
      version,
      userId,
    });
  }

  // ---------------------------------------------------------------------------
  // SOFT DELETE CASCADE
  // ---------------------------------------------------------------------------

  /**
   * Soft-delete a workflow and all its versions and trigger registrations.
   * Uses a MongoDB transaction when available.
   */
  async softDeleteCascade(tenantId: string, projectId: string, workflowId: string): Promise<void> {
    const { Workflow, WorkflowVersion, TriggerRegistration } =
      await import('@agent-platform/database/models');

    await withTransaction(async (session) => {
      const opts = session ? { session } : {};

      await Workflow.findOneAndUpdate(
        { _id: workflowId, tenantId, projectId },
        { $set: { deleted: true, deletedAt: new Date() } },
        opts,
      );

      await WorkflowVersion.updateMany(
        { workflowId, tenantId, projectId },
        { $set: { deleted: true, deletedAt: new Date() } },
        opts,
      );

      await TriggerRegistration.updateMany(
        { workflowId, tenantId, projectId },
        { $set: { status: 'deleted' } },
        opts,
      );
    });

    log.info('Workflow soft-delete cascade completed', {
      workflowId,
      tenantId,
      projectId,
    });
  }

  // ---------------------------------------------------------------------------
  // DEPRECATED — remove when workflow-versions route is migrated (Phase 3)
  // ---------------------------------------------------------------------------

  /** @deprecated Use activate() / deactivate() instead. Remove in Phase 3. */
  async promoteVersion(params: PromoteWorkflowVersionParams) {
    const { workflowId, version, targetStatus, promotedBy, tenantId, projectId } = params;

    if (!WorkflowVersionService.isValidStatus(targetStatus)) {
      throw new AppError(`Invalid target status '${targetStatus}'`, { ...ErrorCodes.BAD_REQUEST });
    }

    const { WorkflowVersion } = await import('@agent-platform/database/models');
    const record = await WorkflowVersion.findOne({
      workflowId,
      version,
      tenantId,
      projectId,
    }).lean();
    if (!record) {
      throw new AppError(`Version '${version}' not found`, { ...ErrorCodes.NOT_FOUND });
    }

    const currentStatus = (record as Record<string, unknown>).status as string;
    const allowed = LEGACY_VALID_STATUS_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.includes(targetStatus)) {
      throw new AppError(`Cannot transition from '${currentStatus}' to '${targetStatus}'`, {
        ...ErrorCodes.BAD_REQUEST,
      });
    }

    const previousStatus = currentStatus;

    const updated = await WorkflowVersion.findOneAndUpdate(
      { _id: (record as Record<string, unknown>)._id, tenantId, status: currentStatus },
      {
        $set: {
          status: targetStatus,
          promotedAt: new Date(),
          promotedBy,
        },
      },
      { new: true },
    ).lean();

    if (!updated) {
      throw new AppError(
        `Concurrent modification: version '${version}' status changed since read`,
        { ...ErrorCodes.UNPROCESSABLE_ENTITY },
      );
    }

    log.info('Workflow version promoted (deprecated)', {
      workflowId,
      version,
      from: previousStatus,
      to: targetStatus,
      promotedBy,
    });

    return { ...(updated as Record<string, unknown>), previousStatus };
  }

  // ---------------------------------------------------------------------------
  // DIFF VERSIONS
  // ---------------------------------------------------------------------------

  async diffVersions(
    workflowId: string,
    versionA: string,
    versionB: string,
    tenantId: string,
    projectId: string,
  ) {
    const { WorkflowVersion } = await import('@agent-platform/database/models');
    const baseFilter = { workflowId, tenantId, projectId, deleted: false };
    const [a, b] = await Promise.all([
      WorkflowVersion.findOne({ ...baseFilter, version: versionA }).lean(),
      WorkflowVersion.findOne({ ...baseFilter, version: versionB }).lean(),
    ]);

    if (!a) throw new AppError(`Version '${versionA}' not found`, { ...ErrorCodes.NOT_FOUND });
    if (!b) throw new AppError(`Version '${versionB}' not found`, { ...ErrorCodes.NOT_FOUND });

    return { a, b };
  }
}

// =============================================================================
// SINGLETON FACTORY
// =============================================================================

let instance: WorkflowVersionService | null = null;

/**
 * Get (or lazily construct) the singleton. `deps` is only honored on the
 * construction call that creates the singleton — callers that need a specific
 * wiring must reset first, or construct `new WorkflowVersionService(deps)`
 * directly. Production code never passes `deps`; tests use it to inject an
 * `encryptSecret` stub.
 */
export function getWorkflowVersionService(
  deps?: WorkflowVersionServiceDeps,
): WorkflowVersionService {
  if (!instance) {
    instance = new WorkflowVersionService(deps);
  }
  return instance;
}

export function resetWorkflowVersionService(): void {
  instance = null;
}
