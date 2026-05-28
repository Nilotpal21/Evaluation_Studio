import type { Edge, Node } from '@xyflow/react';
import { ContractRegistry } from '@agent-platform/pipeline-engine/contracts';
import { getNodeReferenceName } from '@agent-platform/pipeline-engine/node-references';
import type { PipelineNodeData } from './PipelineNodeComponent';
import { TRIGGER_NODE_ID } from './pipeline-trigger-constants';

const contractRegistry = new ContractRegistry();

export interface AvailableDataField {
  path: string;
  fieldPath: string;
  type: string;
  description?: string;
}

export interface AvailableDataNode {
  id: string;
  referenceName: string;
  label: string;
  activityType: string;
  fields: AvailableDataField[];
}

function getActivityType(node: Node): string | null {
  const data = node.data as Partial<PipelineNodeData> | undefined;
  return data?.activityType ?? null;
}

function getNodeLabel(node: Node): string {
  const data = node.data as Partial<PipelineNodeData> | undefined;
  return typeof data?.label === 'string' && data.label.trim() ? data.label : node.id;
}

function collectDirectUpstreamIds(edges: Edge[], currentNodeId: string): Set<string> {
  const upstream = new Set<string>();
  for (const edge of edges) {
    if (edge.source === TRIGGER_NODE_ID) continue;
    if (edge.target === currentNodeId) {
      upstream.add(edge.source);
    }
  }
  return upstream;
}

export function getAvailableDataNodes(
  nodes: Node[],
  edges: Edge[],
  currentNodeId: string,
): AvailableDataNode[] {
  const upstreamIds = collectDirectUpstreamIds(edges, currentNodeId);
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const availableNodes: AvailableDataNode[] = [];

  for (const nodeId of upstreamIds) {
    const node = byId.get(nodeId);
    if (!node) continue;

    const activityType = getActivityType(node);
    if (!activityType) continue;

    const contract = contractRegistry.getNode(activityType);
    const referenceName = getNodeReferenceName({ id: node.id, label: getNodeLabel(node) });
    const fields: AvailableDataField[] = Object.entries(
      contract?.outputSchema.properties ?? {},
    ).map(([fieldPath, meta]) => ({
      path: `{{steps.${referenceName}.output.${fieldPath}}}`,
      fieldPath,
      type: meta.type,
      description: meta.description,
    }));

    availableNodes.push({
      id: node.id,
      referenceName,
      label: getNodeLabel(node),
      activityType,
      fields,
    });
  }

  return availableNodes.sort((a, b) => a.label.localeCompare(b.label));
}
