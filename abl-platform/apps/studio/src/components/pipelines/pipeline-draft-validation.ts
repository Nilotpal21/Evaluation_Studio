import type { Edge, Node } from '@xyflow/react';
import { normalizeNodeReferenceName } from '@agent-platform/pipeline-engine/node-references';
import { extractExpressionRefs } from '../../lib/pipeline-expression-utils';
import type { ValidationIssue, ValidationResult } from '../../store/pipeline-editor-store';
import { TRIGGER_NODE_ID } from './pipeline-trigger-constants';
import { getAvailableDataNodes } from './available-data';

function getNodeLabel(node: Node): string {
  const data = node.data as Record<string, unknown> | undefined;
  return typeof data?.label === 'string' ? data.label : '';
}

function collectStringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStringValues);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(collectStringValues);
  }
  return [];
}

export function validatePipelineDraft(nodes: Node[], edges: Edge[]): ValidationResult {
  const issues: ValidationIssue[] = [];
  const realNodes = nodes.filter((node) => node.id !== TRIGGER_NODE_ID);
  const topLevelNodes = realNodes.filter((node) => !node.parentId);

  if (topLevelNodes.length === 0) {
    issues.push({ message: 'Pipeline has no nodes', severity: 'error' });
  }

  const referenceOwners = new Map<string, Node[]>();

  for (const node of realNodes) {
    const label = getNodeLabel(node);
    if (!label.trim()) {
      issues.push({
        nodeId: node.id,
        field: 'label',
        message: 'Node is missing a name',
        severity: 'error',
      });
      continue;
    }

    const referenceName = normalizeNodeReferenceName(label);
    const owners = referenceOwners.get(referenceName) ?? [];
    owners.push(node);
    referenceOwners.set(referenceName, owners);
  }

  for (const [referenceName, owners] of referenceOwners.entries()) {
    if (owners.length <= 1) continue;
    for (const owner of owners) {
      issues.push({
        nodeId: owner.id,
        field: 'label',
        message: `Node name creates duplicate reference "steps.${referenceName}". Rename one of these nodes.`,
        severity: 'error',
      });
    }
  }

  // ── Connectivity checks ──
  // A real node is "disconnected" if it has no incoming AND no outgoing edges.
  // Previously this was guarded by `topLevelNodes.length > 1`, which let a
  // single orphan node pass validation. Removed the guard and upgraded to error
  // since a pipeline with disconnected nodes cannot execute.
  for (const node of topLevelNodes) {
    const outgoing = edges.filter((edge) => edge.source === node.id);
    const incoming = edges.filter((edge) => edge.target === node.id);
    if (outgoing.length === 0 && incoming.length === 0) {
      issues.push({
        nodeId: node.id,
        message: `Node "${getNodeLabel(node) || node.id}" is disconnected`,
        severity: 'error',
      });
    }
  }

  // The pipeline must have at least one node connected to the trigger
  // (an "entry" node). Without it, the trigger fires into an empty graph.
  if (topLevelNodes.length > 0) {
    const hasTriggerEdge = edges.some(
      (edge) => edge.source === TRIGGER_NODE_ID && topLevelNodes.some((n) => n.id === edge.target),
    );
    if (!hasTriggerEdge) {
      issues.push({
        message:
          'Pipeline has no entry node — connect the trigger to a node so the pipeline can run.',
        severity: 'error',
      });
    }
  }

  for (const node of realNodes) {
    const data = node.data as Record<string, unknown> | undefined;
    const config = data?.config as Record<string, unknown> | undefined;
    if (!config) continue;

    const availableNodes = getAvailableDataNodes(nodes, edges, node.id);
    const availableRefs = new Set(
      availableNodes.flatMap((source) => [source.id, source.referenceName]),
    );

    for (const text of collectStringValues(config)) {
      for (const ref of extractExpressionRefs(text)) {
        if (!availableRefs.has(ref.nodeId)) {
          issues.push({
            nodeId: node.id,
            field: 'config',
            message: `Reference "${ref.nodeId}" is not a direct upstream node name for "${getNodeLabel(node) || node.id}".`,
            severity: 'error',
          });
          continue;
        }

        const source = availableNodes.find(
          (candidate) => candidate.id === ref.nodeId || candidate.referenceName === ref.nodeId,
        );
        const fieldNames = new Set(source?.fields.map((field) => field.fieldPath) ?? []);
        if (source && fieldNames.size > 0 && !fieldNames.has(ref.field)) {
          issues.push({
            nodeId: node.id,
            field: 'config',
            message: `Field "${ref.field}" is not declared by "${source.label}".`,
            severity: 'warning',
          });
        }
      }
    }
  }

  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues,
  };
}
