import type {
  MockLLM,
  OpenAIChatMessageContent,
  OpenAIChatRequest,
} from '../../../../../tools/agents/e2e-functional/types.js';

export function stringifyMessageContent(content: OpenAIChatMessageContent): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!content) {
    return '';
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        if (!part || typeof part !== 'object') {
          return '';
        }

        if (typeof part.text === 'string') {
          return part.text;
        }

        if (typeof part.content === 'string') {
          return part.content;
        }

        return JSON.stringify(part);
      })
      .filter(Boolean)
      .join('\n');
  }

  return JSON.stringify(content);
}

export function extractLastUserMessage(
  messages: Array<{ role: string; content: OpenAIChatMessageContent }>,
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      return stringifyMessageContent(messages[index].content);
    }
  }

  return '';
}

export function findRequestsForLastUserMessage(
  mockLlm: MockLLM,
  userMessage: string,
): OpenAIChatRequest[] {
  return mockLlm
    .getAllRequests()
    .filter((request) => extractLastUserMessage(request.messages).includes(userMessage));
}

function getSystemPrompt(request: OpenAIChatRequest): string {
  const systemPrompt = request.messages.find((message) => message.role === 'system');
  return systemPrompt ? stringifyMessageContent(systemPrompt.content) : '';
}

export function findRuntimeInteractionRequestsForLastUserMessage(
  mockLlm: MockLLM,
  userMessage: string,
): OpenAIChatRequest[] {
  return findRequestsForLastUserMessage(mockLlm, userMessage).filter((request) =>
    ['"interactionContext"', '"runtime_interaction"'].some((key) =>
      getSystemPrompt(request).includes(key),
    ),
  );
}

export function findLatestRequestForLastUserMessage(
  mockLlm: MockLLM,
  userMessage: string,
): OpenAIChatRequest | undefined {
  return findRequestsForLastUserMessage(mockLlm, userMessage).at(-1);
}

export function findLatestRuntimeInteractionRequestForLastUserMessage(
  mockLlm: MockLLM,
  userMessage: string,
): OpenAIChatRequest | undefined {
  return findRuntimeInteractionRequestsForLastUserMessage(mockLlm, userMessage).at(-1);
}

export function extractRuntimeInteractionBlock(systemPrompt: string): string {
  const keys = ['"interactionContext"', '"runtime_interaction"'];
  let startIndex = -1;
  for (const key of keys) {
    startIndex = systemPrompt.indexOf(key);
    if (startIndex !== -1) {
      break;
    }
  }
  if (startIndex === -1) {
    return '';
  }

  const firstBrace = systemPrompt.indexOf('{', startIndex);
  if (firstBrace === -1) {
    return '';
  }

  let depth = 0;
  for (let index = firstBrace; index < systemPrompt.length; index += 1) {
    const char = systemPrompt[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return systemPrompt.slice(startIndex, index + 1);
      }
    }
  }

  return systemPrompt.slice(startIndex);
}

export function getSystemPromptForLastUserMessage(mockLlm: MockLLM, userMessage: string): string {
  const request = findLatestRuntimeInteractionRequestForLastUserMessage(mockLlm, userMessage);
  return request ? getSystemPrompt(request) : '';
}
