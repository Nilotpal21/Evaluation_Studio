/**
 * Shared Workflow Types — Node-Based Canvas System
 *
 * TypeScript interfaces for the visual, node-based workflow builder.
 * 16 node types as a discriminated union on `nodeType`.
 */

// ─── Workflow Status & Type Enums ───────────────────────────────────────
// Canonical source — imported by database model, runtime routes, shared
// schemas, and Studio types. Change here, all consumers follow.

export const WORKFLOW_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const WORKFLOW_TYPES = ['cx_automation', 'ex_automation', 'internal'] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

// ─── Node Types ─────────────────────────────────────────────────────────

export type NodeType =
  | 'start'
  | 'end'
  | 'condition'
  | 'loop'
  | 'loop_start'
  | 'loop_end'
  | 'delay'
  | 'text_to_text'
  | 'text_to_image'
  | 'audio_to_text'
  | 'image_to_text'
  | 'api'
  | 'function'
  | 'integration'
  | 'browser'
  | 'doc_search'
  | 'doc_intelligence'
  | 'human'
  | 'agentic_app'
  | 'agent'
  | 'tool'
  | 'data_entry';

export const STUB_NODE_TYPES: NodeType[] = [
  'browser',
  'doc_search',
  'doc_intelligence',
  'text_to_image',
  'audio_to_text',
  'image_to_text',
  'agentic_app',
];

/** Node types hidden from the palette (superseded or internal-only) */
export const HIDDEN_NODE_TYPES: NodeType[] = [
  'text_to_text',
  'text_to_image',
  'audio_to_text',
  'image_to_text',
  'doc_search',
  'doc_intelligence',
  'loop_end',
  'agentic_app',
  'browser',
  'api',
  'loop_start',
];

// ─── Node Categories ────────────────────────────────────────────────────

export type NodeCategory =
  | 'flow_control'
  | 'ai'
  | 'action'
  | 'data'
  | 'human_in_loop'
  | 'agent'
  | 'tool';

export const NODE_CATEGORY_MAP: Record<NodeType, NodeCategory> = {
  start: 'flow_control',
  end: 'flow_control',
  condition: 'flow_control',
  loop: 'flow_control',
  loop_start: 'flow_control',
  loop_end: 'flow_control',
  delay: 'flow_control',
  text_to_text: 'ai',
  text_to_image: 'ai',
  audio_to_text: 'ai',
  image_to_text: 'ai',
  api: 'action',
  function: 'action',
  integration: 'action',
  browser: 'action',
  doc_search: 'data',
  doc_intelligence: 'data',
  human: 'human_in_loop',
  agentic_app: 'agent',
  agent: 'agent',
  tool: 'tool',
  data_entry: 'human_in_loop',
};

// ─── Node Color Map ─────────────────────────────────────────────────────

export const NODE_COLOR_MAP: Record<NodeType, string> = {
  start: '#4CAF50',
  end: '#616161',
  condition: '#A1887F',
  loop: '#9E9E9E',
  loop_start: '#4CAF50',
  loop_end: '#4CAF50',
  delay: '#FFB300',
  text_to_text: '#7E57C2',
  text_to_image: '#7E57C2',
  audio_to_text: '#7E57C2',
  image_to_text: '#7E57C2',
  api: '#1565C0',
  function: '#00ACC1',
  integration: '#FF7043',
  browser: '#42A5F5',
  doc_search: '#66BB6A',
  doc_intelligence: '#66BB6A',
  human: '#8D6E63',
  agentic_app: '#26A69A',
  agent: '#26A69A',
  tool: '#FF8A65',
  data_entry: '#6D4C41',
};

// ─── Node Display Names ─────────────────────────────────────────────────

export const NODE_DISPLAY_NAMES: Record<NodeType, string> = {
  start: 'Start',
  end: 'End',
  condition: 'Condition',
  loop: 'Loop',
  loop_start: 'Loop Start',
  loop_end: 'Loop End',
  delay: 'Delay',
  text_to_text: 'Text-to-Text',
  text_to_image: 'Text-to-Image',
  audio_to_text: 'Audio-to-Text',
  image_to_text: 'Image-to-Text',
  api: 'API',
  function: 'Function',
  integration: 'Integration',
  browser: 'Browser',
  doc_search: 'DocSearch',
  doc_intelligence: 'Doc Intelligence',
  human: 'Approval',
  agentic_app: 'Agentic App',
  agent: 'Agent',
  tool: 'Tool',
  data_entry: 'Data Entry',
};

// ─── Output Handles per Node Type ───────────────────────────────────────

