/**
 * NL Parser types
 */

import { z } from 'zod';

/**
 * Extracted step from natural language
 */
export const ExtractedStepSchema = z.object({
  number: z.number(),
  name: z.string(),
  description: z.string(),
  action_type: z.enum([
    'respond',
    'call_tool',
    'wait_input',
    'classify',
    'condition',
    'set_state',
    'signal',
  ]),
  action_details: z.record(z.any()),
  branches: z.array(
    z.object({
      condition: z.string(),
      target_step: z.union([z.number(), z.string()]),
    }),
  ),
});

export type ExtractedStep = z.infer<typeof ExtractedStepSchema>;

/**
 * Inferred tool from natural language
 */
export const InferredToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      required: z.boolean(),
    }),
  ),
  returns: z.string(),
});

export type InferredTool = z.infer<typeof InferredToolSchema>;

/**
 * Agent extraction result
 */
export const AgentExtractionSchema = z.object({
  agent_name: z.string(),
  description: z.string(),
  confidence: z.number().min(0).max(1),
  identity: z.object({
    role: z.string(),
    persona: z.string().optional(),
    expertise: z.array(z.string()),
    limitations: z.array(z.string()),
  }),
  steps: z.array(ExtractedStepSchema),
  guardrails: z.array(
    z.object({
      name: z.string(),
      type: z.enum(['input', 'output', 'behavioral']),
      check: z.string(),
      action: z.enum(['block', 'warn', 'redact']),
    }),
  ),
  inferred_tools: z.array(InferredToolSchema),
});

export type AgentExtraction = z.infer<typeof AgentExtractionSchema>;

/**
 * Extracted routing rule
 */
export const ExtractedRoutingRuleSchema = z.object({
  priority: z.number(),
  condition: z.string(),
  target: z.string(),
  context_fields: z.array(z.string()).optional(),
  flags: z.array(z.string()).optional(),
});

export type ExtractedRoutingRule = z.infer<typeof ExtractedRoutingRuleSchema>;

/**
 * Supervisor extraction result
 */
export const SupervisorExtractionSchema = z.object({
  name: z.string(),
  description: z.string(),
  confidence: z.number().min(0).max(1),
  state_variables: z.array(
    z.object({
      namespace: z.string(),
      name: z.string(),
      type: z.string(),
      default_value: z.any().optional(),
    }),
  ),
  routing_rules: z.array(ExtractedRoutingRuleSchema),
  intent_mappings: z.array(
    z.object({
      intents: z.array(z.string()),
      target_agent: z.string(),
    }),
  ),
  policies: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      rules: z.record(z.string()),
    }),
  ),
});

export type SupervisorExtraction = z.infer<typeof SupervisorExtractionSchema>;

/**
 * Extraction context
 */
export interface ExtractionContext {
  existingAgents?: string[];
  existingTools?: string[];
  stateVariables?: string[];
  language?: string;
}

/**
 * Review item for human verification
 */
export interface ReviewItem {
  type: 'confirm' | 'clarify' | 'choose' | 'warn';
  element: string;
  question: string;
  options?: string[];
  originalText: string;
  extractedValue: any;
}

/**
 * Review session
 */
export interface ReviewSession {
  documentType: 'agent' | 'supervisor';
  items: ReviewItem[];
  extraction: AgentExtraction | SupervisorExtraction;
}
