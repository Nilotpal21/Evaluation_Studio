'use client';

import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';

interface MergerNodeConfigProps {
  nodeId: string;
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
}

/**
 * MergerNodeConfig
 *
 * Renders a "Required predecessors" checklist for join/merger nodes
 * (nodes with ≥2 incoming on_success edges). Checking a predecessor
 * marks it as required — the DAG executor will fail the join node
 * (REQUIRED_PREDECESSOR_SKIPPED) if that predecessor is skipped.
 *
 * Subscribes to the canvas store for live edge/node data so the list
 * stays in sync when edges are added or removed without a re-mount.
 */
export function MergerNodeConfig({ nodeId, config, onUpdate }: MergerNodeConfigProps) {
  const edges = useWorkflowCanvasStore((s) => s.edges);
  const nodes = useWorkflowCanvasStore((s) => s.nodes);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  // For loop nodes, incoming edges target the loop_start child, not the loop
  // container itself. Collect both IDs so predecessors are found correctly.
  const incomingTargetIds = new Set([nodeId]);
  const loopStartChild = nodes.find(
    (n) => n.parentId === nodeId && n.data.nodeType === 'loop_start',
  );
  if (loopStartChild) incomingTargetIds.add(loopStartChild.id);

  const predecessorNodes = edges
    .filter((e) => incomingTargetIds.has(e.target))
    .map((e) => ({
      id: e.source,
      label: nodeById.get(e.source)?.data?.label ?? e.source,
      nodeType: nodeById.get(e.source)?.data?.nodeType,
    }))
    .filter((pred) => pred.nodeType !== 'start' && pred.nodeType !== 'loop_start')
    .filter((pred, idx, arr) => arr.findIndex((p) => p.id === pred.id) === idx);

  if (predecessorNodes.length < 2) return null;

  const requiredPredecessors = (config.requiredPredecessors as string[] | undefined) ?? [];

  const toggle = (predId: string, checked: boolean) => {
    const next = checked
      ? [...requiredPredecessors, predId]
      : requiredPredecessors.filter((id) => id !== predId);
    // Drop any ids no longer present as predecessors
    const validIds = new Set(predecessorNodes.map((p) => p.id));
    onUpdate({ ...config, requiredPredecessors: next.filter((id) => validIds.has(id)) });
  };

  return (
    <div className="px-4 pb-4" data-testid="merger-node-config">
      <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-2">
        Required predecessors
      </h4>
      <p className="text-xs text-foreground-muted mb-3">
        If a required predecessor is skipped or failed, this node will be failed and routed via its
        failure path if configured.
      </p>
      <div className="space-y-2">
        {predecessorNodes.map((pred) => {
          const isRequired = requiredPredecessors.includes(pred.id);
          return (
            <label
              key={pred.id}
              className="flex items-center gap-2 cursor-pointer"
              data-testid={`merger-predecessor-${pred.id}`}
            >
              <input
                type="checkbox"
                className="w-4 h-4 rounded border-default accent-accent"
                checked={isRequired}
                onChange={(e) => toggle(pred.id, e.target.checked)}
              />
              <span className="text-sm text-foreground">{pred.label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
