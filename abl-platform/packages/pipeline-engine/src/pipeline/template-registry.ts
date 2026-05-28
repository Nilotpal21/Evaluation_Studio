/**
 * Pipeline Template Registry
 *
 * Loads static template definitions from src/pipeline/templates/. Each template
 * is a JSON file representing a pre-wired PipelineDefinition (graph format)
 * that conforms to the current ContractRegistry.
 *
 * Usage in Studio routes:
 *   import { listTemplates, getTemplate } from '@agent-platform/pipeline-engine/templates';
 *
 *   GET /api/pipelines/templates        → listTemplates()
 *   POST /api/pipelines/templates/:id/clone  → getTemplate(id), clone into project
 */

import templateIndex from './templates/index.json' with { type: 'json' };
import llmEvaluatorTemplate from './templates/llm-evaluator.json' with { type: 'json' };
import perMessageGuardrailTemplate from './templates/per-message-guardrail.json' with { type: 'json' };
import qualityEvaluatorTemplate from './templates/quality-evaluator.json' with { type: 'json' };

export interface TemplateIndexEntry {
  id: string;
  label: string;
  description: string;
  category: string;
  trigger?: string;
  nodes?: string[];
}

export interface TemplatePipelineDefinition {
  name: string;
  description?: string;
  supportedTriggers: unknown[];
  defaultTriggerIds: string[];
  nodes: unknown[];
  entryNodeId: string;
  configSchema: { fields: unknown[] };
}

const TEMPLATE_DEFINITIONS: Record<string, TemplatePipelineDefinition> = {
  'llm-evaluator': llmEvaluatorTemplate as TemplatePipelineDefinition,
  'per-message-guardrail': perMessageGuardrailTemplate as TemplatePipelineDefinition,
  'quality-evaluator': qualityEvaluatorTemplate as TemplatePipelineDefinition,
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Returns the full template index (all available templates). */
export async function listTemplates(): Promise<TemplateIndexEntry[]> {
  return cloneJson(templateIndex as TemplateIndexEntry[]);
}

/**
 * Load the full pipeline definition for a given template ID.
 * Returns `null` when the template does not exist or cannot be parsed.
 */
export async function getTemplate(id: string): Promise<TemplatePipelineDefinition | null> {
  if (id === 'blank') {
    // The blank template has no nodes; return a minimal empty definition.
    return {
      name: 'Untitled Pipeline',
      description: '',
      supportedTriggers: [],
      defaultTriggerIds: [],
      nodes: [],
      entryNodeId: '',
      configSchema: { fields: [] },
    };
  }

  // File name mirrors the template id
  const safeId = id.replace(/[^a-z0-9-]/g, '');
  if (safeId !== id) return null; // reject traversal attempts

  const template = TEMPLATE_DEFINITIONS[safeId];
  return template ? cloneJson(template) : null;
}
