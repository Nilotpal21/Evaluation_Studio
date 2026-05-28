/**
 * Settings Version Service
 *
 * Handles project settings version lifecycle: snapshot working copy,
 * manage status transitions (draft → testing → staged → active → deprecated).
 *
 * All methods require tenantId for cross-tenant isolation.
 */

import { createHash } from 'crypto';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import { createLogger } from '@abl/compiler/platform';
import {
  findProjectSettings,
  createSettingsVersion,
  findSettingsVersion,
  findLatestSettingsVersion,
  listSettingsVersions,
  countSettingsVersions,
  getAllSettingsVersionNumbers,
  promoteSettingsVersion,
} from '../repos/project-settings-repo.js';

const log = createLogger('settings-version-service');

// =============================================================================
// TYPES
// =============================================================================

export interface CreateSettingsVersionParams {
  projectId: string;
  tenantId: string;
  createdBy: string;
  changelog?: string;
}

export interface CreateSettingsVersionResult {
  versionId: string;
  version: string;
  sourceHash: string;
  deduplicated?: boolean;
}

export interface PromoteSettingsVersionParams {
  projectId: string;
  version: string;
  targetStatus: string;
  promotedBy: string;
  tenantId: string;
}

export interface ListSettingsVersionsParams {
  projectId: string;
  tenantId: string;
  limit?: number;
  offset?: number;
}

// =============================================================================
// CONSTANTS (reuse same values as VersionService)
// =============================================================================

const VALID_STATUSES = ['draft', 'testing', 'staged', 'active', 'deprecated'] as const;
type VersionStatus = (typeof VALID_STATUSES)[number];

const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ['testing', 'staged'],
  testing: ['staged', 'draft'],
  staged: ['active', 'draft'],
  active: ['deprecated'],
  deprecated: [],
};

const MAX_CHANGELOG_SIZE = 10_000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const MAX_DUPLICATE_KEY_RETRIES = 3;

// =============================================================================
// SERVICE
// =============================================================================

export class SettingsVersionService {
  static isValidStatus(status: unknown): status is VersionStatus {
    return typeof status === 'string' && VALID_STATUSES.includes(status as VersionStatus);
  }

  static validateChangelog(changelog: unknown): string | null {
    if (changelog === undefined || changelog === null) return null;
    if (typeof changelog !== 'string') return 'changelog must be a string';
    if (changelog.length > MAX_CHANGELOG_SIZE)
      return `changelog exceeds maximum size of ${MAX_CHANGELOG_SIZE} characters`;
    return null;
  }

  // ---------------------------------------------------------------------------
  // CREATE VERSION
  // ---------------------------------------------------------------------------

  async createVersion(params: CreateSettingsVersionParams): Promise<CreateSettingsVersionResult> {
    const { projectId, tenantId, createdBy, changelog } = params;

    const changelogError = SettingsVersionService.validateChangelog(changelog);
    if (changelogError) throw new AppError(changelogError, { ...ErrorCodes.BAD_REQUEST });

    // Load working copy
    const workingCopy = await findProjectSettings(projectId, tenantId);
    const promptOverrides: Record<string, unknown> =
      workingCopy?.promptOverrides && typeof workingCopy.promptOverrides === 'object'
        ? (workingCopy.promptOverrides as Record<string, unknown>)
        : {};

    const settings: {
      enableThinking: boolean;
      thinkingBudget: number | null;
      thoughtDescription: string | null;
      promptOverrides?: Record<string, unknown>;
      memory?: { dedupMaxDepth?: number | null } | null;
    } = {
      enableThinking: workingCopy?.enableThinking ?? false,
      thinkingBudget: workingCopy?.thinkingBudget ?? null,
      thoughtDescription: workingCopy?.thoughtDescription ?? null,
    };
    if (Object.keys(promptOverrides).length > 0) {
      settings.promptOverrides = promptOverrides;
    }
    const workingMemory = (workingCopy as { memory?: { dedupMaxDepth?: number | null } | null })
      ?.memory;
    if (workingMemory && typeof workingMemory === 'object') {
      settings.memory = { dedupMaxDepth: workingMemory.dedupMaxDepth ?? null };
    }

    // Compute sourceHash
    const sourceHash = createHash('sha256')
      .update(JSON.stringify(settings))
      .digest('hex')
      .substring(0, 16);

    // Dedup: skip if latest version has same sourceHash
    const latest = await findLatestSettingsVersion(projectId, tenantId);
    if (latest && latest.sourceHash === sourceHash) {
      log.info('Settings version dedup — same sourceHash as latest', {
        projectId,
        sourceHash,
      });
      return {
        versionId: latest._id,
        version: latest.version,
        sourceHash,
        deduplicated: true,
      };
    }

    // Auto-increment version
    let version = await this.nextVersion(projectId, tenantId);

    // Create version record — retry on unique constraint collision
    for (let attempt = 0; attempt < MAX_DUPLICATE_KEY_RETRIES; attempt++) {
      try {
        const record = await createSettingsVersion({
          tenantId,
          projectId,
          version,
          status: 'draft',
          settings,
          sourceHash,
          changelog,
          createdBy,
        });

        const recordId = record._id ?? record.id;
        log.info('Settings version created', {
          projectId,
          version,
          versionId: recordId,
          sourceHash,
        });

        return { versionId: recordId, version, sourceHash };
      } catch (err: any) {
        if (err?.code === 11000 && attempt < MAX_DUPLICATE_KEY_RETRIES - 1) {
          log.warn('Settings version create collision, retrying', {
            projectId,
            version,
            attempt,
          });
          version = await this.nextVersion(projectId, tenantId);
          continue;
        }
        throw err;
      }
    }

    throw new AppError('Settings version creation failed after maximum retries', {
      ...ErrorCodes.INTERNAL_ERROR,
    });
  }

