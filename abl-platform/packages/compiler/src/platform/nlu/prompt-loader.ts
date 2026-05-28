/**
 * Prompt Loader
 *
 * Loads and renders YAML prompt templates for NLU tasks.
 * Supports embedded defaults and external file overrides.
 */

import { readFileSync, existsSync } from 'fs';
import type { PromptTemplate } from './types.js';

// =============================================================================
// EMBEDDED DEFAULT PROMPTS
// =============================================================================

const EMBEDDED_DEFAULTS: Record<string, PromptTemplate> = {
  intent: {
    system: `You are an NLU intent classification engine for a "{{agentGoal}}" agent.
{{#if agentDomain}}Domain: {{agentDomain}}{{/if}}
{{#if glossary}}Terminology: {{glossary}}{{/if}}
{{#if language}}The user speaks {{language}}.{{/if}}
Conversation phase: {{conversationPhase}}
{{#if pendingQuestion}}Agent last asked: "{{pendingQuestion}}"{{/if}}
Already collected: {{collectedData}}
{{#if missingFields}}Still needed: {{missingFields}}{{/if}}
{{#if fewShotExamples}}
Examples:
{{fewShotExamples}}
{{/if}}
Available intents:
{{intents}}
Classify the user's message into ALL matching intents from the available list.
Return JSON:
{"intents": [{"intent": "intent_name", "confidence": 0.0-1.0}, ...], "relationships": {"type": "independent"|"dependent"|"ambiguous", "reasoning": "brief explanation"}}
If only one intent matches, return a single entry in the intents array.
Only include intents with confidence >= 0.5.
If no intent matches, return: {"intents": [{"intent": "none", "confidence": 1.0}], "relationships": {"type": "ambiguous", "reasoning": ""}}`,
  },

  entity: {
    system: `You are an NLU entity extraction engine for a "{{agentGoal}}" agent.
{{#if agentDomain}}Domain: {{agentDomain}}{{/if}}
{{#if glossary}}Terminology: {{glossary}}{{/if}}
{{#if language}}The user speaks {{language}}.{{/if}}
Conversation phase: {{conversationPhase}}
{{#if pendingQuestion}}Agent last asked: "{{pendingQuestion}}"{{/if}}
Already collected: {{collectedData}}
{{#if missingFields}}Focus on extracting: {{missingFields}}{{/if}}
Extract the following entities from the user's message:
{{entityFields}}
{{#if entityDefinitions}}
Custom entity types:
{{entityDefinitions}}
{{/if}}
Rules:
- Only extract values clearly stated by the user
- Use null for values not found
- Normalize synonyms to canonical values
- Respect locale for dates, numbers, currency
Respond ONLY with JSON matching the requested fields.`,
  },

  correction: {
    system: `You are a correction detection engine for a "{{agentGoal}}" agent.
{{#if language}}The user speaks {{language}}.{{/if}}
The agent has already collected:
{{collectedData}}
{{#if pendingQuestion}}Agent last asked: "{{pendingQuestion}}"{{/if}}
Determine if the user is correcting a previously provided value.
Look for: "actually X", "no, Y", "I meant Z", "change it to W".
Respond ONLY with JSON: {"detected": true/false, "field": "field_name_or_null", "newValue": "value_or_null", "confidence": 0.0-1.0}`,
  },

  category: {
    system: `You are a message category classifier for a "{{agentGoal}}" agent.
{{#if language}}The user speaks {{language}}.{{/if}}
Classify the user's message into one of these categories:
{{categories}}
If no category matches, use "none".
Respond ONLY with JSON: {"category": "name_or_none", "confidence": 0.0-1.0}`,
  },

  combined: {
    system: `You are a comprehensive NLU engine for a "{{agentGoal}}" agent.
{{#if agentDomain}}Domain: {{agentDomain}}{{/if}}
{{#if glossary}}Terminology: {{glossary}}{{/if}}
{{#if language}}The user speaks {{language}}.{{/if}}
Conversation phase: {{conversationPhase}}
{{#if pendingQuestion}}Agent last asked: "{{pendingQuestion}}"{{/if}}
Already collected: {{collectedData}}
{{#if missingFields}}Still needed: {{missingFields}}{{/if}}
{{#if fewShotExamples}}
Examples:
{{fewShotExamples}}
{{/if}}
Analyze the user's message and provide a JSON response with the requested fields.`,
  },

  language: {
    system: `Detect the language(s) of the following message.
If the message mixes languages (code-switching), identify each segment.
Respond ONLY with JSON:
{"primary": "xx", "secondary": "yy_or_null", "isCodeSwitched": true/false, "confidence": 0.0-1.0}
Use ISO 639-1 two-letter codes (en, es, fr, de, ar, zh, ja, ko, etc.).`,
  },
};

