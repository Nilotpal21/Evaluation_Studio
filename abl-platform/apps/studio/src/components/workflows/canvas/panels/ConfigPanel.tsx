/**
 * ConfigPanel
 *
 * Shows the selected node's config editor based on node type.
 * Has two tabs: Configuration and Connections.
 * Connections tab is hidden for condition, start, and end nodes.
 */

'use client';

import { useCallback, useMemo } from 'react';
import {
  X,
  Flag,
  StopCircle,
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
  LogOut,
} from 'lucide-react';
import type { NodeType } from '@agent-platform/shared-kernel/types';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';
import { useNavigationStore } from '../../../../store/navigation-store';
import { useWorkflowExpressionContext } from '../hooks/useWorkflowExpressionContext';
import { NodeExpressionContext } from '../config/NodeExpressionContext';
import { testTriggerSample } from '../../../../api/workflows';

const NODE_ICON_MAP: Record<NodeType, React.ComponentType<{ className?: string }>> = {
  start: Flag,
  end: StopCircle,
  condition: GitBranch,
  loop: Repeat,
  loop_start: Flag,
  loop_end: LogOut,
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
import { StartNodeConfig } from '../config/StartNodeConfig';
import { EndNodeConfig } from '../config/EndNodeConfig';
import { TextToTextNodeConfig } from '../config/TextToTextNodeConfig';
import { ApiNodeConfig } from '../config/ApiNodeConfig';
import { FunctionNodeConfig } from '../config/FunctionNodeConfig';
import { ConditionNodeConfig } from '../config/ConditionNodeConfig';
import { HumanNodeConfig } from '../config/HumanNodeConfig';
import { DataEntryNodeConfig } from '../config/DataEntryNodeConfig';
import { LoopNodeConfig } from '../config/LoopNodeConfig';
import { GenericNodeConfig } from '../config/GenericNodeConfig';
// import { MergerNodeConfig } from '../config/MergerNodeConfig';
import { Select } from '../../../ui/Select';

// loop manages its own on_failure handle via getOutputHandles — exclude from the generic toggle
const NODES_WITHOUT_ON_FAILURE = ['condition', 'start', 'end', 'loop'];

function renderConfig(
  nodeType: string,
  nodeId: string,
  config: Record<string, unknown>,
  onUpdate: (config: Record<string, unknown>) => void,
) {
  switch (nodeType) {
    case 'start':
      return <StartNodeConfig nodeId={nodeId} config={config} onUpdate={onUpdate} />;
    case 'end':
      return <EndNodeConfig nodeId={nodeId} config={config} onUpdate={onUpdate} />;
    case 'text_to_text':
      return <TextToTextNodeConfig nodeId={nodeId} config={config} onUpdate={onUpdate} />;
    case 'api':
      return <ApiNodeConfig nodeId={nodeId} config={config} onUpdate={onUpdate} />;
    case 'function':
      return <FunctionNodeConfig nodeId={nodeId} config={config} onUpdate={onUpdate} />;
    case 'condition':
      return <ConditionNodeConfig nodeId={nodeId} config={config} onUpdate={onUpdate} />;
    case 'human':
      return <HumanNodeConfig nodeId={nodeId} config={config} onUpdate={onUpdate} />;
    case 'data_entry':
      return <DataEntryNodeConfig nodeId={nodeId} config={config} onUpdate={onUpdate} />;
    case 'loop':
      return <LoopNodeConfig nodeId={nodeId} config={config} onUpdate={onUpdate} />;
    default:
      return (
        <GenericNodeConfig
          nodeType={nodeType}
          nodeId={nodeId}
          config={config}
          onUpdate={onUpdate}
        />
      );
  }
}

export function ConfigPanel() {
  const selectedNodeId = useWorkflowCanvasStore((s) => s.selectedNodeId);
  const nodes = useWorkflowCanvasStore((s) => s.nodes);
  const edges = useWorkflowCanvasStore((s) => s.edges);
  const setConfigPanelOpen = useWorkflowCanvasStore((s) => s.setConfigPanelOpen);
  const selectNode = useWorkflowCanvasStore((s) => s.selectNode);
  const updateNodeName = useWorkflowCanvasStore((s) => s.updateNodeName);
  const updateNodeConfig = useWorkflowCanvasStore((s) => s.updateNodeConfig);
  const toggleOnFailure = useWorkflowCanvasStore((s) => s.toggleOnFailure);
  const updateOnFailureTarget = useWorkflowCanvasStore((s) => s.updateOnFailureTarget);

  const projectId = useNavigationStore((s) => s.projectId);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const { triggers, previousSteps, refreshTrigger, executionContext } =
    useWorkflowExpressionContext(selectedNodeId ?? '');

  const onTestTrigger = useCallback(
    async (triggerId: string) => {
      if (!projectId) return;
      const result = await testTriggerSample(projectId, triggerId);
      if (result.itemCount === 0) {
        throw new Error('No data returned — check your connection or try again');
      }
      refreshTrigger(triggerId, result.sample);
    },
    [projectId, refreshTrigger],
  );

  const handleConfigUpdate = useCallback(
    (config: Record<string, unknown>) => {
      if (selectedNodeId) {
        updateNodeConfig(selectedNodeId, config);
      }
    },
    [selectedNodeId, updateNodeConfig],
  );

  if (!selectedNode) return null;

  const nodeData = selectedNode.data;
  const showOnFailure = !NODES_WITHOUT_ON_FAILURE.includes(nodeData.nodeType);
  const onFailureEnabled = Boolean(nodeData.config.onFailureEnabled);
  const failureEdge = edges.find(
    (e) => e.source === selectedNodeId && e.sourceHandle === 'on_failure',
  );
  const failureTargetOptions = useMemo(() => {
    const parentId = selectedNode?.parentId;
    return nodes
      .filter((n) => {
        if (n.id === selectedNodeId) return false;
        if (n.data.nodeType === 'start' || n.data.nodeType === 'loop_start') return false;
        // Body node: only show siblings inside the same loop container
        if (parentId) return n.parentId === parentId;
        // Outer node: exclude nodes that live inside a loop body
        return !n.parentId;
      })
      .map((n) => ({ value: n.id, label: n.data.label }));
  }, [nodes, selectedNodeId, selectedNode?.parentId]);

  return (
    <NodeExpressionContext.Provider
      value={{ triggers, previousSteps, refreshTrigger, onTestTrigger, executionContext }}
    >
      <div
        className="w-[380px] border-l border-default bg-background-elevated overflow-y-auto"
        data-testid="config-panel"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-default">
          <div className="flex items-center gap-2">
            {(() => {
              const Icon = NODE_ICON_MAP[nodeData.nodeType as NodeType];
              if (!Icon) return null;
              const tint =
                nodeData.nodeType === 'start'
                  ? 'text-success'
                  : nodeData.nodeType === 'end'
                    ? 'text-error'
                    : 'text-foreground-muted';
              return <Icon className={`w-4 h-4 shrink-0 ${tint}`} />;
            })()}
            <input
              className="font-semibold text-sm bg-transparent border-none outline-none focus:ring-1 focus:ring-blue-500 rounded px-1"
              value={nodeData.label}
              onChange={(e) => updateNodeName(selectedNodeId!, e.target.value)}
              data-testid="config-panel-name-input"
            />
          </div>
          <button
            onClick={() => {
              setConfigPanelOpen(false);
              selectNode(null);
            }}
            className="p-1 hover:bg-muted rounded"
            data-testid="config-panel-close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Configuration */}
        <div className="p-4">
          {renderConfig(nodeData.nodeType, selectedNodeId!, nodeData.config, handleConfigUpdate)}
        </div>

        {/* On Failure */}
        {showOnFailure && (
          <div className="px-4 pb-4">
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
                  onChange={(e) => toggleOnFailure(selectedNodeId!, e.target.checked)}
                />
                <div className="w-9 h-5 bg-foreground-muted/30 peer-focus:ring-2 peer-focus:ring-accent/50 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:border-foreground-muted/20 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-accent" />
              </label>
            </div>
            {onFailureEnabled ? (
              <Select
                options={failureTargetOptions}
                value={failureEdge?.target}
                onChange={(val) => updateOnFailureTarget(selectedNodeId!, val)}
                placeholder="Select node"
              />
            ) : (
              <div className="px-3 py-2 rounded-lg border border-default bg-background-subtle text-sm text-foreground-muted">
                End (with error)
              </div>
            )}
          </div>
        )}
      </div>
    </NodeExpressionContext.Provider>
  );
}
