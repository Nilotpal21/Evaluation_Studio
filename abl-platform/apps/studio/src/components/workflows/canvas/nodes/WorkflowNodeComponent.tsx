'use client';

import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import { clsx } from 'clsx';
import {
  Play,
  Square,
  GitBranch,
  Repeat,
  Clock,
  MessageSquareText,
  Image,
  Mic,
  Eye,
  Globe,
  Code,
  Plug,
  Monitor,
  Search,
  FileText,
  User,
  Bot,
  Wrench,
  ClipboardEdit,
} from 'lucide-react';
import type { NodeType } from '@agent-platform/shared-kernel/types';
import { STUB_NODE_TYPES, getOutputHandles } from '@agent-platform/shared-kernel/types';
import type { WorkflowNodeData } from '../../../../store/workflow-canvas-store';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';
import { HandlePlusMenu } from './HandlePlusMenu';
import { NodeDeleteButton } from './NodeDeleteButton';
import { ConnectorLogo } from '../../../connections/ConnectorLogo';

// =============================================================================
// Types
// =============================================================================

type WorkflowNodeXYType = Node<WorkflowNodeData, 'workflow-node'>;

// =============================================================================
// Icon mapping
// =============================================================================

const NODE_ICON_MAP: Record<NodeType, React.ComponentType<{ className?: string }>> = {
  start: Play,
  end: Square,
  condition: GitBranch,
  loop: Repeat,
  loop_start: Play,
  loop_end: Play,
  delay: Clock,
  text_to_text: MessageSquareText,
  text_to_image: Image,
  audio_to_text: Mic,
  image_to_text: Eye,
  api: Globe,
  function: Code,
  integration: Plug,
  browser: Monitor,
  doc_search: Search,
  doc_intelligence: FileText,
  human: User,
  agentic_app: Bot,
  agent: Bot,
  tool: Wrench,
  data_entry: ClipboardEdit,
};

// =============================================================================
// Handle label formatting
// =============================================================================

function formatHandleLabel(handle: string): string {
  return handle.replace(/_/g, ' ');
}

function isFailureHandle(handle: string): boolean {
  return handle === 'on_failure';
}

// =============================================================================
// Component
// =============================================================================

