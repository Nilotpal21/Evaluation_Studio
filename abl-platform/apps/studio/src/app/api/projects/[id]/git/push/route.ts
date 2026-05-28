/**
 * POST /api/projects/:id/git/push — Push to git
 */

import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { resolveGitCredentials } from '@/lib/git-credentials';
import {
  acquireGitOperationLock,
  gitOperationLockedResponse,
  type GitOperationLockResult,
} from '@/lib/git-operation-lock';
import { AuditActions, logAuditEvent } from '@/services/audit-service';
import {
  ConnectorConfig,
  ensureConnected,
  GitIntegration,
  GitSyncHistory,
  MCPServerConfig,
  Project,
  ProjectAgent,
  ProjectConfigVariable,
  ProjectLLMConfig,
  ProjectRuntimeConfig,
  ProjectTool,
  type IProjectAgent,
  type IProjectTool,
} from '@agent-platform/database/models';
import { behaviorProfileConfigKeyToName } from '@agent-platform/project-io';
import {
  buildExportProvisioningRequirements,
  exportProjectV2,
  extractProfileManifestEntries,
  resolveLayers,
  resolveLayersForToolDependencies,
  type ExportV2Deps,
} from '@agent-platform/project-io/export';
import {
  createGitProvider,
  GitSyncService,
  GitCircuitBreakerError,
} from '@agent-platform/project-io/git';
import {
  buildInvalidProjectExportPayload,
  getProjectExportReadinessIssues,
} from '@/lib/project-agent-export-readiness';

const log = createLogger('git-push-route');

function sanitizeGitLifecycleError(
  message: string,
  sensitiveValues: Array<string | null | undefined>,
): string {
  let sanitized = message || 'Git operation failed';
  for (const value of sensitiveValues) {
    if (value) {
      sanitized = sanitized.split(value).join('[redacted]');
    }
  }
  sanitized = sanitized
    .replace(/https:\/\/[^@\s]+@/gi, 'https://[redacted]@')
    .replace(/\bsecret[-_a-z0-9]*\b/gi, '[redacted]');
  return sanitized;
}

function isProtectedBranchFailure(error: { code?: string; message?: string } | undefined): boolean {
  if (!error) return false;
  return (
    error.code === 'BRANCH_PROTECTED' ||
    /protected branch|pull request review/i.test(error.message ?? '')
  );
}

function isValidGitBranchName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const branch = value.trim();
  return (
    branch.length > 0 &&
    branch.length <= 256 &&
    /^[a-zA-Z0-9_\-/.]+$/.test(branch) &&
    !branch.includes('..') &&
    !branch.startsWith('/') &&
    !branch.endsWith('/')
  );
}

type CreatePullRequestInput = {
  title: string;
  description: string;
  targetBranch: string;
};

type CreatePullRequestValidationResult =
  | { success: true; createPR: CreatePullRequestInput | undefined }
  | { success: false; response: NextResponse };

