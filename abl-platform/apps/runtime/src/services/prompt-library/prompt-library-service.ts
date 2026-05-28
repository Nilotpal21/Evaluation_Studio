/**
 * Prompt Library Service
 *
 * CRUD + lifecycle management for prompt library items and versions.
 * Follows the singleton pattern from version-service.ts:705-716.
 *
 * Atomic promote uses two-step `findOneAndUpdate` matching the
 * `promoteAgentVersion()` pattern — see LLD Decision D-1.
 */

import {
  PromptLibraryItem,
  PromptLibraryVersion,
  AgentVersion,
  ProjectAgent,
  ProjectRuntimeConfig,
  type IPromptLibraryItem,
  type IPromptLibraryVersion,
  type PromptLibraryVersionStatus,
  computeSourceHash,
} from '@agent-platform/database/models';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import { createLogger } from '@abl/compiler/platform';
import { refreshPersistedRuntimeProjectAgentDraftMetadata } from '../session/project-agent-draft-metadata.js';

const log = createLogger('prompt-library-service');

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_TEMPLATE_SIZE = 32768; // 32KB
const MAX_VARIABLE_COUNT = 20;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// =============================================================================
// PURE VALIDATORS (exported for unit testing)
// =============================================================================

/**
 * Validate that a lifecycle transition is allowed.
 * Valid transitions: draft→active, draft→archived, active→archived.
 */
export function validateLifecycleTransition(
  current: PromptLibraryVersionStatus,
  next: PromptLibraryVersionStatus,
): boolean {
  const valid = new Set(['draft:active', 'draft:archived', 'active:archived']);
  return valid.has(`${current}:${next}`);
}

/** Returns true if template byte length is within 32KB limit. */
export function validateTemplateSize(template: string): boolean {
  return Buffer.byteLength(template, 'utf8') <= MAX_TEMPLATE_SIZE;
}

/** Returns true if variable count is within limit (max 20). */
export function validateVariableCount(variables: string[]): boolean {
  return variables.length <= MAX_VARIABLE_COUNT;
}

/** Returns true if pane count is within limit (max 5). */
export function validatePaneCount(paneCount: number): boolean {
  return paneCount <= 5;
}

// =============================================================================
// INTERFACES
// =============================================================================

export interface PromoteVersionResult {
  version: IPromptLibraryVersion;
  previousActiveVersionId?: string;
}

export interface CreatePromptParams {
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  tags?: string[];
  createdBy: string;
  initialVersion?: {
    template: string;
    variables?: string[];
    description?: string;
  };
}

export interface CreateVersionParams {
  tenantId: string;
  projectId: string;
  template: string;
  variables?: string[];
  description?: string;
  createdBy: string;
}

export interface ListPromptsOptions {
  tenantId: string;
  projectId: string;
  status?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

export interface ScopeOptions {
  tenantId: string;
  projectId: string;
}

export interface ActorScope {
  tenantId: string;
  projectId: string;
  userId: string;
}

export interface ReferenceInfo {
  count: number;
  agents: Array<{
    agentName: string;
    versionId: string;
    resolvedHash: string;
  }>;
  draftAgents: Array<{
    agentName: string;
    versionId: string;
    resolvedHash?: string;
  }>;
  runtimeConfigRefs: Array<{
    section: 'filler.promptRef';
    versionId: string;
  }>;
}

// =============================================================================
// SERVICE
// =============================================================================

export class PromptLibraryService {
  /**
   * Create a new prompt library item.
   * Optionally creates an initial version in the same call.
   */
  async createPrompt(params: CreatePromptParams): Promise<IPromptLibraryItem> {
    const { tenantId, projectId, name, description, tags, createdBy, initialVersion } = params;

    log.info('Creating prompt library item', { tenantId, projectId, name });

    const item = await PromptLibraryItem.create({
      tenantId,
      projectId,
      name,
      description,
      tags: tags ?? [],
      createdBy,
    });

    const plainItem = item.toObject() as IPromptLibraryItem;

    if (initialVersion) {
      if (!validateTemplateSize(initialVersion.template)) {
        throw new AppError('Template exceeds 32KB limit', {
          code: 'PROMPT_LIBRARY_TEMPLATE_TOO_LONG',
          statusCode: 400,
        });
      }
      const vars = initialVersion.variables ?? [];
      if (!validateVariableCount(vars)) {
        throw new AppError('Variables exceed limit of 20', {
          code: 'PROMPT_LIBRARY_TOO_MANY_VARIABLES',
          statusCode: 400,
        });
      }
      await this.createVersion(String(plainItem._id), {
        tenantId,
        projectId,
        template: initialVersion.template,
        variables: vars,
        description: initialVersion.description,
        createdBy,
      });
    }

    return plainItem;
  }

