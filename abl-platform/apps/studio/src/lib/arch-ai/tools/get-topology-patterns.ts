import { z } from 'zod';
import { tool } from 'ai';
import { TOPOLOGY_PATTERNS, TOPOLOGY_DECISION_TREE } from '../topology-patterns';

export function createTopologyPatternsTool() {
  return tool({
    description:
      'Query the topology pattern catalog. Returns available patterns with selection criteria and anti-patterns. Use when the user asks about restructuring the topology or wants to understand pattern alternatives.',
    inputSchema: z.object({
      filter: z
        .enum(['all', 'simple', 'complex'])
        .optional()
        .describe(
          'Filter patterns by complexity. simple = single_agent + triage. complex = pipeline + hub_spoke + mesh.',
        ),
      currentPattern: z
        .string()
        .optional()
        .describe('The current topology pattern, for "what alternatives exist?" queries'),
    }),
    execute: async ({ filter, currentPattern }) => {
      let patterns = TOPOLOGY_PATTERNS;

      if (filter === 'simple') {
        patterns = patterns.filter((p) => ['single_agent', 'triage_specialists'].includes(p.id));
      } else if (filter === 'complex') {
        patterns = patterns.filter((p) => ['pipeline', 'hub_spoke', 'mesh'].includes(p.id));
      }

      if (currentPattern) {
        patterns = patterns.filter((p) => p.id !== currentPattern);
      }

      return {
        patterns: patterns.map((p) => ({
          id: p.id,
          name: p.name,
          whenToUse: p.whenToUse,
          structure: p.structure,
          ablImplications: p.ablImplications,
          edgeTypes: p.edgeTypes,
          antiPatterns: p.antiPatterns,
        })),
        decisionTree: TOPOLOGY_DECISION_TREE,
        currentPattern: currentPattern || null,
      };
    },
  });
}
