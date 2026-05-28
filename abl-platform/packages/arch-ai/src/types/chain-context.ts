import type { InProjectSpecialistId } from './constants.js';

export interface Finding {
  type: 'error' | 'warning' | 'info';
  summary: string;
  agentName?: string;
  metric?: { name: string; value: number; threshold?: number };
}

export interface RecommendedAction {
  type: 'modify_agent' | 'modify_topology' | 'create_guardrail' | 'configure' | string;
  target: string;
  description: string;
  scope: 'SMALL' | 'MEDIUM' | 'LARGE';
}

/**
 * Typed context passed between chained specialists.
 * Prevents the second specialist from receiving ambiguous prose.
 */
export interface ChainContext {
  sourceSpecialist: InProjectSpecialistId;
  findings: Finding[];
  recommendedActions: RecommendedAction[];
  suggestedToolNames?: string[];
  rawEvidence?: unknown;
}
