/**
 * Visual Editor Types
 */

import type { Node, Edge } from '@xyflow/react';

// Node Types for React Flow
export type DSLNodeType =
  | 'supervisor'
  | 'agent'
  | 'step'
  | 'routing-rule'
  | 'tool'
  | 'guardrail'
  | 'state-variable'
  | 'intent-group';

// Base node data with index signature for React Flow compatibility
export interface BaseNodeData {
  [key: string]: unknown;
  label: string;
  description?: string;
  selected?: boolean;
  errors?: string[];
  warnings?: string[];
}

// Supervisor Node
export interface SupervisorNodeData extends BaseNodeData {
  type: 'supervisor';
  document?: unknown; // SupervisorDocument from core
}

// Agent Node
export interface AgentNodeData extends BaseNodeData {
  type: 'agent';
  document?: unknown; // AgentDocument from core
  agentId: string;
  isActive?: boolean;
}

// Step Node
export interface StepNodeData extends BaseNodeData {
  type: 'step';
  stepNumber: string;
  action: 'RESPOND' | 'WAIT_INPUT' | 'CALL' | 'SET' | 'IF' | 'GOTO' | 'SIGNAL';
  content?: string;
  agentId: string;
}

// Routing Rule Node
export interface RoutingRuleNodeData extends BaseNodeData {
  type: 'routing-rule';
  priority: number;
  condition: string;
  target: string;
  flags?: string[];
}

// Tool Node
export interface ToolNodeData extends BaseNodeData {
  type: 'tool';
  toolName: string;
  parameters: Array<{ name: string; type: string }>;
  returnType?: string;
  agentId: string;
}

// Guardrail Node
export interface GuardrailNodeData extends BaseNodeData {
  type: 'guardrail';
  guardrailName: string;
  guardrailType: 'input' | 'output' | 'behavioral';
  action: 'block' | 'warn' | 'redact';
}

// State Variable Node
export interface StateVariableNodeData extends BaseNodeData {
  type: 'state-variable';
  variableName: string;
  variableType: string;
  defaultValue?: string;
  namespace: string;
}

// Intent Group Node
export interface IntentGroupNodeData extends BaseNodeData {
  type: 'intent-group';
  intents: string[];
  targetAgent: string;
}

// Union type for all node data
export type DSLNodeData =
  | SupervisorNodeData
  | AgentNodeData
  | StepNodeData
  | RoutingRuleNodeData
  | ToolNodeData
  | GuardrailNodeData
  | StateVariableNodeData
  | IntentGroupNodeData;

// Typed nodes - using generic Node type for React Flow compatibility
export type DSLNode = Node<BaseNodeData>;

// Edge Types
export type DSLEdgeType =
  | 'routing'
  | 'step-flow'
  | 'tool-call'
  | 'agent-reference'
  | 'state-update';

// Edge data with index signature for React Flow compatibility
export interface DSLEdgeData {
  [key: string]: unknown;
  type: DSLEdgeType;
  condition?: string;
  label?: string;
  animated?: boolean;
}

export type DSLEdge = Edge<DSLEdgeData>;

// Editor State
export interface EditorProject {
  id: string;
  name: string;
  supervisor: unknown | null; // SupervisorDocument
  agents: Map<string, unknown>; // AgentDocument
  createdAt: Date;
  updatedAt: Date;
}

// Panel Types
export type PanelType = 'properties' | 'code' | 'validation' | 'preview' | 'outline';

export interface PanelState {
  type: PanelType;
  isOpen: boolean;
  width: number;
  position: 'left' | 'right' | 'bottom';
}

// Editor View Mode
export type ViewMode = 'graph' | 'code' | 'split';

// Selection State
export interface SelectionState {
  nodeIds: string[];
  edgeIds: string[];
  type: 'single' | 'multiple' | 'none';
}

// Drag and Drop
export interface DragItem {
  type: DSLNodeType;
  data: Partial<DSLNodeData>;
}

// Code Editor State
export interface CodeEditorState {
  content: string;
  language: 'dsl' | 'python' | 'json';
  cursorPosition: { line: number; column: number };
  isDirty: boolean;
}

// Validation Result
export interface ValidationResult {
  isValid: boolean;
  errors: ValidationMessage[];
  warnings: ValidationMessage[];
}

export interface ValidationMessage {
  nodeId?: string;
  edgeId?: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  rule?: string;
  suggestion?: string;
}

// Canvas Transform
export interface CanvasTransform {
  x: number;
  y: number;
  zoom: number;
}

// History for Undo/Redo
export interface HistoryEntry {
  nodes: DSLNode[];
  edges: DSLEdge[];
  timestamp: Date;
  description: string;
}

// Export Options
export interface ExportOptions {
  format: 'abl' | 'python' | 'json' | 'png' | 'svg';
  includeLayout?: boolean;
  minify?: boolean;
}
