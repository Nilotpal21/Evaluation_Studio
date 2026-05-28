import type { LLMMessage } from '@agent-platform/arch-ai/engine';
import type { ProviderContentBlock } from '@agent-platform/arch-ai';

type VercelModelMessage = Record<string, unknown>;

function serializeToolOutput(
  content: unknown,
): { type: 'json'; value: unknown } | { type: 'text'; value: string } {
  if (content == null) {
    return {
      type: 'json',
      value: null,
    };
  }

  if (typeof content !== 'string') {
    return {
      type: 'json',
      value: content,
    };
  }

  try {
    return {
      type: 'json',
      value: JSON.parse(content),
    };
  } catch {
    return {
      type: 'text',
      value: content,
    };
  }
}

function toVercelContentParts(
  content: ProviderContentBlock[],
  toolCallIdToName: Map<string, string>,
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];

  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', text: block.text });
        break;
      case 'image':
        parts.push({
          type: 'image',
          image:
            block.source.type === 'base64'
              ? `data:${block.source.media_type};base64,${block.source.data}`
              : block.source.url,
        });
        break;
      case 'image_url':
        parts.push({
          type: 'image',
          image: block.image_url.url,
        });
        break;
      case 'tool_use':
        parts.push({
          type: 'tool-call',
          toolCallId: block.id,
          toolName: block.name,
          input: block.input,
        });
        break;
      case 'tool_result':
        parts.push({
          type: 'tool-result',
          toolCallId: block.tool_use_id,
          toolName: toolCallIdToName.get(block.tool_use_id) ?? block.tool_use_id,
          output: serializeToolOutput(block.content),
        });
        break;
      default:
        break;
    }
  }

  return parts;
}

/**
 * Convert the v4 engine's LLMMessage[] into the Vercel AI SDK ModelMessage
 * shape expected by `streamText()`.
 *
 * The v4 turn engine loops internal tool calls by appending:
 * - assistant messages with `toolCalls[]`
 * - tool messages with `toolCallId`
 *
 * Vercel expects those follow-up messages as structured content parts using:
 * - assistant: `{ type: 'tool-call', toolCallId, toolName, input }`
 * - tool: `{ type: 'tool-result', toolCallId, toolName, output }`
 *
 * If we forward `args` or a raw string tool result, Anthropic rejects the
 * prompt as an invalid `ModelMessage[]` schema during the resume turn.
 */
export function toV2VercelMessages(messages: LLMMessage[]): VercelModelMessage[] {
  const toolCallIdToName = new Map<string, string>();

  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.toolCalls)) {
      continue;
    }

    for (const toolCall of message.toolCalls) {
      toolCallIdToName.set(toolCall.id, toolCall.name);
    }
  }

  return messages.flatMap<VercelModelMessage>((message) => {
    if (message.role === 'tool') {
      if (!message.toolCallId) {
        return [];
      }

      return [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: message.toolCallId,
              toolName: toolCallIdToName.get(message.toolCallId) ?? message.toolCallId,
              output: serializeToolOutput(message.content),
            },
          ],
        },
      ];
    }

    const toolCallParts =
      message.role === 'assistant'
        ? (message.toolCalls ?? []).map((toolCall) => ({
            type: 'tool-call',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            input: toolCall.args ?? {},
          }))
        : [];

    const messageContentParts = Array.isArray(message.content)
      ? toVercelContentParts(message.content, toolCallIdToName)
      : [];

    if (toolCallParts.length > 0) {
      const contentParts = [...messageContentParts];
      if (typeof message.content === 'string' && message.content.length > 0) {
        contentParts.push({ type: 'text', text: message.content });
      }
      contentParts.push(...toolCallParts);
      return [{ role: message.role, content: contentParts }];
    }

    if (Array.isArray(message.content)) {
      return [
        { role: message.role, content: messageContentParts.length > 0 ? messageContentParts : '' },
      ];
    }

    return [{ role: message.role, content: message.content }];
  });
}