// =============================================================================
// TEMPLATE RENDERING
// =============================================================================

/**
 * Simple Handlebars-like template rendering.
 * Supports: {{var}}, {{#if var}}...{{/if}}, {{#each arr}}...{{/each}}
 */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  let result = template;

  // Process {{#if var}}...{{/if}} blocks
  result = result.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, varName, content) => {
    const value = vars[varName];
    if (value !== undefined && value !== null && value !== '' && value !== false) {
      return renderTemplate(content, vars);
    }
    return '';
  });

  // Process {{#each arr}}...{{/each}} blocks
  result = result.replace(
    /\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_, varName, content) => {
      const arr = vars[varName];
      if (Array.isArray(arr)) {
        return arr
          .map((item, idx) => {
            const itemVars =
              typeof item === 'object' && item !== null
                ? { ...vars, this: item, '@index': idx, ...item }
                : { ...vars, this: item, '@index': idx };
            return renderTemplate(content, itemVars);
          })
          .join('');
      }
      return '';
    },
  );

  // Replace simple {{var}} placeholders
  result = result.replace(/\{\{(\w+)\}\}/g, (_, varName) => {
    const value = vars[varName];
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });

  // Clean up multiple blank lines
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

// =============================================================================
// LOADER
// =============================================================================

/**
 * Load a prompt template from external file or embedded defaults
 */
export function loadPromptTemplate(taskName: string, overridePath?: string): PromptTemplate {
  if (overridePath && existsSync(overridePath)) {
    try {
      const content = readFileSync(overridePath, 'utf-8');
      return parseSimpleYAML(content);
    } catch {
      // Fall through to embedded defaults
    }
  }

  const embedded = EMBEDDED_DEFAULTS[taskName];
  if (embedded) {
    return embedded;
  }

  // Return a minimal fallback
  return {
    system: `Analyze the user's message and respond with JSON.`,
  };
}

/**
 * Get all embedded prompt templates
 */
export function getEmbeddedPrompts(): Record<string, PromptTemplate> {
  return { ...EMBEDDED_DEFAULTS };
}

// =============================================================================
// SIMPLE YAML PARSER (for prompt templates only)
// =============================================================================

/**
 * Parse a simple YAML prompt template file.
 * Supports top-level keys with multiline string values (using |).
 */
function parseSimpleYAML(content: string): PromptTemplate {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');
  let currentKey: string | null = null;
  let currentValue: string[] = [];
  let isMultiline = false;

  for (const line of lines) {
    // Top-level key with pipe (multiline string)
    const pipeMatch = line.match(/^(\w+):\s*\|$/);
    if (pipeMatch) {
      if (currentKey && isMultiline) {
        result[currentKey] = currentValue.join('\n').trim();
      }
      currentKey = pipeMatch[1];
      currentValue = [];
      isMultiline = true;
      continue;
    }

    // Top-level key with inline value
    const inlineMatch = line.match(/^(\w+):\s*(.+)$/);
    if (inlineMatch && !isMultiline) {
      if (currentKey && isMultiline) {
        result[currentKey] = currentValue.join('\n').trim();
      }
      currentKey = inlineMatch[1];
      result[currentKey] = inlineMatch[2].trim();
      isMultiline = false;
      continue;
    }

    // Continuation of multiline value
    if (isMultiline && currentKey) {
      // Check for end of multiline (new top-level key)
      if (line.match(/^\w+:/) && !line.startsWith('  ')) {
        result[currentKey] = currentValue.join('\n').trim();
        isMultiline = false;
        currentKey = null;
        // Re-process this line
        const reMatch = line.match(/^(\w+):\s*(.*)$/);
        if (reMatch) {
          currentKey = reMatch[1];
          if (reMatch[2] === '|') {
            currentValue = [];
            isMultiline = true;
          } else {
            result[currentKey] = reMatch[2].trim();
          }
        }
      } else {
        // Remove leading indentation (2 spaces)
        currentValue.push(line.startsWith('  ') ? line.slice(2) : line);
      }
    }
  }

  // Flush last key
  if (currentKey && isMultiline) {
    result[currentKey] = currentValue.join('\n').trim();
  }

  return {
    system: (result.system as string) || '',
    schema: result.schema as Record<string, unknown> | undefined,
    user: result.user as string | undefined,
  };
}