export function getOutputHandles(nodeType: NodeType, config?: Record<string, unknown>): string[] {
  switch (nodeType) {
    case 'start':
      return ['on_success'];
    case 'end':
      return [];
    case 'human':
      if (config?.onFailureEnabled) {
        return ['on_approve', 'on_reject', 'on_failure'];
      }
      return ['on_approve', 'on_reject'];
    case 'condition': {
      // Dynamic based on conditions config
      const conditions = (config?.conditions as Array<{ id: string; label: string }>) || [];
      const handles = conditions.map((c) => c.id);
      handles.push('else');
      return handles;
    }
    case 'loop':
      return ['on_complete', 'on_failure'];
    case 'loop_start':
      return ['loop_body'];
    case 'loop_end':
      return [];
    default:
      if (config?.onFailureEnabled) {
        return ['on_success', 'on_failure'];
      }
      return ['on_success'];
  }
}

// ─── Workflow Node ──────────────────────────────────────────────────────

export interface WorkflowNode {
  id: string;
  nodeType: NodeType;
  name: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  parentId?: string;
}

// ─── Workflow Edge ──────────────────────────────────────────────────────

export interface WorkflowEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle?: string;
  label?: string;
}

// ─── Workflow Deployment ────────────────────────────────────────────────

export interface WorkflowDeployment {
  endpointSlug: string;
  mode: 'sync' | 'async_poll' | 'async_push';
  asyncPushConfig?: {
    webhookUrl: string;
    accessToken: string;
  };
  timeout: number;
  deployedAt: Date;
  deployedBy: string;
  deployedVersion: number;
}

// ─── Workflow Context (Runtime) ─────────────────────────────────────────

export interface WorkflowContext {
  input: Record<string, unknown>;
  steps: Record<string, { output?: unknown; error?: { code: string; message: string } }>;
  env: Record<string, string>;
}

// ─── Node Executor Result ───────────────────────────────────────────────

export interface NodeExecutorResult {
  success: boolean;
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
  suspend?: {
    type: 'human' | 'delay';
    durationMs?: number;
  };
  branchId?: string;
  loopResults?: unknown[];
}

// ─── Node Execution Tracking ────────────────────────────────────────────

export interface NodeExecution {
  nodeId: string;
  nodeName: string;
  nodeType: NodeType;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  iteration?: number;
  iterationResults?: unknown[];
}

// ─── Workflow Events ────────────────────────────────────────────────────

export type WorkflowEvent =
  | { type: 'execution_started'; executionId: string; workflowId: string; timestamp: Date }
  | {
      type: 'node_started';
      executionId: string;
      nodeId: string;
      nodeName: string;
      timestamp: Date;
    }
  | {
      type: 'node_completed';
      executionId: string;
      nodeId: string;
      nodeName: string;
      output: unknown;
      durationMs: number;
      timestamp: Date;
    }
  | {
      type: 'node_failed';
      executionId: string;
      nodeId: string;
      nodeName: string;
      error: string;
      timestamp: Date;
    }
  | { type: 'execution_completed'; executionId: string; status: string; timestamp: Date };

// ─── Expression Resolution ──────────────────────────────────────────────

export type ContextExpression = string;

export function resolveExpression(
  expression: ContextExpression,
  context: WorkflowContext,
): unknown {
  // Handle mixed text with expressions: "Hello {{context.input.name}}"
  const multiPattern = /\{\{(.+?)\}\}/g;
  const singleMatch = expression.match(/^\{\{(.+?)\}\}$/);

  // If the entire string is a single expression, return the resolved value directly
  if (singleMatch) {
    return resolveContextPath(singleMatch[1].trim(), context);
  }

  // Otherwise, do string interpolation
  return expression.replace(multiPattern, (_match, path) => {
    const resolved = resolveContextPath(path.trim(), context);
    return resolved === undefined ? '' : String(resolved);
  });
}

function resolveContextPath(path: string, context: WorkflowContext): unknown {
  // Strip "context." prefix if present
  const normalizedPath = path.startsWith('context.') ? path.slice(8) : path;
  const parts = normalizedPath.split('.');
  let current: unknown = context;

  const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    if (DANGEROUS_KEYS.has(part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

// ─── Auto-naming Helper ─────────────────────────────────────────────────

export function generateNodeName(nodeType: NodeType, existingNames: string[]): string {
  if (nodeType === 'start') return 'Start';

  const prefix = (NODE_DISPLAY_NAMES[nodeType] ?? nodeType).replace(/[^A-Za-z0-9]/g, '');
  let counter = 1;
  let name = `${prefix}${String(counter).padStart(4, '0')}`;
  while (existingNames.includes(name)) {
    counter++;
    name = `${prefix}${String(counter).padStart(4, '0')}`;
  }
  return name;
}

// ─── Validation ─────────────────────────────────────────────────────────

export const NODE_NAME_PATTERN = /^[A-Za-z0-9_]+$/;
