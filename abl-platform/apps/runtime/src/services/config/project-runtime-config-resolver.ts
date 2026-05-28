/**
 * Project Runtime Config Resolver
 *
 * Loads project-level runtime config from MongoDB and maps the nested DB
 * schema to the flat IR shape expected by the engine.
 */

import type { ProjectRuntimeConfigIR } from '@abl/compiler/platform/ir/schema.js';
import { createLogger } from '@abl/compiler/platform';
import { mapProjectRuntimeConfigDocumentToIR } from '@abl/compiler/platform/ir/project-runtime-config.js';
import {
  getProjectExportReadinessIssues,
  type ProjectExportReadinessIssue,
} from '@agent-platform/project-io';
import { isDatabaseReady } from '../../db/index.js';

const log = createLogger('project-runtime-config-resolver');

export class ProjectRuntimeConfigResolutionError extends Error {
  readonly code = 'PROJECT_RUNTIME_CONFIG_INVALID';
  readonly issues: ProjectExportReadinessIssue[];

  constructor(issues: ProjectExportReadinessIssue[]) {
    super('Project runtime config has validation errors. Fix runtime config before execution.');
    this.name = 'ProjectRuntimeConfigResolutionError';
    this.issues = issues;
  }
}

/**
 * Load project runtime config from DB and map to IR shape.
 * Returns undefined when no record exists or on DB error (graceful degradation).
 */
export async function resolveProjectRuntimeConfig(
  tenantId: string,
  projectId: string,
): Promise<ProjectRuntimeConfigIR | undefined> {
  if (!isDatabaseReady()) {
    log.debug('Project runtime config unavailable because database is not ready', {
      tenantId,
      projectId,
    });
    return undefined;
  }

  try {
    const { ProjectRuntimeConfig } = await import('@agent-platform/database');
    const doc = await ProjectRuntimeConfig.findOne({ tenantId, projectId }).lean();
    if (!doc) return undefined;
    const readinessIssues = await getProjectExportReadinessIssues({
      agents: [],
      tenantId,
      projectId,
      runtimeConfig: doc as Record<string, unknown>,
    });
    if (readinessIssues.length > 0) {
      throw new ProjectRuntimeConfigResolutionError(readinessIssues);
    }
    return mapProjectRuntimeConfigDocumentToIR(doc);
  } catch (err) {
    if (err instanceof ProjectRuntimeConfigResolutionError) {
      log.warn('Project runtime config is invalid', {
        tenantId,
        projectId,
        issueKinds: err.issues.map((issue) => issue.kind),
      });
      throw err;
    }
    log.warn('Failed to load project runtime config, using defaults', {
      tenantId,
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
