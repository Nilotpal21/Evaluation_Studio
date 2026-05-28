import { parseAgentBasedABL } from '@abl/core';
import { extractToolNames } from '@/lib/arch-ai/topology-helpers';
import type { ModelRecommendationInput } from './get-model-recommendation';

type AgentLike = Record<string, unknown>;

function getDslContent(agent: AgentLike): string | null {
  return typeof agent.dslContent === 'string' ? agent.dslContent : null;
}

export function extractDeclaredToolNamesForRecommendation(agent: AgentLike): string[] {
  const dslContent = getDslContent(agent);
  if (!dslContent) {
    return [];
  }

  try {
    const parsed = parseAgentBasedABL(dslContent);
    const parsedToolNames =
      parsed.document?.tools
        ?.map((tool) => tool.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0) ?? [];

    if (parsedToolNames.length > 0) {
      return [...new Set(parsedToolNames)];
    }
  } catch {
    // Fall back to the lightweight extractor below.
  }

  return extractToolNames(dslContent);
}

export function buildModelRecommendationInputFromToolCount(
  toolCount: number,
): ModelRecommendationInput {
  return {
    agentRole: 'specialist',
    executionMode: toolCount > 3 ? 'reasoning' : 'scripted',
    requiresToolCalling: toolCount > 0,
    requiresVision: false,
    requiresStructuredOutput: false,
    complexityTier: toolCount > 4 ? 'complex' : toolCount > 1 ? 'moderate' : 'simple',
  };
}

export function buildModelRecommendationInputFromAgent(agent: AgentLike): ModelRecommendationInput {
  return buildModelRecommendationInputFromToolCount(
    extractDeclaredToolNamesForRecommendation(agent).length,
  );
}
