/**
 * Source Hash Computation
 *
 * Computes a deterministic SHA-256 hash from module source content.
 * Used for deduplication detection (Decision 2c).
 *
 * Includes entryAgentName because it affects runtime behavior
 * (which agent is the module's entry point).
 */

import { createHash } from 'crypto';
import {
  buildAgentCompanionHashInput,
  type AgentCompanionMetadata,
} from '../agent-companion-metadata.js';

/**
 * Compute a deterministic source hash for a module release.
 *
 * Deep-sorts all object keys for deterministic serialization,
 * then returns a truncated SHA-256 hex digest (16 chars).
 *
 * @param entryAgentName - The module's entry agent name
 * @param agents - Map of agent name to DSL content
 * @param profiles - Map of behavior profile name to DSL content
 * @param tools - Map of tool name to DSL content
 * @returns 16-character hex hash string
 */
export function computeModuleSourceHash(
  entryAgentName: string,
  agents: Record<string, string>,
  tools: Record<string, string>,
  profiles: Record<string, string> = {},
  agentCompanions: Record<string, AgentCompanionMetadata | null> = {},
): string {
  const normalizedCompanions = Object.fromEntries(
    Object.entries(agentCompanions)
      .map(([agentName, companion]) => [agentName, buildAgentCompanionHashInput(companion)])
      .filter((entry): entry is [string, Record<string, unknown>] => entry[1] !== null),
  );

  const payload =
    Object.keys(profiles).length > 0
      ? {
          entryAgentName,
          agents,
          tools,
          profiles,
          ...(Object.keys(normalizedCompanions).length > 0
            ? { agentCompanions: normalizedCompanions }
            : {}),
        }
      : {
          entryAgentName,
          agents,
          tools,
          ...(Object.keys(normalizedCompanions).length > 0
            ? { agentCompanions: normalizedCompanions }
            : {}),
        };
  const canonical = JSON.stringify(payload, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort())
      : value,
  );
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