  // ---------------------------------------------------------------------------
  // PROMOTE VERSION
  // ---------------------------------------------------------------------------

  async promoteVersion(params: PromoteSettingsVersionParams) {
    const { projectId, version, targetStatus, promotedBy, tenantId } = params;

    if (!SettingsVersionService.isValidStatus(targetStatus)) {
      throw new AppError(`Invalid target status '${targetStatus}'`, { ...ErrorCodes.BAD_REQUEST });
    }

    const record = await findSettingsVersion(projectId, tenantId, version);
    if (!record) {
      throw new AppError(`Settings version '${version}' not found`, { ...ErrorCodes.NOT_FOUND });
    }

    const recordId = record._id;
    const recordStatus = record.status as string;

    const allowed = VALID_STATUS_TRANSITIONS[recordStatus];
    if (!allowed || !allowed.includes(targetStatus)) {
      throw new AppError(`Cannot transition from '${recordStatus}' to '${targetStatus}'`, {
        ...ErrorCodes.BAD_REQUEST,
      });
    }

    const previousStatus = recordStatus;

    // Optimistic locking: only update if status hasn't changed since we read it
    const updated = await promoteSettingsVersion({
      id: recordId,
      currentStatus: previousStatus,
      newStatus: targetStatus,
      promotedBy,
    });

    if (updated.count === 0) {
      throw new AppError(
        `Concurrent modification: settings version '${version}' status changed since read`,
        { ...ErrorCodes.UNPROCESSABLE_ENTITY },
      );
    }

    log.info('Settings version promoted', {
      projectId,
      version,
      from: previousStatus,
      to: targetStatus,
      promotedBy,
    });

    // Re-fetch to return full data
    const result = await findSettingsVersion(projectId, tenantId, version);
    return { ...result!, previousStatus };
  }

  // ---------------------------------------------------------------------------
  // LIST / GET
  // ---------------------------------------------------------------------------

  async listVersions(params: ListSettingsVersionsParams) {
    const { projectId, tenantId } = params;
    const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const offset = Math.max(params.offset ?? 0, 0);

    const [versions, total] = await Promise.all([
      listSettingsVersions(projectId, tenantId, { skip: offset, take: limit }),
      countSettingsVersions(projectId, tenantId),
    ]);

    return { versions, total };
  }

  async getVersion(projectId: string, version: string, tenantId: string) {
    return findSettingsVersion(projectId, tenantId, version);
  }

  // ---------------------------------------------------------------------------
  // NEXT VERSION
  // ---------------------------------------------------------------------------

  async nextVersion(projectId: string, tenantId: string): Promise<string> {
    const versionStrings = await getAllSettingsVersionNumbers(projectId, tenantId);
    if (versionStrings.length === 0) return '0.1.0';

    let highest: [number, number, number] | null = null;
    for (const ver of versionStrings) {
      const parts = ver.split('.').map(Number);
      if (parts.length !== 3 || parts.some(isNaN)) continue;
      const tuple = parts as unknown as [number, number, number];
      if (
        !highest ||
        tuple[0] > highest[0] ||
        (tuple[0] === highest[0] && tuple[1] > highest[1]) ||
        (tuple[0] === highest[0] && tuple[1] === highest[1] && tuple[2] > highest[2])
      ) {
        highest = tuple;
      }
    }

    if (!highest) return '0.1.0';
    return `${highest[0]}.${highest[1]}.${highest[2] + 1}`;
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

let instance: SettingsVersionService | null = null;

export function getSettingsVersionService(): SettingsVersionService {
  if (!instance) {
    instance = new SettingsVersionService();
  }
  return instance;
}

export function resetSettingsVersionService(): void {
  instance = null;
}
