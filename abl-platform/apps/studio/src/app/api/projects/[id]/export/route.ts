/**
 * GET /api/projects/:id/export?format=zip&include_deployments=true&dsl_format=source
 * GET /api/projects/:id/export?layers=core,connections,guardrails,prompts
 *
 * Export a project as a downloadable archive (JWT auth only).
 * Always uses the v2 layered orchestrator.
 */

export const maxDuration = 60; // seconds

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import {
  ProjectAgent,
  ProjectTool,
  ProjectConfigVariable,
  ConnectorConfig,
  MCPServerConfig,
  ProjectRuntimeConfig,
  ProjectLLMConfig,
  type IProjectAgent,
  type IProjectTool,
} from '@agent-platform/database/models';
import {
  buildExportProvisioningRequirements,
  extractProfileManifestEntries,
  exportProjectV2,
  resolveLayers,
  resolveLayersForToolDependencies,
  type ExportV2Deps,
} from '@agent-platform/project-io/export';
import { behaviorProfileConfigKeyToName } from '@agent-platform/project-io';
import type { ExportDslFormat, LayerName } from '@agent-platform/project-io';
import {
  buildInvalidProjectExportPayload,
  getProjectExportReadinessIssues,
} from '@/lib/project-agent-export-readiness';

/** Valid layer names for query param parsing */
const VALID_LAYERS: Set<string> = new Set([
  'core',
  'connections',
  'guardrails',
  'workflows',
  'prompts',
  'evals',
  'search',
  'channels',
  'vocabulary',
]);

/** Parse layers query param: "core,connections,guardrails" → LayerName[] */
function parseLayers(raw: string | null): LayerName[] | undefined {
  if (!raw) return undefined;
  const names = raw.split(',').filter((n) => VALID_LAYERS.has(n.trim()));
  return names.length > 0 ? (names as LayerName[]) : undefined;
}

function parseDslFormat(raw: string | null): ExportDslFormat {
  return raw === 'yaml' ? 'yaml' : 'source';
}

export const GET = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.PROJECT_EXPORT,
    rateLimit: { limit: 10, windowMs: 60_000, scope: 'tenant' },
  },
  async (ctx) => {
    const { project, tenantId, user, request } = ctx;
    const projectId = ctx.params.id;
    const format = request.nextUrl.searchParams.get('format') ?? 'zip';
    const includeDeployments = request.nextUrl.searchParams.get('include_deployments') === 'true';
    const dslFormat = parseDslFormat(request.nextUrl.searchParams.get('dsl_format'));

    // ── v2 export (always) ────────────────────────────────────────────
    {
      const requestedLayers = parseLayers(request.nextUrl.searchParams.get('layers'));

      // Query agents for manifest metadata + lockfile
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
      const layers = resolveLayersForToolDependencies(
        requestedLayers ?? resolveLayers(requestedLayers),
        tools.map((tool: IProjectTool) => ({
          name: tool.name,
          dslContent: tool.dslContent,
          toolType: tool.toolType,
        })),
      );

      // Lazy-load assemblers after resolving portable dependency layers.
      const { buildAssemblerMap } = await import('@/lib/export-assemblers');
      const assemblers = buildAssemblerMap(layers);

      const profiles = new Map<string, string>();
      for (const doc of profileDocs as Array<{ key: string; value: string }>) {
        const profileName = behaviorProfileConfigKeyToName(doc.key);
        if (profileName) {
          profiles.set(profileName, doc.value);
        }
      }
      const profileDslEntries = [...profiles.entries()].map(([name, dslContent]) => ({
        name,
        dslContent,
      }));

      const profileManifestEntries = extractProfileManifestEntries(
        profiles,
        agents.map((a: IProjectAgent) => ({
          name: a.name,
          dslContent: a.dslContent ?? '',
        })),
      );
      const provisioning = buildExportProvisioningRequirements({
        agents: agents.map((a: IProjectAgent) => ({
          name: a.name,
          dslContent: a.dslContent ?? '',
        })),
        tools: tools.map((t: IProjectTool) => ({ name: t.name, dslContent: t.dslContent })),
        profiles: profileDslEntries,
        connectorConfigs,
        mcpServers,
      });

      const result = await exportProjectV2(
        {
          projectId,
          userId: user.id,
          tenantId: tenantId ?? '',
          format: format as 'folder' | 'zip' | 'tar.gz',
          layers,
          dslFormat,
          includeDeployments,
        },
        {
          assemblers,
          agentData: agents.map((a: IProjectAgent) => ({
            name: a.name,
            version: '1.0',
            dslContent: a.dslContent ?? '',
            status: 'active',
            systemPromptLibraryRef: a.systemPromptLibraryRef ?? null,
          })),
          toolData: tools.map((t: IProjectTool) => ({
            name: t.name,
            dslContent: t.dslContent,
            toolType: t.toolType,
          })),
        } satisfies ExportV2Deps,
        {
          projectName: project!.name,
          projectSlug: project!.slug,
          projectDescription:
            ((project as Record<string, unknown>).description as string | null) ?? null,
          exportedBy: user.id,
          entryAgent:
            ((project as Record<string, unknown>).entryAgentName as string | null) ?? null,
          agents: agents.map((a: IProjectAgent) => ({
            name: a.name,
            description: a.description ?? null,
            ownerId: a.ownerId ?? null,
            ownerTeamId: a.ownerTeamId ?? null,
            version: null,
            systemPromptLibraryRef: a.systemPromptLibraryRef ?? null,
          })),
          tools: tools.map((t: IProjectTool) => ({ name: t.name, ownerId: null })),
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

      if (!result.success) {
        return NextResponse.json({ success: false, error: result.error }, { status: 400 });
      }

      const filesObj: Record<string, string> = {};
      for (const [path, content] of result.files) {
        filesObj[path] = content;
      }

      return NextResponse.json({
        success: true,
        version: 2,
        manifest: result.manifest,
        lockfile: result.lockfile,
        files: filesObj,
        warnings: result.warnings,
      });
    }
  },
);
