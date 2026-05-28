import type {
  ConfigField,
  NodeCategory,
  NodeTypeDefinition,
  NodeTypeDefinitionDoc,
} from './types.js';
import { mergeTraitFields } from './trait-merger.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}

function mapFieldType(type: string): ConfigField['type'] {
  switch (type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
    case 'object':
    case 'string[]':
    case 'info':
      return type;
    case 'object[]':
      return 'array';
    default:
      return 'string';
  }
}

/**
 * Bounded Map: holds one entry per registered node type.
 * With ~35 SYSTEM types + possible tenant overrides, the practical
 * upper bound is well under MAX_NODE_TYPES.
 */
const MAX_NODE_TYPES = 200;

export class NodeRegistry {
  private nodes: Map<string, NodeTypeDefinition> = new Map();

  register(definition: NodeTypeDefinition): void {
    if (this.nodes.has(definition.type)) {
      throw new Error(`Node type '${definition.type}' is already registered`);
    }
    if (this.nodes.size >= MAX_NODE_TYPES) {
      throw new Error(`Node registry is full (max ${MAX_NODE_TYPES} types)`);
    }
    this.nodes.set(definition.type, definition);
  }

  get(type: string): NodeTypeDefinition | undefined {
    return this.nodes.get(type);
  }

  has(type: string): boolean {
    return this.nodes.has(type);
  }

  list(filters?: { category?: NodeCategory; capabilities?: string[] }): NodeTypeDefinition[] {
    let results = [...this.nodes.values()];

    if (filters?.category) {
      results = results.filter((n) => n.category === filters.category);
    }

    if (filters?.capabilities) {
      results = results.filter((n) => {
        if (!n.requiredCapabilities || n.requiredCapabilities.length === 0) return true;
        return n.requiredCapabilities.every((cap) => filters.capabilities!.includes(cap));
      });
    }

    return results;
  }

  validateConfig(type: string, config: Record<string, unknown>): ValidationResult {
    const definition = this.nodes.get(type);
    if (!definition) {
      return { valid: false, errors: [`Unknown node type: '${type}'`] };
    }
    return validateAgainstSchema(config, definition.configSchema);
  }

  /**
   * Clear all registered nodes and load from an array of DB documents.
   * Trait-based standard fields are auto-merged into configSchema.
   */
  loadFromDocs(docs: NodeTypeDefinitionDoc[]): void {
    this.nodes.clear();

    for (const doc of docs) {
      const mergedFields = mergeTraitFields(doc);

      const fields: ConfigField[] = mergedFields.map((f) => ({
        name: f.name,
        type: mapFieldType(f.type),
        required: f.required,
        default: f.default,
        description: f.description,
        label: f.label,
        placeholder: f.placeholder,
        multiline: f.multiline,
        expressionAware: f.expressionAware,
        group: f.group,
        validation: f.validation,
        values: f.values,
        showWhen: f.showWhen,
        intent: f.intent,
        dynamicOptions: f.dynamicOptions,
        suggestions: f.suggestions,
        resetFields: f.resetFields,
        items: f.itemSchema
          ? {
              type: 'object',
              properties: Object.fromEntries(
                f.itemSchema.map((s) => [
                  s.name,
                  {
                    name: s.name,
                    type: mapFieldType(s.type),
                    required: s.required,
                    description: s.description,
                    label: s.label,
                    placeholder: s.placeholder,
                    default: s.default,
                    values: s.values,
                  } as ConfigField,
                ]),
              ),
            }
          : undefined,
      }));

      const definition: NodeTypeDefinition = {
        type: doc._id,
        category: doc.category,
        label: doc.label,
        description: doc.description,
        icon: doc.icon,
        configSchema: { fields },
        executionModel: doc.executionModel,
        defaultTimeout: doc.defaultTimeout,
        defaultRetries: doc.defaultRetries,
        retryable: doc.retryable,
        requiredCapabilities: doc.requiredCapabilities,
        contextKey: doc.contextKey,
        outputSchema: doc.outputSchema ? { properties: doc.outputSchema } : undefined,
      };

      this.nodes.set(doc._id, definition);
    }
  }
}

function validateAgainstSchema(
  config: Record<string, unknown>,
  schema: { fields: ConfigField[] },
): ValidationResult {
  const errors: string[] = [];

  for (const field of schema.fields) {
    // Skip required check when the field's showWhen condition is not met
    if (field.showWhen) {
      const actual = String(config[field.showWhen.field] ?? '');
      const expected = field.showWhen.equals;
      const conditionMet = Array.isArray(expected)
        ? expected.includes(actual)
        : actual === String(expected);
      if (!conditionMet) continue;
    }
    if (field.required && !(field.name in config)) {
      errors.push(`Required field '${field.name}' is missing`);
    }
  }

  return { valid: errors.length === 0, errors };
}
