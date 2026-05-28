/**
 * ConnectionsTab
 *
 * Shows connection configuration for a workflow node:
 * - On Success: dropdown to select target node
 * - On Failure: toggle switch to enable/disable + simple dropdown to pick target node
 *
 * Not rendered for condition, start, or end nodes.
 */

'use client';

import { useMemo } from 'react';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';
import { Select } from '../../../ui/Select';

interface ConnectionsTabProps {
  nodeId: string;
}

export function ConnectionsTab({ nodeId }: ConnectionsTabProps) {
  const nodes = useWorkflowCanvasStore((s) => s.nodes);
  const edges = useWorkflowCanvasStore((s) => s.edges);
  const toggleOnFailure = useWorkflowCanvasStore((s) => s.toggleOnFailure);
  const updateOnFailureTarget = useWorkflowCanvasStore((s) => s.updateOnFailureTarget);
  const updateOnSuccessTarget = useWorkflowCanvasStore((s) => s.updateOnSuccessTarget);

  const currentNode = nodes.find((n) => n.id === nodeId);
  if (!currentNode) return null;

  const onFailureEnabled = Boolean(currentNode.data.config.onFailureEnabled);

  // Find the current on_success target
  const successEdge = edges.find((e) => e.source === nodeId && e.sourceHandle === 'on_success');

  // Find the current on_failure target
  const failureEdge = edges.find((e) => e.source === nodeId && e.sourceHandle === 'on_failure');

  // Build dropdown options: all nodes except self and start nodes
  const targetOptions = useMemo(() => {
    return nodes
      .filter((n) => n.id !== nodeId && n.data.nodeType !== 'start')
      .map((n) => ({ value: n.id, label: n.data.label }));
  }, [nodes, nodeId]);

  return (
    <div className="space-y-4" data-testid="connections-tab">
      {/* On Failure — toggle + dropdown */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
            On Failure
          </h4>
          <label
            className="relative inline-flex items-center cursor-pointer"
            data-testid="on-failure-toggle"
          >
            <input
              type="checkbox"
              className="sr-only peer"
              checked={onFailureEnabled}
              onChange={(e) => toggleOnFailure(nodeId, e.target.checked)}
            />
            <div className="w-9 h-5 bg-foreground-muted/30 peer-focus:ring-2 peer-focus:ring-accent/50 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:border-foreground-muted/20 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-accent" />
          </label>
        </div>

        {onFailureEnabled ? (
          <Select
            options={targetOptions}
            value={failureEdge?.target}
            onChange={(val) => updateOnFailureTarget(nodeId, val)}
            placeholder="Select node"
          />
        ) : (
          <div className="px-3 py-2 rounded-lg border border-default bg-background-subtle text-sm text-foreground-muted">
            End (with error)
          </div>
        )}
      </div>
    </div>
  );
}