  /**
   * Create a new version for a prompt library item.
   * Uses atomic $inc on nextVersionNumber for TOCTOU-safe numbering (LLD D-7).
   */
  async createVersion(
    promptId: string,
    params: CreateVersionParams,
  ): Promise<IPromptLibraryVersion> {
    const { tenantId, projectId, template, variables, description, createdBy } = params;
    const vars = variables ?? [];

    if (!validateTemplateSize(template)) {
      throw new AppError('Template exceeds 32KB limit', {
        code: 'PROMPT_LIBRARY_TEMPLATE_TOO_LONG',
        statusCode: 400,
      });
    }
    if (!validateVariableCount(vars)) {
      throw new AppError('Variables exceed limit of 20', {
        code: 'PROMPT_LIBRARY_TOO_MANY_VARIABLES',
        statusCode: 400,
      });
    }

    // Atomically increment version counter
    const item = await PromptLibraryItem.findOneAndUpdate(
      { _id: promptId, tenantId, projectId },
      { $inc: { nextVersionNumber: 1 } },
      { new: true },
    ).lean();

    if (!item) {
      throw new AppError('Prompt library item not found', { ...ErrorCodes.NOT_FOUND });
    }

    const sourceHash = computeSourceHash(template, vars);

    const version = await PromptLibraryVersion.create({
      tenantId,
      projectId,
      promptId,
      versionNumber: item.nextVersionNumber,
      template,
      variables: vars,
      description,
      sourceHash,
      createdBy,
    });

    log.info('Created prompt version', {
      promptId,
      versionNumber: item.nextVersionNumber,
      sourceHash,
    });

    return version.toObject() as IPromptLibraryVersion;
  }

  /**
   * Promote a draft version to active.
   * Two-step atomicity: promote target, then archive previous active (LLD D-1, D-8).
   */
  async promoteVersion(
    promptId: string,
    versionId: string,
    actor: ActorScope,
  ): Promise<PromoteVersionResult> {
    const { tenantId, projectId, userId } = actor;

    // Step 0: idempotency — if already active, return current state (HLD concern 7)
    const existing = (await PromptLibraryVersion.findOne({
      _id: versionId,
      promptId,
      tenantId,
      projectId,
    }).lean()) as IPromptLibraryVersion | null;

    if (existing?.status === 'active') {
      return { version: existing, previousActiveVersionId: undefined };
    }

    const previousActive = (await PromptLibraryVersion.findOne({
      promptId,
      tenantId,
      projectId,
      status: 'active',
      _id: { $ne: versionId },
    }).lean()) as IPromptLibraryVersion | null;

    if (previousActive) {
      await this.assertVersionNotReferencedByWorkingCopies(promptId, String(previousActive._id), {
        tenantId,
        projectId,
      });
    }

    // Step 1: atomically set draft → active
    const result = (await PromptLibraryVersion.findOneAndUpdate(
      {
        _id: versionId,
        promptId,
        tenantId,
        projectId,
        status: 'draft',
      },
      {
        $set: {
          status: 'active',
          publishedAt: new Date(),
          publishedBy: userId,
        },
      },
      { new: true },
    ).lean()) as IPromptLibraryVersion | null;

    if (!result) {
      throw new AppError('Version not found or not in draft status', {
        code: 'PROMPT_LIBRARY_CONCURRENT_PROMOTE',
        statusCode: 409,
      });
    }

    // Step 2: archive previously active version (if any)
    const previous = (await PromptLibraryVersion.findOneAndUpdate(
      {
        promptId,
        tenantId,
        projectId,
        status: 'active',
        _id: { $ne: versionId },
      },
      { $set: { status: 'archived' } },
      { new: true },
    ).lean()) as IPromptLibraryVersion | null;

    log.info('Promoted prompt version', {
      promptId,
      versionId,
      previousActiveVersionId: previous?._id,
    });

    await refreshPersistedRuntimeProjectAgentDraftMetadata({
      projectId,
      tenantId,
      diagnosticSource: 'runtime-prompt-library',
    });

    return {
      version: result,
      previousActiveVersionId: previous ? String(previous._id) : undefined,
    };
  }

