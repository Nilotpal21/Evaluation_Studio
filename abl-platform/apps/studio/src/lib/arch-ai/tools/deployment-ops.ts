import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, isDangerousAction, type ToolPermissionContext } from '../guards';

const log = createLogger('arch-ai:deployment-ops');

interface DeploymentOpsInput {
  action: 'list' | 'deploy' | 'promote' | 'configure_channel' | 'list_channels';
  deploymentId?: string;
  environment?: string;
  channelType?: string;
  channelConfig?: Record<string, unknown>;
  confirmed?: boolean;
}

interface DeploymentOpsResult {
  success?: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  needsConfirmation?: boolean;
  warning?: string;
}

export async function executeDeploymentOps(
  input: DeploymentOpsInput,
  ctx: ToolPermissionContext,
): Promise<DeploymentOpsResult> {
  const { action } = input;

  const perm = await checkToolPermission('deployment_ops', action, ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  if (['deploy', 'promote'].includes(action) && !input.confirmed) {
    return {
      needsConfirmation: true,
      warning: `Deploy to ${input.environment ?? 'target environment'}?`,
    };
  }

  if (action === 'configure_channel' && !input.confirmed) {
    return {
      needsConfirmation: true,
      warning: `Configure ${input.channelType ?? 'channel'} will mutate production routing. Confirm to proceed.`,
    };
  }

  const { projectId, user } = ctx;
  const tenantId = user.tenantId;

  switch (action) {
    case 'list':
      return listDeployments(projectId, tenantId);
    case 'deploy':
      if (!input.environment) {
        return {
          success: false,
          error: { code: 'MISSING_PARAM', message: 'environment is required' },
        };
      }
      return deploy(projectId, input.environment, tenantId);
    case 'promote':
      if (!input.deploymentId || !input.environment) {
        return {
          success: false,
          error: { code: 'MISSING_PARAM', message: 'deploymentId and environment are required' },
        };
      }
      return promote(projectId, input.deploymentId, input.environment, tenantId);
    case 'list_channels':
      return listChannels(projectId, tenantId, ctx.authToken);
    case 'configure_channel':
      if (!input.channelType || !input.channelConfig) {
        return {
          success: false,
          error: { code: 'MISSING_PARAM', message: 'channelType and channelConfig are required' },
        };
      }
      return configureChannel(
        projectId,
        input.channelType,
        input.channelConfig,
        tenantId,
        ctx.authToken,
      );
    default:
      return {
        success: false,
        error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
      };
  }
}

async function listDeployments(projectId: string, tenantId: string): Promise<DeploymentOpsResult> {
  try {
    const { fetchDeployments } = await import('@/api/deployments');
    const result = await fetchDeployments(projectId);
    return { success: true, data: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('List deployments failed', { projectId, error: message });
    return { success: false, error: { code: 'FETCH_ERROR', message } };
  }
}

async function deploy(
  projectId: string,
  environment: string,
  tenantId: string,
): Promise<DeploymentOpsResult> {
  try {
    const { getProjectAgents } = await import('@/services/project-service');
    const agents = await getProjectAgents(projectId, tenantId);

    if (agents.length === 0) {
      return {
        success: false,
        error: { code: 'NO_AGENTS', message: 'Project has no agents to deploy' },
      };
    }

    const agentVersionManifest: Record<string, string> = {};
    for (const a of agents) {
      const agent = a as Record<string, unknown>;
      agentVersionManifest[agent.name as string] = (agent.version as string) ?? 'latest';
    }

    const entryAgent = agents[0] as Record<string, unknown>;
    const { createDeployment } = await import('@/api/deployments');
    const result = await createDeployment(projectId, {
      environment,
      agentVersionManifest,
      entryAgentName: entryAgent.name as string,
    });
    log.info('Deployment created', { projectId, environment });
    return { success: true, data: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Deploy failed', { projectId, environment, error: message });
    return { success: false, error: { code: 'DEPLOY_ERROR', message } };
  }
}

async function promote(
  projectId: string,
  deploymentId: string,
  environment: string,
  tenantId: string,
): Promise<DeploymentOpsResult> {
  try {
    const { promoteDeployment } = await import('@/api/deployments');
    const result = await promoteDeployment(projectId, deploymentId, {
      targetEnvironment: environment as 'dev' | 'staging' | 'production',
    });
    log.info('Deployment promoted', { projectId, deploymentId, environment });
    return { success: true, data: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Promote failed', { projectId, deploymentId, error: message });
    return { success: false, error: { code: 'PROMOTE_ERROR', message } };
  }
}

async function listChannels(
  projectId: string,
  tenantId: string,
  authToken?: string,
): Promise<DeploymentOpsResult> {
  try {
    const { getRuntimeUrl } = await import('@/config/runtime.server');
    const url = `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/sdk-channels`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Tenant-Id': tenantId,
    };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const response = await fetch(url, { headers });
    const result = await response.json();
    if (!response.ok) {
      const message = result?.error?.message || `Runtime returned ${response.status}`;
      return { success: false, error: { code: 'FETCH_ERROR', message } };
    }
    return { success: true, data: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: { code: 'FETCH_ERROR', message } };
  }
}

async function configureChannel(
  projectId: string,
  channelType: string,
  channelConfig: Record<string, unknown>,
  tenantId: string,
  authToken?: string,
): Promise<DeploymentOpsResult> {
  try {
    const { getRuntimeUrl } = await import('@/config/runtime.server');
    const url = `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/sdk-channels`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Tenant-Id': tenantId,
    };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: (channelConfig.name as string) ?? channelType,
        channelType,
        publicApiKeyId: (channelConfig.publicApiKeyId as string) ?? '',
        config: channelConfig,
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      const message = result?.error?.message || `Runtime returned ${response.status}`;
      return { success: false, error: { code: 'CHANNEL_ERROR', message } };
    }
    log.info('Channel configured', { projectId, channelType });
    return { success: true, data: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: { code: 'CHANNEL_ERROR', message } };
  }
}
