/**
 * Agent extraction prompts
 */

import type { ExtractionContext } from '../types.js';

/**
 * System prompt for agent extraction
 */
export const AGENT_EXTRACTION_SYSTEM = `You are an expert at converting natural language Standard Operating Procedures (SOPs) into structured agent definitions.

Your task is to analyze SOP text and extract:
1. Agent identity (role, persona, expertise, limitations)
2. Workflow steps with their actions
3. Branching logic and conditions
4. Required tools and their signatures
5. Safety guardrails

Output a JSON object following the exact schema provided.

Key rules:
- Each step should have a clear action type: respond, call_tool, wait_input, classify, condition, set_state, or signal
- Steps should be numbered sequentially (1, 2, 3, etc.) with sub-steps for branches (1.1, 1.2)
- Infer tool signatures from the described operations
- Extract guardrails from any safety/compliance mentions
- Assign a confidence score (0-1) based on clarity of the source text`;

/**
 * User prompt template for agent extraction
 */
export function buildAgentExtractionPrompt(sopText: string, context: ExtractionContext): string {
  let prompt = `Extract an agent definition from this SOP:

---
${sopText}
---

`;

  if (context.existingTools?.length) {
    prompt += `Available tools to reference: ${context.existingTools.join(', ')}\n`;
  }

  if (context.stateVariables?.length) {
    prompt += `Available state variables: ${context.stateVariables.join(', ')}\n`;
  }

  prompt += `
Return a JSON object with this exact structure:
{
  "agent_name": "string - PascalCase name for the agent",
  "description": "string - brief description",
  "confidence": "number 0-1 - how confident you are in this extraction",
  "identity": {
    "role": "string - the agent's role",
    "persona": "string - personality/tone description",
    "expertise": ["array of expertise areas"],
    "limitations": ["array of things the agent should NOT do"]
  },
  "steps": [
    {
      "number": 1,
      "name": "STEP_NAME",
      "description": "what this step does",
      "action_type": "respond|call_tool|wait_input|classify|condition|set_state|signal",
      "action_details": {
        // For respond: { "message": "template string" }
        // For call_tool: { "tool": "tool_name", "params": {} }
        // For wait_input: { "routes": { "POSITIVE": 2, "NEGATIVE": 3 } }
        // For classify: { "intents": { "intent1": 2, "intent2": 3 } }
        // For condition: { "when": "condition expression", "then_step": 2, "else_step": 3 }
        // For set_state: { "updates": { "var.path": "value" } }
        // For signal: { "signal": "CONTINUE|COMPLETE|HANDOFF_READY|ESCALATE" }
      },
      "branches": [
        { "condition": "description of when", "target_step": 2 }
      ]
    }
  ],
  "guardrails": [
    {
      "name": "guardrail_name",
      "type": "input|output|behavioral",
      "check": "what to check for",
      "action": "block|warn|redact"
    }
  ],
  "inferred_tools": [
    {
      "name": "tool_name",
      "description": "what the tool does",
      "parameters": [
        { "name": "param", "type": "string|number|boolean", "required": true }
      ],
      "returns": "description of return value"
    }
  ]
}`;

  return prompt;
}
