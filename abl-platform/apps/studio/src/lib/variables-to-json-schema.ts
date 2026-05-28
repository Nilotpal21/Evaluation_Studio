/**
 * Variables → JSON Schema derivation.
 *
 * The Studio canvas has two authoring surfaces that describe the shape of
 * data flowing into and out of a workflow:
 *
 *   - Start node `config.inputVariables[]` — `{name, type, required, description, defaultValue?}`
 *   - End node `config.outputMapping` — `{fieldName: {expression, type?, description?}}`
 *     (legacy shape was `{fieldName: 'expression'}` with no type info)
 *
 * These are the single source of truth for authoring. `workflow.inputSchema`
 * and `workflow.outputSchema` are derived at save time via the helpers below
 * so downstream consumers (curl snippets, Fire Now modal, OpenAPI export)
 * read a consistent JSON-Schema view without authors maintaining two
 * representations.
 *
 * Mapping rules:
 *   - `string` / `number` / `boolean` → direct JSON Schema primitives
 *   - `json` → `{}` (permissive — author opted out of declaring a shape)
 *   - Missing or unknown `type` → `{}` (permissive, same reasoning)
 *   - `description` / `default` passed through when present
 *   - `required` flag collected into the schema's `required` array
 *   - Empty variable lists produce `null` so callers can skip rendering
 */

import type { WorkflowNode } from '@agent-platform/shared-kernel/types';

export type VariableType = 'string' | 'number' | 'boolean' | 'json';

export interface InputVariable {
  name: string;
  type?: string;
  required?: boolean;
  description?: string;
  defaultValue?: unknown;
}

export interface TypedOutputEntry {
  expression: string;
  type?: string;
  description?: string;
}

/** End-node outputMapping supports both legacy (string) and typed (object) values. */
export type OutputMappingValue = string | TypedOutputEntry;

type JsonSchemaProperty = Record<string, unknown>;

function variableTypeToSchemaProp(type: string | undefined): JsonSchemaProperty {
  switch (type) {
    case 'string':
    case 'number':
    case 'boolean':
      return { type };
    case 'json':
    case undefined:
    default:
      // Permissive — the author declined to constrain shape.
      return {};
  }
}

function attachMetadata(
  prop: JsonSchemaProperty,
  description?: string,
  defaultValue?: unknown,
): JsonSchemaProperty {
  const out = { ...prop };
  if (description) out.description = description;
  if (defaultValue !== undefined) out.default = defaultValue;
  return out;
}

/**
 * Derive a JSON Schema from a Start node's inputVariables. Returns `null`
 * when the list is empty so callers can skip emitting a schema entirely.
 */
export function inputVariablesToJsonSchema(
  vars: InputVariable[] | undefined | null,
): Record<string, unknown> | null {
  if (!Array.isArray(vars) || vars.length === 0) return null;

  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const v of vars) {
    if (!v.name) continue;
    properties[v.name] = attachMetadata(
      variableTypeToSchemaProp(v.type),
      v.description,
      v.defaultValue,
    );
    if (v.required !== false) required.push(v.name);
  }

  if (Object.keys(properties).length === 0) return null;

  const schema: Record<string, unknown> = {
    type: 'object',
    properties,
  };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * Derive a JSON Schema from a single End node's outputMapping. Returns
 * `null` for an empty mapping. Legacy string values produce a permissive
 * `{}` for that property (no type info available).
 */
export function outputMappingToJsonSchema(
  mapping: Record<string, OutputMappingValue> | undefined | null,
): Record<string, unknown> | null {
  if (!mapping || typeof mapping !== 'object') return null;

  const entries = Object.entries(mapping).filter(([name]) => name.length > 0);
  if (entries.length === 0) return null;

  const properties: Record<string, JsonSchemaProperty> = {};
  for (const [name, value] of entries) {
    if (typeof value === 'string') {
      // Legacy shape — expression only, no type declared.
      properties[name] = {};
    } else if (value && typeof value === 'object') {
      properties[name] = attachMetadata(variableTypeToSchemaProp(value.type), value.description);
    }
  }

  if (Object.keys(properties).length === 0) return null;
  return { type: 'object', properties };
}

/**
 * Derive the workflow-level outputSchema from every End node in the canvas.
 *
 *   - Zero end nodes / no mappings → null
 *   - One or more end nodes with mappings → one object schema containing
 *     every declared output field
 *
 * Missing outputMappings on an end node are skipped rather than treated as
 * an empty object — a branch that doesn't declare anything is "unknown
 * shape", and cannot add useful fields to the workflow-level schema.
 */
export function deriveWorkflowOutputSchema(
  nodes: WorkflowNode[] | undefined | null,
): Record<string, unknown> | null {
  if (!Array.isArray(nodes)) return null;

  const endNodes = nodes.filter((n) => n.nodeType === 'end');
  const properties: Record<string, JsonSchemaProperty> = {};
  for (const node of endNodes) {
    const mapping = (node.config as { outputMapping?: Record<string, OutputMappingValue> })
      ?.outputMapping;
    const schema = outputMappingToJsonSchema(mapping ?? null);
    if (!schema) continue;
    const schemaProperties = schema.properties as Record<string, JsonSchemaProperty> | undefined;
    if (schemaProperties) Object.assign(properties, schemaProperties);
  }

  if (Object.keys(properties).length === 0) return null;
  return { type: 'object', properties };
}

/**
 * Derive the workflow-level inputSchema from the canvas's Start node.
 * Returns `null` when no Start node exists or the node declares no
 * inputVariables.
 */
export function deriveWorkflowInputSchema(
  nodes: WorkflowNode[] | undefined | null,
): Record<string, unknown> | null {
  if (!Array.isArray(nodes)) return null;
  const startNode = nodes.find((n) => n.nodeType === 'start');
  if (!startNode) return null;
  const vars = (startNode.config as { inputVariables?: InputVariable[] })?.inputVariables;
  return inputVariablesToJsonSchema(vars);
}
