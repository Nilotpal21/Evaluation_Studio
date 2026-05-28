/**
 * Prompt Catalog — Re-exports from @agent-platform/shared/prompts.
 *
 * The canonical implementation lives in the shared package.
 * This file exists for backward compatibility with existing runtime imports.
 */
export {
  PromptCatalog,
  type SystemPromptKey,
  type MessageKey,
  type ToolSchemaKey,
  type LLMPromptKey,
} from '@agent-platform/shared/prompts';
