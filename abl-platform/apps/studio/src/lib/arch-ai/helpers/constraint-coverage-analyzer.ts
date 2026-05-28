/**
 * analyzeConstraintCoverage() — Compares existing constraints against required.
 * B23: Constraint & Guardrail Design Coaching
 */

import { classifyDataSensitivity } from './classify-data-sensitivity';
import type { AgentTool, SensitivityCategory } from './classify-data-sensitivity';

// =============================================================================
// TYPES
// =============================================================================

export type CoverageStatus = 'covered' | 'partial' | 'missing' | 'n/a';

export interface CoverageMatrixEntry {
  agent: string;
  regulation: string;
  status: CoverageStatus;
  detail?: string;
}

export interface CoverageMatrix {
  entries: CoverageMatrixEntry[];
  summary: {
    totalAgents: number;
    totalRegulations: number;
    coveredCount: number;
    partialCount: number;
    missingCount: number;
    naCount: number;
  };
}

export interface AgentConstraintState {
  name: string;
  tools: AgentTool[];
  existingConstraints: string[]; // condition strings from existing ABL
}

// =============================================================================
// MAIN ENTRY
// =============================================================================

/**
 * Analyze constraint coverage for a set of agents against applicable regulations.
 */
export function analyzeConstraintCoverage(
  agents: AgentConstraintState[],
  regulations: string[],
): CoverageMatrix {
  const entries: CoverageMatrixEntry[] = [];
  let coveredCount = 0;
  let partialCount = 0;
  let missingCount = 0;
  let naCount = 0;

  for (const agent of agents) {
    const sensitivity = classifyDataSensitivity(agent.tools);

    for (const regulation of regulations) {
      // If agent has no sensitive data, this regulation doesn't apply
      if (sensitivity.categories.length === 1 && sensitivity.categories[0] === 'general') {
        entries.push({ agent: agent.name, regulation, status: 'n/a' });
        naCount++;
        continue;
      }

      const status = evaluateCoverage(agent, regulation, sensitivity.categories);
      entries.push({
        agent: agent.name,
        regulation,
        status: status.status,
        detail: status.detail,
      });

      if (status.status === 'covered') coveredCount++;
      else if (status.status === 'partial') partialCount++;
      else if (status.status === 'missing') missingCount++;
      else naCount++;
    }
  }

  return {
    entries,
    summary: {
      totalAgents: agents.length,
      totalRegulations: regulations.length,
      coveredCount,
      partialCount,
      missingCount,
      naCount,
    },
  };
}

// =============================================================================
// COVERAGE EVALUATION
// =============================================================================

/** Keywords that indicate a constraint covers a particular regulation */
const REGULATION_KEYWORDS: Record<string, string[]> = {
  'PCI-DSS': ['credit card', 'payment', 'card number', 'pci', 'redact'],
  HIPAA: ['health', 'medical', 'pii', 'hipaa', 'patient', 'phi'],
  GDPR: ['personal data', 'consent', 'gdpr', 'data minimization', 'erasure'],
  SOC2: ['access control', 'audit', 'soc2', 'authorization'],
};

/** Sensitivity categories that trigger a regulation requirement */
const REGULATION_TRIGGERS: Record<string, SensitivityCategory[]> = {
  'PCI-DSS': ['payment'],
  HIPAA: ['health', 'pii'],
  GDPR: ['pii', 'payment', 'health', 'financial'],
  SOC2: ['payment', 'pii', 'health', 'financial'],
};

function evaluateCoverage(
  agent: AgentConstraintState,
  regulation: string,
  agentCategories: SensitivityCategory[],
): { status: CoverageStatus; detail?: string } {
  const triggers = REGULATION_TRIGGERS[regulation] ?? [];
  const relevant = triggers.some((t) => agentCategories.includes(t));

  if (!relevant) {
    return { status: 'n/a' };
  }

  const keywords = REGULATION_KEYWORDS[regulation] ?? [];
  const matchingConstraints = agent.existingConstraints.filter((c) =>
    keywords.some((k) => c.toLowerCase().includes(k)),
  );

  if (matchingConstraints.length === 0) {
    return {
      status: 'missing',
      detail: `${agent.name} handles ${agentCategories.join(', ')} data but has no ${regulation} constraints`,
    };
  }

  // Check if coverage is complete (heuristic: at least 2 constraints for comprehensive coverage)
  if (matchingConstraints.length >= 2) {
    return { status: 'covered' };
  }

  return {
    status: 'partial',
    detail: `${agent.name} has ${matchingConstraints.length} ${regulation} constraint(s) — may need additional coverage`,
  };
}
