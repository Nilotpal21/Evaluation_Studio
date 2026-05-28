import type { PipelineNode, StepOutput } from './types.js';

const FALLBACK_REFERENCE_NAME = 'node';

export function normalizeNodeReferenceName(value: string | undefined): string {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!normalized) return FALLBACK_REFERENCE_NAME;
  if (/^[a-z_]/.test(normalized)) return normalized;
  return `node_${normalized}`;
}

export function getNodeReferenceName(node: Pick<PipelineNode, 'id' | 'label'>): string {
  return normalizeNodeReferenceName(node.label ?? node.id);
}

export function buildStepOutputReferences(
  nodes: Array<Pick<PipelineNode, 'id' | 'label'>>,
  stepOutputs: Record<string, StepOutput>,
): Record<string, StepOutput> {
  const references: Record<string, StepOutput> = { ...stepOutputs };
  const aliasCounts = new Map<string, number>();

  for (const node of nodes) {
    const alias = getNodeReferenceName(node);
    aliasCounts.set(alias, (aliasCounts.get(alias) ?? 0) + 1);
  }

  for (const node of nodes) {
    const output = stepOutputs[node.id];
    if (!output) continue;

    const alias = getNodeReferenceName(node);
    if (alias === node.id || aliasCounts.get(alias) !== 1 || references[alias]) continue;

    references[alias] = output;
  }

  return references;
}
