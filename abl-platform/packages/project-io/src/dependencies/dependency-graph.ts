/**
 * Dependency Graph — builds and validates inter-agent dependency graphs
 *
 * Takes agents and tool files, extracts dependencies from each,
 * builds a directed graph, and validates completeness.
 */

import type {
  AgentEntry,
  ToolFileEntry,
  DependencyGraph,
  DependencyEdge,
  DependencyValidation,
} from '../types.js';
import { extractDependencies } from './dependency-extractor.js';
import { detectCircularDependencies } from './circular-detector.js';

/**
 * Build a dependency graph from all agents and tool files.
 *
 * @param agents - All agent entries (name + dslContent)
 * @param toolFiles - All tool file entries (name + path + content)
 * @returns Complete dependency graph with adjacency lists
 */
export function buildDependencyGraph(
  agents: AgentEntry[],
  toolFiles: ToolFileEntry[] = [],
  profileNames: string[] = [],
): DependencyGraph {
  const agentNames = agents.map((a) => a.name);
  const toolFilePaths = toolFiles.map((t) => t.path ?? t.name).filter(Boolean);

  const edges: DependencyEdge[] = [];
  const adjacency = new Map<string, DependencyEdge[]>();
  const reverseAdjacency = new Map<string, DependencyEdge[]>();

  // Initialize adjacency maps for all agents
  for (const name of agentNames) {
    adjacency.set(name, []);
    reverseAdjacency.set(name, []);
  }

  // Extract dependencies from each agent
  for (const agent of agents) {
    const deps = extractDependencies(agent.dslContent);

    for (const dep of deps) {
      const edge: DependencyEdge = {
        from: agent.name,
        to: dep.targetAgent,
        type: dep.type,
        toolNames: dep.toolNames,
        sourcePath: dep.sourcePath,
      };

      edges.push(edge);

      // Add to adjacency
      const outEdges = adjacency.get(agent.name);
      if (outEdges) {
        outEdges.push(edge);
      }

      // Add to reverse adjacency
      if (!reverseAdjacency.has(dep.targetAgent)) {
        reverseAdjacency.set(dep.targetAgent, []);
      }
      const inEdges = reverseAdjacency.get(dep.targetAgent);
      if (inEdges) {
        inEdges.push(edge);
      }
    }
  }

  return {
    agents: agentNames,
    toolFiles: toolFilePaths,
    profiles: profileNames,
    edges,
    adjacency,
    reverseAdjacency,
  };
}

/**
 * Validate a dependency graph for completeness and acyclicity.
 *
 * Checks:
 * 1. All handoff/delegate targets exist as agents in the graph
 * 2. All tool import source paths exist as tool files
 * 3. All profile_use targets exist as behavior profiles
 * 4. No circular agent dependencies (handoff/delegate cycles)
 *
 * @param graph - The dependency graph to validate
 * @returns Validation result with missing edges and cycles
 */
export function validateDependencies(graph: DependencyGraph): DependencyValidation {
  // Lookup sets — bounded by graph input size, no eviction needed (MAX_SIZE = input length)
  const agentSet = new Set(graph.agents);
  const toolFileSet = new Set(graph.toolFiles);
  const profileSet = new Set(graph.profiles);

  const missing: DependencyEdge[] = [];
  const circular = detectCircularDependencies(graph.agents, graph.adjacency);

  for (const edge of graph.edges) {
    if (edge.type === 'tool_import') {
      // Tool imports reference file paths; normalize and check
      if (edge.sourcePath && !toolFileSet.has(edge.sourcePath)) {
        const normalized = normalizeToolPath(edge.sourcePath);
        if (!toolFileSet.has(normalized)) {
          missing.push(edge);
        }
      }
    } else if (edge.type === 'profile_use') {
      // Behavior profile references: check against profile name set
      if (!profileSet.has(edge.to)) {
        missing.push(edge);
      }
    } else {
      // Agent references: handoff, delegate, inline_handoff
      if (!agentSet.has(edge.to)) {
        missing.push(edge);
      }
    }
  }

  return {
    valid: missing.length === 0 && circular.length === 0,
    missing,
    circular,
  };
}

/**
 * Get all agents that depend on the given agent (its dependents).
 */
export function getAgentDependents(graph: DependencyGraph, agentName: string): string[] {
  const edges = graph.reverseAdjacency.get(agentName) ?? [];
  const dependents = new Set<string>();
  for (const edge of edges) {
    dependents.add(edge.from);
  }
  return [...dependents];
}

/**
 * Get all agents/tools that the given agent depends on.
 */
export function getAgentDependencies(graph: DependencyGraph, agentName: string): string[] {
  const edges = graph.adjacency.get(agentName) ?? [];
  const dependencies = new Set<string>();
  for (const edge of edges) {
    dependencies.add(edge.to);
  }
  return [...dependencies];
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function normalizeToolPath(path: string): string {
  // Remove leading ./ if present
  return path.replace(/^\.\//, '');
}
