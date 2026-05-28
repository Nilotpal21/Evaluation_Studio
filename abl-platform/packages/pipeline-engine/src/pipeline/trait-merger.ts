/**
 * Merges trait-based standard fields into a node type's configSchema.
 *
 * Each trait defines standard fields that are auto-appended unless the
 * node's configSchema already defines a field with the same name.
 *
 * Traits:
 *   compute → (no fields — execution context replaces sourceStep)
 *   llm     → model
 *   storage → skipDirectWrite
 */

import type { ConfigFieldDefinition, NodeTypeDefinitionDoc, NodeTrait } from './types.js';

const TRAIT_FIELDS: Record<NodeTrait, ConfigFieldDefinition[]> = {
  compute: [],
  llm: [
    {
      name: 'model',
      type: 'string',
      required: false,
      label: 'LLM Model Override',
      description: 'Override the default LLM model for this node',
      group: 'advanced',
    },
  ],
  storage: [
    {
      name: 'skipDirectWrite',
      type: 'boolean',
      required: false,
      default: false,
      label: 'Skip Direct Write',
      description: 'Skip ClickHouse write (use store-results node instead)',
      group: 'advanced',
    },
  ],
};

/**
 * Given a NodeTypeDefinitionDoc, return a new configSchema array with
 * trait-based standard fields merged in. Fields already present in the
 * doc's configSchema take precedence (not overwritten).
 */
export function mergeTraitFields(doc: NodeTypeDefinitionDoc): ConfigFieldDefinition[] {
  const existingNames = new Set(doc.configSchema.map((f) => f.name));
  const merged = [...doc.configSchema];

  for (const trait of doc.traits) {
    const traitFields = TRAIT_FIELDS[trait];
    if (!traitFields) continue;

    for (const field of traitFields) {
      if (!existingNames.has(field.name)) {
        merged.push(field);
        existingNames.add(field.name);
      }
    }
  }

  return merged;
}
