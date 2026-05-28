/**
 * Progressive Disclosure - User prompt system
 *
 * Exports:
 * - Interfaces: IPromptEvaluator, PromptEvaluation, UserDisclosureSettings
 * - Implementations: PromptEvaluator
 * - Errors: DisclosureError
 */

export {
  // Interfaces
  type IPromptEvaluator,
  type IUserDisclosureSettingsStore,
  type PromptEvaluation,
  type UserDisclosureSettings,
  type CrawlHistory,

  // Error
  DisclosureError,
} from './interfaces.js';

export {
  // Core implementation
  PromptEvaluator,
  type PromptEvaluatorOptions,
} from './prompt-evaluator.js';

export {
  // Question generation
  QuestionGenerator,
  type QuestionGeneratorOptions,
  type PromptQuestion,
  type QuestionOption,
  type QuestionType,
} from './question-generator.js';

export {
  // Response processing
  ResponseProcessor,
  type ResponseProcessorOptions,
  type QuestionResponse,
  type ResponseApplicationResult,
} from './response-processor.js';
