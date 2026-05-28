/**
 * Stage Insertion Rules
 *
 * Position-aware logic for determining which pipeline stage types can be
 * inserted at a given position within a flow. Stages follow a fixed order:
 * Extraction -> Chunking -> Enrichment.
 */

import type { PipelineStage } from '../../../../api/pipelines';

// =============================================================================
// TYPES
// =============================================================================

export interface InsertPosition {
  flowId: string;
  afterStageId: string | null; // null = before first stage (after router)
  beforeStageId: string | null; // null = after last stage (before merge)
}

export interface InsertOption {
  stageType: string;
  label: string;
  description: string;
  disabled: boolean;
  disabledReason?: string;
}

// =============================================================================
// FIXED STAGE ORDER
// =============================================================================

/** The fixed pipeline stage order. Lower index = earlier in pipeline. */
const STAGE_ORDER: readonly string[] = [
  'extraction',
  'chunking',
  'content-intelligence',
  'visual-analysis',
  'enrichment',
];

/** Utility stages are order-free and allow duplicates at any position. */
export const UTILITY_STAGES: readonly string[] = ['field-mapping', 'api-webhook', 'llm-stage'];

/** Check whether a stage type is a utility (order-free) stage. */
export function isUtilityStage(type: string): boolean {
  return (UTILITY_STAGES as readonly string[]).includes(type);
}

function stageOrderIndex(stageType: string): number {
  const idx = STAGE_ORDER.indexOf(stageType);
  return idx >= 0 ? idx : -1;
}

// =============================================================================
// DEFAULT PROVIDERS
// =============================================================================

const DEFAULT_PROVIDERS: Record<string, string> = {
  extraction: 'docling',
  chunking: 'recursive-character',
  enrichment: 'llm-enrichment',
  'content-intelligence': 'content-intelligence',
  'visual-analysis': 'visual-analysis',
  'field-mapping': 'field-mapping',
  'api-webhook': 'api-webhook',
  'llm-stage': 'llm-stage',
};

export function getDefaultProvider(stageType: string): string {
  return DEFAULT_PROVIDERS[stageType] ?? stageType;
}

// =============================================================================
// STAGE DESCRIPTIONS (keys for i18n — caller maps to translated strings)
// =============================================================================

const STAGE_DESCRIPTION_KEYS: Record<string, string> = {
  extraction: 'v2_insert_extraction_desc',
  chunking: 'v2_insert_chunking_desc',
  enrichment: 'v2_insert_enrichment_desc',
  'content-intelligence': 'v2_insert_content_intelligence_desc',
  'visual-analysis': 'v2_insert_visual_analysis_desc',
  'field-mapping': 'v2_insert_field_mapping_desc',
  'api-webhook': 'v2_insert_api_webhook_desc',
  'llm-stage': 'v2_insert_llm_stage_desc',
};

const STAGE_LABEL_KEYS: Record<string, string> = {
  extraction: 'v2_insert_extraction',
  chunking: 'v2_insert_chunking',
  enrichment: 'v2_insert_enrichment',
  'content-intelligence': 'v2_insert_content_intelligence',
  'visual-analysis': 'v2_insert_visual_analysis',
  'field-mapping': 'v2_insert_field_mapping',
  'api-webhook': 'v2_insert_api_webhook',
  'llm-stage': 'v2_insert_llm_stage',
};

export function getStageLabelKey(stageType: string): string {
  return STAGE_LABEL_KEYS[stageType] ?? stageType;
}

export function getStageDescriptionKey(stageType: string): string {
  return STAGE_DESCRIPTION_KEYS[stageType] ?? stageType;
}

// =============================================================================
// INSERTION LOGIC
// =============================================================================

/**
 * Determine which stage types can be inserted at the given position.
 *
 * The general rule: a stage type T can be inserted between `before` and `after`
 * if T's order is >= the order of the stage before and <= the order of the
 * stage after. If before is null (router), any type from the start is allowed.
 * If after is null (merge), any type from the end is allowed.
 *
 * Stages that already exist at the exact same type within the flow are
 * marked as disabled.
 */
export function getValidInsertOptions(
  position: InsertPosition,
  existingStages: PipelineStage[],
  t: (key: string) => string,
): InsertOption[] {
  const beforeStage = position.afterStageId
    ? existingStages.find((s) => s.id === position.afterStageId)
    : null;
  const afterStage = position.beforeStageId
    ? existingStages.find((s) => s.id === position.beforeStageId)
    : null;

  // Determine the order bounds
  const minOrder = beforeStage ? stageOrderIndex(beforeStage.type) : 0;
  const maxOrder = afterStage ? stageOrderIndex(afterStage.type) : STAGE_ORDER.length - 1;

  // Collect existing stage types in the flow for disabled check
  const existingTypes = new Set(existingStages.map((s) => s.type));

  const options: InsertOption[] = [];

  for (const stageType of STAGE_ORDER) {
    const order = stageOrderIndex(stageType);
    if (order < 0) continue;

    // Must fit within the position bounds
    if (order < minOrder || order > maxOrder) continue;

    const alreadyPresent = existingTypes.has(stageType);

    options.push({
      stageType,
      label: t(getStageLabelKey(stageType)),
      description: t(getStageDescriptionKey(stageType)),
      disabled: alreadyPresent,
      disabledReason: alreadyPresent ? t('v2_insert_already_present') : undefined,
    });
  }

  // Utility stages are order-free and always available (duplicates allowed)
  for (const stageType of UTILITY_STAGES) {
    options.push({
      stageType,
      label: t(getStageLabelKey(stageType)),
      description: t(getStageDescriptionKey(stageType)),
      disabled: false,
    });
  }

  return options;
}
