/**
 * Exit-criterion ordering and architecture-finding severity predicates.
 *
 * Extracted verbatim from `pipeline-engine.ts`. Behavior is unchanged.
 * `orderExitCriteria` defines the stable evaluation order used when
 * iterating a slice's exit criteria;
 * `architectureFindingBlocksApproval` classifies severities that must
 * block approval during architecture review.
 */
import type { ExitCriterion, ReviewFinding } from '../../types.js';

export function orderExitCriteria(criteria: ExitCriterion[]): ExitCriterion[] {
  return [...criteria].sort(
    (left, right) => exitCriterionPriority(left) - exitCriterionPriority(right),
  );
}

function exitCriterionPriority(criterion: ExitCriterion): number {
  switch (criterion.type) {
    case 'typecheck':
      return 10;
    case 'lint':
      return 20;
    case 'test-lock':
      return 30;
    case 'impact-reviewed':
      return 40;
    case 'exports-wired':
      return 50;
    case 'custom':
      return 60;
    case 'no-new-findings':
      return 70;
    case 'workspace-scope-clean':
      return 75;
    case 'architecture-reviewed':
      return 80;
    default:
      return 90;
  }
}

export function architectureFindingBlocksApproval(severity: ReviewFinding['severity']): boolean {
  return severity === 'critical' || severity === 'high' || severity === 'medium';
}