  /**
   * Archive a version. Only non-archived versions can be archived.
   */
  async archiveVersion(
    promptId: string,
    versionId: string,
    opts: ScopeOptions,
  ): Promise<IPromptLibraryVersion> {
    const { tenantId, projectId } = opts;

    await this.assertVersionNotReferencedByWorkingCopies(promptId, versionId, opts);

    const result = (await PromptLibraryVersion.findOneAndUpdate(
      {
        _id: versionId,
        promptId,
        tenantId,
        projectId,
        status: { $ne: 'archived' },
      },
      { $set: { status: 'archived' } },
      { new: true },
    ).lean()) as IPromptLibraryVersion | null;

    if (!result) {
      throw new AppError('Version not found or already archived', { ...ErrorCodes.NOT_FOUND });
    }

    log.info('Archived prompt version', { promptId, versionId });

    await refreshPersistedRuntimeProjectAgentDraftMetadata({
      projectId,
      tenantId,
      diagnosticSource: 'runtime-prompt-library',
    });

    return result;
  }

  /**
   * Update a draft version's template, variables, and/or description.
   * Rejects updates to non-draft versions (template is immutable once promoted).
   */
  async updateVersion(
    promptId: string,
    versionId: string,
    patch: { template?: string; variables?: string[]; description?: string },
    opts: ScopeOptions,
  ): Promise<IPromptLibraryVersion> {
    const { tenantId, projectId } = opts;

    const template = patch.template?.trim();
    const vars = patch.variables;

    if (template !== undefined) {
      if (!validateTemplateSize(template)) {
        throw new AppError('Template exceeds maximum size', {
          code: 'PROMPT_LIBRARY_TEMPLATE_TOO_LARGE',
          statusCode: 400,
        });
      }
    }
    if (vars !== undefined && !validateVariableCount(vars)) {
      throw new AppError('Variables exceed limit of 20', {
        code: 'PROMPT_LIBRARY_TOO_MANY_VARIABLES',
        statusCode: 400,
      });
    }

    const $set: Record<string, unknown> = {};

    if (template !== undefined || vars !== undefined) {
      // Need both template and variables to compute a correct sourceHash.
      // Fetch current values for whichever field(s) were not supplied in the patch.
      const current = (await PromptLibraryVersion.findOne(
        { _id: versionId, promptId, tenantId, projectId, status: 'draft' },
        { template: 1, variables: 1 },
      ).lean()) as Pick<IPromptLibraryVersion, 'template' | 'variables'> | null;

      if (!current) {
        throw new AppError('Version not found or not in draft status', { ...ErrorCodes.NOT_FOUND });
      }

      const effectiveTemplate = template ?? current.template;
      const effectiveVars = vars ?? current.variables;
      $set.sourceHash = computeSourceHash(effectiveTemplate, effectiveVars);
    }

    if (template !== undefined) $set.template = template;
    if (vars !== undefined) $set.variables = vars;
    if (patch.description !== undefined) $set.description = patch.description;

    const result = (await PromptLibraryVersion.findOneAndUpdate(
      { _id: versionId, promptId, tenantId, projectId, status: 'draft' },
      { $set },
      { new: true },
    ).lean()) as IPromptLibraryVersion | null;

    if (!result) {
      throw new AppError('Version not found or not in draft status', { ...ErrorCodes.NOT_FOUND });
    }

    if (template !== undefined || vars !== undefined) {
      await refreshPersistedRuntimeProjectAgentDraftMetadata({
        projectId,
        tenantId,
        diagnosticSource: 'runtime-prompt-library',
      });
    }

    return result;
  }

  /**
   * Update a prompt library item (name, description, tags).
   */
  async updatePrompt(
    promptId: string,
    patch: { name?: string; description?: string; tags?: string[] },
    opts: ScopeOptions,
  ): Promise<IPromptLibraryItem> {
    const { tenantId, projectId } = opts;

    let result: IPromptLibraryItem | null;
    try {
      result = (await PromptLibraryItem.findOneAndUpdate(
        { _id: promptId, tenantId, projectId },
        { $set: patch },
        { new: true },
      ).lean()) as IPromptLibraryItem | null;
    } catch (err: unknown) {
      // Duplicate name within the same tenant+project
      if (err instanceof Error && 'code' in err && (err as { code: number }).code === 11000) {
        throw new AppError('A prompt with this name already exists in the project', {
          code: 'PROMPT_LIBRARY_NAME_CONFLICT',
          statusCode: 409,
        });
      }
      throw err;
    }

    if (!result) {
      throw new AppError('Prompt library item not found', { ...ErrorCodes.NOT_FOUND });
    }

    return result;
  }

