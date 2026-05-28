/**
 * POST /api/projects/:id/module-dependencies/preview — Preview import (dry-run)
 *
 * Resolves the selector, computes mounted symbol names, checks for collisions,
 * and validates configOverrides — all without persisting anything.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import { resolveSelector, validateConfigOverrides } from '@agent-platform/project-io';
import type { ModuleReleaseContract } from '@agent-platform/database/models';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { findMountedSymbolCollisions } from '../collision-utils';

const log = createLogger('module-dependencies-preview-route');

// ─── Constants ────────────────────────────────────────────────────────────

/** Alias pattern: lowercase start, alphanumeric + underscore, 2-25 chars total */
const ALIAS_PATTERN = /^[a-z][a-z0-9_]{1,24}$/;

/** Reserved alias prefixes */
const RESERVED_PREFIXES = ['system_', 'internal_', 'test_'];

/** Module visibility filter shared with the catalog endpoints */
const VISIBLE_MODULE_FILTER = [
  { moduleVisibility: 'tenant' },
  { moduleVisibility: { $in: [null, undefined] } },
  { moduleVisibility: { $exists: false } },
];

// ─── Schema ───────────────────────────────────────────────────────────────

const PreviewImportSchema = z.object({
  moduleProjectId: z.string().min(1),
  selector: z.object({
    type: z.enum(['version', 'environment']),
    value: z.string().min(1),
  }),
  alias: z.string().min(1).regex(ALIAS_PATTERN, 'Invalid alias format'),
  configOverrides: z.record(z.string()).optional(),
});

type PreviewImportInput = z.infer<typeof PreviewImportSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────

function validateAlias(alias: string): string | null {
  if (!ALIAS_PATTERN.test(alias)) {
    return 'Alias must start with a lowercase letter, contain only a-z, 0-9, underscore, and be 2-25 characters';
  }
  if (alias.includes('__')) {
    return 'Alias must not contain consecutive underscores "__"';
  }
  for (const prefix of RESERVED_PREFIXES) {
    if (alias.startsWith(prefix)) {
      return `Alias must not start with reserved prefix "${prefix}"`;
    }
  }
  return null;
}

// ─── POST — Preview import ────────────────────────────────────────────────

export const POST = withRouteHandler<PreviewImportInput>(
  {
    requireProject: true,
    permissions: StudioPermission.MODULE_IMPORT,
    requireFeature: 'reusable_modules',
    bodySchema: PreviewImportSchema,
  },
  async ({ body, params, tenantId, project }) => {
    await ensureDb();
    const projectId = params.id;
    const consumerProjectKind = (project as Record<string, unknown> | undefined)?.kind;

    if (consumerProjectKind === 'module') {
      return errorJson(
        'Module projects cannot import module dependencies in Phase 1',
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // 0. Self-import guard
    if (body.moduleProjectId === projectId) {
      return errorJson(
        'A project cannot import itself as a module dependency',
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // 1. Validate alias
    const aliasError = validateAlias(body.alias);
    if (aliasError) {
      return errorJson(aliasError, 400, ErrorCode.VALIDATION_ERROR);
    }

    // 2. Verify module project exists and is visible
    const { Project, ModuleRelease, ProjectAgent, ProjectTool } =
      await import('@agent-platform/database/models');
    const moduleProject = await Project.findOne({
      _id: body.moduleProjectId,
      tenantId,
      kind: 'module',
      $or: VISIBLE_MODULE_FILTER,
    });
    if (!moduleProject) {
      return errorJson('Module project not found', 404, ErrorCode.NOT_FOUND);
    }

    // 3. Resolve release from selector
    const selectorResult = await resolveSelector(tenantId, body.moduleProjectId, body.selector);
    if ('error' in selectorResult) {
      return errorJson(selectorResult.error, 404, ErrorCode.NOT_FOUND);
    }

    // 4. Load release contract
    const release = await ModuleRelease.findOne({
      _id: selectorResult.releaseId,
      tenantId,
      moduleProjectId: body.moduleProjectId,
      archivedAt: null,
    });
    if (!release) {
      return errorJson('Resolved release not found or archived', 404, ErrorCode.NOT_FOUND);
    }

    const contract: ModuleReleaseContract = release.contract;
    const prerequisites: { blocking: string[]; warnings: string[] } = {
      blocking: [],
      warnings: [],
    };

    // 5. Compute mounted symbols and check for collisions with existing project agents/tools
    const { mountedSymbols, collisions } = await findMountedSymbolCollisions({
      tenantId,
      projectId,
      alias: body.alias,
      contract,
      ProjectAgent,
      ProjectTool,
    });

    // 6. Check prerequisites from contract
    if (contract.requiredSecrets?.length) {
      if (contract.requiredSecrets.length > 0) {
        prerequisites.warnings.push(
          `Module requires ${contract.requiredSecrets.length} runtime secret(s) that must be set separately`,
        );
      }
    }
    if (contract.requiredAuthProfiles?.length) {
      prerequisites.warnings.push(
        `Module requires ${contract.requiredAuthProfiles.length} auth profile(s)`,
      );
    }
    if (contract.requiredConnectors?.length) {
      prerequisites.warnings.push(
        `Module requires ${contract.requiredConnectors.length} connector(s)`,
      );
    }
    if (contract.requiredMcpServers?.length) {
      prerequisites.warnings.push(
        `Module requires ${contract.requiredMcpServers.length} MCP server(s)`,
      );
    }
    if (contract.requiredEnvVars?.length) {
      prerequisites.warnings.push(
        `Module requires ${contract.requiredEnvVars.length} environment variable(s)`,
      );
    }

    // 7. Validate configOverrides if provided
    if (body.configOverrides && Object.keys(body.configOverrides).length > 0) {
      const validation = validateConfigOverrides(
        body.configOverrides,
        contract.requiredConfigKeys ?? [],
      );
      prerequisites.blocking.push(...validation.blocking);
      prerequisites.warnings.push(...validation.warnings);
    }

    log.debug('Preview computed', {
      projectId,
      moduleProjectId: body.moduleProjectId,
      alias: body.alias,
      collisionCount: collisions.length,
    });

    return NextResponse.json({
      success: true,
      data: {
        resolvedReleaseId: selectorResult.releaseId,
        resolvedVersion: selectorResult.version,
        mountedSymbols,
        prerequisites,
        collisions,
      },
    });
  },
);
