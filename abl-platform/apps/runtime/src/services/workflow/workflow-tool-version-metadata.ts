import type { ToolDefinition } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('workflow-tool-version-metadata');

export interface WorkflowToolVersionMetadata {
  workflowId: string;
  workflowVersionId?: string;
  workflowVersion?: string;
}

export async function resolveWorkflowToolVersionMetadata(params: {
  tenantId: string;
  projectId: string;
  tools: ToolDefinition[];
  workflowVersionManifest?: Record<string, string>;
}): Promise<Record<string, WorkflowToolVersionMetadata>> {
  const resolved: Record<string, WorkflowToolVersionMetadata> = {};
  const manifest = params.workflowVersionManifest ?? {};
  const unresolvedWorkflowIds = new Set<string>();
  const toolsByWorkflowId = new Map<string, ToolDefinition[]>();

  for (const tool of params.tools) {
    const binding = tool.workflow_binding;
    if (!binding) {
      continue;
    }

    if (binding.workflowVersionId || binding.workflowVersion) {
      resolved[tool.name] = {
        workflowId: binding.workflowId,
        ...(binding.workflowVersionId ? { workflowVersionId: binding.workflowVersionId } : {}),
        ...(binding.workflowVersion ? { workflowVersion: binding.workflowVersion } : {}),
      };
      continue;
    }

    unresolvedWorkflowIds.add(binding.workflowId);
    const bucket = toolsByWorkflowId.get(binding.workflowId) ?? [];
    bucket.push(tool);
    toolsByWorkflowId.set(binding.workflowId, bucket);
  }

  if (unresolvedWorkflowIds.size === 0 || Object.keys(manifest).length === 0) {
    return resolved;
  }

  const { Workflow } = await import('@agent-platform/database/models');
  const workflows = await Workflow.find({
    _id: { $in: [...unresolvedWorkflowIds] },
    tenantId: params.tenantId,
    projectId: params.projectId,
  })
    .select('_id name')
    .lean();

  for (const workflow of workflows as Array<{ _id: string; name?: string }>) {
    const workflowName = typeof workflow.name === 'string' ? workflow.name : undefined;
    if (!workflowName) {
      continue;
    }

    const pinnedVersion = manifest[workflowName];
    if (!pinnedVersion) {
      continue;
    }

    for (const tool of toolsByWorkflowId.get(String(workflow._id)) ?? []) {
      resolved[tool.name] = {
        workflowId: tool.workflow_binding!.workflowId,
        workflowVersion: pinnedVersion,
      };
    }
  }

  for (const workflowId of unresolvedWorkflowIds) {
    const hasResolvedVersion = (toolsByWorkflowId.get(workflowId) ?? []).some(
      (tool) => resolved[tool.name]?.workflowVersion,
    );
    if (!hasResolvedVersion) {
      log.warn('No deployment workflow version pin resolved for workflow tool', {
        workflowId,
        tenantId: params.tenantId,
        projectId: params.projectId,
      });
    }
  }

  return resolved;
}
