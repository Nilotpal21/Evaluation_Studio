/**
 * FlowLaneHeader — a non-interactive label node positioned above each flow's stage lane.
 * Shows flow name + priority badge. Clicking selects the flow for detail panel.
 */

import { memo, useCallback } from 'react';
import { type NodeProps } from '@xyflow/react';
import { usePipelineStore } from '../../../../../store/pipeline-store';
import type { V2NodeData } from '../graph-builder';

function FlowLaneHeaderInner({ data }: NodeProps) {
  const nodeData = data as V2NodeData;
  const flowName = (nodeData.flowName as string) ?? 'Flow';
  const flowPriority = (nodeData.flowPriority as number) ?? 0;
  const flowId = (nodeData.flowId as string) ?? '';
  const selectedFlowId = usePipelineStore((s) => s.selectedFlowId);
  const expandStage = usePipelineStore((s) => s.expandStage);
  const selectFlow = usePipelineStore((s) => s.selectFlow);

  const isSelected = selectedFlowId === flowId;

  const handleClick = useCallback(() => {
    // Clear any stage selection, select this flow
    expandStage(null);
    selectFlow(flowId);
  }, [expandStage, selectFlow, flowId]);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      className={`cursor-pointer select-none rounded px-3 py-1 text-xs font-medium transition-colors ${
        isSelected
          ? 'bg-accent/10 text-accent'
          : 'text-foreground-muted hover:text-foreground hover:bg-background-muted'
      }`}
    >
      <span>{flowName}</span>
      {flowPriority > 0 && (
        <span className="ml-2 rounded-full bg-background-muted px-1.5 py-0.5 text-[10px] text-foreground-muted">
          P:{flowPriority}
        </span>
      )}
    </div>
  );
}

export const FlowLaneHeader = memo(FlowLaneHeaderInner);
