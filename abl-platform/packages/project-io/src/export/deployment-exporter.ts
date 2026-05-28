/**
 * Deployment Exporter — converts deployment records to deployment manifest JSON
 */

export interface DeploymentRecord {
  environment: string;
  status: string;
  agentVersions: Record<string, string>;
  config: Record<string, unknown>;
  createdAt: Date;
  deployedBy: string;
}

export interface DeploymentManifest {
  environment: string;
  status: string;
  agent_versions: Record<string, string>;
  config: Record<string, unknown>;
  deployed_at: string;
  deployed_by: string;
}

/**
 * Convert deployment records to export-friendly JSON files.
 *
 * @param deployments - Array of deployment records
 * @returns Map of filename → JSON content string
 */
export function exportDeployments(deployments: DeploymentRecord[]): Map<string, string> {
  const files = new Map<string, string>();

  for (const dep of deployments) {
    const manifest: DeploymentManifest = {
      environment: dep.environment,
      status: dep.status,
      agent_versions: dep.agentVersions,
      config: dep.config,
      deployed_at: dep.createdAt.toISOString(),
      deployed_by: dep.deployedBy,
    };

    const filename = `${dep.environment}.deployment.json`;
    files.set(filename, JSON.stringify(manifest, null, 2));
  }

  return files;
}
