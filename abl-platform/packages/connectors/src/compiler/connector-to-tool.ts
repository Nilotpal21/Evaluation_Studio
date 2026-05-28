/**
 * Compiler Bridge: Connector → Tool Definition
 *
 * Converts connector actions into tool definitions consumable by the
 * ABL compiler. This bridges the gap between the connector SDK's
 * ConnectorAction type and the compiler's tool definition format.
 */

import type { ConnectorAction, ConnectorProperty } from '../types.js';

export interface ConnectorToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  tool_type: 'connector';
}

/** Map ConnectorPropertyType to JSON Schema type */
const PROPERTY_TYPE_TO_SCHEMA: Record<string, string> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  dropdown: 'string',
  dynamic_dropdown: 'string',
  json: 'object',
  date: 'string',
  file: 'string',
  oauth: 'string',
};

/** Map ConnectorPropertyType to JSON Schema format (where applicable) */
const PROPERTY_TYPE_TO_FORMAT: Record<string, string> = {
  date: 'date-time',
  file: 'uri',
};

/**
 * Convert an array of ConnectorProperty to a JSON Schema object.
 * Produces a `type: 'object'` schema with properties and required list.
 */
export function propsToJsonSchema(props: ConnectorProperty[]): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const prop of props) {
    const schema: Record<string, unknown> = {
      type: PROPERTY_TYPE_TO_SCHEMA[prop.type] ?? 'string',
    };

    if (prop.description) {
      schema.description = prop.description;
    }

    if (prop.defaultValue !== undefined) {
      schema.default = prop.defaultValue;
    }

    const format = PROPERTY_TYPE_TO_FORMAT[prop.type];
    if (format) {
      schema.format = format;
    }

    // Dropdown: add enum constraint from options
    if (prop.type === 'dropdown' && prop.options) {
      schema.enum = prop.options.map((o) => o.value);
    }

    properties[prop.name] = schema;

    if (prop.required) {
      required.push(prop.name);
    }
  }

  const jsonSchema: Record<string, unknown> = {
    type: 'object',
    properties,
  };

  if (required.length > 0) {
    jsonSchema.required = required;
  }

  return jsonSchema;
}

/**
 * Convert a ConnectorAction into a tool definition object
 * compatible with the ABL compiler's tool format.
 *
 * @param connectorName - The connector's registered name (e.g., "slack", "stripe")
 * @param action - The action to convert
 * @returns A tool definition with dotted name (connector.action)
 */
export function connectorActionToToolDefinition(
  connectorName: string,
  action: ConnectorAction,
): ConnectorToolDefinition {
  return {
    name: `${connectorName}.${action.name}`,
    description: action.description,
    parameters: propsToJsonSchema(action.props),
    tool_type: 'connector',
  };
}
