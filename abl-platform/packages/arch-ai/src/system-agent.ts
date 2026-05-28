/**
 * System Agent Definition — `system/arch`
 *
 * Defines the Arch AI system agent identity and invocation contract.
 * This is the canonical definition used by FLOW DELEGATE, workflow
 * `agent` nodes, and any other platform component that needs to
 * invoke Arch as an in-platform agent.
 *
 * The agent ID `system/arch` is namespaced with `system/` to clearly
 * distinguish it from user-defined project agents. The `system/`
 * prefix is reserved for platform-provided built-in agents.
 */

import type { TopologyOutput, TopologyAgent } from './types/blueprint.js';

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * Stable identifier for the Arch AI system agent.
 *
 * Convention: `system/<name>` for all platform-provided agents.
 * This prefix is reserved and cannot be used by user-defined agents.
 */
export const ARCH_SYSTEM_AGENT_ID = 'system/arch';

/**
 * Prefix for all platform-provided system agents.
 * Used by registries to identify and route system agent invocations
 * separately from project-scoped user agents.
 */
export const SYSTEM_AGENT_PREFIX = 'system/';

// ─── Invocation Contract ──────────────────────────────────────────────────

/**
 * Input for invoking the Arch system agent.
 *
 * This is the contract that callers (FLOW DELEGATE, workflow nodes,
 * other system agents) must satisfy when delegating to `system/arch`.
 */
export interface ArchSystemAgentInput {
  /** Project specification — what to build */
  spec: {
    projectName: string;
    description: string;
    channels?: string[];
    language?: string;
  };
  /** Optional existing project ID (currently unsupported — returns 501) */
  projectId?: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Successful output from the Arch system agent.
 */
export interface ArchSystemAgentOutput {
  projectId: string;
  agents: TopologyAgent[];
  topology: TopologyOutput;
}

/**
 * Full result envelope from the Arch system agent invocation.
 */
export interface ArchSystemAgentResult {
  success: boolean;
  data?: ArchSystemAgentOutput;
  error?: {
    code: string;
    message: string;
  };
  correlationId: string;
  sessionId?: string;
  retryable?: boolean;
}

// ─── Agent Definition ─────────────────────────────────────────────────────

/**
 * Metadata descriptor for the system/arch agent.
 *
 * Used by agent registries to describe the agent's capabilities
 * without needing to know the implementation details.
 */
export interface SystemAgentDefinition {
  id: string;
  name: string;
  description: string;
  /** Whether this is a platform-provided system agent */
  system: true;
  /** The intents this agent can handle */
  intents: string[];
  /** Required caller permissions */
  requiredPermissions: string[];
}

/**
 * The Arch AI system agent definition.
 */
export const ARCH_SYSTEM_AGENT_DEFINITION: SystemAgentDefinition = {
  id: ARCH_SYSTEM_AGENT_ID,
  name: 'Arch AI',
  description:
    'AI-powered agent topology designer. Takes a project specification and generates a complete multi-agent topology with agent definitions, edges, and project structure.',
  system: true,
  intents: ['generate_topology'],
  requiredPermissions: ['project:write'],
};

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Check if an agent ID refers to a system agent.
 */
export function isSystemAgent(agentId: string): boolean {
  return agentId.startsWith(SYSTEM_AGENT_PREFIX);
}

/**
 * Get the list of all registered system agent definitions.
 *
 * Currently only Arch AI; this will grow as more platform agents are added
 * (e.g., system/cost-estimator, system/test-runner).
 */
export function getSystemAgentDefinitions(): SystemAgentDefinition[] {
  return [ARCH_SYSTEM_AGENT_DEFINITION];
}

/**
 * Look up a system agent definition by ID.
 */
export function getSystemAgentDefinition(agentId: string): SystemAgentDefinition | undefined {
  return getSystemAgentDefinitions().find((def) => def.id === agentId);
}
