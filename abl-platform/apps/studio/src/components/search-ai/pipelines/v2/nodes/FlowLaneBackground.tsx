/**
 * FlowLaneBackground — a non-interactive background node rendered behind each flow's stages.
 * When the flow is selected, shows a highlighted accent border; otherwise transparent.
 */

import { memo } from 'react';
import { type NodeProps } from '@xyflow/react';
import { usePipelineStore } from '../../../../../store/pipeline-store';
import type { V2NodeData } from '../graph-builder';

function FlowLaneBackgroundInner({ data }: NodeProps) {
  const nodeData = data as V2NodeData;
  const flowId = (nodeData.flowId as string) ?? '';
  const selectedFlowId = usePipelineStore((s) => s.selectedFlowId);
  const isSelected = selectedFlowId === flowId;

  return (
    <div
      className={`h-full w-full rounded-xl transition-all duration-200 ${
        isSelected
          ? 'border border-accent/30 bg-accent/5'
          : 'border border-transparent bg-transparent'
      }`}
      style={{ pointerEvents: 'none' }}
    />
  );
}

export const FlowLaneBackground = memo(FlowLaneBackgroundInner);
