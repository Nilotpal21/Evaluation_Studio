/**
 * GET /api/projects/:id/module-dependencies/:dependencyId/diff
 *
 * Computes a structured diff between the currently-pinned module release
 * and a target release. Returns contract changes, prerequisite issues,
 * and mounted symbol changes for upgrade preview.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode, actionJson } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { diffModuleContracts, EMPTY_MODULE_CONTRACT } from '@agent-platform/project-io';
import type { ModuleReleaseContract } from '@agent-platform/database/models';
import { findMountedSymbolCollisions } from '../../collision-utils';

const log = createLogger('module-dependency-diff-route');

// ─── GET — Compute upgrade diff ──────────────────────────────────────────

export const GET = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.MODULE_READ,
    requireFeature: 'reusable_modules',
  },
  async ({ request, params, tenantId }) => {
    await ensureDb();
    const projectId = params.id;
    const dependencyId = params.dependencyId;

    if (!dependencyId) {
      return errorJson('Dependency ID is required', 400, ErrorCode.VALIDATION_ERROR);
    }

    // Read targetReleaseId from query params
    const url = new URL(request.url);
    const targetReleaseId = url.searchParams.get('targetReleaseId');

    if (!targetReleaseId || targetReleaseId.trim().length === 0) {
      return errorJson(
        'targetReleaseId query parameter is required',
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const { ProjectModuleDependency, ModuleRelease, ProjectAgent, ProjectTool } =
      await import('@agent-platform/database/models');

    // 1. Load current dependency scoped by tenantId + projectId
    const dep = await ProjectModuleDependency.findOne({
      _id: dependencyId,
      tenantId,
      projectId,
    }).lean();

    if (!dep) {
      return errorJson('Module dependency not found', 404, ErrorCode.NOT_FOUND);
    }

    // 2. Load target release — must belong to same module project, not archived
    const targetRelease = await ModuleRelease.findOne({
      _id: targetReleaseId,
      tenantId,
      moduleProjectId: dep.moduleProjectId,
      archivedAt: { $in: [null, undefined] },
    }).lean();

    if (!targetRelease) {
      return errorJson('Target release not found or archived', 404, ErrorCode.NOT_FOUND);
    }

    // 3. Compute contract diff (pre-Phase-2 deps may have null contractSnapshot)
    const currentContract: ModuleReleaseContract =
      (dep.contractSnapshot as ModuleReleaseContract) ?? EMPTY_MODULE_CONTRACT;
    const targetContract: ModuleReleaseContract =
      (targetRelease.contract as ModuleReleaseContract) ?? EMPTY_MODULE_CONTRACT;
    const diff = diffModuleContracts(currentContract, targetContract);

    // 4. Compute prerequisite issues: check target's required prereqs
    //    against what the consumer project might not satisfy.
    //    We compare current vs target required prereqs — new ones are flagged.
    const prerequisiteIssues: Array<{
      type: string;
      name: string;
      severity: 'breaking' | 'warn';
    }> = [];

    const currentEnvNames = new Set(currentContract.requiredEnvVars.map((e) => e.name));
    for (const envVar of targetContract.requiredEnvVars) {
      if (!currentEnvNames.has(envVar.name)) {
        prerequisiteIssues.push({
          type: 'envVar',
          name: envVar.name,
          severity: 'breaking',
        });
      }
    }

    const currentAuthNames = new Set(currentContract.requiredAuthProfiles.map((a) => a.name));
    for (const auth of targetContract.requiredAuthProfiles) {
      if (!currentAuthNames.has(auth.name)) {
        prerequisiteIssues.push({
          type: 'authProfile',
          name: auth.name,
          severity: 'breaking',
        });
      }
    }

    const currentConnNames = new Set(currentContract.requiredConnectors.map((c) => c.name));
    for (const conn of targetContract.requiredConnectors) {
      if (!currentConnNames.has(conn.name)) {
        prerequisiteIssues.push({
          type: 'connector',
          name: conn.name,
          severity: 'breaking',
        });
      }
    }

    const currentMcpNames = new Set(currentContract.requiredMcpServers.map((m) => m.name));
    for (const mcp of targetContract.requiredMcpServers) {
      if (!currentMcpNames.has(mcp.name)) {
        prerequisiteIssues.push({
          type: 'mcpServer',
          name: mcp.name,
          severity: 'breaking',
        });
      }
    }

    const currentConfigKeys = new Set(currentContract.requiredConfigKeys.map((k) => k.key));
    for (const configKey of targetContract.requiredConfigKeys) {
      if (!currentConfigKeys.has(configKey.key)) {
        prerequisiteIssues.push({
          type: 'configKey',
          name: configKey.key,
          severity: 'breaking',
        });
      }
    }

    const secretKey = (secret: { key: string; toolName?: string }) =>
      secret.toolName ? `${secret.toolName}:${secret.key}` : secret.key;
    const currentSecretKeys = new Set((currentContract.requiredSecrets ?? []).map(secretKey));
    for (const secret of targetContract.requiredSecrets ?? []) {
      const name = secretKey(secret);
      if (!currentSecretKeys.has(name)) {
        prerequisiteIssues.push({
          type: 'secret',
          name,
          severity: 'breaking',
        });
      }
    }

    // 5. Compute mounted symbol changes: compare current vs target
    //    providedAgents and providedTools with alias prefix
    const alias = dep.alias;
    const mountedSymbolChanges: Array<{
      symbolType: 'agent' | 'tool';
      name: string;
      mountedName: string;
      change: 'added' | 'removed';
    }> = [];

    const currentAgentNames = new Set(currentContract.providedAgents.map((a) => a.name));
    const targetAgentNames = new Set(targetContract.providedAgents.map((a) => a.name));

    for (const name of targetAgentNames) {
      if (!currentAgentNames.has(name)) {
        mountedSymbolChanges.push({
          symbolType: 'agent',
          name,
          mountedName: `${alias}__${name}`,
          change: 'added',
        });
      }
    }
    for (const name of currentAgentNames) {
      if (!targetAgentNames.has(name)) {
        mountedSymbolChanges.push({
          symbolType: 'agent',
          name,
          mountedName: `${alias}__${name}`,
          change: 'removed',
        });
      }
    }

    const currentToolNames = new Set(currentContract.providedTools.map((t) => t.name));
    const targetToolNames = new Set(targetContract.providedTools.map((t) => t.name));

    for (const name of targetToolNames) {
      if (!currentToolNames.has(name)) {
        mountedSymbolChanges.push({
          symbolType: 'tool',
          name,
          mountedName: `${alias}__${name}`,
          change: 'added',
        });
      }
    }
    for (const name of currentToolNames) {
      if (!targetToolNames.has(name)) {
        mountedSymbolChanges.push({
          symbolType: 'tool',
          name,
          mountedName: `${alias}__${name}`,
          change: 'removed',
        });
      }
    }

    const { collisions } = await findMountedSymbolCollisions({
      tenantId,
      projectId,
      alias,
      contract: targetContract,
      ProjectAgent,
      ProjectTool,
    });

    log.info('Computed module dependency diff', {
      dependencyId,
      targetReleaseId,
      hasBreakingChanges: diff.hasBreakingChanges,
      prerequisiteIssueCount: prerequisiteIssues.length,
      mountedSymbolChangeCount: mountedSymbolChanges.length,
      collisionCount: collisions.length,
    });

    return actionJson({
      data: {
        diff,
        prerequisiteIssues,
        mountedSymbolChanges,
        collisions,
        currentVersion: dep.resolvedVersion,
        targetVersion: targetRelease.version,
      },
    });
  },
);
