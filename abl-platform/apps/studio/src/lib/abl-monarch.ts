/**
 * ABL Monarch Tokenizers
 *
 * Provides syntax highlighting definitions for Monaco's Monarch tokenizer engine.
 * Two tokenizers are exported:
 *
 * - ablUppercaseTokenizer: handles the uppercase ABL domain DSL format (AGENT:, TOOLS:, FLOW:, etc.)
 * - ablYamlTokenizer: handles the lowercase YAML-based ABL format (agent:, tools:, flow:, etc.)
 *
 * Usage:
 *   import { ablUppercaseTokenizer, ablYamlTokenizer } from '@/lib/abl-monarch';
 *   monaco.languages.setMonarchTokensProvider('abl', isYaml ? ablYamlTokenizer : ablUppercaseTokenizer);
 */

import type { languages } from 'monaco-editor';

/**
 * Uppercase ABL tokenizer for the domain DSL format.
 *
 * Handles section keywords (AGENT, TOOLS, FLOW, etc.), sub-keywords (WHEN, TO, etc.),
 * comments, strings, numbers, booleans, arrows, and template variables.
 */
export const ablUppercaseTokenizer: languages.IMonarchLanguage = {
  tokenizer: {
    root: [
      // Comments
      [/#.*$/, 'comment'],
      [/\/\/.*$/, 'comment'],

      // Section keywords (top-level)
      [
        /\b(AGENT|SUPERVISOR|MODE|GOAL|PERSONA|IDENTITY|LIMITATIONS|TOOLS|GATHER|MEMORY|CONSTRAINTS|FLOW|STEPS|DELEGATE|HANDOFF|ESCALATE|COMPLETE|ON_ERROR|ON_START|GUARDRAILS|TESTS)\b/,
        'keyword',
      ],

      // Sub-keywords
      [
        /\b(WHEN|TO|RESPOND|STORE|RETURN|REQUIRE|ON_FAIL|ON_SUCCESS|THEN|CALL|CHECK|COLLECT|INPUT|RETURNS|PURPOSE|REASON|PRIORITY|TIMEOUT|TTL|CONTEXT|ON_INPUT|PROMPT|PRESENT|SET|IF|ELSE|FIELDS|STRATEGY|AS)\b/,
        'type.identifier',
      ],

      // Booleans
      [/\b(true|false)\b/, 'constant'],

      // Numbers
      [/\b\d+(\.\d+)?\b/, 'number'],

      // Strings
      [/"([^"\\]|\\.)*"/, 'string'],
      [/'([^'\\]|\\.)*'/, 'string'],

      // Arrows
      [/->|=>|→/, 'operator'],

      // Variable references
      [/\{\{[^}]+\}\}/, 'variable'],
      [/\$\{[^}]+\}/, 'variable'],

      // Identifiers
      [/[a-zA-Z_][a-zA-Z0-9_]*/, 'identifier'],
    ],
  },
};

/**
 * YAML ABL tokenizer for the lowercase YAML-based DSL format.
 *
 * Handles YAML structure (keys, values, lists, block scalars) with ABL-specific
 * highlighting for top-level and sub-level keys, template variables, and
 * CEL-like expressions.
 */
export const ablYamlTokenizer: languages.IMonarchLanguage = {
  tokenizer: {
    root: [
      // Comments
      [/#.*$/, 'comment'],

      // Template variables (before other rules so they take priority in values)
      [/\{\{[^}]+\}\}/, 'variable'],
      [/\$\{[^}]+\}/, 'variable'],

      // Top-level ABL keys at start of line (no indentation)
      [
        /^(agent|supervisor|mode|goal|persona|identity|limitations|tools|gather|memory|constraints|flow|steps|delegate|handoff|escalate|complete|on_error|on_start|guardrails|tests)\s*:/,
        'keyword',
      ],

      // Sub-keys (indented, followed by colon)
      [
        /^\s+(entry_point|fields|strategy|rule|action|to|respond|call|then|when|store|return|require|on_fail|on_success|check|collect|input|returns|purpose|reason|priority|timeout|ttl|context|on_input|prompt|present|set|if|else|as|name|type|description|steps|next|condition|success_when|fail_when|max_retries|retry_delay|parameters|required|optional|default|validation|extraction_hints|confirm|format|message|target|routing|agents|model|temperature|max_tokens|system_prompt|constraints|tools|handoffs|escalations)\s*:/,
        'type.identifier',
      ],

      // YAML block scalar indicators
      [/[|>][-+]?\s*$/, 'operator'],

      // YAML list item dash
      [/^\s*-\s/, 'operator'],

      // Booleans and null
      [/\b(true|false|yes|no|null)\b/, 'constant'],

      // Numbers
      [/\b\d+(\.\d+)?\b/, 'number'],

      // Quoted strings
      [/"([^"\\]|\\.)*"/, 'string'],
      [/'([^'\\]|\\.)*'/, 'string'],

      // Arrows (used in some ABL expressions)
      [/->|=>|→/, 'operator'],

      // CEL-like dotted expressions (context.user.tier, abl.something)
      [/\b(context|abl)\.[a-zA-Z_][a-zA-Z0-9_.]*/, 'variable'],

      // Generic key: value pattern (unindented keys not in the ABL keyword list)
      [/^[a-zA-Z_][a-zA-Z0-9_]*\s*:/, 'identifier'],

      // Identifiers
      [/[a-zA-Z_][a-zA-Z0-9_]*/, 'identifier'],
    ],
  },
};
