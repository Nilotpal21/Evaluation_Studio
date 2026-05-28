/**
 * @abl/conversation-testing — LLM-driven conversation testing for insights pipeline seeding.
 *
 * Public API:
 *   - generateScenarios(llm, config) — generate N diverse scenarios via one LLM call
 *   - runConversation(sdkToken, scenario, llm, opts) — drive a single persona conversation
 *   - pickLLMFromEnv() — create an LLM client from environment variables
 *   - makeLimit(n) — bounded concurrency limiter
 *   - PRESETS, PRESET_NAMES, DEFAULT_PRESET — behavioral preset catalog
 *   - buildScenarioPrompt, buildPersonaPrompt, formatHistory, detectEndSentinel — prompt utilities
 */

export { generateScenarios } from './scenario-generator.js';
export { runConversation } from './conversation-runner.js';
export { pickLLMFromEnv } from './llm/index.js';
export { makeLimit } from './concurrency.js';
export { PRESETS, PRESET_NAMES, DEFAULT_PRESET } from './presets.js';
export {
  buildScenarioPrompt,
  buildPersonaPrompt,
  formatHistory,
  detectEndSentinel,
} from './prompt-builder.js';
export type {
  Scenario,
  AgentSummary,
  SlotAssignment,
  TranscriptMessage,
  Transcript,
  TranscriptOutcome,
  LLMClient,
  LLMMessage,
  RunConfig,
  DomainContext,
  ConversationRunnerOpts,
  PresetName,
} from './types.js';
