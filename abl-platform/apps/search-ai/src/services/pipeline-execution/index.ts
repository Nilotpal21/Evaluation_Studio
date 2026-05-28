/**
 * Pipeline Execution Module
 *
 * Exports the Pipeline Execution Service for use by workers.
 */

export {
  PipelineExecutionService,
  type PipelineExecutionContext,
  type StageInput,
  type StageResult,
  type PipelineExecutionResult,
} from './pipeline-execution.service.js';

export { executeCustomEnrichmentStages } from './execute-custom-stages.js';
