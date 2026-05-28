import {
  TOPOLOGY_PATTERN_VOCABULARY,
  classifyTopologyPattern,
  synthesizePatternTopology,
} from '@agent-platform/arch-ai/coordinator';
import type { ArchSession, TopologyOutput } from '@agent-platform/arch-ai/types';

export function synthesizeDeterministicBlueprintDraft(
  specification: ArchSession['metadata']['specification'],
): {
  topology: TopologyOutput;
  summary: string;
  patternName: string;
} {
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
      `Created a ${patternName} blueprint from the current specification.${matchedSignals} ` +
      `You can adjust names, ownership, or handoff paths before build.`,
  };
}