function WorkflowNodeComponentInner({ id, data, selected }: NodeProps<WorkflowNodeXYType>) {
  const executionOverlay = useWorkflowCanvasStore((s) => s.executionOverlay);
  const edges = useWorkflowCanvasStore((s) => s.edges);
  const isInsideLoop = useWorkflowCanvasStore((s) => !!s.nodes.find((n) => n.id === id)?.parentId);
  const nodeStatus = executionOverlay?.[id];
  const Icon = NODE_ICON_MAP[data.nodeType];
  const outputHandles = data.outputHandles ?? getOutputHandles(data.nodeType, data.config);
  const integrationConnectorId =
    data.nodeType === 'integration' ? (data.config.connectorId as string | undefined) : undefined;
  const isStub = data.isStub ?? STUB_NODE_TYPES.includes(data.nodeType);
  const isSingleHandle = outputHandles.length === 1;

  // Build a set of connected handle IDs for this node
  const connectedHandles = new Set(edges.filter((e) => e.source === id).map((e) => e.sourceHandle));

  return (
    <div
      className={clsx(
        'group relative bg-background-elevated border border-default rounded-lg',
        'transition-all duration-200 ease-out animate-node-appear',
        'w-[200px]',
        selected ? 'shadow-lg ring-2 ring-accent' : 'shadow-sm hover:shadow-md',
        nodeStatus === 'running' && 'animate-pulse-ring ring-2 ring-accent',
        (nodeStatus === 'waiting_delay' ||
          nodeStatus === 'waiting_human_task' ||
          nodeStatus === 'waiting_approval' ||
          nodeStatus === 'waiting_callback') &&
          'animate-pulse ring-2 ring-warning',
        nodeStatus === 'completed' && 'animate-completion-flash ring-2 ring-success',
        nodeStatus === 'rejected' && 'ring-2 ring-error',
        nodeStatus === 'failed' && 'animate-error-shake ring-2 ring-error',
        nodeStatus === 'cancelled' && 'ring-2 ring-error',
        (nodeStatus === 'skipped' || nodeStatus === 'pending') && 'opacity-50',
      )}
      data-testid={`workflow-node-${id}`}
      data-node-type={data.nodeType}
      data-node-name={data.label}
    >
      {/* Delete button — top-right outside node, shown on hover */}
      <NodeDeleteButton nodeId={id} />

      {/* Input handle on left */}
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-foreground-subtle !border-2 !border-background-elevated !w-3 !h-3"
      />

      {isSingleHandle ? (
        /* ── Single-connection compact layout ── */
        <div className="px-3 py-3 flex items-center gap-1.5">
          {integrationConnectorId ? (
            <ConnectorLogo name={integrationConnectorId} className="w-6 h-6" />
          ) : (
            Icon && <Icon className="w-5 h-5 shrink-0 text-foreground-muted" />
          )}
          {/* Vertical divider line between icon and text */}
          <div className="w-px h-7 bg-foreground-muted/25 shrink-0" />
          <div className="flex-1 min-w-0 leading-none">
            <span
              className="text-xs font-bold text-foreground truncate block leading-none"
              title={data.label}
            >
              {data.label}
            </span>
            <span className="text-[10px] text-foreground-muted capitalize leading-none mt-1 block">
              {data.nodeType.replace(/_/g, ' ')}
            </span>
          </div>
          {isStub && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-foreground-muted/10 text-foreground-muted whitespace-nowrap">
              Coming soon
            </span>
          )}
          <HandlePlusMenu
            nodeId={id}
            handleId={outputHandles[0]}
            isFailure={false}
            isConnected={connectedHandles.has(outputHandles[0])}
            blockedTypes={isInsideLoop ? ['loop', 'start', 'end'] : undefined}
          />
        </div>
      ) : (
        /* ── Multi-connection layout — same header as compact ── */
        <>
          {/* Header: icon + divider + name/type */}
          <div className="px-3 pt-2.5 pb-2 flex items-center gap-1.5">
            {integrationConnectorId ? (
              <ConnectorLogo name={integrationConnectorId} className="w-6 h-6" />
            ) : (
              Icon && <Icon className="w-5 h-5 shrink-0 text-foreground-muted" />
            )}
            <div className="w-px h-7 bg-foreground-muted/25 shrink-0" />
            <div className="flex-1 min-w-0 leading-none">
              <span
                className="text-xs font-bold text-foreground truncate block leading-none"
                title={data.label}
              >
                {data.label}
              </span>
              <span className="text-[10px] text-foreground-muted capitalize leading-none mt-1 block">
                {data.nodeType.replace(/_/g, ' ')}
              </span>
            </div>
            {isStub && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-foreground-muted/10 text-foreground-muted whitespace-nowrap">
                Coming soon
              </span>
            )}
          </div>

          {/* Divider */}
          {outputHandles.length > 0 && <div className="mx-3 border-t border-default" />}

          {/* Output handles — right-aligned labels with colored dot ports */}
          {outputHandles.length > 0 && (
            <div className="px-3 py-1.5 flex flex-col gap-0.5">
              {outputHandles.map((handle) => (
                <div key={handle} className="flex flex-row items-center gap-1.5 h-6">
                  <span
                    className={clsx(
                      'text-[11px] leading-tight flex-1 text-right',
                      isFailureHandle(handle) ? 'text-error font-medium' : 'text-foreground-muted',
                    )}
                  >
                    {formatHandleLabel(handle)}
                  </span>
                  <HandlePlusMenu
                    nodeId={id}
                    handleId={handle}
                    isFailure={isFailureHandle(handle)}
                    isConnected={connectedHandles.has(handle)}
                    blockedTypes={isInsideLoop ? ['loop', 'start', 'end'] : undefined}
                  />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export const WorkflowNodeComponent = memo(WorkflowNodeComponentInner);
