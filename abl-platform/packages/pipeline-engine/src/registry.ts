/**
 * Lightweight registry re-export.
 *
 * Studio imports this subpath (`@agent-platform/pipeline-engine/registry`)
 * to avoid pulling in the full engine barrel (which has Restate top-level
 * await and breaks Next.js webpack dev mode).
 */
export { NodeRegistry } from './pipeline/node-registry.js';
export { registerAnalyticsNodes, registerBuiltinNodes } from './pipeline/register-nodes.js';
export type { NodeCategory, NodeTypeDefinitionDoc } from './pipeline/types.js';