function validateCreatePullRequestInput(createPR: unknown): CreatePullRequestValidationResult {
  if (createPR === undefined) {
    return { success: true, createPR: undefined };
  }

  if (!createPR || typeof createPR !== 'object') {
    return {
      success: false,
      response: NextResponse.json({ error: 'Invalid pull request options' }, { status: 400 }),
    };
  }

  const source = createPR as Record<string, unknown>;
  const title = typeof source.title === 'string' ? source.title.trim() : '';
  const description = typeof source.description === 'string' ? source.description : '';
  const targetBranch = typeof source.targetBranch === 'string' ? source.targetBranch.trim() : '';

  if (!title || !isValidGitBranchName(targetBranch)) {
    return {
      success: false,
      response: NextResponse.json({ error: 'Invalid pull request options' }, { status: 400 }),
    };
  }

  return { success: true, createPR: { title, description, targetBranch } };
}

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.PROJECT_GIT,
    rateLimit: { limit: 10, windowMs: 60_000, scope: 'tenant' },
  },
  async (ctx): Promise<NextResponse> => {
    const { tenantId, user, request } = ctx;
    const projectId = ctx.params.id;

    let body: {
      commitMessage?: string;
      branch?: string;
      createPR?: { title: string; description: string; targetBranch: string };
    };
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    let operationLock: GitOperationLockResult | null = null;
    try {
      operationLock = await acquireGitOperationLock({ tenantId, projectId, operation: 'push' });
      if (!operationLock.acquired) {
        return gitOperationLockedResponse(operationLock);
      }

      await ensureConnected();

      const integration = await GitIntegration.findOne({ projectId, tenantId }).lean();
      if (!integration) {
        return NextResponse.json({ error: 'No git integration configured' }, { status: 404 });
      }

      const project = await Project.findOne({ _id: projectId, tenantId }).lean();
      if (!project) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }

      const [agents, tools, profileDocs, connectorConfigs, mcpServers, runtimeConfig, llmConfig] =
        await Promise.all([
          ProjectAgent.find({ projectId, tenantId })
            .select(
              'name description dslContent ownerId ownerTeamId version status systemPromptLibraryRef dslValidationStatus dslDiagnostics',
            )
            .lean(),
          ProjectTool.find({ projectId, tenantId }).select('name slug toolType dslContent').lean(),
          ProjectConfigVariable.find({ projectId, tenantId, key: /^profile:/ })
            .select('key value')
            .lean(),
          ConnectorConfig.find({ projectId, tenantId }).select('connectorType').lean(),
          MCPServerConfig.find({ projectId, tenantId }).select('name').lean(),
          ProjectRuntimeConfig.findOne({ projectId, tenantId }).lean(),
          ProjectLLMConfig.findOne({ projectId, tenantId }).lean(),
        ]);
      const readinessIssues = await getProjectExportReadinessIssues({
        agents,
        projectId,
        tenantId,
        runtimeConfig: (runtimeConfig as Record<string, unknown> | null) ?? null,
        llmConfig: (llmConfig as Record<string, unknown> | null) ?? null,
      });
      if (readinessIssues.length > 0) {
        return NextResponse.json(buildInvalidProjectExportPayload(readinessIssues), {
          status: 409,
        });
      }

      const branch =
        typeof body.branch === 'string' ? body.branch.trim() : integration.defaultBranch;
      const createPRValidation = validateCreatePullRequestInput(body.createPR);
      if (!createPRValidation.success) {
        return createPRValidation.response;
      }
      const createPR = createPRValidation.createPR;
      const sensitiveValues = [
        projectId,
        tenantId,
        user.id,
        typeof integration.authProfileId === 'string' ? integration.authProfileId : null,
      ];

      // Validate branch name (prevent injection and path traversal)
      if (!isValidGitBranchName(branch)) {
        return NextResponse.json({ error: 'Invalid branch name' }, { status: 400 });
      }
      const commitMessage = body.commitMessage ?? `sync: update project content from ABL Platform`;

      // Resolve credentials and create provider
      let credentials;
      try {
        credentials = await resolveGitCredentials(integration.authProfileId, tenantId, {
          projectId,
          userId: user.id,
        });
      } catch (credentialError) {
        const message =
          credentialError instanceof Error ? credentialError.message : String(credentialError);
        const safeError = sanitizeGitLifecycleError(message, sensitiveValues);
        await GitSyncHistory.create({
          projectId,
          tenantId,
          direction: 'push',
          commitSha: null,
          branch,
          status: 'failed',
          error: safeError,
          agentsAffected: agents.map((a: IProjectAgent) => a.name),
          changesSummary: { added: [], modified: [], deleted: [] },
          triggeredBy: user.id,
        });
        return NextResponse.json({ error: 'Failed to resolve git credentials' }, { status: 500 });
      }
      const provider = createGitProvider(
        { provider: integration.provider, repositoryUrl: integration.repositoryUrl },
        credentials,
      );
      const syncService = new GitSyncService(provider);

      const layers = resolveLayersForToolDependencies(
        resolveLayers(),
        tools.map((tool: IProjectTool) => ({
          name: tool.name,
          dslContent: tool.dslContent,
          toolType: tool.toolType,
        })),
      );
      const { buildAssemblerMap } = await import('@/lib/export-assemblers');
      const assemblers = buildAssemblerMap(layers);
      const profiles = new Map<string, string>();
      for (const doc of profileDocs as Array<{ key: string; value: string }>) {
        const profileName = behaviorProfileConfigKeyToName(doc.key);
        if (profileName) {
          profiles.set(profileName, doc.value);
        }
      }
      const profileManifestEntries = extractProfileManifestEntries(
        profiles,
        agents.map((agent: IProjectAgent) => ({
          name: agent.name,
          dslContent: agent.dslContent ?? '',
        })),
      );
      const profileEntries = [...profiles.entries()].map(([name, dslContent]) => ({
        name,
        dslContent,
      }));
      const provisioning = buildExportProvisioningRequirements({
        agents: agents.map((agent: IProjectAgent) => ({
          name: agent.name,
          dslContent: agent.dslContent ?? '',
        })),
        tools: tools.map((tool: IProjectTool) => ({
          name: tool.name,
          dslContent: tool.dslContent,
        })),
        profiles: profileEntries,
        connectorConfigs,
        mcpServers,
      });
      const exportResult = await exportProjectV2(
        {
          projectId,
          userId: user.id,
          tenantId,
          format: 'folder',
          layers,
          dslFormat: 'yaml',
          includeDeployments: false,
        },
        {
          assemblers,
          agentData: agents.map((agent: IProjectAgent) => ({
            name: agent.name,
            version: '1.0',
            dslContent: agent.dslContent ?? '',
            status: 'active',
            systemPromptLibraryRef: agent.systemPromptLibraryRef ?? null,
          })),
          toolData: tools.map((tool: IProjectTool) => ({
            name: tool.name,
            dslContent: tool.dslContent,
            toolType: tool.toolType,
          })),
        } satisfies ExportV2Deps,
        {
          projectName: project.name,
          projectSlug: project.slug,
          projectDescription:
            ((project as Record<string, unknown>).description as string | null) ?? null,
          exportedBy: user.id,
          entryAgent:
            ((project as Record<string, unknown>).entryAgentName as string | null) ?? null,
          agents: agents.map((agent: IProjectAgent) => ({
            name: agent.name,
            description: agent.description ?? null,
            ownerId: agent.ownerId ?? null,
            ownerTeamId: agent.ownerTeamId ?? null,
            version: null,
            systemPromptLibraryRef: agent.systemPromptLibraryRef ?? null,
          })),
          tools: tools.map((tool: IProjectTool) => ({ name: tool.name, ownerId: null })),
          profiles: profileManifestEntries,
          entityCounts: {
            agents: agents.length,
            tools: tools.length,
            behavior_profiles: profileManifestEntries.length,
          },
          requiredEnvVars: provisioning.requiredEnvVars,
          requiredAuthProfiles: provisioning.requiredAuthProfiles,
          requiredConnectors: provisioning.requiredConnectors,
          requiredMcpServers: provisioning.requiredMcpServers,
        },
      );
      if (!exportResult.success) {
        return NextResponse.json(
          { error: exportResult.error?.message ?? 'Failed to export project for git sync' },
          { status: 400 },
        );
      }
      const localeFileCount = [...exportResult.files.keys()].filter((filePath) =>
        filePath.startsWith('locales/'),
      ).length;

      // Push via sync service
      const result = await syncService.push({
        projectFiles: exportResult.files,
        userId: user.id,
        tenantId,
        branch,
        commitMessage,
        committer: { name: user.name ?? user.id, email: user.email ?? 'noreply@ablplatform.io' },
        lastSyncCommit: integration.lastSyncCommit,
        createPR,
        conflictStrategy: integration.syncConfig?.conflictStrategy ?? 'manual',
        syncPath: typeof integration.syncPath === 'string' ? integration.syncPath : '/',
      });

      if (!result.success && result.conflicts.length > 0) {
        // Record conflict in sync history
        await GitSyncHistory.create({
          projectId,
          tenantId,
          direction: 'push',
          commitSha: null,
          branch,
          status: 'conflict',
          agentsAffected: agents.map((a: IProjectAgent) => a.name),
          changesSummary: result.changes,
          conflictDetails: result.conflicts.map((c) => ({
            agentName: c.agentName,
            file: c.file,
            resolved: false,
            resolution: null,
          })),
          triggeredBy: user.id,
        });

        await GitIntegration.findOneAndUpdate(
          { projectId, tenantId },
          { lastSyncAt: new Date(), lastSyncStatus: 'conflict' },
        );

        return NextResponse.json(
          {
            error: 'Conflicts detected',
            conflicts: result.conflicts,
            changes: result.changes,
          },
          { status: 409 },
        );
      }

      if (!result.success) {
        const safeError = sanitizeGitLifecycleError(
          result.error?.message ?? 'Push failed',
          sensitiveValues,
        );
        const status = isProtectedBranchFailure(result.error) ? 409 : 500;
        await GitSyncHistory.create({
          projectId,
          tenantId,
          direction: 'push',
          commitSha: null,
          branch,
          status: 'failed',
          error: safeError,
          agentsAffected: agents.map((a: IProjectAgent) => a.name),
          changesSummary: result.changes,
          triggeredBy: user.id,
        });

        await GitIntegration.findOneAndUpdate(
          { projectId, tenantId },
          {
            lastSyncAt: new Date(),
            lastSyncStatus: 'failed',
            lastSyncError: safeError,
          },
        );

        return NextResponse.json({ error: safeError }, { status });
      }

      // Record successful sync
      await GitSyncHistory.create({
        projectId,
        tenantId,
        direction: 'push',
        commitSha: result.commitSha,
        branch,
        status: 'success',
        ...(createPR
          ? {
              pullRequest: {
                title: createPR.title,
                description: createPR.description,
                targetBranch: createPR.targetBranch,
              },
            }
          : {}),
        agentsAffected: agents.map((a: IProjectAgent) => a.name),
        changesSummary: result.changes,
        triggeredBy: user.id,
      });

      const integrationUpdate: Record<string, unknown> = {
        lastSyncAt: new Date(),
        lastSyncStatus: 'success',
        lastSyncError: null,
      };
      if (!createPR) {
        integrationUpdate.lastSyncCommit = result.commitSha;
      }

      await GitIntegration.findOneAndUpdate({ projectId, tenantId }, integrationUpdate);

      try {
        await logAuditEvent({
          userId: user.id,
          tenantId,
          action: AuditActions.GIT_PUSH_COMPLETED,
          ip: request.headers.get('x-forwarded-for') || undefined,
          userAgent: request.headers.get('user-agent') || undefined,
          metadata: {
            projectId,
            resourceType: 'git_integration',
            resourceId: String(integration._id),
            branch,
            commitSha: result.commitSha ?? null,
            createPR: createPR ?? null,
            added: result.changes.added.length,
            modified: result.changes.modified.length,
            deleted: result.changes.deleted.length,
            agentsCount: agents.length,
          },
        });
      } catch (auditError) {
        const auditMessage = auditError instanceof Error ? auditError.message : String(auditError);
        log.warn('Git push audit event failed after sync', { projectId, error: auditMessage });
      }

      log.info('Git push succeeded', {
        projectId,
        branch,
        commitSha: result.commitSha,
        added: result.changes.added.length,
        modified: result.changes.modified.length,
        deleted: result.changes.deleted.length,
        userId: user.id,
      });

      return NextResponse.json({
        success: true,
        branch,
        commitSha: result.commitSha,
        changes: result.changes,
        agentsCount: agents.length,
        localeFilesCount: localeFileCount,
        message: `Pushed ${agents.length} agent${agents.length === 1 ? '' : 's'} and ${localeFileCount} locale file${localeFileCount === 1 ? '' : 's'}`,
      });
    } catch (error) {
      if (error instanceof GitCircuitBreakerError) {
        const retryAfterSec = Math.ceil(error.retryAfterMs / 1000);
        log.warn('Git push blocked by circuit breaker', {
          projectId,
          retryAfterMs: error.retryAfterMs,
        });
        return NextResponse.json(
          { error: 'Git provider temporarily unavailable', retryAfterMs: error.retryAfterMs },
          { status: 503, headers: { 'Retry-After': String(retryAfterSec) } },
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      log.error('Git push failed', { projectId, error: message, stack });
      return NextResponse.json({ error: 'Failed to push to git' }, { status: 500 });
    } finally {
      if (operationLock?.acquired) {
        await operationLock.release();
      }
    }
  },
);