  /**
   * Delete a prompt library item and all its versions.
   * Refuses deletion if referenced by any agent version.
   */
  async deletePrompt(promptId: string, opts: ScopeOptions): Promise<void> {
    const { tenantId, projectId } = opts;

    const refs = await this.getReferences(promptId, opts);
    if (refs.count > 0) {
      throw new AppError('Cannot delete prompt: referenced by agent versions or draft agents', {
        code: 'PROMPT_LIBRARY_HAS_REFERENCES',
        statusCode: 409,
      });
    }

    await PromptLibraryVersion.deleteMany({ promptId, tenantId, projectId });
    const deleted = await PromptLibraryItem.deleteOne({ _id: promptId, tenantId, projectId });

    if (deleted.deletedCount === 0) {
      throw new AppError('Prompt library item not found', { ...ErrorCodes.NOT_FOUND });
    }

    log.info('Deleted prompt library item', { promptId });

    await refreshPersistedRuntimeProjectAgentDraftMetadata({
      projectId,
      tenantId,
      diagnosticSource: 'runtime-prompt-library',
    });
  }

  /**
   * Get the active version for a prompt.
   */
  async getActiveVersion(
    promptId: string,
    opts: ScopeOptions,
  ): Promise<IPromptLibraryVersion | null> {
    return (await PromptLibraryVersion.findOne({
      promptId,
      status: 'active',
      tenantId: opts.tenantId,
      projectId: opts.projectId,
    }).lean()) as IPromptLibraryVersion | null;
  }

  /**
   * Get a specific version by ID.
   */
  async getVersion(
    promptId: string,
    versionId: string,
    opts: ScopeOptions,
  ): Promise<IPromptLibraryVersion | null> {
    return (await PromptLibraryVersion.findOne({
      _id: versionId,
      promptId,
      tenantId: opts.tenantId,
      projectId: opts.projectId,
    }).lean()) as IPromptLibraryVersion | null;
  }

  /**
   * Get a specific prompt by ID.
   */
  async getPrompt(promptId: string, opts: ScopeOptions): Promise<IPromptLibraryItem | null> {
    return (await PromptLibraryItem.findOne({
      _id: promptId,
      tenantId: opts.tenantId,
      projectId: opts.projectId,
    }).lean()) as IPromptLibraryItem | null;
  }

  /**
   * Increment usage count (fire-and-forget from compile hook).
   * Scoped to tenantId to prevent cross-tenant updates.
   */
  async incrementUsageCount(promptId: string, tenantId: string): Promise<void> {
    await PromptLibraryItem.updateOne({ _id: promptId, tenantId }, { $inc: { usageCount: 1 } });
  }

