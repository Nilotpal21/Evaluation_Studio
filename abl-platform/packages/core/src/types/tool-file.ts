/**
 * Tool File Types
 *
 * Types for reusable .tools.abl files that define tool collections
 * with shared defaults (base_url, auth, timeout, etc.)
 */

import type { AgentTool, ToolAuthType } from './agent-based.js';

/**
 * Default configuration applied to all tools in a .tools.abl file
 */
export interface ToolFileDefaults {
  baseUrl?: string;
  auth?: ToolAuthType;
  timeout?: number;
  retry?: number;
  retryDelay?: number;
  rateLimit?: number;
  headers?: Record<string, string>;
}

/**
 * Parsed .tools.abl file document
 */
export interface ToolFileDocument {
  defaults: ToolFileDefaults;
  tools: AgentTool[]; // Reuses same AgentTool type
}
