/**
 * Shared NodeRegistry singleton for pipeline API routes.
 *
 * Tries to load from MongoDB first (config-driven node types).
 * Falls back to static registration if DB is unavailable.
 * Cache has a TTL so new/updated node types are picked up without a restart.
 */
import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  NodeRegistry,
  registerAnalyticsNodes,
  registerBuiltinNodes,
  type NodeTypeDefinitionDoc,
} from '@agent-platform/pipeline-engine/registry';
import { NodeTypeDefinitionModel } from '@agent-platform/pipeline-engine/schemas';

const log = createLogger('pipeline-registry');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedRegistry: NodeRegistry | null = null;
let cachedAt = 0;

export async function getNodeRegistry(): Promise<NodeRegistry> {
  if (cachedRegistry && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedRegistry;
  }

  const registry = new NodeRegistry();

  try {
    const docs = await NodeTypeDefinitionModel.find({
      tenantId: 'SYSTEM',
      isActive: true,
    }).lean<NodeTypeDefinitionDoc[]>();

    if (docs.length > 0) {
      registry.loadFromDocs(docs);
      log.info(`Loaded ${docs.length} node types from MongoDB`);
    } else {
      registerAnalyticsNodes(registry);
      registerBuiltinNodes(registry);
      log.warn('No node types in DB — using static fallback');
    }
  } catch (err: unknown) {
    registerAnalyticsNodes(registry);
    registerBuiltinNodes(registry);
    log.warn(
      `Failed to load node types from DB — using static fallback: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  cachedRegistry = registry;
  cachedAt = Date.now();

  return registry;
}

/** For testing: reset the cached registry */
export function resetNodeRegistryCache(): void {
  cachedRegistry = null;
  cachedAt = 0;
}
