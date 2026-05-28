/**
 * PipelineNodeComponent
 *
 * Custom React Flow node for the pipeline graph editor.
 * Shows a card with label, category badge, activity type,
 * error indicator, and source/target handles.
 *
 * Pattern: follows AgentNode.tsx from the canvas components.
 */

'use client';

import { memo, useCallback, type CSSProperties } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import type { NodeCategory } from '@agent-platform/pipeline-engine';
import { getBadgeIntentStyles } from '@agent-platform/design-tokens';
import type { SemanticIntent } from '@agent-platform/design-tokens';
import { usePipelineEditorStore } from '../../store/pipeline-editor-store';

// =============================================================================
// Types
// =============================================================================

export interface PipelineNodeData extends Record<string, unknown> {
  label: string;
  activityType: string;
  category: NodeCategory;
  hasError?: boolean;
  errorCount?: number;
  config?: Record<string, unknown>;
  timeout?: number;
  retries?: number;
  onFailure?: 'stop' | 'skip' | 'continue';
}

type PipelineNodeType = Node<PipelineNodeData, 'pipeline-node'>;

// =============================================================================
// Constants
// =============================================================================

const CATEGORY_INTENT: Record<NodeCategory, SemanticIntent> = {
  data: 'info',
  logic: 'info',
  integration: 'success',
  compute: 'orange',
  action: 'error',
};

/** Left-border accent color per category intent */
const CATEGORY_LEFT_BORDER: Record<NodeCategory, string> = {
  data: 'border-l-info',
  logic: 'border-l-info',
  integration: 'border-l-success',
  compute: 'border-l-orange',
  action: 'border-l-error',
};

function getCategoryStyles(category: NodeCategory) {
  const intent = CATEGORY_INTENT[category];
  const badge = getBadgeIntentStyles(intent);
  return {
    badge: badge.badge,
    accent: CATEGORY_LEFT_BORDER[category],
  };
}

const CATEGORY_LABELS: Record<NodeCategory, string> = {
  data: 'Data',
  logic: 'Logic',
  integration: 'Integration',
  compute: 'Compute',
  action: 'Action',
};

export const PIPELINE_NODE_WIDTH = 220;
export const PIPELINE_NODE_HEIGHT = 100;

// =============================================================================
// Component
// =============================================================================

function PipelineNodeComponent({ id, data, selected }: NodeProps<PipelineNodeType>) {
  const removeNode = usePipelineEditorStore((s) => s.removeNode);
  const category = data.category ?? 'compute';
  const styles = getCategoryStyles(category);
  const containerStyle: CSSProperties = {
    width: PIPELINE_NODE_WIDTH,
    height: PIPELINE_NODE_HEIGHT,
  };

  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      removeNode(id);
    },
    [id, removeNode],
  );

  return (
    <div
      className={clsx(
        'group/node bg-background-elevated border shadow-sm rounded-lg flex flex-col overflow-hidden',
        'transition-shadow duration-200 ease-out',
        'hover:shadow-md',
        'border-l-[3px]',
        styles.accent,
        data.hasError && !selected && 'border-error/60',
        !data.hasError && !selected && 'border-default',
        selected && 'ring-2 ring-accent border-accent',
      )}
      style={containerStyle}
      role="button"
      aria-label={`Pipeline node: ${data.label}`}
    >
      {/* Target handle (top) */}
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-foreground-subtle !border-2 !border-background-elevated !w-2.5 !h-2.5"
      />

      {/* Header: label + delete */}
      <div className="px-3 pt-2.5 pb-1.5 border-b border-default/40 flex items-center gap-1">
        <span className="text-sm font-semibold text-foreground truncate flex-1" title={data.label}>
          {data.label}
        </span>
        <button
          type="button"
          className="p-0.5 rounded text-foreground-muted hover:text-error hover:bg-error-subtle opacity-0 group-hover/node:opacity-100 transition-all shrink-0"
          onClick={handleRemove}
          title="Remove node"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Body: type info + error */}
      <div className="px-3 py-2 flex-1 flex flex-col gap-1 min-h-0">
        <span className="text-xs text-foreground-muted truncate" title={data.activityType}>
          {data.activityType}
        </span>

        {/* Error indicator */}
        {data.hasError && (
          <div className="flex items-center gap-1 text-xs text-error font-medium">
            <AlertTriangle className="w-3 h-3" />
            {data.errorCount ?? 1} error{(data.errorCount ?? 1) !== 1 ? 's' : ''}
          </div>
        )}
      </div>

      {/* Source handle (bottom) */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-foreground-subtle !border-2 !border-background-elevated !w-2.5 !h-2.5"
      />
    </div>
  );
}

export const PipelineNode = memo(PipelineNodeComponent);