  /**
   * Find agent versions that reference a given prompt library item.
   * Scoped to tenant+project via ProjectAgent join — AgentVersion has no
   * tenantId/projectId, so we first resolve the set of agentIds that belong
   * to the caller's project before scanning irContent.
   */
  async getReferences(promptId: string, opts: ScopeOptions): Promise<ReferenceInfo> {
    const { tenantId, projectId } = opts;

    const draftAgents = await this.getDraftAgentReferences(promptId, opts);
    const runtimeConfigRefs = await this.getRuntimeConfigReferences(promptId, opts);

    // Step 1: resolve agentIds for this tenant+project to avoid cross-tenant leakage.
    const projectAgents = await ProjectAgent.find(
      { tenantId, projectId },
      { _id: 1, name: 1 },
    ).lean();

    if (projectAgents.length === 0) {
      return {
        count: draftAgents.length + runtimeConfigRefs.length,
        agents: [],
        draftAgents,
        runtimeConfigRefs,
      };
    }

    const agentIdToName = new Map<string, string>(
      projectAgents.map((a: { _id: unknown; name: string }) => [String(a._id), a.name]),
    );
    const agentIds = [...agentIdToName.keys()];

    // Step 2: scan only versions owned by this project.
    const escapedPromptId = promptId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const results = await AgentVersion.find(
      {
        agentId: { $in: agentIds },
        irContent: { $regex: escapedPromptId },
      },
      { agentId: 1, _id: 1, irContent: 1 },
    ).lean();

    const agents: Array<{ agentName: string; versionId: string; resolvedHash: string }> = [];

    for (const v of results) {
      try {
        const ir = JSON.parse(v.irContent);
        const ref = ir?.identity?.system_prompt?.libraryRef;
        if (ref?.promptId === promptId) {
          agents.push({
            agentName: agentIdToName.get(v.agentId) ?? v.agentId,
            versionId: String(v._id),
            resolvedHash: ref.resolvedHash ?? '',
          });
        }
      } catch (err: unknown) {
        log.warn('Failed to parse irContent for agent version', {
          versionId: String(v._id),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      count: agents.length + draftAgents.length + runtimeConfigRefs.length,
      agents,
      draftAgents,
      runtimeConfigRefs,
    };
  }

  private async getRuntimeConfigReferences(
    promptId: string,
    opts: ScopeOptions,
    versionId?: string,
  ): Promise<Array<{ section: 'filler.promptRef'; versionId: string }>> {
    const config = await ProjectRuntimeConfig.findOne(
      {
        tenantId: opts.tenantId,
        projectId: opts.projectId,
        'filler.promptRef.promptId': promptId,
      },
      { 'filler.promptRef': 1 },
    ).lean();

    const refVersionId = config?.filler?.promptRef?.versionId;
    if (typeof refVersionId !== 'string' || refVersionId.length === 0) {
      return [];
    }

    if (versionId && refVersionId !== versionId) {
      return [];
    }

    return [{ section: 'filler.promptRef', versionId: refVersionId }];
  }

  private async assertVersionNotReferencedByWorkingCopies(
    promptId: string,
    versionId: string,
    opts: ScopeOptions,
  ): Promise<void> {
    const [draftRefs, runtimeConfigRefs] = await Promise.all([
      this.getDraftAgentReferences(promptId, opts, versionId),
      this.getRuntimeConfigReferences(promptId, opts, versionId),
    ]);
    if (draftRefs.length === 0 && runtimeConfigRefs.length === 0) {
      return;
    }

    throw new AppError(
      'Cannot archive or replace prompt version: referenced by draft agents or runtime config',
      {
        code: 'PROMPT_LIBRARY_VERSION_IN_USE',
        statusCode: 409,
      },
    );
  }

  private async getDraftAgentReferences(
    promptId: string,
    opts: ScopeOptions,
    versionId?: string,
  ): Promise<
    Array<{
      agentName: string;
      versionId: string;
      resolvedHash?: string;
    }>
  > {
    const projectAgents = (await ProjectAgent.find(
      { tenantId: opts.tenantId, projectId: opts.projectId },
      { name: 1, systemPromptLibraryRef: 1 },
    ).lean()) as Array<{
      name?: string;
      systemPromptLibraryRef?: {
        promptId?: unknown;
        versionId?: unknown;
        resolvedHash?: unknown;
      } | null;
    }>;

    return projectAgents.flatMap((agent) => {
      const ref = agent.systemPromptLibraryRef;
      if (!ref || typeof ref !== 'object') {
        return [];
      }

      const refPromptId = ref.promptId;
      const refVersionId = ref.versionId;
      if (refPromptId !== promptId || typeof refVersionId !== 'string') {
        return [];
      }

      if (versionId && refVersionId !== versionId) {
        return [];
      }

      return [
        {
          agentName: typeof agent.name === 'string' ? agent.name : 'unknown_agent',
          versionId: refVersionId,
          ...(typeof ref.resolvedHash === 'string' ? { resolvedHash: ref.resolvedHash } : {}),
        },
      ];
    });
  }

  /**
   * List prompts with optional filters and pagination.
   */
  async listPrompts(
    opts: ListPromptsOptions,
  ): Promise<{ items: IPromptLibraryItem[]; total: number }> {
    const { tenantId, projectId, status, tag } = opts;
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = opts.offset ?? 0;

    const filter: Record<string, unknown> = { tenantId, projectId };
    if (status) filter.status = status;
    if (tag) filter.tags = tag;

    const [items, total] = await Promise.all([
      PromptLibraryItem.find(filter)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean() as Promise<IPromptLibraryItem[]>,
      PromptLibraryItem.countDocuments(filter),
    ]);

    return { items, total };
  }

  /**
   * List all versions for a prompt, newest first.
   */
  async listVersions(promptId: string, opts: ScopeOptions): Promise<IPromptLibraryVersion[]> {
    return (await PromptLibraryVersion.find({
      promptId,
      tenantId: opts.tenantId,
      projectId: opts.projectId,
    })
      .sort({ versionNumber: -1 })
      .lean()) as IPromptLibraryVersion[];
  }
}

// =============================================================================
// SINGLETON FACTORY
// =============================================================================

let instance: PromptLibraryService | null = null;

export function getPromptLibraryService(): PromptLibraryService {
  if (!instance) {
    instance = new PromptLibraryService();
  }
  return instance;
}

export function resetPromptLibraryService(): void {
  instance = null;
}
