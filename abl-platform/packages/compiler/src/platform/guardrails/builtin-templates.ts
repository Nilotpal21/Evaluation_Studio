/**
 * Built-in prompt injection detection guardrail templates.
 *
 * These templates provide out-of-the-box protection against common
 * prompt injection patterns. They use CEL expressions with `abl.matches_pattern`
 * for regex-based detection, running as Tier 1 (local) checks for zero-cost,
 * low-latency evaluation.
 *
 * Each template is a complete Guardrail definition that can be merged into
 * an agent's guardrail set via policy `additionalGuardrails`.
 */

import type { Guardrail } from '../ir/schema.js';

/**
 * Built-in guardrail templates keyed by identifier.
 *
 * - `detect_instruction_override`: Catches "ignore previous instructions"-style attacks
 * - `detect_role_manipulation`: Catches "you are now / act as / pretend"-style attacks
 * - `detect_system_prompt_extraction`: Catches "what is your system prompt"-style attacks
 * - `detect_encoding_tricks`: Catches base64/rot13/hex obfuscation attempts
 * - `detect_credential_leak`: Catches leaked API keys, Bearer tokens, private keys in output
 */
export const BUILTIN_GUARDRAIL_TEMPLATES: Record<string, Guardrail> = {
  detect_instruction_override: {
    name: 'detect_instruction_override',
    description: 'Detects attempts to override or ignore system instructions',
    kind: 'input',
    tier: 'local',
    priority: 5,
    check:
      'abl.matches_pattern(abl.lower(input), "(ignore|disregard|forget|override|bypass|skip|delete|erase)(\\\\s+\\\\w+){0,3}\\\\s+(previous|prior|above|earlier|original|existing|system|initial)(\\\\s+\\\\w+){0,2}\\\\s+(instructions|prompts?|rules?|guidelines?|directives?|context)")',
    action: { type: 'warn', message: 'Potential instruction override attempt detected' },
  },

  detect_role_manipulation: {
    name: 'detect_role_manipulation',
    description: 'Detects attempts to manipulate the AI role or persona',
    kind: 'input',
    tier: 'local',
    priority: 6,
    check:
      'abl.matches_pattern(abl.lower(input), "(you\\\\s+are\\\\s+now|act\\\\s+as\\\\s+(if\\\\s+you|a\\\\s+|an\\\\s+|my\\\\s+)|pretend\\\\s+(you\\\\s+are|to\\\\s+be\\\\s+a|that\\\\s+you)|imagine\\\\s+you\\\\s+are|roleplay\\\\s+as|from\\\\s+now\\\\s+on\\\\s+you|switch\\\\s+to\\\\s+.*?\\\\s+mode)")',
    action: { type: 'warn', message: 'Potential role manipulation attempt detected' },
  },

  detect_system_prompt_extraction: {
    name: 'detect_system_prompt_extraction',
    description: 'Detects attempts to extract the system prompt',
    kind: 'input',
    tier: 'local',
    priority: 5,
    check:
      'abl.matches_pattern(abl.lower(input), "(what\\\\s+(is|are)\\\\s+your\\\\s+(system\\\\s+)?prompt|repeat\\\\s+your\\\\s+(instructions|prompt|system)|show\\\\s+(me\\\\s+)?your\\\\s+(instructions|prompt|system)|display\\\\s+your\\\\s+(initial|system|original)\\\\s+(prompt|instructions)|print\\\\s+your\\\\s+(system|initial)\\\\s+(message|prompt))")',
    action: { type: 'warn', message: 'Potential system prompt extraction attempt detected' },
  },

  detect_encoding_tricks: {
    name: 'detect_encoding_tricks',
    description: 'Detects encoding-based obfuscation attempts (base64, rot13, hex)',
    kind: 'input',
    tier: 'local',
    priority: 7,
    check:
      'abl.matches_pattern(abl.lower(input), "(base64|rot13|hex\\\\s*encod|decode\\\\s+this|encode\\\\s+this|convert\\\\s+(to|from)\\\\s+(base64|hex|rot13))") || abl.matches_pattern(input, "[A-Za-z0-9+/]{80,}={0,2}")',
    action: { type: 'warn', message: 'Potential encoding-based obfuscation detected' },
  },

  detect_credential_leak: {
    name: 'detect_credential_leak',
    description: 'Detects leaked credentials, API keys, or tokens in output',
    kind: 'output',
    tier: 'local',
    priority: 3,
    check:
      'abl.matches_pattern(output, "(sk-[a-zA-Z0-9]{20,}|api_key\\\\s*=\\\\s*[\\\\S]{8,}|Bearer\\\\s+[a-zA-Z0-9._\\\\-]{20,}|-----BEGIN\\\\s+(RSA\\\\s+)?PRIVATE\\\\s+KEY-----)")',
    action: { type: 'redact', message: 'Credential or secret detected in output' },
  },
};

/**
 * Returns all built-in guardrail templates as an array.
 * Useful for merging into an agent's guardrail set.
 */
export function getBuiltinGuardrailTemplates(): Guardrail[] {
  return Object.values(BUILTIN_GUARDRAIL_TEMPLATES);
}
