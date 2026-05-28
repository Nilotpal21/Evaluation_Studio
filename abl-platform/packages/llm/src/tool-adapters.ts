/**
 * Type Adapters for Vercel AI SDK Integration
 *
 * Converts between ABL platform types (Anthropic-style) and Vercel AI SDK types.
 *
 * Key differences from platform types:
 *   - Tool calls use `input` (not `args`) and live in assistant messages
 *   - Tool results use `output: { type, value }` (not `result`) and require `role: 'tool'`
 *   - Tool results reference `toolName` (looked up from prior tool_use blocks)
 */

import type { Message, ToolDefinition } from '@abl/compiler/platform/llm/types.js';
import { z } from 'zod';

// Vercel AI SDK tool format
export interface SDKTool {
  description: string;
  inputSchema: z.ZodType;
}

// ─── Provider Metadata Helpers ───────────────────────────────────────

function readOpenAIResponseId(providerMetadata: unknown): string | undefined {
  if (
    !providerMetadata ||
    typeof providerMetadata !== 'object' ||
    Array.isArray(providerMetadata)
  ) {
    return undefined;
  }
  const openai = (providerMetadata as Record<string, unknown>).openai;
  if (!openai || typeof openai !== 'object' || Array.isArray(openai)) {
    return undefined;
  }
  const responseId = (openai as Record<string, unknown>).responseId;
  return typeof responseId === 'string' && responseId.length > 0 ? responseId : undefined;
}

export interface OpenAIResponsesPreviousResponseRef {
  responseId: string;
  messageIndex: number;
  blockIndex: number;
}

/**
 * Return the latest OpenAI Responses API response id stored in message provider
 * metadata. Runtime callers use this as `previousResponseId`, letting OpenAI
 * reconnect hidden reasoning/function-call items without us serializing them.
 */
export function findOpenAIResponsesPreviousResponse(
  messages: Message[],
): OpenAIResponsesPreviousResponseRef | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const content = messages[messageIndex].content;
    if (typeof content === 'string') {
      continue;
    }
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex--) {
      const block = content[blockIndex];
      if ('providerMetadata' in block) {
        const responseId = readOpenAIResponseId(block.providerMetadata);
        if (responseId) {
          return { responseId, messageIndex, blockIndex };
        }
      }
    }
  }
  return undefined;
}

export function extractOpenAIResponsesPreviousResponseId(messages: Message[]): string | undefined {
  return findOpenAIResponsesPreviousResponse(messages)?.responseId;
}

// ─── Message Conversion ──────────────────────────────────────────────

/**
 * Convert ABL platform messages (Anthropic-style) to Vercel AI SDK ModelMessage format.
 *
 * Platform format:
 *   assistant: [{ type: 'tool_use', id, name, input }]
 *   user:      [{ type: 'tool_result', tool_use_id, content }]
 *
 * Vercel AI SDK format (ai@6.x):
 *   assistant: [{ type: 'tool-call', toolCallId, toolName, input }]
 *   tool:      [{ type: 'tool-result', toolCallId, toolName, output: { type, value } }]
 */
export function convertMessages(
  messages: Message[],
  options?: { toolNameSourceMessages?: Message[] },
): any[] {
  const result: any[] = [];

  // Build toolCallId → toolName map so tool_result blocks can reference the correct name.
  const toolCallIdToName = new Map<string, string>();
  for (const msg of options?.toolNameSourceMessages ?? messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        toolCallIdToName.set(block.id, block.name);
      }
    }
  }

  for (const msg of messages) {
    // Simple string content
    if (typeof msg.content === 'string') {
      result.push({
        role: msg.role,
        content: msg.content,
      });
      continue;
    }

    // Categorise content blocks. When reasoning parts are present, assistant
    // parts preserve ordering because Responses API reasoning items must remain
    // adjacent to their tool calls.
    const assistantOrderedParts: any[] = [];
    const toolResultParts: any[] = [];
    const contentParts: any[] = [];
    const toolCallParts: any[] = [];
    let hasReasoningParts = false;

    for (const block of msg.content) {
      switch (block.type) {
        case 'text': {
          const textPart = {
            type: 'text',
            text: block.text,
            ...(block.providerMetadata ? { providerOptions: block.providerMetadata } : {}),
          };
          contentParts.push(textPart);
          if (msg.role === 'assistant') {
            assistantOrderedParts.push(textPart);
          }
          break;
        }

        case 'reasoning':
          if (msg.role === 'assistant') {
            hasReasoningParts = true;
            assistantOrderedParts.push({
              type: 'reasoning',
              text: block.text,
              ...(block.providerMetadata ? { providerOptions: block.providerMetadata } : {}),
            });
          }
          break;

        case 'image':
          if (block.source.type === 'base64') {
            const imagePart = {
              type: 'image',
              image: Buffer.from(block.source.data, 'base64'),
            };
            contentParts.push(imagePart);
            if (msg.role === 'assistant') {
              assistantOrderedParts.push(imagePart);
            }
          } else if (block.source.type === 'url') {
            const imagePart = {
              type: 'image',
              image: block.source.url,
            };
            contentParts.push(imagePart);
            if (msg.role === 'assistant') {
              assistantOrderedParts.push(imagePart);
            }
          }
          break;

        case 'tool_use':
          if (msg.role === 'assistant') {
            const toolCallPart = {
              type: 'tool-call',
              toolCallId: block.id,
              toolName: block.name,
              input: block.input ?? {},
              // Round-trip provider metadata (e.g. Gemini thoughtSignature) so providers
              // that require it on subsequent requests receive it back.
              ...(block.providerMetadata ? { providerOptions: block.providerMetadata } : {}),
            };
            toolCallParts.push(toolCallPart);
            assistantOrderedParts.push(toolCallPart);
          }
          break;

        case 'tool_result': {
          // AI SDK v6 requires `output: { type, value }` — not `result: string`
          let output: { type: string; value: unknown };
          if (typeof block.content === 'string') {
            try {
              output = { type: 'json', value: JSON.parse(block.content) };
            } catch {
              output = { type: 'text', value: block.content };
            }
          } else {
            output = { type: 'json', value: block.content };
          }
          toolResultParts.push({
            type: 'tool-result',
            toolCallId: block.tool_use_id,
            toolName: toolCallIdToName.get(block.tool_use_id) || block.tool_use_id,
            output,
          });
          break;
        }
      }
    }

    // Emit assistant message (text + tool-call parts)
    if (msg.role === 'assistant') {
      const parts = hasReasoningParts ? assistantOrderedParts : [...contentParts, ...toolCallParts];
      if (parts.length > 0) {
        result.push({ role: 'assistant', content: parts });
      }
    } else if (contentParts.length > 0) {
      // Emit user/system message with text/image content only
      result.push({
        role: msg.role,
        content:
          contentParts.length === 1 && contentParts[0].type === 'text'
            ? contentParts[0].text
            : contentParts,
      });
    }

    // Emit tool results as separate role:'tool' message (Vercel AI SDK requirement)
    if (toolResultParts.length > 0) {
      result.push({ role: 'tool', content: toolResultParts });
    }
  }

  return result;
}

