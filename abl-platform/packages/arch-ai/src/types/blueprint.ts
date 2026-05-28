/**
 * BlueprintOutput — the structured contract between Blueprint and Build phases.
 * Contract: S2-F04, tool-call-sequences.md (Blueprint Phase)
 *
 * Build does not re-think architecture. It compiles exactly what Blueprint decided.
 * This schema is the single source of truth for that decision.
 */

import { z } from 'zod';

// ─── Topology ───────────────────────────────────────────────────────────

export const TopologyAgentModelPolicySchema = z
  .object({
    agentType: z.enum(['classifier', 'support', 'dispatcher', 'research', 'reasoning']).optional(),
    reasoningRequired: z.boolean().optional(),
    defaultModelClass: z.enum(['fast_tool_capable', 'reasoning', 'research']).optional(),
  })
  .strict();

export const TopologyAgentSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  executionMode: z.enum(['reasoning', 'scripted', 'hybrid']),
  description: z.string().min(1),
  modelPolicy: TopologyAgentModelPolicySchema.optional(),
  tools: z.array(z.string().min(1)).optional(),
  gatherFields: z.array(z.string().min(1)).optional(),
  flowStepSeeds: z.array(z.string().min(1)).optional(),
  suggestedConstructs: z.array(z.string().min(1)).optional(),
});

export type TopologyAgent = z.infer<typeof TopologyAgentSchema>;

export const TopologyEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(['delegate', 'escalate', 'transfer']),
  experienceMode: z
    .enum(['shared_voice_handoff', 'visible_handoff', 'silent_delegate', 'human_escalation'])
    .optional(),
  condition: z.string().min(1),
  allowCycle: z.boolean().optional(),
  expectReturn: z.boolean().optional(),
});

export type TopologyEdge = z.infer<typeof TopologyEdgeSchema>;

export const TopologyOutputSchema = z.object({
  agents: z.array(TopologyAgentSchema).min(1),
  edges: z.array(TopologyEdgeSchema),
  entryPoint: z.string().min(1),
});

export type TopologyOutput = z.infer<typeof TopologyOutputSchema>;

// ─── Per-Agent Spec ─────────────────────────────────────────────────────

export const AgentSpecSchema = z.object({
  role: z.string().min(1),
  model: z.enum(['reasoning', 'scripted', 'hybrid']),
  persona: z.string().min(1),
  tools: z.array(z.string()),
  gathers: z.array(
    z.object({
      name: z.string().min(1),
      prompt: z.string().min(1),
      type: z.string().min(1),
      dependsOn: z.array(z.string()).optional(),
    }),
  ),
  handoffs: z.array(
    z.object({
      target: z.string().min(1),
      condition: z.string().min(1),
    }),
  ),
  constraints: z.array(z.string()),
  guardrails: z.array(z.string()),
});

export type AgentSpec = z.infer<typeof AgentSpecSchema>;

// ─── Governance ─────────────────────────────────────────────────────────

export const GuardrailSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  scope: z.enum(['conversation', 'agent']),
  config: z.record(z.unknown()).optional(),
});

export const GovernanceSchema = z.object({
  guardrails: z.array(GuardrailSchema),
  compliance: z.array(z.string()),
  policies: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().min(1),
      enforcement: z.enum(['block', 'warn', 'log']),
    }),
  ),
});

// ─── Integrations ───────────────────────────────────────────────────────

export const ToolSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  agent: z.string().min(1),
  type: z.enum(['api', 'function', 'database', 'external']),
});

export const ApiSpecSchema = z.object({
  name: z.string().min(1),
  format: z.enum(['openapi', 'swagger', 'graphql', 'custom']),
  source: z.string().optional(),
});

export const IntegrationsSchema = z.object({
  tools: z.array(ToolSpecSchema),
  apiSpecs: z.array(ApiSpecSchema),
});

// ─── Full BlueprintOutput ───────────────────────────────────────────────

export const BlueprintOutputSchema = z.object({
  version: z.string().min(1),
  topology: TopologyOutputSchema,
  perAgent: z.record(z.string(), AgentSpecSchema),
  governance: GovernanceSchema,
  integrations: IntegrationsSchema,
  buildOrder: z.array(z.string().min(1)),
  specReference: z.record(z.string(), z.array(z.string())).optional(),
  approvedAt: z.string().optional(),
});

export type BlueprintOutput = z.infer<typeof BlueprintOutputSchema>;

// ─── Topological Sort ───────────────────────────────────────────────────

/**
 * Kahn's algorithm for topological sort.
 * S2-F04 req 5: buildOrder computed from topology edges.
 * Returns agent names in build order, or throws if cycle detected.
 */
export function computeBuildOrder(topology: TopologyOutput): string[] {
  const agentNames = topology.agents.map((a) => a.name);
  const inDegree: Record<string, number> = {};
  const adjacency: Record<string, string[]> = {};

  for (const name of agentNames) {
    inDegree[name] = 0;
    adjacency[name] = [];
  }

  for (const edge of topology.edges) {
    if (edge.type === 'delegate' || edge.type === 'transfer') {
      // Build dependency: if A delegates to B, B should be built first
      adjacency[edge.to] = adjacency[edge.to] ?? [];
      adjacency[edge.to].push(edge.from);
      inDegree[edge.from] = (inDegree[edge.from] ?? 0) + 1;
    }
  }

  const queue: string[] = agentNames.filter((n) => inDegree[n] === 0);
  const result: string[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);

    for (const neighbor of adjacency[node] ?? []) {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) {
        queue.push(neighbor);
      }
    }
  }

  // If not all nodes are in result, there's a cycle
  if (result.length !== agentNames.length) {
    const missing = agentNames.filter((n) => !result.includes(n));
    throw new Error(`Cycle detected in topology involving: ${missing.join(', ')}`);
  }

  return result;
}

// ─── Validation ─────────────────────────────────────────────────────────

/**
 * Validate BlueprintOutput completeness.
 * S2-F04 req 6: perAgent must have entry for every agent in topology.
 */
export function validateBlueprintOutput(output: BlueprintOutput): string[] {
  const errors: string[] = [];

  const agentNames = output.topology.agents.map((a) => a.name);

  // Check perAgent has entry for every topology agent
  for (const name of agentNames) {
    if (!output.perAgent[name]) {
      errors.push(`Missing perAgent spec for agent '${name}'`);
    }
  }

  // Check entryPoint is a valid agent
  if (!agentNames.includes(output.topology.entryPoint)) {
    errors.push(`entryPoint '${output.topology.entryPoint}' is not in agents list`);
  }

  // Check edges reference valid agents
  for (const edge of output.topology.edges) {
    if (!agentNames.includes(edge.from)) {
      errors.push(`Edge from '${edge.from}' references unknown agent`);
    }
    if (!agentNames.includes(edge.to)) {
      errors.push(`Edge to '${edge.to}' references unknown agent`);
    }
  }

  // Check buildOrder matches agents
  if (output.buildOrder.length !== agentNames.length) {
    errors.push(
      `buildOrder has ${output.buildOrder.length} entries but topology has ${agentNames.length} agents`,
    );
  }

  return errors;
}
