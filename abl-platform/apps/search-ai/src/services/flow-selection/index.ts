/**
 * Flow Selection Module
 *
 * Priority-based flow selection with CEL expression evaluation.
 *
 * ## Quick Start
 *
 * ```typescript
 * import { FlowSelectionService } from './flow-selection';
 *
 * const service = new FlowSelectionService();
 * const result = await service.selectFlow(pipeline.flows, {
 *   document: { extension: 'pdf', mimeType: 'application/pdf', size: 1048576, name: 'doc.pdf' },
 *   source: { connector: 'google-drive' },
 * });
 *
 * if (result.success) {
 *   console.log('Selected flow:', result.flow.name);
 * }
 * ```
 *
 * ## Features
 *
 * - Priority-based ordering (highest priority first)
 * - Simple operator matching (eq, ne, gt, lt, contains, etc.)
 * - Compound logic (AND/OR)
 * - CEL expression evaluation (maximum flexibility)
 * - Fail-safe error handling
 * - 5-second timeout on CEL evaluation
 *
 * Reference: docs/searchai/pipelines/design/backend/01-DATA-MODELS.md
 */

export { FlowSelectionService } from './flow-selection.service.js';
export {
  type FlowContext,
  type FlowSelectionResult,
  type RuleEvaluationResult,
  CELEvaluationError,
  NoFlowMatchedError,
  FlowSelectionTimeoutError,
} from './types.js';
