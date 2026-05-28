/**
 * Tool Types
 *
 * Re-exports from the ProjectTool model. The old Tool + ToolVersion types
 * (NormalizedTool, ApiToolVersion, etc.) have been removed — project_tools
 * is the sole tool storage model.
 */

export type { ProjectToolType as ToolType } from '@agent-platform/database/models';
export { PROJECT_TOOL_TYPES as TOOL_TYPES } from '@agent-platform/database/models';
