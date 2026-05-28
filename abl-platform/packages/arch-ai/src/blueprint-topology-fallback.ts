import {
  TOPOLOGY_PATTERN_VOCABULARY,
  classifyTopologyPattern,
  synthesizePatternTopology,
} from './coordinator/index.js';
import type { ArchSession, TopologyOutput } from './types/index.js';
import {
  synthesizeTopologyFromSourceContract,
  type SourceArchitectureContract,
} from './blueprint/source-architecture-contract.js';

export function synthesizeDeterministicBlueprintDraft(
  specification: ArchSession['metadata']['specification'],
  sourceContract?: SourceArchitectureContract | null,
): {
  topology: TopologyOutput;
  summary: string;
  patternName: string;
} {
  const sourceTopology = sourceContract
    ? synthesizeTopologyFromSourceContract(sourceContract)
    : null;
  if (sourceTopology) {
    return {
      topology: sourceTopology,
      patternName: 'Source Document Contract',
      summary:
        `Created a source-faithful blueprint from the uploaded architecture documents. ` +
        `It keeps ${sourceContract?.declaredAgents.length ?? sourceTopology.agents.length} declared agents and uses ${sourceTopology.entryPoint} as the entry point. ` +
        `You can adjust names, ownership, or handoff paths before build.`,
    };
  }

  const classification = classifyTopologyPattern(specification);
  const topology = synthesizePatternTopology(specification, classification.pattern);
  const patternName =
    TOPOLOGY_PATTERN_VOCABULARY.find((pattern) => pattern.id === classification.pattern)?.name ??
    classification.pattern;
  const matchedSignals =
    classification.matchedSignals.length > 0
      ? ` Signals: ${classification.matchedSignals.join(', ')}.`
      : '';

  return {
    topology,
    patternName,
    summary:
      `Created a ${patternName} topology from the current specification.${matchedSignals} ` +
      `You can adjust names, ownership, or handoff paths before build.`,
  };
}