// ─── Tool Conversion ─────────────────────────────────────────────────

export function convertTools(tools: ToolDefinition[]): Record<string, SDKTool> {
  const result: Record<string, SDKTool> = {};

  for (const tool of tools) {
    result[tool.name] = {
      description: tool.description,
      inputSchema: jsonSchemaToZod(tool.input_schema),
    };
  }

  return result;
}

// ─── JSON Schema → Zod Conversion ────────────────────────────────────

/**
 * Convert JSON Schema to Zod schema.
 * Handles common JSON Schema patterns used in tool definitions.
 */
export function jsonSchemaToZod(schema: any): z.ZodType {
  // Object type
  if (schema.type === 'object') {
    const shape: Record<string, z.ZodType> = {};

    for (const [key, propSchema] of Object.entries(schema.properties || {})) {
      let fieldSchema = jsonSchemaToZod(propSchema);

      // Handle optional fields
      if (!schema.required?.includes(key)) {
        fieldSchema = fieldSchema.optional();
      }

      shape[key] = fieldSchema;
    }

    return z.object(shape).passthrough();
  }

  // String type
  if (schema.type === 'string') {
    let zodSchema: z.ZodString | z.ZodEnum<[string, ...string[]]> = z.string();

    if (schema.enum) {
      return z.enum(schema.enum as [string, ...string[]]);
    }

    if (schema.minLength !== undefined) {
      zodSchema = (zodSchema as z.ZodString).min(schema.minLength);
    }

    if (schema.maxLength !== undefined) {
      zodSchema = (zodSchema as z.ZodString).max(schema.maxLength);
    }

    if (schema.pattern) {
      zodSchema = (zodSchema as z.ZodString).regex(new RegExp(schema.pattern));
    }

    if (schema.description) {
      zodSchema = zodSchema.describe(schema.description);
    }

    return zodSchema;
  }

  // Number type
  if (schema.type === 'number' || schema.type === 'integer') {
    let zodSchema = schema.type === 'integer' ? z.number().int() : z.number();

    if (schema.minimum !== undefined) {
      zodSchema = zodSchema.min(schema.minimum);
    }

    if (schema.maximum !== undefined) {
      zodSchema = zodSchema.max(schema.maximum);
    }

    if (schema.description) {
      zodSchema = zodSchema.describe(schema.description);
    }

    return zodSchema;
  }

  // Boolean type
  if (schema.type === 'boolean') {
    let zodSchema = z.boolean();

    if (schema.description) {
      zodSchema = zodSchema.describe(schema.description);
    }

    return zodSchema;
  }

  // Array type
  if (schema.type === 'array') {
    const itemSchema = schema.items ? jsonSchemaToZod(schema.items) : z.any();
    let zodSchema = z.array(itemSchema);

    if (schema.minItems !== undefined) {
      zodSchema = zodSchema.min(schema.minItems);
    }

    if (schema.maxItems !== undefined) {
      zodSchema = zodSchema.max(schema.maxItems);
    }

    return zodSchema;
  }

  // Null type
  if (schema.type === 'null') {
    return z.null();
  }

  // Union types (oneOf, anyOf)
  if (schema.oneOf) {
    const schemas = schema.oneOf.map(jsonSchemaToZod);
    if (schemas.length === 0) return z.any();
    if (schemas.length === 1) return schemas[0];
    return z.union([schemas[0], schemas[1], ...schemas.slice(2)]);
  }

  if (schema.anyOf) {
    const schemas = schema.anyOf.map(jsonSchemaToZod);
    if (schemas.length === 0) return z.any();
    if (schemas.length === 1) return schemas[0];
    return z.union([schemas[0], schemas[1], ...schemas.slice(2)]);
  }

  // Handle type as array (e.g., ["string", "null"] from JSON Schema nullable)
  if (Array.isArray(schema.type)) {
    const schemas = schema.type.map((t: string) => jsonSchemaToZod({ ...schema, type: t }));
    if (schemas.length === 0) return z.any();
    if (schemas.length === 1) return schemas[0];
    return z.union([schemas[0], schemas[1], ...schemas.slice(2)]);
  }

  // Fallback: accept any
  return z.any();
}
