import type { Node, Edge } from '@xyflow/react';
import type { TopologyEdgeType, AgentExecutionMode, HealthStatus } from '../../types/arch';

// =============================================================================
// L1 Node Data Types
// =============================================================================

export interface AgentNodeData extends Record<string, unknown> {
  name: string;
  agentType: 'supervisor' | 'agent';
  executionMode: AgentExecutionMode;
  isEntry: boolean;
  goal: string;
  toolCount: number;
  stepCount: number;
  gatherFieldsCount: number;
  hasEscalation: boolean;
  hasErrors: boolean;
  errorCount: number;
  model?: string;
  healthStatus: HealthStatus;
  lastUpdated?: string;
  rank: number;
}

export interface EscalationTargetNodeData extends Record<string, unknown> {
  name: string;
  priority: string;
  skills: string[];
  rank: number;
}

export interface RemoteAgentNodeData extends Record<string, unknown> {
  name: string;
  protocol: string;
  endpoint: string;
  rank: number;
}

// =============================================================================
// L1 Edge Data Types
// =============================================================================

export interface HandoffEdgeData extends Record<string, unknown> {
  edgeType: TopologyEdgeType;
  label: string;
  condition?: string;
  isReturn: boolean;
  priority?: string;
}

export interface DelegateEdgeData extends Record<string, unknown> {
  edgeType: 'delegate';
  label: string;
  condition?: string;
}

export interface EscalateEdgeData extends Record<string, unknown> {
  edgeType: 'escalation';
  label: string;
  reason?: string;
}

export interface FanOutEdgeData extends Record<string, unknown> {
  edgeType: 'fan-out';
  label: string;
}

// =============================================================================
// Typed Node/Edge aliases
// =============================================================================

export type AgentNodeType = Node<AgentNodeData, 'agent'>;
export type EscalationTargetNode = Node<EscalationTargetNodeData, 'escalation-target'>;
export type RemoteAgentNode = Node<RemoteAgentNodeData, 'remote-agent'>;

export type CanvasNode = AgentNodeType | EscalationTargetNode | RemoteAgentNode;
export type CanvasEdge = Edge<
  HandoffEdgeData | DelegateEdgeData | EscalateEdgeData | FanOutEdgeData
>;

// =============================================================================
// ELK Layout Types
// =============================================================================

export interface ElkNodeInput {
  id: string;
  width: number;
  height: number;
  layoutOptions?: Record<string, string>;
}

export interface ElkEdgeInput {
  id: string;
  sources: string[];
  targets: string[];
}

export interface ElkGraphInput {
  id: string;
  children: ElkNodeInput[];
  edges: ElkEdgeInput[];
}

export interface ElkNodeOutput {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElkLayoutResult {
  id: string;
  children: ElkNodeOutput[];
}

// =============================================================================
// Layout Configuration
// =============================================================================

export const PROJECT_LAYOUT_CONFIG: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.layered.spacing.nodeNodeBetweenLayers': '140',
  'elk.spacing.nodeNode': '100',
  'elk.padding': '[top=40,left=40,bottom=40,right=40]',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.mergeEdges': 'true',
  'elk.separateConnectedComponents': 'true',
  'elk.layered.compaction.connectedComponents': 'true',
  'elk.spacing.componentComponent': '200',
};

export const MESH_LAYOUT_CONFIG: Record<string, string> = {
  ...PROJECT_LAYOUT_CONFIG,
  'elk.direction': 'RIGHT',
  'elk.spacing.nodeNode': '120',
};

export const CHAIN_LAYOUT_CONFIG: Record<string, string> = {
  ...PROJECT_LAYOUT_CONFIG,
  'elk.direction': 'RIGHT',
  'elk.spacing.nodeNode': '80',
};

export const NODE_DIMENSIONS_BY_ZOOM = {
  full: {
    'agent-node': { width: 280, height: 180 },
    'escalation-target': { width: 240, height: 100 },
    'remote-agent': { width: 240, height: 100 },
  },
  summary: {
    'agent-node': { width: 240, height: 120 },
    'escalation-target': { width: 200, height: 80 },
    'remote-agent': { width: 200, height: 80 },
  },
  compact: {
    'agent-node': { width: 160, height: 48 },
    'escalation-target': { width: 140, height: 40 },
    'remote-agent': { width: 140, height: 40 },
  },
} as const;

export const PROJECT_NODE_DIMENSIONS = {
  'agent-node': { width: 280, height: 180 },
  supervisor: { width: 280, height: 180 },
  agent: { width: 280, height: 180 },
  'escalation-target': { width: 240, height: 100 },
  'remote-agent': { width: 240, height: 100 },
} as const;
