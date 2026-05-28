/**
 * NL Extractor - uses Claude API to extract structured data from text
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  AgentExtraction,
  SupervisorExtraction,
  ExtractionContext,
  ReviewSession,
  ReviewItem,
} from './types.js';
import { AgentExtractionSchema, SupervisorExtractionSchema } from './types.js';
import { AGENT_EXTRACTION_SYSTEM, buildAgentExtractionPrompt } from './prompts/agent.js';
import {
  SUPERVISOR_EXTRACTION_SYSTEM,
  buildSupervisorExtractionPrompt,
} from './prompts/supervisor.js';

/**
 * NL Extractor configuration
 */
export interface ExtractorConfig {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

/**
 * NL Extractor class
 */
export class NLExtractor {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;

  constructor(config: ExtractorConfig = {}) {
    this.client = new Anthropic({
      apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY,
    });
    this.model = config.model ?? 'claude-sonnet-4-20250514';
    this.maxTokens = config.maxTokens ?? 4096;
  }

  /**
   * Extract agent definition from natural language
   */
  async extractAgent(sopText: string, context: ExtractionContext = {}): Promise<AgentExtraction> {
    const prompt = buildAgentExtractionPrompt(sopText, context);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: AGENT_EXTRACTION_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });

    // Extract JSON from response
    if (!response.content || response.content.length === 0) {
      throw new Error('Empty response from API');
    }
    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content.text);
    } catch {
      const jsonMatch = content.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }
      parsed = JSON.parse(jsonMatch[0]);
    }

    const validated = AgentExtractionSchema.parse(parsed);

    return validated;
  }

  /**
   * Extract supervisor definition from natural language
   */
  async extractSupervisor(
    routingText: string,
    context: ExtractionContext = {},
  ): Promise<SupervisorExtraction> {
    const prompt = buildSupervisorExtractionPrompt(routingText, context);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: SUPERVISOR_EXTRACTION_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });

    // Extract JSON from response
    if (!response.content || response.content.length === 0) {
      throw new Error('Empty response from API');
    }
    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content.text);
    } catch {
      const jsonMatch = content.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }
      parsed = JSON.parse(jsonMatch[0]);
    }

    const validated = SupervisorExtractionSchema.parse(parsed);

    return validated;
  }
}

/**
 * Generate review session from extraction
 */
export function generateReviewSession(
  originalText: string,
  extraction: AgentExtraction | SupervisorExtraction,
): ReviewSession {
  const items: ReviewItem[] = [];
  const isAgent = 'steps' in extraction;

  // Check confidence
  if (extraction.confidence < 0.8) {
    items.push({
      type: 'warn',
      element: 'overall',
      question: `Extraction confidence is ${(extraction.confidence * 100).toFixed(0)}%. Please review carefully.`,
      originalText,
      extractedValue: extraction,
    });
  }

  if (isAgent) {
    const agent = extraction as AgentExtraction;

    // Review agent name
    items.push({
      type: 'confirm',
      element: 'agent_name',
      question: `Is "${agent.agent_name}" the correct name for this agent?`,
      originalText,
      extractedValue: agent.agent_name,
    });

    // Review steps
    for (const step of agent.steps) {
      if (step.action_type === 'call_tool') {
        items.push({
          type: 'confirm',
          element: `step_${step.number}`,
          question: `Step ${step.number} calls tool "${step.action_details.tool}". Is this correct?`,
          originalText,
          extractedValue: step,
        });
      }

      if (step.branches.length > 0) {
        items.push({
          type: 'clarify',
          element: `step_${step.number}_branches`,
          question: `Step ${step.number} has ${step.branches.length} branches. Are the conditions correct?`,
          originalText,
          extractedValue: step.branches,
        });
      }
    }

    // Review inferred tools
    for (const tool of agent.inferred_tools) {
      items.push({
        type: 'confirm',
        element: `tool_${tool.name}`,
        question: `Tool "${tool.name}" was inferred. Is the signature correct?`,
        originalText,
        extractedValue: tool,
      });
    }
  } else {
    const supervisor = extraction as SupervisorExtraction;

    // Review routing rules
    for (const rule of supervisor.routing_rules) {
      items.push({
        type: 'confirm',
        element: `rule_${rule.priority}`,
        question: `Rule ${rule.priority}: When "${rule.condition}" route to "${rule.target}". Correct?`,
        originalText,
        extractedValue: rule,
      });
    }

    // Review intent mappings
    if (supervisor.intent_mappings.length > 0) {
      items.push({
        type: 'confirm',
        element: 'intents',
        question: 'Are the intent-to-agent mappings correct?',
        originalText,
        extractedValue: supervisor.intent_mappings,
      });
    }
  }

  return {
    documentType: isAgent ? 'agent' : 'supervisor',
    items,
    extraction,
  };
}

/**
 * Create extractor instance
 */
export function createExtractor(config?: ExtractorConfig): NLExtractor {
  return new NLExtractor(config);
}
