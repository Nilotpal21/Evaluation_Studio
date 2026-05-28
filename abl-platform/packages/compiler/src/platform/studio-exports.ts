/**
 * Studio-specific re-exports from @abl/compiler.
 *
 * Studio's Next.js standalone build cannot resolve dynamic imports hidden
 * behind new Function() wrappers. This entrypoint provides a static import
 * path for the two runtime classes studio needs (ToolBindingExecutor,
 * MCPServerManager) without pulling in the full barrel export.
 *
 * Usage in studio:
 *   import { ToolBindingExecutor, MCPServerManager } from '@abl/compiler/platform/studio-exports.js';
 */

export { ToolBindingExecutor } from './constructs/executors/tool-binding-executor.js';
export { MCPServerManager } from './mcp/server-manager.js';
