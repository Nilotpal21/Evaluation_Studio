/**
 * GET /api/projects/:id/import/doctor
 *
 * Run post-import validation and return a provisioning report.
 * Used by `kore doctor` CLI command.
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import {
  validatePostImport,
  type PostImportDbAdapter,
  type PostImportInput,
} from '@agent-platform/project-io/import';
import { behaviorProfileConfigKeyToName } from '@agent-platform/project-io';
import { buildExportProvisioningRequirements } from '@agent-platform/project-io/export';
import {
  EnvironmentVariable,
  ConnectorConnection,
  MCPServerConfig,
  GuardrailPolicy,
  TenantGuardrailProviderConfig,
  AuthProfile,
  ProjectAgent,
  ProjectTool,
  ProjectConfigVariable,
} from '@agent-platform/database/models';

const GLOBAL_ENVIRONMENT = 'global';
const DEFAULT_DOCTOR_ENVIRONMENT = 'dev';
const DOCTOR_ENVIRONMENTS = new Set(['dev', 'staging', 'production', GLOBAL_ENVIRONMENT]);

async function buildPostImportInput(projectId: string, tenantId: string): Promise<PostImportInput> {
  const [agents, tools, profileDocs] = await Promise.all([
    ProjectAgent.find({ projectId, tenantId }).select('name dslContent').lean(),
    ProjectTool.find({ projectId, tenantId }).select('name dslContent').lean(),
    ProjectConfigVariable.find({ projectId, tenantId, key: /^profile:/ })
      .select('key value')
      .lean(),
  ]);

  const agentEntries = (agents as Array<Record<string, unknown>>)
    .filter((agent) => typeof agent.dslContent === 'string' && agent.dslContent.length > 0)
    .map((agent) => ({
      name: typeof agent.name === 'string' ? agent.name : undefined,
      dslContent: agent.dslContent as string,
    }));
  const toolEntries = (tools as Array<Record<string, unknown>>).map((tool) => ({
    name: typeof tool.name === 'string' ? tool.name : undefined,
    dslContent: typeof tool.dslContent === 'string' ? tool.dslContent : '',
  }));
  const profileEntries = (profileDocs as Array<Record<string, unknown>>)
    .map((doc) => {
      const key = typeof doc.key === 'string' ? doc.key : '';
      const name = behaviorProfileConfigKeyToName(key);
      return name ? { name, dslContent: typeof doc.value === 'string' ? doc.value : '' } : null;
    })
    .filter((profile): profile is { name: string; dslContent: string } => profile !== null);

  const provisioning = buildExportProvisioningRequirements({
    agents: agentEntries,
    tools: toolEntries,
    profiles: profileEntries,
  });

  const coreImportedCount = agents.length + tools.length + profileEntries.length;
  const importedLayers: PostImportInput['importedLayers'] = coreImportedCount > 0 ? ['core'] : [];

  return {
    projectId,
    tenantId,
    importedLayers,
    referencedEnvVars: provisioning.requiredEnvVars,
    referencedConnectors: provisioning.requiredConnectors,
    referencedMCPServers: provisioning.requiredMcpServers,
    referencedAuthProfiles: provisioning.requiredAuthProfiles.map((profile) => profile.name),
    layerCounts: {
      ...(coreImportedCount > 0 ? { core: { imported: coreImportedCount, skipped: 0 } } : {}),
    },
  };
}

function resolveDoctorEnvironment(requestUrl: URL): string {
  const requested = requestUrl.searchParams.get('environment')?.trim();
  if (requested && DOCTOR_ENVIRONMENTS.has(requested)) {
    return requested;
  }
  return DEFAULT_DOCTOR_ENVIRONMENT;
}

function createPostImportDbAdapter(params: {
  environment: string;
  userId: string;
}): PostImportDbAdapter {
  return {
    async getProjectEnvVars(projectId, tenantId) {
      const envCandidates =
        params.environment === GLOBAL_ENVIRONMENT
          ? [params.environment]
          : [params.environment, GLOBAL_ENVIRONMENT];
      const vars = await EnvironmentVariable.find({
        projectId,
        tenantId,
        environment: { $in: envCandidates },
      })
        .select('key encryptedValue')
        .lean();
      return vars.map((v: Record<string, unknown>) => ({
        key: v.key as string,
        hasValue: !!(v.encryptedValue as string),
      }));
    },
    async getProjectConnectors(projectId, tenantId) {
      const conns = await ConnectorConnection.find({ projectId, tenantId })
        .select('displayName connectorName authProfileId status')
        .lean();
      return conns.map((c: Record<string, unknown>) => ({
        name: (c.displayName as string) || (c.connectorName as string),
        hasCredentials: c.status === 'active' && !!(c.authProfileId as string),
      }));
    },
    async getProjectMCPServers(projectId, tenantId) {
      const servers = await MCPServerConfig.find({ projectId, tenantId })
        .select('name authType encryptedAuthConfig authProfileId')
        .lean();
      return servers.map((s: Record<string, unknown>) => ({
        serverName: s.name as string,
        hasAuth:
          s.authType === 'none' ||
          !!(s.encryptedAuthConfig as string) ||
          !!(s.authProfileId as string),
      }));
    },
    async getProjectGuardrails(projectId, tenantId) {
      const policies = await GuardrailPolicy.find({
        tenantId,
        $or: [
          { 'scope.type': 'project', 'scope.projectId': projectId },
          { 'scope.type': 'agent', 'scope.projectId': projectId },
        ],
      })
        .lean()
        .select('name rules.provider providerOverrides.providerName');
      return policies.map((p: Record<string, unknown>) => ({
        name: p.name as string,
        providerNames: [
          ...new Set(
            [
              ...((p.rules as Array<Record<string, unknown>> | undefined) ?? [])
                .map((rule) => rule.provider)
                .filter((provider): provider is string => typeof provider === 'string'),
              ...((p.providerOverrides as Array<Record<string, unknown>> | undefined) ?? [])
                .map((override) => override.providerName)
                .filter((provider): provider is string => typeof provider === 'string'),
            ].sort(),
          ),
        ],
      }));
    },
    async getTenantGuardrailProviders(tenantId) {
      const providers = await TenantGuardrailProviderConfig.find({ tenantId, isActive: true })
        .select('name')
        .lean();
      return providers
        .map((provider: Record<string, unknown>) => provider.name)
        .filter((providerName: unknown): providerName is string => typeof providerName === 'string')
        .map((providerName: string) => ({ providerName }));
    },
    async getProjectAuthProfiles(projectId, tenantId) {
      const now = new Date();
      const profiles = await AuthProfile.find({
        tenantId,
        status: 'active',
        $and: [
          { $or: [{ projectId }, { projectId: null }, { projectId: { $exists: false } }] },
          {
            $or:
              params.environment === GLOBAL_ENVIRONMENT
                ? [{ environment: GLOBAL_ENVIRONMENT }]
                : [
                    { environment: params.environment },
                    { environment: null },
                    { environment: { $exists: false } },
                  ],
          },
          { $or: [{ visibility: 'personal', createdBy: params.userId }, { visibility: 'shared' }] },
          { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
        ],
      })
        .select('name authType')
        .lean();
      return profiles.map((p: Record<string, unknown>) => ({
        name: p.name as string,
        authType: p.authType as string,
      }));
    },
  };
}

export const GET = withRouteHandler(
  {
    requireProject: true,
    rateLimit: { limit: 10, windowMs: 60_000, scope: 'user' },
  },
  async (ctx) => {
    const { tenantId } = ctx;
    const projectId = ctx.params.id;
    const environment = resolveDoctorEnvironment(ctx.request.nextUrl);

    const dbAdapter = createPostImportDbAdapter({ environment, userId: ctx.user.id });
    const input = await buildPostImportInput(projectId, tenantId);

    const report = await validatePostImport(input, dbAdapter);

    return NextResponse.json({ success: true, data: report });
  },
);
