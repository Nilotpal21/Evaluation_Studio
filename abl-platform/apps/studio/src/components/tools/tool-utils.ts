/**
 * Shared utility functions for tool components
 * Extracted from duplicated implementations to ensure consistency
 */

import type { ToolWithVersion } from '../../store/tool-store';
import type { ParameterDefinition, JsonSchema, JsonSchemaProperty } from './shared-types';
import { parseDslParamMetadata } from '@agent-platform/shared/tools';

// Re-export ParameterDefinition for existing consumers
export type { ParameterDefinition } from './shared-types';

/**
 * Build JSON Schema from sandbox parameters
 * Used in: ToolDetailPage, ToolCreatePage, ToolCreateDialog
 */
export function buildInputSchemaFromParams(parameters: ParameterDefinition[]): JsonSchema | null {
  if (!parameters || parameters.length === 0) {
    return null;
  }

  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const param of parameters) {
    if (!param.name) continue;

    const prop: JsonSchemaProperty = {};

    if (param.type === 'enum') {
      prop.type = 'string';
      prop.enum = (param.enumValues || []).filter(Boolean);
    } else if (param.type === 'object') {
      prop.type = 'object';
      if (param.objectSchema) {
        try {
          prop.properties = JSON.parse(param.objectSchema) as Record<string, JsonSchemaProperty>;
        } catch {
          // Skip invalid schema
        }
      }
    } else if (param.type === 'array') {
      prop.type = 'array';
      if (param.objectSchema) {
        try {
          prop.items = JSON.parse(param.objectSchema) as JsonSchemaProperty;
        } catch {
          // Skip invalid schema
        }
      }
    } else {
      prop.type = param.type;
    }

    if (param.description) {
      prop.description = param.description;
    }

    // Map enumValues → enum for non-enum types that still have allowed values
    if (param.type !== 'enum' && param.enumValues && param.enumValues.length > 0) {
      prop.enum = param.enumValues.filter(Boolean);
    }

    // Map defaultValue → default with type coercion
    if (param.defaultValue !== undefined && param.defaultValue !== '') {
      if (param.type === 'number' || param.type === 'integer') {
        prop.default = Number(param.defaultValue) || 0;
      } else if (param.type === 'boolean') {
        prop.default = param.defaultValue === 'true';
      } else if (param.type === 'object' || param.type === 'array') {
        try {
          prop.default = JSON.parse(param.defaultValue);
        } catch {
          prop.default = param.defaultValue;
        }
      } else {
        prop.default = param.defaultValue;
      }
    }

    properties[param.name] = prop;

    if (param.required) {
      required.push(param.name);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * Generate dummy data from JSON Schema for testing with context-aware values
 * Used in: TestToolDialog, ToolTestPanel
 */
export function generateDummyDataFromSchema(schema: JsonSchemaProperty): Record<string, unknown> {
  if (!schema?.properties) return {};

  const dummy: Record<string, unknown> = {};

  Object.entries(schema.properties).forEach(([key, prop]) => {
    // Use default value if available
    if (prop.default !== undefined) {
      dummy[key] = prop.default;
      return;
    }

    // Use first enum value if available
    if (prop.enum && prop.enum.length > 0) {
      dummy[key] = prop.enum[0];
      return;
    }

    const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;

    // Generate realistic example values based on field name and type
    if (type === 'string') {
      // Context-aware dummy values
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes('email')) dummy[key] = 'user@example.com';
      else if (lowerKey.includes('name')) dummy[key] = 'John Doe';
      else if (lowerKey.includes('url') || lowerKey.includes('endpoint'))
        dummy[key] = 'https://api.example.com';
      else if (lowerKey.includes('id')) dummy[key] = 'abc123';
      else if (lowerKey.includes('phone')) dummy[key] = '+1-555-0100';
      else if (lowerKey.includes('address')) dummy[key] = '123 Main St';
      else if (lowerKey.includes('city')) dummy[key] = 'San Francisco';
      else if (lowerKey.includes('country')) dummy[key] = 'USA';
      else if (lowerKey.includes('description')) dummy[key] = 'Sample description';
      else if (lowerKey.includes('message')) dummy[key] = 'Hello, this is a test message';
      else dummy[key] = 'example';
    } else if (type === 'number' || type === 'integer') {
      const min = prop.minimum ?? 0;
      const max = prop.maximum ?? 100;
      dummy[key] = type === 'integer' ? Math.floor((min + max) / 2) : (min + max) / 2;
    } else if (type === 'boolean') {
      dummy[key] = false;
    } else if (type === 'array') {
      if (prop.items) {
        const itemType = Array.isArray(prop.items.type) ? prop.items.type[0] : prop.items.type;
        if (itemType === 'string') dummy[key] = ['item1', 'item2'];
        else if (itemType === 'number' || itemType === 'integer') dummy[key] = [1, 2, 3];
        else if (itemType === 'object' && prop.items.properties) {
          dummy[key] = [generateDummyDataFromSchema(prop.items)];
        } else {
          dummy[key] = [];
        }
      } else {
        dummy[key] = [];
      }
    } else if (type === 'object') {
      if (prop.properties) {
        dummy[key] = generateDummyDataFromSchema(prop);
      } else {
        dummy[key] = {};
      }
    }
  });

  return dummy;
}

/**
 * Build JSON Schema from a tool's dslContent signature for testing.
 * Parses the first line: tool_name(param1: type1, param2?: type2) -> returnType
 */
export function buildInputSchemaFromTool(tool: ToolWithVersion): JsonSchema | null {
  if (!tool.dslContent) return null;

  const firstLine = tool.dslContent.split('\n')[0] || '';
  const parenMatch = firstLine.match(/\(([^)]*)\)/);
  if (!parenMatch || !parenMatch[1].trim()) return null;

  // Parse rich metadata from params: block
  const paramMeta = parseDslParamMetadata(tool.dslContent);

  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const segment of parenMatch[1].split(',')) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const isOptional = trimmed.includes('?');
    const [name, type] = trimmed
      .replace('?', '')
      .split(':')
      .map((s) => s.trim());
    if (name) {
      const meta = paramMeta.get(name);
      const prop: JsonSchemaProperty = { type: type || 'string' };
      if (meta?.description) prop.description = meta.description;
      if (meta?.enum && meta.enum.length > 0) {
        prop.enum = meta.enum.map(String);
        prop.type = 'string'; // enum values are strings
      }
      if (meta?.default !== undefined) prop.default = meta.default;
      properties[name] = prop;
      if (!isOptional) required.push(name);
    }
  }

  if (Object.keys(properties).length === 0) return null;

  return { type: 'object', properties, required };
}
