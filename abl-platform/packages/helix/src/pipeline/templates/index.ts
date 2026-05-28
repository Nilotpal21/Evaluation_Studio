import type { PipelineTemplate, WorkItem, WorkItemType } from '../../types.js';
import { bugFixPipeline } from './bug-fix.js';
import { driftAuditPipeline } from './drift-audit.js';
import { focusedChangePipeline } from './focused-change.js';
import { holisticAuditPipeline } from './holistic-audit.js';
import { quickFixPipeline } from './quick-fix.js';

/**
 * Registry of available pipeline templates.
 */
const pipelineRegistry: PipelineTemplate[] = [
  holisticAuditPipeline,
  bugFixPipeline,
  focusedChangePipeline,
  quickFixPipeline,
  driftAuditPipeline,
];

export interface PipelineSelectionResult {
  pipeline: PipelineTemplate;
  reason?: string;
}

/**
 * Select the best pipeline template for a given work item type.
 */
export function selectPipeline(workItemType: WorkItemType): PipelineTemplate {
  const match = pipelineRegistry.find((p) => p.applicableTo.includes(workItemType));
  if (!match) {
    throw new Error(`No pipeline template found for work item type: ${workItemType}`);
  }
  return match;
}

/**
 * Select the best pipeline template for a concrete work item.
 *
 * This adds a small-scope fast path for feature audits that look like a
 * targeted fix/change rather than a full holistic audit.
 */
export function selectPipelineForWorkItem(
  workItem: Pick<
    WorkItem,
    'type' | 'title' | 'description' | 'scope' | 'featureSpec' | 'testSpec' | 'hldSpec' | 'lldPlan'
  >,
): PipelineSelectionResult {
  const baseline = selectPipeline(workItem.type);

  if (!shouldUseFocusedChangePipeline(workItem)) {
    return { pipeline: baseline };
  }

  return {
    pipeline: focusedChangePipeline,
    reason:
      'small explicit feature-audit scope with fix-like language; routing to Focused Change fast path',
  };
}

/**
 * Get all available pipeline templates.
 */
export function listPipelines(): PipelineTemplate[] {
  return [...pipelineRegistry];
}

/**
 * Register a custom pipeline template.
 */
export function registerPipeline(pipeline: PipelineTemplate): void {
  pipelineRegistry.push(pipeline);
}

function shouldUseFocusedChangePipeline(
  workItem: Pick<
    WorkItem,
    'type' | 'title' | 'description' | 'scope' | 'featureSpec' | 'testSpec' | 'hldSpec' | 'lldPlan'
  >,
): boolean {
  if (workItem.type !== 'feature-audit') {
    return false;
  }

  if (workItem.featureSpec || workItem.testSpec || workItem.hldSpec || workItem.lldPlan) {
    return false;
  }

  const scope = workItem.scope.map((entry) => entry.trim()).filter(Boolean);
  if (scope.length === 0 || scope.length > 3) {
    return false;
  }

  const packageDirs = new Set(
    scope
      .map((entry) => {
        const match = entry.match(/^((?:apps|packages)\/[^/]+)/);
        return match?.[1];
      })
      .filter((entry): entry is string => Boolean(entry)),
  );
  if (packageDirs.size !== 1) {
    return false;
  }

  const targetedScope = scope.every(
    (entry) =>
      /^(?:apps|packages)\/[^/]+\/.+/.test(entry) &&
      (looksLikeFilePath(entry) || entry.split('/').length >= 4),
  );
  if (!targetedScope) {
    return false;
  }

  const intentText = `${workItem.title} ${workItem.description}`;
  return /\b(fix|bug|regression|broken|failing|failure|error|timeout|stuck|wrong|missing|leak|crash)\b/i.test(
    intentText,
  );
}

function looksLikeFilePath(value: string): boolean {
  return /\.[a-z0-9]+$/i.test(value);
}

export {
  bugFixPipeline,
  driftAuditPipeline,
  focusedChangePipeline,
  holisticAuditPipeline,
  quickFixPipeline,
};

/**
 * Look up a pipeline by name (case-insensitive, dash-separated). Used by
 * the --template CLI flag to override automatic selection.
 */
export function findPipelineByName(name: string): PipelineTemplate | undefined {
  const target = name.trim().toLowerCase().replace(/[\s_]/g, '-');
  return pipelineRegistry.find((p) => p.name.toLowerCase().replace(/[\s_]/g, '-') === target);
}
