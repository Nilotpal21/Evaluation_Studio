/**
 * Tools barrel — v4 clone.
 *
 * Tool definitions and utilities for the Arch AI v4 engine.
 */

export { toolInputSchemas } from './schemas/in-project-schemas.js';
export { TOOL_CLASSIFICATION } from './adapters/classification.js';
export { ToolRegistry, isInternalTool, isInteractiveTool } from './v2/registry.js';
export type {
  ToolKind,
  ToolDefinition,
  InternalToolDefinition,
  InteractiveToolDefinition,
  MinimalTurnContext,
} from './v2/registry.js';
