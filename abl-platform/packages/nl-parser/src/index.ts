/**
 * @abl/nl-parser
 *
 * Natural language to ABL (Agent Blueprint Language) conversion using LLM
 */

// Export types
export type {
  ExtractedStep,
  InferredTool,
  AgentExtraction,
  ExtractedRoutingRule,
  SupervisorExtraction,
  ExtractionContext,
  ReviewItem,
  ReviewSession,
} from './types.js';

export {
  ExtractedStepSchema,
  InferredToolSchema,
  AgentExtractionSchema,
  ExtractedRoutingRuleSchema,
  SupervisorExtractionSchema,
} from './types.js';

// Export extractor
export { NLExtractor, createExtractor, generateReviewSession } from './extractor.js';
export type { ExtractorConfig } from './extractor.js';

// Export generator (ABL)
export {
  ABLGenerator,
  createGenerator,
  generateAgentABL,
  generateSupervisorABL,
  // Legacy exports for backward compatibility
  DSLGenerator,
  generateAgentDSL,
  generateSupervisorDSL,
} from './generator.js';

// Export prompts for customization
export { AGENT_EXTRACTION_SYSTEM, buildAgentExtractionPrompt } from './prompts/agent.js';
export {
  SUPERVISOR_EXTRACTION_SYSTEM,
  buildSupervisorExtractionPrompt,
} from './prompts/supervisor.js';
