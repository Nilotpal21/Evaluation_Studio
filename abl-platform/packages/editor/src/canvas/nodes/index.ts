/**
 * Node Type Exports
 */

export { BaseNode } from './BaseNode.js';
export { SupervisorNode } from './SupervisorNode.js';
export { AgentNode } from './AgentNode.js';
export { StepNode } from './StepNode.js';
export { RoutingRuleNode } from './RoutingRuleNode.js';
export { ToolNode } from './ToolNode.js';
export { GuardrailNode } from './GuardrailNode.js';

import { SupervisorNode } from './SupervisorNode.js';
import { AgentNode } from './AgentNode.js';
import { StepNode } from './StepNode.js';
import { RoutingRuleNode } from './RoutingRuleNode.js';
import { ToolNode } from './ToolNode.js';
import { GuardrailNode } from './GuardrailNode.js';

// Node types registry for React Flow
export const nodeTypes = {
  supervisor: SupervisorNode,
  agent: AgentNode,
  step: StepNode,
  'routing-rule': RoutingRuleNode,
  tool: ToolNode,
  guardrail: GuardrailNode,
} as const;

export type NodeTypesMap = typeof nodeTypes;
