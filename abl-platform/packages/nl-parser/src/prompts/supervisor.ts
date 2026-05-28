/**
 * Supervisor extraction prompts
 */

import type { ExtractionContext } from '../types.js';

/**
 * System prompt for supervisor extraction
 */
export const SUPERVISOR_EXTRACTION_SYSTEM = `You are an expert at converting natural language routing descriptions into structured supervisor definitions.

Your task is to analyze routing/orchestration text and extract:
1. State variables needed for routing decisions
2. Routing rules with priorities and conditions
3. Intent-to-agent mappings
4. Policies and guardrails

Output a JSON object following the exact schema provided.

Key rules:
- Routing rules should be ordered by priority (lower number = higher priority)
- Use clear condition expressions (e.g., "user.is_validated", "NOT user.is_validated AND session.channel == 'whatsapp'")
- Include a catch-all rule with condition "*" at the lowest priority
- Extract any business rules as policies
- Assign a confidence score (0-1) based on clarity of the source text`;

/**
 * User prompt template for supervisor extraction
 */
export function buildSupervisorExtractionPrompt(
  routingText: string,
  context: ExtractionContext,
): string {
  let prompt = `Extract a supervisor definition from this routing description:

---
${routingText}
---

`;

  if (context.existingAgents?.length) {
    prompt += `Available agents: ${context.existingAgents.join(', ')}\n`;
  }

  if (context.stateVariables?.length) {
    prompt += `Known state variables: ${context.stateVariables.join(', ')}\n`;
  }

  prompt += `
Return a JSON object with this exact structure:
{
  "name": "string - name for the supervisor",
  "description": "string - brief description",
  "confidence": "number 0-1",
  "state_variables": [
    {
      "namespace": "user|session|transfer|conversation",
      "name": "variable_name",
      "type": "string|number|boolean|enum(val1,val2)",
      "default_value": "optional default"
    }
  ],
  "routing_rules": [
    {
      "priority": 1,
      "condition": "expression like 'user.is_validated' or 'NOT user.is_validated'",
      "target": "AgentName or @action or {variable} or ?intent_match",
      "flags": ["set_active", "silent"]
    }
  ],
  "intent_mappings": [
    {
      "intents": ["intent1", "intent2"],
      "target_agent": "AgentName"
    }
  ],
  "policies": [
    {
      "name": "policy_name",
      "description": "what the policy enforces",
      "rules": {
        "allowed_when": "condition",
        "forbidden_when": "condition"
      }
    }
  ]
}

Important:
- Always include a catch-all rule with condition "*" at the highest priority number
- Routing is priority-based: lower number = evaluated first
- Common patterns:
  - Active agent: "conversation.active_agent IS SET" → "{active_agent}"
  - Validation gate: "NOT user.is_validated" → "User_Validator"
  - Intent routing: "user.is_validated" → "?intent_match"`;

  return prompt;
}
