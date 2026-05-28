'use client';

import { memo } from 'react';
import type { NodeType, NodeCategory } from '@agent-platform/shared-kernel/types';
import {
  NODE_DISPLAY_NAMES,
  NODE_COLOR_MAP,
  STUB_NODE_TYPES,
  HIDDEN_NODE_TYPES,
} from '@agent-platform/shared-kernel/types';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';

// =============================================================================
// Palette node types (all except start)
// =============================================================================

const PALETTE_NODE_TYPES: NodeType[] = [
  'agent',
  'tool',
  'function',
  'integration',
  'browser',
  'human',
  'condition',
  'delay',
  'end',
];

// =============================================================================
// Component
// =============================================================================

function QuickAddBarInner() {
  const addNode = useWorkflowCanvasStore((s) => s.addNode);

  const visibleTypes = PALETTE_NODE_TYPES.filter((nt) => !HIDDEN_NODE_TYPES.includes(nt));

  return (
    <div
      className="flex items-center gap-1 px-3 py-2 bg-background border-t border-default overflow-x-auto"
      data-testid="quick-add-bar"
    >
      {visibleTypes.map((nodeType) => {
        const isStub = STUB_NODE_TYPES.includes(nodeType);
        return (
          <button
            key={nodeType}
            type="button"
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs whitespace-nowrap hover:bg-background-muted transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => addNode(nodeType)}
            disabled={isStub}
            data-testid={`quick-add-${nodeType}`}
            title={
              isStub
                ? `${NODE_DISPLAY_NAMES[nodeType]} (coming soon)`
                : NODE_DISPLAY_NAMES[nodeType]
            }
          >
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: NODE_COLOR_MAP[nodeType] }}
            />
            <span className="text-foreground-muted">{NODE_DISPLAY_NAMES[nodeType]}</span>
          </button>
        );
      })}
    </div>
  );
}

export const QuickAddBar = memo(QuickAddBarInner);
