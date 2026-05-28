/**
 * Deployment Repository
 *
 * MongoDB deployment lifecycle operations.
 * Used by: routes/deployments.ts, routes/sdk-init.ts, services/deployment-resolver.ts
 */

// ─── Find ─────────────────────────────────────────────────────────────────

export async function findActiveDeployment(
  projectId: string,
  tenantId: string,
  environment?: string,
): Promise<any | null> {
  const { Deployment } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { projectId, tenantId, status: 'active' };
  if (environment) filter.environment = environment;
  const doc = await Deployment.findOne(filter).sort({ createdAt: -1 }).lean();
  return doc ? parseDeploymentJson(doc) : null;
}

export async function findDeploymentById(
  deploymentId: string,
  projectId: string,
  tenantId: string,
): Promise<any | null> {
  const { Deployment } = await import('@agent-platform/database/models');
  const doc = await Deployment.findOne({ _id: deploymentId, projectId, tenantId }).lean();
  return doc ? parseDeploymentJson(doc) : null;
}

export async function findDeploymentBySlug(endpointSlug: string): Promise<any | null> {
  const { Deployment } = await import('@agent-platform/database/models');
  const doc = await Deployment.findOne({ endpointSlug }).lean();
  return doc ? parseDeploymentJson(doc) : null;
}

// ─── List ─────────────────────────────────────────────────────────────────

export async function listDeployments(
  projectId: string,
  tenantId: string,
  filters?: { environment?: string; status?: string },
): Promise<any[]> {
  const { Deployment } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { projectId, tenantId };
  if (filters?.environment) filter.environment = filters.environment;
  if (filters?.status) filter.status = filters.status;
  const docs = await Deployment.find(filter).select('-voiceConfig').sort({ createdAt: -1 }).lean();
  return docs.map(parseDeploymentJson);
}

// ─── Create / Update ──────────────────────────────────────────────────────

export async function createDeployment(data: {
  projectId: string;
  tenantId: string;
  environment: string;
  label?: string;
  description?: string;
  agentVersionManifest: Record<string, string>;
  workflowVersionManifest?: Record<string, string>;
  entryAgentName: string;
  endpointSlug: string;
  compilationHash?: string | null;
  previousDeploymentId?: string | null;
  promotedFromDeploymentId?: string | null;
  createdBy: string;
  modelOverrides?: Record<string, unknown> | null;
  settingsVersionId?: string | null;
}): Promise<any> {
  const { Deployment } = await import('@agent-platform/database/models');
  const doc = await Deployment.create({
    projectId: data.projectId,
    tenantId: data.tenantId,
    environment: data.environment,
    label: data.label || null,
    description: data.description || null,
    agentVersionManifest: data.agentVersionManifest,
    workflowVersionManifest: data.workflowVersionManifest ?? {},
    entryAgentName: data.entryAgentName,
    endpointSlug: data.endpointSlug,
    compilationHash: data.compilationHash ?? null,
    status: 'active',
    previousDeploymentId: data.previousDeploymentId || null,
    promotedFromDeploymentId: data.promotedFromDeploymentId || null,
    createdBy: data.createdBy,
    modelOverrides: data.modelOverrides ?? null,
    settingsVersionId: data.settingsVersionId ?? null,
  });
  return parseDeploymentJson(doc.toObject());
}

export async function updateDeploymentStatus(
  deploymentId: string,
  tenantId: string,
  data: { status: string; drainingStartedAt?: Date; retiredAt?: Date | null },
): Promise<any> {
  const { Deployment } = await import('@agent-platform/database/models');
  const doc = await Deployment.findOneAndUpdate(
    { _id: deploymentId, tenantId },
    { $set: data },
    { new: true },
  ).lean();
  return doc ? parseDeploymentJson(doc) : null;
}

/**
 * Atomically retire the current active deployment for a project+environment.
 * Returns the retired deployment (pre-update) or null if none was active.
 */
export async function retirePreviousActiveDeployment(
  projectId: string,
  tenantId: string,
  environment: string,
): Promise<Record<string, unknown> | null> {
  const { Deployment } = await import('@agent-platform/database/models');
  const doc = await Deployment.findOneAndUpdate(
    { projectId, tenantId, environment, status: 'active' },
    { $set: { status: 'retired', retiredAt: new Date() } },
    { new: false },
  ).lean();
  return doc ? parseDeploymentJson(doc) : null;
}

// ─── Channel Count ────────────────────────────────────────────────────────

export async function countLinkedChannels(deploymentId: string, tenantId: string): Promise<number> {
  const { SDKChannel } = await import('@agent-platform/database/models');
  return SDKChannel.countDocuments({ deploymentId, tenantId });
}

// ─── Variable Snapshot ───────────────────────────────────────────────────

/**
 * Find a deployment's variable snapshot by deploymentId + tenantId + projectId.
 * Call sites: deployments.ts:1155, 1239, 1367, 1368.
 * Filter: { deploymentId, tenantId, projectId }
 */
export async function findDeploymentVariableSnapshot(
  deploymentId: string,
  tenantId: string,
  projectId: string,
): Promise<any | null> {
  const { DeploymentVariableSnapshot } = await import('@agent-platform/database/models');
  return DeploymentVariableSnapshot.findOne({ deploymentId, tenantId, projectId }).lean();
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function parseDeploymentJson(d: any): any {
  if (!d) return d;
  const result = { ...d };
  // Normalize id
  if (result._id && !result.id) result.id = result._id;
  // Parse JSON fields stored as strings
  if (typeof result.agentVersionManifest === 'string') {
    result.agentVersionManifest = JSON.parse(result.agentVersionManifest);
  }
  if (typeof result.modelOverrides === 'string') {
    result.modelOverrides = JSON.parse(result.modelOverrides);
  }
  if (typeof result.workflowVersionManifest === 'string') {
    result.workflowVersionManifest = JSON.parse(result.workflowVersionManifest);
  }
  return result;
}
