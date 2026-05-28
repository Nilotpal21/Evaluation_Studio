/**
 * Shared Workflow Types — Node-Based Canvas System
 *
 * Re-exports from @agent-platform/shared-kernel for backwards compatibility.
 */
export type {
  NodeType,
  NodeCategory,
  WorkflowNode,
  WorkflowEdge,
  WorkflowDeployment,
  WorkflowContext,
  NodeExecutorResult,
  NodeExecution,
  WorkflowEvent,
  ContextExpression,
} from '@agent-platform/shared-kernel';
export {
  STUB_NODE_TYPES,
  NODE_CATEGORY_MAP,
  NODE_COLOR_MAP,
  NODE_DISPLAY_NAMES,
  NODE_NAME_PATTERN,
  getOutputHandles,
  resolveExpression,
  generateNodeName,
} from '@agent-platform/shared-kernel';
